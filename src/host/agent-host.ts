import { stat } from "node:fs/promises";
import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	type ActionEnvelope,
	type ActionOrigin,
	ActionType,
	AhpErrorCodes,
	type ChatAction,
	type InitializeResult,
	JsonRpcErrorCodes,
	type ListSessionsResult,
	type ReconnectResult,
	ReconnectResultType,
	SessionStatus,
	type SessionSummary,
	type Snapshot,
	type StateAction,
	type TerminalClaim,
} from "@microsoft/agent-host-protocol";
import type { AttachRequest } from "../bridge/protocol.ts";
import { type Logger, silentLogger } from "../core/logger.ts";
import { StateStore } from "../core/state-store.ts";
import {
	fileUri,
	PROVIDER,
	parseChannel,
	parseSessionUri,
	pathFromFileUri,
	ROOT_CHANNEL,
	sessionUri,
} from "../core/uris.ts";
import type { PiBackend } from "../pi/agent.ts";
import { toSessionModelInfo } from "../pi/models.ts";
import { PiSession, type SessionHostContext } from "../pi/pi-session.ts";
import { connectRpcAgent } from "../pi/rpc-agent.ts";
import type { RpcChannel } from "../pi/rpc-channel.ts";
import { ProtocolError } from "../protocol/jsonrpc.ts";
import { selectProtocolVersion } from "../protocol/version.ts";
import type { LiveSessionHandler } from "./bridges.ts";
import { Connection, type ConnectionHandler, type RESPONDED, type Reply } from "./connection.ts";
import { ResourceWatchService } from "./resource-watches.ts";
import { ResourceService } from "./resources.ts";
import { TerminalService } from "./terminals.ts";

export interface AgentHostOptions {
	backend: PiBackend;
	/** Directory offered to clients as the default working directory. */
	defaultDirectory: string;
	serverVersion?: string;
	logger?: Logger;
}

type ActionOutcome = { kind: "accepted" } | { kind: "rejected"; reason: string } | { kind: "ignored" };

const CATALOG_TTL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 200;

/** Session-channel actions a client may dispatch and the host accepts. */
const ACCEPTED_SESSION_ACTIONS = new Set<string>([
	ActionType.SessionTitleChanged,
	ActionType.SessionIsReadChanged,
	ActionType.SessionIsArchivedChanged,
	ActionType.SessionActiveClientSet,
	ActionType.SessionActiveClientRemoved,
	ActionType.SessionConfigChanged,
]);

const UNSUPPORTED_METHODS = new Set([
	"createChat",
	"moveChat",
	"disposeChat",
	"invokeChangesetOperation",
	"listAutomationTriggerDefinitions",
	"runAutomation",
	"fetchAutomationRuns",
]);

const DENIED_RESOURCE_METHODS = new Set([
	"resourceWrite",
	"resourceCopy",
	"resourceDelete",
	"resourceMove",
	"resourceMkdir",
	"resourceRequest",
]);

/** The AHP host: routes protocol commands to pi sessions and owns all protocol state. */
export class AgentHost implements ConnectionHandler, SessionHostContext, LiveSessionHandler {
	readonly store: StateStore;
	readonly backend: PiBackend;
	readonly #defaultDirectory: string;
	readonly #serverVersion: string;
	readonly logger: Logger;
	readonly #connections = new Set<Connection>();
	readonly #sessions = new Map<string, PiSession>();
	/** Negotiated protocol version per clientId, for `reconnect`. */
	readonly #clientVersions = new Map<string, string>();
	readonly #resources = new ResourceService();
	readonly #terminals: TerminalService;
	readonly #watches: ResourceWatchService;
	#catalog: { at: number; sessions: Promise<SessionInfo[]> } | undefined;
	#activeSessions = 0;

