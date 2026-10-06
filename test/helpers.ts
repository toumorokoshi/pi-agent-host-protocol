import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type ActionEnvelope,
	type ChatAction,
	type ChatState,
	chatReducer,
	type RootAction,
	type RootState,
	rootReducer,
	type SessionAction,
	type SessionState,
	type Snapshot,
	sessionReducer,
} from "@microsoft/agent-host-protocol";
import WebSocket from "ws";
import { type Logger, silentLogger } from "../src/core/logger.ts";
import { AgentHost } from "../src/host/agent-host.ts";
import { BridgeServer } from "../src/host/bridges.ts";
import type { PiBackend, PiMode } from "../src/pi/agent.ts";
import { EmbeddedBackend } from "../src/pi/embedded-backend.ts";
import { RpcBackend } from "../src/pi/rpc-backend.ts";
import { JsonlChannel } from "../src/pi/rpc-channel.ts";
import { type Listener, listen } from "../src/transport/websocket.ts";

export interface TestHost {
	readonly url: string;
	readonly dir: string;
	readonly cwd: string;
	readonly mode: PiMode;
	/** In rpc mode, the URL the faux provider extension fetches responses from. */
	readonly fauxUrl: string | undefined;
	/** The bridge socket, when started with `bridge: true`. */
	readonly socketPath: string | undefined;
	readonly faux: FauxScript;
	readonly host: AgentHost;
	/** Stops the host but keeps its session files (to test restarts). */
	stop(): Promise<void>;
	/** Stops the host and deletes all files. */
	cleanup(): Promise<void>;
}

/** Scripts pi's faux model, in-process (embedded) or through the RPC child's faux extension. */
export interface FauxScript {
	setResponses(responses: FauxResponseStep[]): void;
}

/** Runs each test suite against both backends. */
export const PI_MODES: readonly PiMode[] = ["rpc", "embedded"];

/** pi's own CLI from node_modules, so RPC tests do not depend on an installed `pi`. */
export const PI_CLI = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
export const FAUX_EXTENSION = fileURLToPath(new URL("./fixtures/faux-provider.ts", import.meta.url));
const FAUX_MODELS = [{ id: "faux-1", name: "Faux One" }];

interface StartedBackend {
	backend: PiBackend;
	faux: FauxScript;
	fauxUrl?: string;
	close(): Promise<void>;
}

/** Starts a host backed by pi's scripted faux model, isolated in a temp directory. */
export async function startHost(
	options: {
		token?: string;
		dir?: string;
		logger?: Logger;
		mode?: PiMode;
		bridge?: boolean;
		idleTimeoutMs?: number;
		now?: () => number;
	} = {},
): Promise<TestHost> {
	const mode = options.mode ?? "rpc";
	const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-test-")));
	const cwd = join(dir, "workspace");
	await mkdir(cwd, { recursive: true });
	const started = mode === "rpc" ? await startRpcBackend(dir, cwd, options.logger) : await startEmbeddedBackend(dir);
	const host = new AgentHost({
		backend: started.backend,
		defaultDirectory: cwd,
		serverVersion: "test",
		logger: options.logger,
		idleTimeoutMs: options.idleTimeoutMs,
		now: options.now,
	});
	await host.refreshAgents();
	const listener: Listener = await listen(host, { host: "127.0.0.1", port: 0, token: options.token });
	const bridge = options.bridge
		? await BridgeServer.listen(join(dir, "host.sock"), host, options.logger ?? silentLogger)
		: undefined;
	bridge?.setUrl(listener.url);
	const stop = async () => {
		await bridge?.close();
		await listener.close();
		await host.dispose();
		await started.close();
	};
	return {
		url: listener.url,
		dir,
		cwd,
		mode,
		socketPath: bridge?.path,
		fauxUrl: started.fauxUrl,
		faux: started.faux,
		host,
		stop,
		cleanup: async () => {
			await stop();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

async function startEmbeddedBackend(dir: string): Promise<StartedBackend> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "faux", models: FAUX_MODELS, tokensPerSecond: 2000 });
	modelRuntime.registerNativeProvider(faux.provider);
	// Without credentials pi does not list a provider's models as available.
	await modelRuntime.setRuntimeApiKey("faux", "test-key");
	const backend = await EmbeddedBackend.create({
		agentDir: join(dir, "agent"),
		sessionDir: join(dir, "sessions"),
		modelRuntime,
		sessionOverrides: { model: faux.getModel(), settingsManager: SettingsManager.inMemory() },
	});
	return { backend, faux, close: async () => {} };
}

