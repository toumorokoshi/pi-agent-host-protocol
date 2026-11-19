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

const SESSION_URI = /^(ahp-session|pi):\/([^/?#]+)$/i;

/** Returns the scheme a session URI is spelled with, or `undefined` if `uri` is not a session URI. */
export function sessionSchemeOf(uri: string): SessionScheme | undefined {
	const scheme = SESSION_URI.exec(uri)?.[1]?.toLowerCase();
	return scheme === "ahp-session" ? "ahp-session" : scheme === PROVIDER ? PROVIDER : undefined;
}
const CANONICAL_CHAT_URI = /^ahp-chat:\/([^/?#]+)$/i;
// Only the `default` authority names a session's default chat. VS Code
// names other chats `ahp-chat://<chatId>/<base64url(sessionUri)>`, which
// only the state store's fork records resolve.
const DERIVED_CHAT_URI = /^ahp-chat:\/\/default\/([^/?#]+)$/i;

/** Returns the session id addressed by a session URI, or `undefined`. */
export function parseSessionUri(uri: string): string | undefined {
	return SESSION_URI.exec(uri)?.[2];
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
 * own id for its default chat, another pi session's id for a forked chat.
 */
export type ChatRef = { kind: "chat"; sessionId: string; chatId: string };

export type ChannelRef = { kind: "root" } | { kind: "session"; sessionId: string } | ChatRef | { kind: "unknown" };

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
