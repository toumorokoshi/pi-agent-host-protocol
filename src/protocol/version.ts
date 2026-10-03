import {
	AhpErrorCodes,
	isActionKnownToVersion,
	isNotificationKnownToVersion,
	negotiateProtocolVersion,
	type ProtocolNotificationMethod,
	type StateAction,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { ProtocolError } from "./jsonrpc.ts";

/** Version assumed for a client that reconnects without a prior `initialize` on this host. */
export const FALLBACK_PROTOCOL_VERSION = "0.9.0";

/**
 * Picks the protocol version for a connection. VS Code currently offers
 * `0.10.0, 0.9.0, ...`, which resolves to `0.9.0` against the 1.0.0/0.9.0
 * compatibility baselines shipped by `@microsoft/agent-host-protocol`.
 */
export function selectProtocolVersion(offered: unknown): string {
	if (!Array.isArray(offered) || !offered.every((v) => typeof v === "string")) {
		throw ProtocolError.invalidParams("protocolVersions must be an array of strings");
	}
	let selected: string | undefined;
	try {
		selected = negotiateProtocolVersion(offered);
	} catch (error) {
		throw ProtocolError.invalidParams(error instanceof Error ? error.message : String(error));
	}
	if (!selected) {
		throw new ProtocolError(AhpErrorCodes.UnsupportedProtocolVersion, "Unsupported protocol version", {
			supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
		});
	}
	return selected;
}

export function actionVisibleTo(action: StateAction, version: string): boolean {
	try {
		return isActionKnownToVersion(action, version);
	} catch {
		// Unknown action types (e.g. host `x-` extensions) are passed through.
		return true;
	}
}

export function notificationVisibleTo(method: ProtocolNotificationMethod, version: string): boolean {
	try {
		return isNotificationKnownToVersion(method, version);
	} catch {
		return true;
	}
}
