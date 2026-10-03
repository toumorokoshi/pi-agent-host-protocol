import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT_CHANNEL = "ahp-root://";

/** The AHP agent provider id this host advertises. */
export const PROVIDER = "pi";

/**
 * URI shapes.
 *
 * VS Code does not use the host's published session/chat URIs verbatim: it
 * addresses a session as `<provider>:/<id>` and derives its default chat as
 * `ahp-chat://default/<base64url(sessionUri)>`. Rather than rewriting traffic
 * per connection, this host *publishes* exactly those shapes (AHP requires
 * clients to treat URIs as opaque, so other clients are unaffected) and
 * *accepts* both those and the spec's canonical `ahp-session:/<id>` /
 * `ahp-chat:/<id>` forms.
 */
export function sessionUri(id: string): string {
	return `${PROVIDER}:/${id}`;
}

export function chatUri(sessionId: string): string {
	return `ahp-chat://default/${Buffer.from(sessionUri(sessionId), "utf8").toString("base64url")}`;
}

const SESSION_URI = /^(?:ahp-session|pi):\/([^/?#]+)$/i;
const CANONICAL_CHAT_URI = /^ahp-chat:\/([^/?#]+)$/i;
const DERIVED_CHAT_URI = /^ahp-chat:\/\/[^/]+\/([^/?#]+)$/i;

/** Returns the session id addressed by a session URI, or `undefined`. */
export function parseSessionUri(uri: string): string | undefined {
	return SESSION_URI.exec(uri)?.[1];
}

/** Returns the id of the session owning a chat URI, or `undefined`. */
export function parseChatUri(uri: string): string | undefined {
	const derived = DERIVED_CHAT_URI.exec(uri)?.[1];
	if (derived) {
		return parseSessionUri(Buffer.from(derived, "base64url").toString("utf8"));
	}
	// A single default chat per session: the canonical chat id is the session id.
	return CANONICAL_CHAT_URI.exec(uri)?.[1];
}

export type ChannelRef =
	| { kind: "root" }
	| { kind: "session"; sessionId: string }
	| { kind: "chat"; sessionId: string }
	| { kind: "unknown" };

export function parseChannel(uri: string): ChannelRef {
	if (uri === ROOT_CHANNEL) return { kind: "root" };
	const sessionId = parseSessionUri(uri);
	if (sessionId) return { kind: "session", sessionId };
	const chatSessionId = parseChatUri(uri);
	if (chatSessionId) return { kind: "chat", sessionId: chatSessionId };
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