	constructor(options: AgentHostOptions) {
		this.backend = options.backend;
		this.#defaultDirectory = options.defaultDirectory;
		this.#serverVersion = options.serverVersion ?? "0.0.0";
		this.logger = options.logger ?? silentLogger;
		this.store = new StateStore({
			agents: [
				{
					provider: PROVIDER,
					displayName: "Pi",
					description: "The pi coding agent",
					models: [],
				},
			],
			activeSessions: 0,
			terminals: [],
		});
		this.#terminals = new TerminalService(this.store, this.logger, this.#defaultDirectory);
		this.#watches = new ResourceWatchService(this.store, this.logger);
		this.store.onEnvelope((envelope) => {
			for (const connection of this.#connections) connection.deliver(envelope);
		});
	}

	/** Loads the model catalog into root state. */
	async refreshAgents(): Promise<void> {
		const models = (await this.backend.models()).map(toSessionModelInfo);
		const [agent] = this.store.root.agents;
		if (!agent || JSON.stringify(agent.models) === JSON.stringify(models)) return;
		this.store.dispatch(ROOT_CHANNEL, { type: ActionType.RootAgentsChanged, agents: [{ ...agent, models }] });
	}

	connect(label: string, send: (text: string) => void): Connection {
		const connection = new Connection(label, send, this, this.logger);
		this.logger.info("client connected", connection.logFields);
		this.#connections.add(connection);
		return connection;
	}

	disconnect(connection: Connection): void {
		this.logger.info("client disconnected", connection.logFields);
		connection.close();
		this.#connections.delete(connection);
		void this.#watches.release((channel) => this.#isSubscribed(channel), connection);
	}

	async dispose(): Promise<void> {
		for (const connection of this.#connections) connection.close();
		this.#connections.clear();
		await Promise.all([...this.#sessions.values()].map((session) => session.dispose()));
		this.#sessions.clear();
		this.#terminals.disposeAll();
		await this.#watches.disposeAll();
		await this.backend.dispose();
	}

	#isSubscribed(channel: string): boolean {
		return [...this.#connections].some((connection) => connection.isSubscribed(channel));
	}

	// ── LiveSessionHandler ────────────────────────────────────────────────

	/**
	 * A session open in an interactive pi attached through the bridge. The
	 * TUI becomes the session's only writer: a session the host already has
	 * hands over to it, otherwise a new one is announced with history from
	 * pi's live branch.
	 */
	async attachLive(info: AttachRequest, channel: RpcChannel): Promise<void> {
		const agent = await connectRpcAgent(channel, this.logger);
		let session = this.#sessions.get(info.sessionId);
		if (session) {
			session.adoptAgent(agent);
		} else {
			const { entries } = await channel.request<{ entries: SessionEntry[] }>({ type: "get_branch" });
			session = this.#sessions.get(info.sessionId);
			if (session) {
				session.adoptAgent(agent);
			} else {
				session = PiSession.live(this, info, agent, entries);
				this.#sessions.set(info.sessionId, session);
				this.#notifyRoot("root/sessionAdded", { summary: session.summary() });
			}
		}
		const attached = session;
		channel.onClose(() => attached.agentDetached(agent, info.sessionFile));
		this.logger.debug("live session ready", { session: info.sessionId, pid: info.pid });
	}

	// ── SessionHostContext ────────────────────────────────────────────────

	summaryChanged(sessionId: string, changes: Partial<SessionSummary>): void {
		this.#notifyRoot("root/sessionSummaryChanged", { session: sessionUri(sessionId), changes });
	}

	activityChanged(): void {
		const active = [...this.#sessions.values()].filter((session) => session.isRunning).length;
		if (active === this.#activeSessions) return;
		this.#activeSessions = active;
		this.store.dispatch(ROOT_CHANNEL, { type: ActionType.RootActiveSessionsChanged, activeSessions: active });
	}

	// ── ConnectionHandler ─────────────────────────────────────────────────

	async request(
		connection: Connection,
		method: string,
		params: Record<string, unknown>,
		reply: Reply,
	): Promise<unknown> {
		switch (method) {
			case "initialize":
				return this.#initialize(connection, params, reply);
			case "reconnect":
				return this.#reconnect(connection, params, reply);
			case "subscribe":
				return this.#subscribe(connection, params, reply);
			case "createSession":
				return this.#createSession(params);
			case "disposeSession":
				return this.#disposeSession(params);
			case "listSessions":
				return this.#listSessions(params);
			case "fetchTurns":
				// History is always delivered in full; there are never older turns to page in.
				return {};
			case "resolveSessionConfig":
				return { schema: { type: "object", properties: {} }, values: {} };
			case "sessionConfigCompletions":
			case "completions":
				return { items: [] };
			case "authenticate":
				return {};
			case "resourceRead":
				return this.#resources.read(params.uri, params.encoding);
			case "resourceList":
				return this.#resources.list(params.uri);
			case "resourceResolve":
				return this.#resources.resolve(params.uri);
			case "createResourceWatch":
				return this.#watches.create(
					{
						uri: params.uri,
						recursive: params.recursive === true,
						includes: globList(params.includes),
						excludes: globList(params.excludes),
					},
					connection,
				);
			case "createTerminal":
				return this.#createTerminal(params);
			case "disposeTerminal":
				this.#terminals.dispose(requireString(params.channel, "channel"));
				return null;
			default:
				if (DENIED_RESOURCE_METHODS.has(method)) return this.#resources.denied(method);
				if (UNSUPPORTED_METHODS.has(method)) {
					throw new ProtocolError(JsonRpcErrorCodes.MethodNotFound, `${method} is not supported by this host`);
				}
				throw new ProtocolError(JsonRpcErrorCodes.MethodNotFound, `Method not found: ${method}`);
		}
	}

	async notification(connection: Connection, method: string, params: Record<string, unknown>): Promise<void> {
		const channel = typeof params.channel === "string" ? params.channel : undefined;
		if (!channel) return;
		if (method === "unsubscribe") {
			connection.unsubscribe(channel, this.store.resolve(channel));
			await this.#watches.release((uri) => this.#isSubscribed(uri));
		} else if (method === "dispatchAction") {
			await this.#dispatchAction(connection, channel, params.clientSeq, params.action);
		}
	}

	// ── Handshake ─────────────────────────────────────────────────────────

	async #initialize(connection: Connection, params: Record<string, unknown>, reply: Reply): Promise<typeof RESPONDED> {
		const version = selectProtocolVersion(params.protocolVersions);
		const clientId = requireString(params.clientId, "clientId");
		const requested = stringArray(params.initialSubscriptions) ?? [ROOT_CHANNEL];
		await Promise.all(requested.map((uri) => this.#load(uri).catch(() => undefined)));
		void this.refreshAgents().catch(() => {});

		connection.clientId = clientId;
		connection.clientName = clientName(params.clientInfo);
		connection.protocolVersion = version;
		connection.initialized = true;
		this.#clientVersions.set(clientId, version);
		this.logger.info("client initialized", { ...connection.logFields, clientId, protocolVersion: version });
		const snapshots = this.#subscribeAll(connection, requested);
		const result: InitializeResult = {
			protocolVersion: version,
			serverSeq: this.store.serverSeq,
			serverInfo: { name: "pi-agent-host", version: this.#serverVersion },
			snapshots,
			defaultDirectory: fileUri(this.#defaultDirectory),
		};
		return reply(result);
	}

	async #reconnect(connection: Connection, params: Record<string, unknown>, reply: Reply): Promise<typeof RESPONDED> {
		const clientId = requireString(params.clientId, "clientId");
		const lastSeen = typeof params.lastSeenServerSeq === "number" ? params.lastSeenServerSeq : -1;
		const requested = stringArray(params.subscriptions) ?? [ROOT_CHANNEL];
		await Promise.all(requested.map((uri) => this.#load(uri).catch(() => undefined)));

		const knownClient = this.#clientVersions.get(clientId);
		connection.clientId = clientId;
		connection.protocolVersion = knownClient ?? connection.protocolVersion;
		connection.initialized = true;
		this.#clientVersions.set(clientId, connection.protocolVersion);
		this.logger.info("client reconnected", {
			...connection.logFields,
			clientId,
			protocolVersion: connection.protocolVersion,
			lastSeenServerSeq: lastSeen,
		});

		// A client this host instance never saw (e.g. after a host restart)
		// cannot be replayed: its sequence numbers belong to another instance.
		const replay = knownClient && lastSeen <= this.store.serverSeq ? this.store.replaySince(lastSeen) : undefined;
		if (!replay) {
			const result: ReconnectResult = {
				type: ReconnectResultType.Snapshot,
				snapshots: this.#subscribeAll(connection, requested),
			};
			return reply(result);
		}
		const missing: string[] = [];
		for (const uri of requested) {
			const canonical = this.store.resolve(uri);
			if (canonical) connection.subscribe(canonical, uri);
			else missing.push(uri);
		}
		const actions = replay
			.map((envelope) => connection.present(envelope))
			.filter((envelope): envelope is ActionEnvelope => envelope !== undefined);
		const result: ReconnectResult = { type: ReconnectResultType.Replay, actions, missing };
		return reply(result);
	}

	async #subscribe(connection: Connection, params: Record<string, unknown>, reply: Reply): Promise<typeof RESPONDED> {
		const channel = requireString(params.channel, "channel");
		await this.#load(channel);
		const snapshot = this.store.snapshot(channel);
		if (!snapshot) throw ProtocolError.notFound(channel);
		connection.subscribe(snapshot.resource, channel);
		this.#watches.subscribed(snapshot.resource);
		return reply({ snapshot: { ...snapshot, resource: channel } });
	}

	/** Subscribes to every resolvable channel and returns their snapshots, synchronously. */
	#subscribeAll(connection: Connection, channels: string[]): Snapshot[] {
		const snapshots: Snapshot[] = [];
		for (const channel of channels) {
			const snapshot = this.store.snapshot(channel);
			if (!snapshot) continue;
			connection.subscribe(snapshot.resource, channel);
			this.#watches.subscribed(snapshot.resource);
			snapshots.push({ ...snapshot, resource: channel });
		}
		return snapshots;
	}

	// ── Sessions ──────────────────────────────────────────────────────────

	/** Ensures the session addressed by a session or chat URI is loaded. */
	async #load(channel: string): Promise<void> {
		if (this.store.channel(channel)) return;
		const ref = parseChannel(channel);
		if (ref.kind === "root") return;
		if (ref.kind === "unknown") throw ProtocolError.notFound(channel);
		if (this.#sessions.has(ref.sessionId)) return;
		const info = (await this.#catalogSessions()).find((session) => session.id === ref.sessionId);
		if (!info) throw ProtocolError.sessionNotFound(channel);
		if (this.#sessions.has(ref.sessionId)) return;
		this.#sessions.set(ref.sessionId, PiSession.open(this, info.path));
		this.logger.debug("session loaded", { session: ref.sessionId, path: info.path });
	}

	async #createSession(params: Record<string, unknown>): Promise<null> {
		const channel = requireString(params.channel, "channel");
		const id = parseSessionUri(channel);
		if (!id) throw ProtocolError.invalidParams(`Invalid session URI: ${channel}`);
		if (params.provider !== undefined && params.provider !== PROVIDER) {
			throw new ProtocolError(AhpErrorCodes.ProviderNotFound, `Unknown provider: ${String(params.provider)}`);
		}
		const exists = this.#sessions.has(id) || (await this.#catalogSessions()).some((session) => session.id === id);
		if (exists) throw new ProtocolError(AhpErrorCodes.SessionAlreadyExists, `Session already exists: ${channel}`);

		const directory = stringArray(params.workingDirectories)?.[0];
		const cwd = directory ? pathFromFileUri(directory) : this.#defaultDirectory;
		if (
			!cwd ||
			!(await stat(cwd).then(
				(info) => info.isDirectory(),
				() => false,
			))
		) {
			throw ProtocolError.invalidParams(`Working directory is not a local directory: ${directory}`);
		}
		if (this.#sessions.has(id))
			throw new ProtocolError(AhpErrorCodes.SessionAlreadyExists, `Session already exists: ${channel}`);

		const session = PiSession.create(this, id, cwd);
		this.#sessions.set(id, session);
		this.logger.debug("session created", { session: id, cwd });
		void session.initialize().then(() => {
			if (this.store.session(id)?.lifecycle === "ready") {
				this.#notifyRoot("root/sessionAdded", { summary: session.summary() });
			}
		});
		return null;
	}

	async #createTerminal(params: Record<string, unknown>): Promise<null> {
		const claim = params.claim;
		if (typeof claim !== "object" || claim === null || typeof (claim as { kind?: unknown }).kind !== "string") {
			throw ProtocolError.invalidParams("claim is required");
		}
		await this.#terminals.create(requireString(params.channel, "channel"), {
			claim: claim as TerminalClaim,
			name: typeof params.name === "string" ? params.name : undefined,
			cwd: typeof params.cwd === "string" ? params.cwd : undefined,
			cols: positiveInt(params.cols),
			rows: positiveInt(params.rows),
		});
		return null;
	}

	/**
	 * pi session files are never deleted. An empty session is discarded; a
	 * session with history stays listed (VS Code currently disposes sessions
	 * it still shows, so treating this as deletion would lose work).
	 */
	async #disposeSession(params: Record<string, unknown>): Promise<null> {
		const channel = requireString(params.channel, "channel");
		const id = parseSessionUri(channel);
		const session = id ? this.#sessions.get(id) : undefined;
		if (!id || !session) {
			if (id && (await this.#catalogSessions()).some((info) => info.id === id)) return null;
			throw ProtocolError.sessionNotFound(channel);
		}
		if (session.hasTurns || session.isRunning) {
			this.logger.debug("session dispose ignored (has history)", { session: id });
			return null;
		}
		this.#sessions.delete(id);
		this.logger.debug("session disposed", { session: id });
		this.store.removeSession(id);
		await session.dispose();
		this.#notifyRoot("root/sessionRemoved", { session: sessionUri(id) });
		return null;
	}

	async #listSessions(params: Record<string, unknown>): Promise<ListSessionsResult> {
		const live = new Map<string, SessionSummary>();
		for (const [id, session] of this.#sessions) {
			if (this.store.session(id)) live.set(id, session.summary());
		}
		const all = [...live.values()];
		for (const info of await this.#catalogSessions()) {
			if (!live.has(info.id) && info.messageCount > 0) all.push(catalogSummary(info));
		}
		all.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
		const offset = typeof params.cursor === "string" ? Number.parseInt(params.cursor, 10) || 0 : 0;
		const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : DEFAULT_PAGE_SIZE;
		const items = all.slice(offset, offset + limit);
		return offset + limit < all.length ? { items, nextCursor: String(offset + limit) } : { items };
	}

	#catalogSessions(): Promise<SessionInfo[]> {
		const now = Date.now();
		if (!this.#catalog || now - this.#catalog.at > CATALOG_TTL_MS) {
			const sessions = this.backend.listSessions().catch(() => []);
			this.#catalog = { at: now, sessions };
		}
		return this.#catalog.sessions;
	}

	// ── Actions ───────────────────────────────────────────────────────────

	async #dispatchAction(connection: Connection, channel: string, clientSeq: unknown, action: unknown): Promise<void> {
		if (!connection.clientId || typeof clientSeq !== "number" || !isAction(action)) return;
		const origin: ActionOrigin = { clientId: connection.clientId, clientSeq };
		const outcome = await this.#applyClientAction(channel, action, origin);
		const fields = { ...connection.logFields, channel, action: action.type, clientSeq };
		switch (outcome.kind) {
			case "accepted":
				this.logger.debug("action accepted", fields);
				return;
			case "rejected":
				this.logger.debug("action rejected", { ...fields, reason: outcome.reason });
				connection.sendEnvelope(this.store.reject(channel, action, origin, outcome.reason));
				return;
			case "ignored":
				this.logger.debug("action ignored (unknown channel)", fields);
				return;
		}
	}

	/** Validates and applies a client-dispatched action, running its side effects. */
	async #applyClientAction(channel: string, action: StateAction, origin: ActionOrigin): Promise<ActionOutcome> {
		const unsupported: ActionOutcome = { kind: "rejected", reason: `Unsupported action: ${action.type}` };
		const exact = this.store.channel(channel);
		if (exact?.kind === "terminal") {
			const reason = this.#terminals.validate(channel, action);
			if (reason) return { kind: "rejected", reason };
			this.store.dispatch(channel, action, origin);
			this.#terminals.onAction(channel, action);
			return { kind: "accepted" };
		}
		if (exact?.kind === "resourceWatch") return unsupported;
		let ref = parseChannel(channel);
		// VS Code addresses session renames to the chat; AHP defines them on the session.
		if (ref.kind === "chat" && action.type === ActionType.SessionTitleChanged) {
			ref = { kind: "session", sessionId: ref.sessionId };
		}
		if (ref.kind === "session" || ref.kind === "chat") {
			await this.#load(channel).catch(() => undefined);
		}
		switch (ref.kind) {
			case "root":
				if (action.type !== ActionType.RootConfigChanged) return unsupported;
				this.store.dispatch(ROOT_CHANNEL, action, origin);
				return { kind: "accepted" };
			case "session": {
				const session = this.#sessions.get(ref.sessionId);
				if (!session) return { kind: "ignored" };
				if (!ACCEPTED_SESSION_ACTIONS.has(action.type)) return unsupported;
				this.store.dispatch(sessionUri(ref.sessionId), action, origin);
				session.onSessionAction(action);
				if (action.type === ActionType.SessionIsReadChanged || action.type === ActionType.SessionIsArchivedChanged) {
					const status = this.store.session(ref.sessionId)?.status ?? SessionStatus.Idle;
					this.summaryChanged(ref.sessionId, { status });
				}
				return { kind: "accepted" };
			}
			case "chat": {
				const session = this.#sessions.get(ref.sessionId);
				if (!session) return { kind: "ignored" };
				const reason = session.validateChatAction(action);
				if (reason) return { kind: "rejected", reason };
				if (this.store.dispatch(channel, action, origin)) session.onChatAction(action as ChatAction);
				return { kind: "accepted" };
			}
			default:
				return { kind: "ignored" };
		}
	}

	#notifyRoot(
		method: "root/sessionAdded" | "root/sessionRemoved" | "root/sessionSummaryChanged",
		params: Record<string, unknown>,
	): void {
		for (const connection of this.#connections) connection.notifyRoot(method, params);
	}
}

function catalogSummary(info: SessionInfo): SessionSummary {
	const firstLine = info.firstMessage.trim().split("\n")[0] ?? "";
	return {
		resource: sessionUri(info.id),
		provider: PROVIDER,
		title: info.name || (firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine) || "Untitled session",
		status: SessionStatus.Idle | SessionStatus.IsRead,
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
		workingDirectories: [fileUri(info.cwd)],
	};
}

function clientName(clientInfo: unknown): string | undefined {
	const name = (clientInfo as { name?: unknown } | undefined)?.name;
	return typeof name === "string" ? name : undefined;
}

function globList(value: unknown): { items: string[] } | undefined {
	const items = (value as { items?: unknown } | undefined)?.items;
	return Array.isArray(items) ? { items: items.filter((item): item is string => typeof item === "string") } : undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw ProtocolError.invalidParams(`${name} must be a non-empty string`);
	return value;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function isAction(value: unknown): value is StateAction {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
