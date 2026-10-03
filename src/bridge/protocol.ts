/**
 * The host ⇄ TUI bridge protocol. Over a unix socket, the bridge extension
 * in an interactive `pi` speaks pi's own RPC protocol (commands from the
 * host; responses and wire-form session events from pi), plus two requests
 * of its own, `attach` and `detach`, that tell the host which session the
 * pi process currently has open. See specs/live-tui-sessions.md.
 */
import { dirname, join } from "node:path";

export const BRIDGE_PROTOCOL = 1;

/** Bridge → host request: this pi process now has `sessionId` open. */
export interface AttachRequest {
	type: "attach";
	protocol: number;
	pid: number;
	sessionId: string;
	/** pi writes the file lazily, so it may not exist yet. */
	sessionFile?: string;
	cwd: string;
	name?: string;
}

/** Host's answer to `attach`. */
export interface AttachResult {
	/** The URL to add to VS Code, when the host is listening. */
	url?: string;
}

/** Bridge → host request: this pi process no longer shares `sessionId`. */
export interface DetachRequest {
	type: "detach";
	sessionId: string;
}

/** Host → bridge command (in addition to pi's RPC commands): the live branch of the session. */
export interface GetBranchCommand {
	type: "get_branch";
}

/** The bridge socket, next to the host's settings file. */
export function bridgeSocketPath(settingsFile: string): string {
	return join(dirname(settingsFile), "host.sock");
}
