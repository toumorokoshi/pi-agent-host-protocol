import {
	type ActionEnvelope,
	type ActionOrigin,
	type ChatAction,
	type ChatState,
	chatReducer,
	type ResourceWatchAction,
	type ResourceWatchState,
	type RootAction,
	type RootState,
	resourceWatchReducer,
	rootReducer,
	type SessionAction,
	type SessionState,
	type Snapshot,
	type StateAction,
	sessionReducer,
	type TerminalAction,
	type TerminalState,
	terminalReducer,
} from "@microsoft/agent-host-protocol";
import { chatUri, parseChannel, ROOT_CHANNEL, sessionUri } from "./uris.ts";

const DEFAULT_REPLAY_CAPACITY = 10_000;

export type EnvelopeListener = (envelope: ActionEnvelope) => void;

/** Channels addressed by their exact URI rather than a session id. */
export type ExactChannel =
	| { kind: "terminal"; state: TerminalState }
	| { kind: "resourceWatch"; state: ResourceWatchState };

function reduceExact(channel: ExactChannel, action: StateAction): ExactChannel {
	return channel.kind === "terminal"
		? { kind: "terminal", state: terminalReducer(channel.state, action as TerminalAction) }
		: { kind: "resourceWatch", state: resourceWatchReducer(channel.state, action as ResourceWatchAction) };
}

/**
 * Authoritative protocol state. Every mutation goes through the shared AHP
 * reducers so the host's state is exactly what clients reconstruct, and every
 * applied action is stamped with a host-wide `serverSeq`.
 */
export class StateStore {
	#root: RootState;
	readonly #sessions = new Map<string, SessionState>();
	readonly #chats = new Map<string, ChatState>();
	readonly #exact = new Map<string, ExactChannel>();
	readonly #listeners = new Set<EnvelopeListener>();
	readonly #replay: ActionEnvelope[] = [];
	readonly #replayCapacity: number;
	#seq = 0;

	constructor(root: RootState, replayCapacity = DEFAULT_REPLAY_CAPACITY) {
		this.#root = root;
		this.#replayCapacity = replayCapacity;
	}

	get serverSeq(): number {
		return this.#seq;
	}

	get root(): RootState {
		return this.#root;
	}

	session(id: string): SessionState | undefined {
		return this.#sessions.get(id);
	}

	chat(sessionId: string): ChatState | undefined {
		return this.#chats.get(sessionId);
	}

	sessionIds(): string[] {
		return [...this.#sessions.keys()];
	}

	/** Registers a new session and its default chat without emitting actions. */
	addSession(id: string, session: SessionState, chat: ChatState): void {
		this.#sessions.set(id, session);
		this.#chats.set(id, chat);
	}

	removeSession(id: string): void {
		this.#sessions.delete(id);
		this.#chats.delete(id);
	}

	/** Registers a terminal or resource-watch channel at `uri` without emitting actions. */
	addChannel(uri: string, channel: ExactChannel): void {
		this.#exact.set(uri, channel);
	}

	removeChannel(uri: string): void {
		this.#exact.delete(uri);
	}

	channel(uri: string): ExactChannel | undefined {
		return this.#exact.get(uri);
	}

	/**
	 * Replaces a terminal's state outside the action stream. Used only to bound
	 * retained scrollback; clients keep whatever they already reduced.
	 */
	replaceTerminalState(uri: string, state: TerminalState): void {
		if (this.#exact.get(uri)?.kind === "terminal") this.#exact.set(uri, { kind: "terminal", state });
	}

	/**
	 * Mirrors the default chat's summary status into the session state outside
	 * the action stream. AHP has no action that sets `SessionState.status`, and
	 * the session reducer only toggles its read/archived flags, so without this
	 * session snapshots would never show a running turn. Live clients follow
	 * the status through `root/sessionSummaryChanged` and `session/chatUpdated`.
	 */
	setSessionStatus(id: string, status: SessionState["status"]): void {
		const state = this.#sessions.get(id);
		if (state && state.status !== status) this.#sessions.set(id, { ...state, status });
	}

	snapshot(channel: string): Snapshot | undefined {
		const fromSeq = this.#seq;
		const exact = this.#exact.get(channel);
		if (exact) return { resource: channel, state: exact.state, fromSeq };
		const ref = parseChannel(channel);
		switch (ref.kind) {
			case "root":
				return { resource: ROOT_CHANNEL, state: this.#root, fromSeq };
			case "session": {
				const state = this.#sessions.get(ref.sessionId);
				return state && { resource: sessionUri(ref.sessionId), state, fromSeq };
			}
			case "chat": {
				const state = this.#chats.get(ref.sessionId);
				return state && { resource: chatUri(ref.sessionId), state, fromSeq };
			}
			default:
				return undefined;
		}
	}

	/** Returns the channel's canonical (published) URI if it exists. */
	resolve(channel: string): string | undefined {
		return this.snapshot(channel)?.resource;
	}

	/**
	 * Applies an action to the addressed channel and broadcasts it. Returns the
	 * envelope, or `undefined` if the channel does not exist.
	 */
	dispatch(channel: string, action: StateAction, origin?: ActionOrigin): ActionEnvelope | undefined {
		const exact = this.#exact.get(channel);
		if (exact) {
			this.#exact.set(channel, reduceExact(exact, action));
			return this.#emit(channel, action, origin);
		}
		const ref = parseChannel(channel);
		let resource: string;
		switch (ref.kind) {
			case "root":
				this.#root = rootReducer(this.#root, action as RootAction);
				resource = ROOT_CHANNEL;
				break;
			case "session": {
				const state = this.#sessions.get(ref.sessionId);
				if (!state) return undefined;
				this.#sessions.set(ref.sessionId, sessionReducer(state, action as SessionAction));
				resource = sessionUri(ref.sessionId);
				break;
			}
			case "chat": {
				const state = this.#chats.get(ref.sessionId);
				if (!state) return undefined;
				this.#chats.set(ref.sessionId, chatReducer(state, action as ChatAction));
				resource = chatUri(ref.sessionId);
				break;
			}
			default:
				return undefined;
		}
		return this.#emit(resource, action, origin);
	}

	#emit(channel: string, action: StateAction, origin: ActionOrigin | undefined): ActionEnvelope {
		const envelope: ActionEnvelope = { channel, action, serverSeq: ++this.#seq, origin };
		this.#remember(envelope);
		for (const listener of this.#listeners) listener(envelope);
		return envelope;
	}

	/**
	 * Allocates a sequence number for a rejected client action. The envelope is
	 * returned to the caller (sent only to the originating client) and does not
	 * touch state.
	 */
	reject(channel: string, action: StateAction, origin: ActionOrigin, reason: string): ActionEnvelope {
		return { channel, action, serverSeq: ++this.#seq, origin, rejectionReason: reason };
	}

	/** Envelopes after `lastSeenServerSeq`, or `undefined` if they are no longer retained. */
	replaySince(lastSeenServerSeq: number): ActionEnvelope[] | undefined {
		if (lastSeenServerSeq >= this.#seq) return [];
		const oldest = this.#replay[0]?.serverSeq;
		if (oldest === undefined || oldest > lastSeenServerSeq + 1) return undefined;
		return this.#replay.filter((envelope) => envelope.serverSeq > lastSeenServerSeq);
	}

	onEnvelope(listener: EnvelopeListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#remember(envelope: ActionEnvelope): void {
		this.#replay.push(envelope);
		if (this.#replay.length > this.#replayCapacity) {
			this.#replay.splice(0, this.#replay.length - this.#replayCapacity);
		}
	}
}
