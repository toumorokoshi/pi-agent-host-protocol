import type { ToolResultContent } from "@microsoft/agent-host-protocol";
import { ToolResultContentType } from "@microsoft/agent-host-protocol";

/** Tool output beyond this many characters is truncated in protocol state. */
const MAX_TEXT_CHARS = 64 * 1024;

type Args = Record<string, unknown> | undefined;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function code(text: string): string {
	const oneLine = text.split("\n")[0] ?? "";
	const shown = oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
	return `\`${shown.replaceAll("`", "'")}\``;
}

interface ToolLabels {
	displayName: string;
	invocation: string;
	pastTense: string;
}

/** Human-readable labels for pi's built-in tools; other tools get generic ones. */
export function toolLabels(toolName: string, args: Args): ToolLabels {
	const path = str(args?.path) ?? str(args?.file_path);
	const pattern = str(args?.pattern);
	switch (toolName) {
		case "read":
			return { displayName: "Read", invocation: `Reading ${path ?? "file"}`, pastTense: `Read ${path ?? "file"}` };
		case "write":
			return { displayName: "Write", invocation: `Writing ${path ?? "file"}`, pastTense: `Wrote ${path ?? "file"}` };
		case "edit":
			return { displayName: "Edit", invocation: `Editing ${path ?? "file"}`, pastTense: `Edited ${path ?? "file"}` };
		case "bash": {
			const command = str(args?.command);
			return {
				displayName: "Bash",
				invocation: command ? `Running ${code(command)}` : "Running command",
				pastTense: command ? `Ran ${code(command)}` : "Ran command",
			};
		}
		case "grep":
			return {
				displayName: "Grep",
				invocation: `Searching for ${pattern ? code(pattern) : "pattern"}`,
				pastTense: `Searched for ${pattern ? code(pattern) : "pattern"}`,
			};
		case "find":
			return {
				displayName: "Find",
				invocation: `Finding ${pattern ? code(pattern) : "files"}`,
				pastTense: `Found ${pattern ? code(pattern) : "files"}`,
			};
		case "ls":
			return {
				displayName: "List",
				invocation: `Listing ${path ?? "directory"}`,
				pastTense: `Listed ${path ?? "directory"}`,
			};
		default:
			return { displayName: toolName, invocation: `Running ${toolName}`, pastTense: `Ran ${toolName}` };
	}
}

/**
 * Plain-text form of a tool's invocation label, for activity text. Clients
 * render activity as plain text, so the inline-code backticks are dropped.
 */
export function toolActivity(toolName: string, args: Args): string {
	return toolLabels(toolName, args).invocation.replaceAll("`", "");
}

export function toolInputText(args: unknown): string {
	try {
		return JSON.stringify(args ?? {});
	} catch {
		return String(args);
	}
}

function truncate(text: string): string {
	return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated)` : text;
}

/** Converts pi tool result content (`{ content: (Text|Image)[] }`) to AHP tool result content. */
export function toolResultContent(result: unknown): ToolResultContent[] {
	const blocks = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(blocks)) return [];
	const out: ToolResultContent[] = [];
	for (const block of blocks) {
		if (block?.type === "text" && typeof block.text === "string") {
			out.push({ type: ToolResultContentType.Text, text: truncate(block.text) });
		} else if (block?.type === "image" && typeof block.data === "string") {
			out.push({
				type: ToolResultContentType.EmbeddedResource,
				data: block.data,
				contentType: block.mimeType ?? "image/png",
			});
		}
	}
	return out;
}

export function firstText(content: ToolResultContent[]): string | undefined {
	for (const block of content) {
		if (block.type === ToolResultContentType.Text) return block.text;
	}
	return undefined;
}
