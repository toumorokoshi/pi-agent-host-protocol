import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
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
import type { Logger } from "../src/core/logger.ts";
import { AgentHost } from "../src/host/agent-host.ts";
import { PiServices } from "../src/pi/services.ts";
import { type Listener, listen } from "../src/transport/websocket.ts";

export interface TestHost {
	readonly url: string;
	readonly dir: string;
	readonly cwd: string;
	readonly faux: FauxProviderHandle;
	readonly host: AgentHost;
	/** Stops the host but keeps its session files (to test restarts). */
	stop(): Promise<void>;
	/** Stops the host and deletes all files. */
	cleanup(): Promise<void>;
}

/** Starts a host backed by pi's scripted faux model, isolated in a temp directory. */
export async function startHost(options: { token?: string; dir?: string; logger?: Logger } = {}): Promise<TestHost> {
	const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "pi-agent-host-test-")));
	const cwd = join(dir, "workspace");
	await mkdir(cwd, { recursive: true });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux One" }], tokensPerSecond: 2000 });
	modelRuntime.registerNativeProvider(faux.provider);
	// Without credentials pi does not list a provider's models as available.
	await modelRuntime.setRuntimeApiKey("faux", "test-key");
	const services = await PiServices.create({
		agentDir: join(dir, "agent"),
		sessionDir: join(dir, "sessions"),
		modelRuntime,
		sessionOverrides: { model: faux.getModel(), settingsManager: SettingsManager.inMemory() },
	});
	const host = new AgentHost({ services, defaultDirectory: cwd, serverVersion: "test", logger: options.logger });
	await host.refreshAgents();
	const listener: Listener = await listen(host, { host: "127.0.0.1", port: 0, token: options.token });
	const stop = async () => {
		await listener.close();
		await host.dispose();
	};
	return {
		url: listener.url,
		dir,
		cwd,
		faux,
		host,
		stop,
		cleanup: async () => {
			await stop();
			await rm(dir, { recursive: true, force: true });
		},
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
