import { stat } from "node:fs/promises";
import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	type ActionEnvelope,
	type ActionOrigin,
	ActionType,
	AhpErrorCodes,
	type ChatAction,
	ChatOriginKind,
	CompletionItemKind,
	type CompletionsResult,
	type DirectoryCustomization,
	type InitializeResult,
	JsonRpcErrorCodes,
	type ListSessionsResult,
	type Message,
	MessageKind,
	type ReconnectResult,
	ReconnectResultType,
	type SessionChatSummary,
	type SessionSummary,
	type Snapshot,
	type StateAction,
	type TerminalClaim,
} from "@microsoft/agent-host-protocol";
import type { AttachRequest } from "../bridge/protocol.ts";
import { type Logger, silentLogger } from "../core/logger.ts";
import { StateStore } from "../core/state-store.ts";
import {
	type ChatRef,
	chatUri,
	fileUri,
	PROVIDER,
	parseSessionUri,
	pathFromFileUri,
	ROOT_CHANNEL,
	sessionUri,
} from "../core/uris.ts";
import type { PiBackend } from "../pi/agent.ts";
import {
	COMPLETION_TRIGGER_CHARACTERS,
	toCustomizations,
	userCommands,
	withFrontmatter,
} from "../pi/customizations.ts";
import { forkTitle } from "../pi/forks.ts";
import { sweepInterval } from "../pi/idle.ts";
import { toSessionModelInfo } from "../pi/models.ts";
import {
	type ChatBinding,
	PiSession,
	restoredStatus,
	type SessionHostContext,
	type SessionSummaryChanges,
} from "../pi/pi-session.ts";
import { connectRpcAgent } from "../pi/rpc-agent.ts";
import type { RpcChannel } from "../pi/rpc-channel.ts";
import { ProtocolError } from "../protocol/jsonrpc.ts";
import { selectProtocolVersion } from "../protocol/version.ts";
import { type ArchiveStore, memoryArchiveStore } from "./archive-store.ts";
import type { LiveSessionHandler } from "./bridges.ts";
import { Connection, type ConnectionHandler, type RESPONDED, type Reply } from "./connection.ts";
import { type ForkRecord, type ForkStore, forkByChat, forksOf, memoryForkStore } from "./fork-store.ts";
import { ResourceWatchService } from "./resource-watches.ts";
import { ResourceService } from "./resources.ts";
import { TerminalService } from "./terminals.ts";

export interface AgentHostOptions {
	backend: PiBackend;
	/** Directory offered to clients as the default working directory. */
	defaultDirectory: string;
	serverVersion?: string;
	logger?: Logger;
	/**
	 * Stops a session's `pi --mode rpc` process after this many ms without
	 * activity (see specs/idle-sessions.md). 0 or unset keeps them running.
	 */
	idleTimeoutMs?: number;
	/**
	 * How often to publish the processes each running `pi --mode rpc` started
	 * in the background as its chat's background work (see
	 * specs/background-work.md). 0 or unset only refreshes when a turn starts
	 * or ends, and on `refreshBackgroundWork()`.
	 */
	backgroundWorkIntervalMs?: number;
	/** The clock, in ms (tests replace it). */
	now?: () => number;
	/** Persisted archived flags. Kept in memory when unset. */
	archive?: ArchiveStore;
	/** Persisted forked chats. Kept in memory when unset. */
	forks?: ForkStore;
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
	/** Forked chats, by the id of the pi session backing each one. */
	readonly #forkedChats = new Map<string, PiSession>();
	/** Negotiated protocol version per clientId, for `reconnect`. */
	readonly #clientVersions = new Map<string, string>();
	readonly #resources = new ResourceService();
	readonly #terminals: TerminalService;
	readonly #watches: ResourceWatchService;
	#catalog: { at: number; sessions: Promise<SessionInfo[]> } | undefined;
	#activeSessions = 0;
	readonly #idleTimeoutMs: number;
	readonly #idleTimer: NodeJS.Timeout | undefined;
	#sweeping: Promise<number> | undefined;
	readonly #backgroundTimer: NodeJS.Timeout | undefined;
	#refreshing: Promise<void> | undefined;
	#nextRefresh: Promise<void> | undefined;
	readonly now: () => number;
	readonly archive: ArchiveStore;
	readonly forks: ForkStore;

