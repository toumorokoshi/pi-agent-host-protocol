/**
 * pi extension dialogs (`ctx.ui.select`, `confirm`, `input`, `editor`) as
 * AHP chat input requests, and the answers back. See specs/extension-dialogs.md.
 */
import {
	type ChatInputAnswer,
	ChatInputAnswerState,
	ChatInputAnswerValueKind,
	type ChatInputQuestion,
	ChatInputQuestionKind,
	type ChatInputRequest,
	ChatInputResponseKind,
} from "@microsoft/agent-host-protocol";

/** A dialog an extension opened, as pi's RPC mode sends it (`extension_ui_request`). */
export type PiDialog =
	| { id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { id: string; method: "editor"; title: string; prefill?: string; timeout?: number };

/** pi's answer to a dialog (`extension_ui_response` without its type and id). */
export type PiDialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export type NotifyLevel = "info" | "warning" | "error";

/** Extension UI a pi agent asks the host for. */
export interface PiUiHandler {
	/**
	 * Shows a dialog and resolves with the user's answer, or returns
	 * `undefined` when it cannot be shown now; pi then gets `cancelled`.
	 */
	dialog(dialog: PiDialog): Promise<PiDialogAnswer> | undefined;
	notify(message: string, level: NotifyLevel): void;
}

export const CANCELLED: PiDialogAnswer = { cancelled: true };

/** The single question of every dialog's input request. */
export const ANSWER_ID = "answer";

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const positive = (value: unknown): number | undefined => (typeof value === "number" && value > 0 ? value : undefined);

/** Reads a dialog from an `extension_ui_request` record, or `undefined` if it is not a well-formed dialog. */
export function parseDialog(record: Record<string, unknown>): PiDialog | undefined {
	const { id, method, title } = record;
	if (typeof id !== "string" || typeof title !== "string") return undefined;
	const timeout = positive(record.timeout);
	const common = { id, title, ...(timeout ? { timeout } : {}) };
	switch (method) {
		case "select":
			return Array.isArray(record.options) && record.options.every((option) => typeof option === "string")
				? { ...common, method, options: record.options }
				: undefined;
		case "confirm":
			return { ...common, method, message: optionalString(record.message) ?? "" };
		case "input": {
			const placeholder = optionalString(record.placeholder);
			return { ...common, method, ...(placeholder ? { placeholder } : {}) };
		}
		case "editor": {
			const prefill = optionalString(record.prefill);
			return { ...common, method, ...(prefill ? { prefill } : {}) };
		}
		default:
			return undefined;
	}
}

function question(dialog: PiDialog): ChatInputQuestion {
	const base = { id: ANSWER_ID, title: dialog.title, required: true };
	switch (dialog.method) {
		case "select":
			return {
				...base,
				kind: ChatInputQuestionKind.SingleSelect,
				message: "",
				options: dialog.options.map((label, index) => ({ id: String(index), label })),
				allowFreeformInput: false,
			};
		case "confirm":
			return { ...base, kind: ChatInputQuestionKind.Boolean, message: dialog.message };
		case "input":
			return { ...base, kind: ChatInputQuestionKind.Text, message: dialog.placeholder ?? "" };
		case "editor":
			return {
				...base,
				kind: ChatInputQuestionKind.Text,
				message: "",
				...(dialog.prefill ? { defaultValue: dialog.prefill } : {}),
			};
	}
}

/** The input request that asks a dialog's question, under pi's request id. */
export function dialogRequest(dialog: PiDialog): ChatInputRequest {
	return { id: dialog.id, questions: [question(dialog)] };
}

/**
 * pi's answer from how the user completed the request: anything but an
 * accepted, submitted answer of the expected kind is `cancelled`, which
 * pi treats as dismissing the dialog.
 */
export function dialogAnswer(
	dialog: PiDialog,
	response: ChatInputResponseKind,
	answers: Readonly<Record<string, ChatInputAnswer>> | undefined,
): PiDialogAnswer {
	const answer = answers?.[ANSWER_ID];
	if (response !== ChatInputResponseKind.Accept || answer?.state !== ChatInputAnswerState.Submitted) return CANCELLED;
	const { value } = answer;
	switch (dialog.method) {
		case "select": {
			const option =
				value.kind === ChatInputAnswerValueKind.Selected && /^\d+$/.test(value.value)
					? dialog.options[Number(value.value)]
					: undefined;
			return option === undefined ? CANCELLED : { value: option };
		}
		case "confirm":
			return value.kind === ChatInputAnswerValueKind.Boolean ? { confirmed: value.value } : CANCELLED;
		case "input":
		case "editor":
			return value.kind === ChatInputAnswerValueKind.Text ? { value: value.value } : CANCELLED;
	}
}

/** A notification as markdown in the chat, marked when it is a warning or an error. */
export function noticeMarkdown(message: string, level: NotifyLevel): string {
	if (level === "warning") return `**Warning:** ${message}`;
	if (level === "error") return `**Error:** ${message}`;
	return message;
}

export function notifyLevel(value: unknown): NotifyLevel {
	return value === "warning" || value === "error" ? value : "info";
}
