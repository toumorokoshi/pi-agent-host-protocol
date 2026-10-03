/**
 * pi extension loaded into every `pi --mode rpc` child (RPC backend only).
 *
 * pi's RPC protocol has no command that continues a run without a new user
 * message, so `chat/turnResume` sends the `/ahp-resume` command instead. It
 * appends a hidden marker message that triggers a new run, and a `context`
 * handler removes the marker and the failed reply in front of it from every
 * model request. The session file keeps both, the same way the embedded
 * backend's `context_edit` keeps the raw transcript.
 *
 * Self-contained on purpose: the user's installed `pi` loads this file, so it
 * must not import host modules.
 */

export const RESUME_COMMAND = "ahp-resume";
export const RESUME_MARKER = "ahp-resume";

interface MessageLike {
	role?: string;
	customType?: string;
	stopReason?: string;
}

interface ResumeExtensionApi {
	registerCommand(name: string, options: { description?: string; handler: () => Promise<void> | void }): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean },
	): void;
	on(event: "context", handler: (event: { messages: MessageLike[] }) => { messages: MessageLike[] } | undefined): void;
}

function isMarker(message: MessageLike | undefined): boolean {
	return message?.role === "custom" && message.customType === RESUME_MARKER;
}

/** Drops resume markers, and the errored assistant reply that each marker resumed after. */
export function omitResumedErrors<T extends MessageLike>(messages: readonly T[]): T[] {
	return messages.filter((message, index) => {
		if (isMarker(message)) return false;
		return !(message.role === "assistant" && message.stopReason === "error" && isMarker(messages[index + 1]));
	});
}

export default function ahpResume(pi: ResumeExtensionApi): void {
	pi.registerCommand(RESUME_COMMAND, {
		description: "Continue after a model-server error (used by pi-agent-host)",
		handler: () => {
			pi.sendMessage({ customType: RESUME_MARKER, content: "", display: false }, { triggerTurn: true });
		},
	});
	pi.on("context", (event) => {
		const messages = omitResumedErrors(event.messages);
		return messages.length === event.messages.length ? undefined : { messages };
	});
}