	constructor(options: AgentHostOptions) {
		this.backend = options.backend;
		this.#defaultDirectory = options.defaultDirectory;
		this.#serverVersion = options.serverVersion ?? "0.0.0";
		this.logger = options.logger ?? silentLogger;
		this.now = options.now ?? Date.now;
		this.archive = options.archive ?? memoryArchiveStore();
		this.forks = options.forks ?? memoryForkStore();
		this.#idleTimeoutMs = options.idleTimeoutMs ?? 0;
		if (this.#idleTimeoutMs > 0) {
			this.#idleTimer = setInterval(() => void this.suspendIdleSessions(), sweepInterval(this.#idleTimeoutMs));
			this.#idleTimer.unref();
		}
		const backgroundWorkIntervalMs = options.backgroundWorkIntervalMs ?? 0;
		if (backgroundWorkIntervalMs > 0) {
			this.#backgroundTimer = setInterval(() => void this.refreshBackgroundWork(), backgroundWorkIntervalMs);
			this.#backgroundTimer.unref();
		}
		this.store = new StateStore({
			agents: [
				{
					provider: PROVIDER,
					displayName: "Pi",
					description: "The pi coding agent",
					models: [],
					capabilities: { multipleChats: { fork: true } },
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

	/**
	 * Loads the model catalog and pi's global skills and prompts (as the
	 * agent's customizations, for clients composing a new session) into root
	 * state.
	 */
	async refreshAgents(): Promise<void> {
		const [models, customizations] = await Promise.all([
			this.backend.models().then((list) => list.map(toSessionModelInfo)),
			this.#agentCustomizations(),
		]);
		const [agent] = this.store.root.agents;
		if (!agent) return;
		const next = { ...agent, models, ...(customizations ? { customizations } : {}) };
		if (JSON.stringify(agent) === JSON.stringify(next)) return;
		this.store.dispatch(ROOT_CHANNEL, { type: ActionType.RootAgentsChanged, agents: [next] });
	}

	/** pi's global commands as customizations; undefined (keep the current ones) when pi cannot list them. */
	async #agentCustomizations(): Promise<DirectoryCustomization[] | undefined> {
		try {
			return toCustomizations(await withFrontmatter(userCommands(await this.backend.globalCommands())));
		} catch (error) {
			this.logger.warn("could not read pi's global commands", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
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

	/**
	 * Stops the pi process of every session idle for longer than the idle
	 * timeout. Sessions stay listed and subscribed; their next turn starts a
	 * new pi. Returns how many were stopped. Concurrent calls share one sweep.
	 */
	suspendIdleSessions(): Promise<number> {
		if (this.#idleTimeoutMs <= 0) return Promise.resolve(0);
		this.#sweeping ??= this.#sweep().finally(() => {
			this.#sweeping = undefined;
		});
		return this.#sweeping;
	}

	async #sweep(): Promise<number> {
		const cutoff = this.now() - this.#idleTimeoutMs;
		let stopped = 0;
		for (const session of this.#chats()) {
			try {
				if (!(await session.suspend(cutoff))) continue;
				stopped++;
				this.logger.info("idle session suspended", {
					session: session.id,
					idleMinutes: Math.round((this.now() - session.lastActivity) / 60_000),
				});
			} catch (error) {
				this.logger.warn("could not suspend idle session", {
					session: session.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return stopped;
	}

	/**
	 * Publishes every session's background processes as its chat's
	 * background work. Only sessions with a running pi are read; none is
	 * started. A call made while a refresh runs waits for it and then
	 * refreshes once more, so what it sees is current; calls made meanwhile
	 * share that next refresh.
	 */
	refreshBackgroundWork(): Promise<void> {
		this.#nextRefresh ??= (this.#refreshing ?? Promise.resolve()).then(() => {
			this.#nextRefresh = undefined;
			this.#refreshing = this.#refreshAll().finally(() => {
				this.#refreshing = undefined;
			});
			return this.#refreshing;
		});
		return this.#nextRefresh;
	}

	async #refreshAll(): Promise<void> {
		await Promise.all(
			this.#chats().map((session) =>
				session.refreshBackgroundWork().catch((error) => {
					this.logger.warn("could not refresh background work", {
						session: session.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}),
			),
		);
	}

	async dispose(): Promise<void> {
		if (this.#idleTimer) clearInterval(this.#idleTimer);
		if (this.#backgroundTimer) clearInterval(this.#backgroundTimer);
		await this.#sweeping?.catch(() => {});
		await this.#nextRefresh?.catch(() => {});
		await this.#refreshing?.catch(() => {});
		for (const connection of this.#connections) connection.close();
		this.#connections.clear();
		await Promise.all(this.#chats().map((session) => session.dispose()));
		this.#sessions.clear();
		this.#forkedChats.clear();
		await this.forks.flush();
		this.#terminals.disposeAll();
		await this.#watches.disposeAll();
		await this.backend.dispose();
		await this.archive.flush();
	}

	/** Every loaded chat: sessions' default chats and forked chats. */
	#chats(): PiSession[] {
		return [...this.#sessions.values(), ...this.#forkedChats.values()];
	}

	/** The loaded chat a chat reference addresses. */
	#chat(ref: ChatRef): PiSession | undefined {
		return ref.chatId === ref.sessionId ? this.#sessions.get(ref.sessionId) : this.#forkedChats.get(ref.chatId);
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
				await this.#loadForks(info.sessionId);
				this.#notifyRoot("root/sessionAdded", { summary: session.summary() });
			}
		}
		const attached = session;
		channel.onClose(() => attached.agentDetached(agent, info.sessionFile));
		this.logger.debug("live session ready", { session: info.sessionId, pid: info.pid });
	}

	// ── SessionHostContext ────────────────────────────────────────────────

	summaryChanged(sessionId: string, changes: SessionSummaryChanges): void {
		this.#notifyRoot("root/sessionSummaryChanged", { session: sessionUri(sessionId), changes });
	}

	activityChanged(): void {
		// A turn that ended may have left processes running.
		void this.refreshBackgroundWork();
		const active = new Set(
			this.#chats()
				.filter((chat) => chat.isRunning)
				.map((chat) => chat.sessionId),
		).size;
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
			case "createChat":
				return this.#createChat(params);
			case "listSessions":
				return this.#listSessions(params);
			case "fetchTurns":
				// History is always delivered in full; there are never older turns to page in.
				return {};
			case "resolveSessionConfig":
				return { schema: { type: "object", properties: {} }, values: {} };
			case "sessionConfigCompletions":
				return { items: [] };
			case "completions":
				return this.#completions(params);
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
			serverInfo: { name: "pi-agent-host-protocol", version: this.#serverVersion },
			snapshots,
			defaultDirectory: fileUri(this.#defaultDirectory),
			completionTriggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
		};
		return reply(result);
	}

	async #reconnect(connection: Connection, params: Record<string, unknown>, reply: Reply): Promise<typeof RESPONDED> {
		const clientId = requireString(params.clientId, "clientId");
		const lastSeen = typeof params.lastSeenServerSeq === "number" ? params.lastSeenServerSeq : -1;
		const requested = stringArray(params.subscriptions) ?? [ROOT_CHANNEL];

		// A client this host instance never saw (e.g. after a host restart)
		// must initialize again: its sequence numbers belong to another
		// instance, and it would otherwise keep the protocol version and
		// capabilities (such as `completionTriggerCharacters`) of the host it
		// first initialized with. Clients fall back to `initialize` on NotFound.
		const knownClient = this.#clientVersions.get(clientId);
		if (!knownClient) {
			this.logger.info("reconnect from unknown client; asking it to initialize", {
				...connection.logFields,
				clientId,
			});
			throw new ProtocolError(AhpErrorCodes.NotFound, `Reconnect client not found: ${clientId}`);
		}
		await Promise.all(requested.map((uri) => this.#load(uri).catch(() => undefined)));

		connection.clientId = clientId;
		connection.protocolVersion = knownClient;
		connection.initialized = true;
		this.#clientVersions.set(clientId, connection.protocolVersion);
		this.logger.info("client reconnected", {
			...connection.logFields,
			clientId,
			protocolVersion: connection.protocolVersion,
			lastSeenServerSeq: lastSeen,
		});

		const replay = lastSeen <= this.store.serverSeq ? this.store.replaySince(lastSeen) : undefined;
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

	/** Ensures the session addressed by a session or chat URI is loaded, with its forked chats. */
	async #load(channel: string): Promise<void> {
		if (this.store.channel(channel)) return;
		const ref = this.store.ref(channel);
		if (ref.kind === "root") return;
		if (ref.kind === "unknown") throw ProtocolError.notFound(channel);
		// A forked chat's URI is the client's; until its session loads, only the fork store knows it.
		const sessionId = forkByChat(this.forks.all(), channel)?.[1].session ?? ref.sessionId;
		if (this.#sessions.has(sessionId)) return;
		const info = (await this.#catalogSessions()).find((session) => session.id === sessionId);
		if (!info) throw ProtocolError.sessionNotFound(channel);
		if (this.#sessions.has(sessionId)) return;
		this.#sessions.set(sessionId, PiSession.open(this, info.path));
		this.logger.debug("session loaded", { session: sessionId, path: info.path });
		await this.#loadForks(sessionId);
	}

	/** Loads the forked chats of a loaded session. Forks whose pi session file is gone are skipped. */
	async #loadForks(sessionId: string): Promise<void> {
		const forks = forksOf(this.forks.all(), sessionId);
		if (forks.length === 0) return;
		const catalog = await this.#catalogSessions();
		for (const [id, record] of forks) {
			if (this.#forkedChats.has(id) || !this.#sessions.has(sessionId)) continue;
			const info = catalog.find((session) => session.id === id);
			if (!info) {
				this.logger.warn("forked chat's session file not found", { session: sessionId, chat: record.chat, fork: id });
				continue;
			}
			this.#forkedChats.set(id, PiSession.openFork(this, info.path, forkBinding(record)));
			this.logger.debug("forked chat loaded", { session: sessionId, chat: record.chat, fork: id });
		}
	}

	/**
	 * Forks a chat at a completed turn into a new chat of the same session
	 * (`createChat` with a `ForkChatSource`). The fork is a new pi session
	 * file branched from the source chat's, so the model has the same context
	 * through that turn. See specs/forks.md.
	 */
	async #createChat(params: Record<string, unknown>): Promise<null> {
		const channel = requireString(params.channel, "channel");
		const sessionId = parseSessionUri(channel);
		if (!sessionId) throw ProtocolError.invalidParams(`Invalid session URI: ${channel}`);
		const chat = requireString(params.chat, "chat");
		const source = forkSource(params.source);
		await this.#load(channel);
		const session = this.#sessions.get(sessionId);
		if (!session) throw ProtocolError.sessionNotFound(channel);
		if (this.store.snapshot(chat) || forkByChat(this.forks.all(), chat)) {
			throw new ProtocolError(AhpErrorCodes.AlreadyExists, `Chat already exists: ${chat}`);
		}
		const sourceRef = this.store.ref(source.chat);
		const sourceChat = sourceRef.kind === "chat" ? this.#chat(sourceRef) : undefined;
		if (!sourceChat || sourceChat.sessionId !== sessionId) {
			throw ProtocolError.invalidParams(`Source chat is not a chat of ${channel}: ${source.chat}`);
		}
		const title = forkTitle(this.store.chat(sourceChat.id)?.title ?? "Chat");
		let path: string;
		try {
			path = await sourceChat.fork(source.turnId, title);
		} catch (error) {
			throw ProtocolError.invalidParams(`Cannot fork: ${error instanceof Error ? error.message : String(error)}`);
		}
		// Another request may have taken the URI while pi wrote the file.
		if (this.store.snapshot(chat)) throw new ProtocolError(AhpErrorCodes.AlreadyExists, `Chat already exists: ${chat}`);
		const record: ForkRecord = { session: sessionId, chat, source: source.chat, turnId: source.turnId };
		const fork = PiSession.openFork(this, path, forkBinding(record));
		this.#forkedChats.set(fork.id, fork);
		this.forks.add(fork.id, record);
		this.logger.debug("chat forked", {
			session: sessionId,
			chat,
			fork: fork.id,
			from: source.chat,
			turn: source.turnId,
		});
		const message = initialMessage(params.initialMessage);
		if (message) {
			const action: ChatAction = {
				type: ActionType.ChatTurnStarted,
				turnId: crypto.randomUUID(),
				startedAt: new Date().toISOString(),
				message,
			};
			if (this.store.dispatch(chat, action)) fork.onChatAction(action);
		}
		return null;
	}

	/** Slash-command completions for a user message. Best effort: failures return no items. */
	async #completions(params: Record<string, unknown>): Promise<CompletionsResult> {
		const channel = requireString(params.channel, "channel");
		const text = typeof params.text === "string" ? params.text : "";
		const offset = typeof params.offset === "number" ? params.offset : text.length;
		const ref = this.store.ref(channel);
		if (params.kind !== CompletionItemKind.UserMessage || (ref.kind !== "chat" && ref.kind !== "session")) {
			return { items: [] };
		}
		try {
			await this.#load(channel);
			const loaded = this.store.ref(channel);
			const session = loaded.kind === "chat" ? this.#chat(loaded) : this.#sessions.get(ref.sessionId);
			return { items: (await session?.completions(text, offset)) ?? [] };
		} catch (error) {
			this.logger.debug("completions failed", {
				channel,
				error: error instanceof Error ? error.message : String(error),
			});
			return { items: [] };
		}
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
		const forks = this.forks.all();
		const catalog = await this.#catalogSessions();
		const byId = new Map(catalog.map((info) => [info.id, info]));
		for (const info of catalog) {
			if (live.has(info.id) || forks.has(info.id) || info.messageCount === 0) continue;
			const forkedChats = forksOf(forks, info.id).flatMap(([id, record]) => {
				const fork = byId.get(id);
				return fork ? [forkedChatSummary(fork, record)] : [];
			});
			all.push(catalogSummary(info, this.archive.isArchived(info.id), forkedChats));
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
		if (this.store.ref(channel).kind !== "root") await this.#load(channel).catch(() => undefined);
		let ref = this.store.ref(channel);
		// VS Code addresses session renames to the chat; AHP defines them on the session.
		if (ref.kind === "chat" && action.type === ActionType.SessionTitleChanged) {
			ref = { kind: "session", sessionId: ref.sessionId };
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
				return { kind: "accepted" };
			}
			case "chat": {
				const session = this.#chat(ref);
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

function catalogTitle(info: SessionInfo): string {
	const firstLine = info.firstMessage.trim().split("\n")[0] ?? "";
	return info.name || (firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine) || "Untitled session";
}

function catalogSummary(info: SessionInfo, archived: boolean, forkedChats: SessionChatSummary[] = []): SessionSummary {
	const title = catalogTitle(info);
	const status = restoredStatus(archived);
	return {
		resource: sessionUri(info.id),
		provider: PROVIDER,
		title,
		status,
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
		workingDirectories: [fileUri(info.cwd)],
		chats: [{ resource: chatUri(info.id), title, status }, ...forkedChats],
	};
}

/** A forked chat's catalog entry, from its pi session file's listing. */
function forkedChatSummary(info: SessionInfo, record: ForkRecord): SessionChatSummary {
	return {
		resource: record.chat,
		title: catalogTitle(info),
		status: restoredStatus(false),
		origin: { kind: ChatOriginKind.Fork, chat: record.source, turnId: record.turnId },
	};
}

function forkBinding(record: ForkRecord): Extract<ChatBinding, { kind: "fork" }> {
	return {
		kind: "fork",
		session: record.session,
		chat: record.chat,
		origin: { chat: record.source, turnId: record.turnId },
	};
}

/** The fork source of `createChat`. Other ways of creating a chat are not supported. */
function forkSource(value: unknown): { chat: string; turnId: string } {
	const source = value as { kind?: unknown; chat?: unknown; turnId?: unknown } | undefined;
	if (typeof source !== "object" || source === null) {
		throw ProtocolError.invalidParams("createChat needs a fork source: this host only forks chats");
	}
	if (source.kind !== ChatOriginKind.Fork) {
		throw ProtocolError.invalidParams(`Unsupported chat source: ${String(source.kind)}`);
	}
	return { chat: requireString(source.chat, "source.chat"), turnId: requireString(source.turnId, "source.turnId") };
}

function initialMessage(value: unknown): Message | undefined {
	const message = value as Partial<Message> | undefined;
	if (typeof message !== "object" || message === null || typeof message.text !== "string") return undefined;
	return { ...message, text: message.text, origin: message.origin ?? { kind: MessageKind.User } };
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