/**
 * Runs pi's real CLI in RPC mode. The child loads `fixtures/faux-provider.ts`,
 * which asks this process for each response, so factories still run here.
 */
async function startRpcBackend(dir: string, cwd: string, logger: Logger | undefined): Promise<StartedBackend> {
	const agentDir = join(dir, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "test-key" } }));
	const model = fauxProvider({ provider: "faux", models: FAUX_MODELS }).getModel();
	let steps: FauxResponseStep[] = [];
	const state = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] };
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", async () => {
			state.callCount++;
			const step = steps.shift();
			const message =
				step === undefined
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "No more faux responses queued" })
					: typeof step === "function"
						? await step(JSON.parse(body), undefined, state, model)
						: step;
			response.end(JSON.stringify(message));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	const backend = new RpcBackend({
		pi: PI_CLI,
		agentDir,
		sessionDir: join(dir, "sessions"),
		args: ["-e", FAUX_EXTENSION, "--provider", "faux", "--model", "faux-1"],
		env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_AGENT_HOST_PROTOCOL_FAUX_URL: `http://127.0.0.1:${port}/` },
		cwd,
		logger,
	});
	return {
		backend,
		fauxUrl: `http://127.0.0.1:${port}/`,
		faux: {
			setResponses: (responses) => {
				steps = [...responses];
			},
		},
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

type Inbound = { id?: number; method?: string; params?: any; result?: any; error?: any };

/**
 * A minimal AHP client that speaks VS Code's URI dialect and mirrors state
 * with the official reducers, so assertions run against what a real client
 * would reconstruct.
 */
export class TestClient {
	readonly #ws: WebSocket;
	readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
	readonly #waiters: Array<{ predicate: (message: Inbound) => boolean; resolve: (message: Inbound) => void }> = [];
	readonly messages: Inbound[] = [];
	readonly envelopes: ActionEnvelope[] = [];
	root: RootState | undefined;
	readonly sessions = new Map<string, SessionState>();
	readonly chats = new Map<string, ChatState>();
	#nextId = 1;
	#clientSeq = 0;
	readonly clientId = crypto.randomUUID();

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.on("message", (data) => this.#onMessage(JSON.parse(data.toString()) as Inbound));
	}

	static connect(url: string): Promise<TestClient> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			ws.once("open", () => resolve(new TestClient(ws)));
			ws.once("error", reject);
			ws.once("unexpected-response", (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
		});
	}

	request(method: string, params: Record<string, unknown> = {}): Promise<any> {
		const id = this.#nextId++;
		this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
	}

	async initialize(subscriptions = ["ahp-root://"], versions = ["0.10.0", "0.9.0"]): Promise<any> {
		const result = await this.request("initialize", {
			channel: "ahp-root://",
			protocolVersions: versions,
			clientId: this.clientId,
			clientInfo: { name: "test-client" },
			initialSubscriptions: subscriptions,
		});
		for (const snapshot of result.snapshots) this.#applySnapshot(snapshot);
		return result;
	}

	async subscribe(channel: string): Promise<Snapshot> {
		const result = await this.request("subscribe", { channel });
		this.#applySnapshot(result.snapshot);
		return result.snapshot;
	}

	dispatch(channel: string, action: Record<string, unknown>): number {
		const clientSeq = ++this.#clientSeq;
		this.#ws.send(JSON.stringify({ jsonrpc: "2.0", method: "dispatchAction", params: { channel, clientSeq, action } }));
		return clientSeq;
	}

	notifyUnsubscribe(channel: string): void {
		this.#ws.send(JSON.stringify({ jsonrpc: "2.0", method: "unsubscribe", params: { channel } }));
	}

	/** Resolves with the first (past or future) message matching `predicate`. */
	waitFor(predicate: (message: Inbound) => boolean, timeoutMs = 10_000): Promise<Inbound> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
			this.#waiters.push({
				predicate,
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
		});
	}

	waitForAction(type: string, timeoutMs?: number): Promise<Inbound> {
		return this.waitFor((message) => message.method === "action" && message.params?.action?.type === type, timeoutMs);
	}

	close(): void {
		this.#ws.close();
	}

	#applySnapshot(snapshot: Snapshot): void {
		if (snapshot.resource === "ahp-root://") this.root = snapshot.state as RootState;
		else if (snapshot.resource.startsWith("ahp-chat:")) this.chats.set(snapshot.resource, snapshot.state as ChatState);
		else this.sessions.set(snapshot.resource, snapshot.state as SessionState);
	}

	#apply(envelope: ActionEnvelope): void {
		if (envelope.rejectionReason) return;
		const { channel, action } = envelope;
		if (channel === "ahp-root://" && this.root) {
			this.root = rootReducer(this.root, action as RootAction);
		} else if (this.chats.has(channel)) {
			this.chats.set(channel, chatReducer(this.chats.get(channel)!, action as ChatAction));
		} else if (this.sessions.has(channel)) {
			this.sessions.set(channel, sessionReducer(this.sessions.get(channel)!, action as SessionAction));
		}
	}

	#onMessage(message: Inbound): void {
		this.messages.push(message);
		if (message.id !== undefined && !message.method) {
			const pending = this.#pending.get(message.id);
			this.#pending.delete(message.id);
			if (message.error) {
				const error = Object.assign(new Error(message.error.message), {
					code: message.error.code,
					data: message.error.data,
				});
				pending?.reject(error);
			} else {
				pending?.resolve(message.result);
			}
		}
		if (message.method === "action") {
			this.envelopes.push(message.params);
			this.#apply(message.params);
		}
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const waiter = this.#waiters[i]!;
			if (waiter.predicate(message)) {
				this.#waiters.splice(i, 1);
				waiter.resolve(message);
			}
		}
	}
}

