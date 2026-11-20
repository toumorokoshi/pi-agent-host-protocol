import {
	type ActionEnvelope,
	type ActionOrigin,
	type Annotation,
	type AnnotationsAction,
	type AnnotationsState,
	type AnnotationsSummary,
	annotationsReducer,
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
import {
	annotationsUri,
	type ChannelRef,
	type ChatRef,
	chatUri,
	PROVIDER,
	parseChannel,
	ROOT_CHANNEL,
	type SessionScheme,
	sessionUri,
} from "./uris.ts";

const DEFAULT_REPLAY_CAPACITY = 10_000;

export type EnvelopeListener = (envelope: ActionEnvelope) => void;

/** The scheme a session is published under (see `uris.ts`). */
export type SessionSchemeOf = (sessionId: string) => SessionScheme;

/** Channels addressed by their exact URI rather than a session id. */
export type ExactChannel =
	| { kind: "terminal"; state: TerminalState }
	| { kind: "resourceWatch"; state: ResourceWatchState };

function reduceExact(channel: ExactChannel, action: StateAction): ExactChannel {
	return channel.kind === "terminal"
		? { kind: "terminal", state: terminalReducer(channel.state, action as TerminalAction) }
		: { kind: "resourceWatch", state: resourceWatchReducer(channel.state, action as ResourceWatchAction) };
}

/** The counts clients show for a session's annotations channel at `resource`. */
export function annotationsSummary(resource: string, annotations: readonly Annotation[]): AnnotationsSummary {
	return {
		resource,
		annotationCount: annotations.length,
		entryCount: annotations.reduce((count, annotation) => count + annotation.entries.length, 0),
	};
}

/**
 * Authoritative protocol state. Every mutation goes through the shared AHP
 * reducers so the host's state is exactly what clients reconstruct, and every
 * applied action is stamped with a host-wide `serverSeq`.
 */
export class StateStore {
	#root: RootState;
	readonly #sessions = new Map<string, SessionState>();
	/** Chats by the id of the pi session backing them (`ChatRef.chatId`). */
	readonly #chats = new Map<string, ChatState>();
	/** Forked chats: their client-chosen URIs, and the reverse. */
	readonly #forkRefs = new Map<string, ChatRef>();
	readonly #forkUris = new Map<string, string>();
	/** Each session's annotations channel, by session id. */
	readonly #annotations = new Map<string, AnnotationsState>();
	readonly #exact = new Map<string, ExactChannel>();
	readonly #listeners = new Set<EnvelopeListener>();
	readonly #replay: ActionEnvelope[] = [];
	readonly #replayCapacity: number;
	readonly #schemeOf: SessionSchemeOf;
	#seq = 0;

	constructor(root: RootState, replayCapacity = DEFAULT_REPLAY_CAPACITY, schemeOf: SessionSchemeOf = () => PROVIDER) {
		this.#root = root;
		this.#replayCapacity = replayCapacity;
		this.#schemeOf = schemeOf;
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

	/**
	 * The chat with id `chatId`: the pi session backing it (for a default
	 * chat, the session's id), or a subagent chat's synthetic id (see `ChatRef`).
	 */
	chat(chatId: string): ChatState | undefined {
		return this.#chats.get(chatId);
	}

	sessionIds(): string[] {
		return [...this.#sessions.keys()];
	}

	/**
	 * Registers a new session, its default chat and its annotations channel
	 * without emitting actions. The session state gets the channel's summary.
	 */
	addSession(id: string, session: SessionState, chat: ChatState, annotations: readonly Annotation[] = []): void {
		this.#sessions.set(id, { ...session, annotations: annotationsSummary(this.annotationsResource(id), annotations) });
		this.#chats.set(id, chat);
		this.#annotations.set(id, { annotations: [...annotations] });
	}

	/** A session's annotations channel state. */
	annotations(sessionId: string): AnnotationsState | undefined {
		return this.#annotations.get(sessionId);
	}

	/** The URI a session's annotations channel is published at. */
	annotationsResource(sessionId: string): string {
		return annotationsUri(sessionId, this.#schemeOf(sessionId));
	}

	/**
	 * Registers a forked chat, or a subagent chat (no pi session behind it),
	 * at its URI without emitting actions; the owner announces it with
	 * `session/chatAdded`.
	 */
	addForkedChat(ref: ChatRef, uri: string, chat: ChatState): void {
		this.#chats.set(ref.chatId, chat);
		this.#forkRefs.set(uri, ref);
		this.#forkUris.set(ref.chatId, uri);
	}

	/** Removes a session with its default and forked chats. */
	removeSession(id: string): void {
		this.#sessions.delete(id);
		this.#chats.delete(id);
		this.#annotations.delete(id);
		for (const [uri, ref] of this.#forkRefs) {
			if (ref.sessionId !== id) continue;
			this.#chats.delete(ref.chatId);
			this.#forkRefs.delete(uri);
			this.#forkUris.delete(ref.chatId);
		}
	}

	/** Resolves a URI, forked chats' client-chosen URIs included. */
	ref(uri: string): ChannelRef {
		return this.#forkRefs.get(uri) ?? parseChannel(uri);
	}

	/** The URI a session is published at. */
	sessionResource(sessionId: string): string {
		return sessionUri(sessionId, this.#schemeOf(sessionId));
	}

	/** The URI a session's default chat is published at. */
	defaultChatResource(sessionId: string): string {
		return chatUri(sessionId, this.#schemeOf(sessionId));
	}

	/** The URI a chat is published at. */
	chatResource(ref: ChatRef): string {
		return this.#forkUris.get(ref.chatId) ?? this.defaultChatResource(ref.sessionId);
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

	setChatTitle(id: string, title: string): void {
		const state = this.#chats.get(id);
		if (state && state.title !== title) this.#chats.set(id, { ...state, title });
	}

	snapshot(channel: string): Snapshot | undefined {
		const fromSeq = this.#seq;
		const exact = this.#exact.get(channel);
		if (exact) return { resource: channel, state: exact.state, fromSeq };
		const ref = this.ref(channel);
		switch (ref.kind) {
			case "root":
				return { resource: ROOT_CHANNEL, state: this.#root, fromSeq };
			case "session": {
				const state = this.#sessions.get(ref.sessionId);
				return state && { resource: this.sessionResource(ref.sessionId), state, fromSeq };
			}
			case "chat": {
				const state = this.#chats.get(ref.chatId);
				return state && { resource: this.chatResource(ref), state, fromSeq };
			}
			case "annotations": {
				const state = this.#annotations.get(ref.sessionId);
				return state && { resource: this.annotationsResource(ref.sessionId), state, fromSeq };
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
		const ref = this.ref(channel);
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
				resource = this.sessionResource(ref.sessionId);
				break;
			}
			case "chat": {
				const state = this.#chats.get(ref.chatId);
				if (!state) return undefined;
				this.#chats.set(ref.chatId, chatReducer(state, action as ChatAction));
				resource = this.chatResource(ref);
				break;
			}
			case "annotations": {
				const state = this.#annotations.get(ref.sessionId);
				if (!state) return undefined;
				const next = annotationsReducer(state, action as AnnotationsAction);
				this.#annotations.set(ref.sessionId, next);
				resource = this.annotationsResource(ref.sessionId);
				// AHP has no action that sets `SessionState.annotations`; clients follow it through the root summary.
				const session = this.#sessions.get(ref.sessionId);
				if (session)
					this.#sessions.set(ref.sessionId, {
						...session,
						annotations: annotationsSummary(resource, next.annotations),
					});
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
