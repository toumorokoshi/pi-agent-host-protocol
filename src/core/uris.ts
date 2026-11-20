import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT_CHANNEL = "ahp-root://";

/** The AHP agent provider id this host advertises. */
export const PROVIDER = "pi";

/**
 * URI shapes.
 *
 * VS Code does not use the host's published session/chat URIs verbatim: it
 * picks a session's URI when it creates the session and derives its default
 * chat as `ahp-chat://default/<base64url(sessionUri)>`. Older VS Code builds
 * address every session as `<provider>:/<id>`; current builds create sessions
 * on hosts they do not recognize as their own under the spec's canonical
 * `ahp-session:/<id>`. Rather than rewriting traffic per connection, this host
 * *publishes* each session under the scheme it was created with (`pi` for
 * sessions it did not create, such as pi's existing session files), so the
 * session and default chat URIs match what the creating client derived. It
 * *accepts* both session schemes and the canonical `ahp-chat:/<id>` form.
 */
export type SessionScheme = typeof PROVIDER | "ahp-session";

export function sessionUri(id: string, scheme: SessionScheme = PROVIDER): string {
	return `${scheme}:/${id}`;
}

export function chatUri(sessionId: string, scheme: SessionScheme = PROVIDER): string {
	return `ahp-chat://default/${Buffer.from(sessionUri(sessionId, scheme), "utf8").toString("base64url")}`;
}

/** A session's annotations channel: its session URI plus `/annotations`, as the spec suggests. */
export function annotationsUri(sessionId: string, scheme: SessionScheme = PROVIDER): string {
	return `${sessionUri(sessionId, scheme)}/annotations`;
}

const SESSION_URI = /^(ahp-session|pi):\/([^/?#]+)$/i;
const ANNOTATIONS_URI = /^(?:ahp-session|pi):\/([^/?#]+)\/annotations$/i;

/** Returns the scheme a session URI is spelled with, or `undefined` if `uri` is not a session URI. */
export function sessionSchemeOf(uri: string): SessionScheme | undefined {
	const scheme = SESSION_URI.exec(uri)?.[1]?.toLowerCase();
	return scheme === "ahp-session" ? "ahp-session" : scheme === PROVIDER ? PROVIDER : undefined;
}
const CANONICAL_CHAT_URI = /^ahp-chat:\/([^/?#]+)$/i;
// Only the `default` authority names a session's default chat. VS Code
// names other chats `ahp-chat://<chatId>/<base64url(sessionUri)>`: the state
// store's fork records resolve forked chats, and `subagentChatSession` reads
// the session of a subagent chat.
const DERIVED_CHAT_URI = /^ahp-chat:\/\/default\/([^/?#]+)$/i;

/** Returns the session id addressed by a session URI, or `undefined`. */
export function parseSessionUri(uri: string): string | undefined {
	return SESSION_URI.exec(uri)?.[2];
}

/**
 * A subagent chat's URI: the shape VS Code gives chats of a session
 * (`ahp-chat://<chat id>/<base64url(session URI)>`), so the owning session
 * can be read back from it. `chatId` keeps to lower-case letters, digits and
 * hyphens (see `subagentChatId`), since it is the URI's authority.
 */
export function subagentChatUri(sessionResource: string, chatId: string): string {
	return `ahp-chat://${chatId}/${Buffer.from(sessionResource, "utf8").toString("base64url")}`;
}

const SUBAGENT_CHAT_URI = /^ahp-chat:\/\/subagent-[a-z0-9-]+\/([A-Za-z0-9_-]+)$/;

/** The session URI a subagent chat's URI belongs to, or undefined if `uri` is not one. */
export function subagentChatSession(uri: string): string | undefined {
	const encoded = SUBAGENT_CHAT_URI.exec(uri)?.[1];
	return encoded ? Buffer.from(encoded, "base64url").toString("utf8") : undefined;
}

/** Returns the id of the session owning a chat URI, or `undefined`. */
export function parseChatUri(uri: string): string | undefined {
	const derived = DERIVED_CHAT_URI.exec(uri)?.[1];
	if (derived) {
		return parseSessionUri(Buffer.from(derived, "base64url").toString("utf8"));
	}
	// A session's default chat: the canonical chat id is the session id.
	return CANONICAL_CHAT_URI.exec(uri)?.[1];
}

/**
 * A chat of a session. `chatId` is the pi session backing it: the session's
 * own id for its default chat, another pi session's id for a forked chat. A
 * subagent chat has no pi session and no `PiSession`: its `chatId` is the
 * synthetic id `subagentChatId` makes, kept in the same store maps, so
 * `AgentHost` asks each `PiSession` whether it owns a chat that no
 * `PiSession` answers to (`ownsSubagentChat`).
 */
export type ChatRef = { kind: "chat"; sessionId: string; chatId: string };

export type ChannelRef =
	| { kind: "root" }
	| { kind: "session"; sessionId: string }
	| ChatRef
	| { kind: "annotations"; sessionId: string }
	| { kind: "unknown" };

/**
 * Resolves a URI by its shape alone. Forked chats have client-chosen URIs,
 * which only the state store can resolve (`StateStore.ref`).
 */
export function parseChannel(uri: string): ChannelRef {
	if (uri === ROOT_CHANNEL) return { kind: "root" };
	const sessionId = parseSessionUri(uri);
	if (sessionId) return { kind: "session", sessionId };
	const chatSessionId = parseChatUri(uri);
	if (chatSessionId) return { kind: "chat", sessionId: chatSessionId, chatId: chatSessionId };
	const annotationsSessionId = ANNOTATIONS_URI.exec(uri)?.[1];
	if (annotationsSessionId) return { kind: "annotations", sessionId: annotationsSessionId };
	return { kind: "unknown" };
}

export function fileUri(path: string): string {
	return pathToFileURL(path).href;
}

export function pathFromFileUri(uri: string): string | undefined {
	try {
		return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
	} catch {
		return undefined;
	}
}