export function vscodeChatUri(sessionUri: string): string {
	return `ahp-chat://default/${Buffer.from(sessionUri).toString("base64url")}`;
}

/** Creates a session in the test workspace, subscribes to it and its default chat. */
export async function newSession(host: TestHost, client: TestClient): Promise<{ session: string; chat: string }> {
	const session = `pi:/${crypto.randomUUID()}`;
	await client.request("createSession", {
		channel: session,
		provider: "pi",
		workingDirectories: [pathToFileURL(host.cwd).href],
	});
	const snapshot = await client.subscribe(session);
	if ((snapshot.state as { lifecycle?: string }).lifecycle !== "ready") {
		await client.waitFor(
			(m) => m.method === "action" && m.params.channel === session && m.params.action.type === "session/ready",
		);
	}
	const chat = vscodeChatUri(session);
	await client.subscribe(chat);
	return { session, chat };
}

export function startTurn(client: TestClient, chat: string, text: string): string {
	const turnId = crypto.randomUUID();
	client.dispatch(chat, {
		type: "chat/turnStarted",
		turnId,
		startedAt: new Date().toISOString(),
		message: { text, origin: { kind: "user" } },
	});
	return turnId;
}

/** Two connected in-memory channels, standing in for a socket between the host and a bridge. */
export function channelPair(): [JsonlChannel, JsonlChannel] {
	let a: JsonlChannel;
	let b: JsonlChannel;
	const end = async () => {
		a.end(new Error("Channel closed"));
		b.end(new Error("Channel closed"));
	};
	a = new JsonlChannel({ write: (text) => queueMicrotask(() => b.push(text)), close: end }, { idPrefix: "a" });
	b = new JsonlChannel({ write: (text) => queueMicrotask(() => a.push(text)), close: end }, { idPrefix: "b" });
	return [a, b];
}
