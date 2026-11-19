/**
 * Review comments (annotations) a message refers to, as prompt text. VS Code's
 * Agents window keeps a session's comments on its annotations channel and
 * submits them as `/act-on-feedback` with one annotations attachment per
 * comment. VS Code's own host gives its agent tools to read them; pi has none,
 * so the host writes each comment into the prompt. See specs/annotations.md.
 */
import { isAbsolute, relative } from "node:path";
import {
	type Annotation,
	type AnnotationEntry,
	type Message,
	type MessageAnnotationsAttachment,
	MessageAttachmentKind,
	type TextRange,
} from "@microsoft/agent-host-protocol";
import { pathFromFileUri } from "../core/uris.ts";

/** The message VS Code sends when the user submits review comments. */
export const ACT_ON_FEEDBACK = "/act-on-feedback";
/** What pi is asked instead of `/act-on-feedback`, which it has no command for. */
export const ACT_ON_FEEDBACK_PROMPT = "Address the review comments below.";

/** VS Code's `displayKind` and `_meta` key for review-comment attachments. */
const FEEDBACK_DISPLAY_KIND = "agentFeedback";
const FEEDBACK_ATTACHMENT_META = "agentFeedback";
/** VS Code's `_meta` key on feedback annotations and their entries. */
const FEEDBACK_ANNOTATION_META = "vscode.agentFeedback";

const AUTHORS: Record<string, string> = { user: "user", agent: "agent", prReviewer: "PR reviewer" };

/** A comment as the attachment's `_meta` describes it, for when the channel does not have it. */
interface AttachedComment {
	id: string;
	text: string;
	resourceUri: string;
	range?: TextRange;
	replies?: string[];
}

export interface ReferencedComments {
	/** Ids of the unresolved annotations on the session's channel that the message refers to. */
	readonly ids: readonly string[];
	/** The comments as prompt text, or `undefined` when the message refers to none. */
	readonly text: string | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function attachedComments(attachment: MessageAnnotationsAttachment): AttachedComment[] {
	const items = record(attachment._meta?.[FEEDBACK_ATTACHMENT_META])?.feedbackItems;
	if (!Array.isArray(items)) return [];
	return items.flatMap((item) => {
		const fields = record(item);
		if (!fields || typeof fields.id !== "string" || typeof fields.text !== "string") return [];
		if (typeof fields.resourceUri !== "string") return [];
		const replies = Array.isArray(fields.replies) ? fields.replies.filter((reply) => typeof reply === "string") : [];
		return [
			{
				id: fields.id,
				text: fields.text,
				resourceUri: fields.resourceUri,
				...(record(fields.range) ? { range: fields.range as TextRange } : {}),
				...(replies.length > 0 ? { replies } : {}),
			},
		];
	});
}

/** A file and line range as the model sees it: relative to the session's folder when inside it. */
function location(resource: string, range: TextRange | undefined, cwd: string): string {
	const path = pathFromFileUri(resource);
	const shown = path ? relative(cwd, path) : resource;
	const file = path && shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown : (path ?? resource);
	if (!range) return file;
	const start = range.start.line + 1;
	const end = range.end.line + 1;
	return start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
}

function entryText(entry: AnnotationEntry): string {
	return typeof entry.text === "string" ? entry.text : entry.text.markdown;
}

function entryAuthor(entry: AnnotationEntry): string | undefined {
	const author = record(entry._meta?.[FEEDBACK_ANNOTATION_META])?.author;
	return typeof author === "string" ? AUTHORS[author] : undefined;
}

function labelled(label: string, author: string | undefined, text: string): string {
	return `${label}${author ? ` (${author})` : ""}: ${text}`;
}

function fenced(label: string, language: string, text: string): string {
	return `${label}:\n\`\`\`${language}\n${text}\n\`\`\``;
}

function annotationBlock(annotation: Annotation, cwd: string): string {
	const meta = record(annotation._meta?.[FEEDBACK_ANNOTATION_META]);
	const lines = [location(annotation.resource, annotation.range, cwd)];
	if (typeof meta?.codeSelection === "string" && meta.codeSelection) {
		lines.push(fenced("Selection", "", meta.codeSelection));
	}
	if (typeof meta?.diffHunks === "string" && meta.diffHunks) lines.push(fenced("Diff", "diff", meta.diffHunks));
	annotation.entries.forEach((entry, index) => {
		lines.push(labelled(index === 0 ? "Comment" : "Reply", entryAuthor(entry), entryText(entry)));
	});
	return lines.join("\n");
}

function attachedBlock(comment: AttachedComment, cwd: string): string {
	const lines = [location(comment.resourceUri, comment.range, cwd), labelled("Comment", undefined, comment.text)];
	for (const reply of comment.replies ?? []) lines.push(labelled("Reply", undefined, reply));
	return lines.join("\n");
}

/**
 * The review comments `message` attaches. Each annotations attachment names
 * comments on `channel` by id (all unresolved ones when it names none); a
 * comment the channel does not have is read from the attachment's `_meta`.
 */
export function referencedComments(
	message: Message,
	channel: string,
	annotations: readonly Annotation[],
	cwd: string,
): ReferencedComments {
	const ids: string[] = [];
	const blocks: string[] = [];
	const seen = new Set<string>();
	for (const attachment of message.attachments ?? []) {
		if (attachment.type !== MessageAttachmentKind.Annotations) continue;
		const own = attachment.resource === channel;
		const attached = attachedComments(attachment);
		const wanted =
			attachment.annotationIds ??
			(own ? annotations.filter((annotation) => !annotation.resolved).map((annotation) => annotation.id) : []);
		for (const id of wanted) {
			if (seen.has(id)) continue;
			seen.add(id);
			const annotation = own ? annotations.find((candidate) => candidate.id === id) : undefined;
			if (annotation) {
				if (!annotation.resolved) ids.push(id);
				blocks.push(annotationBlock(annotation, cwd));
				continue;
			}
			const comment = attached.find((candidate) => candidate.id === id);
			if (comment) blocks.push(attachedBlock(comment, cwd));
		}
	}
	return {
		ids,
		text: blocks.length > 0 ? ["Review comments:", ...blocks].join("\n\n") : undefined,
	};
}

/** True when `message` is VS Code's submit of review comments, which pi has no command for. */
export function isActOnFeedback(message: Message): boolean {
	return (
		message.text.trim() === ACT_ON_FEEDBACK &&
		(message.attachments ?? []).some((attachment) => attachment.displayKind === FEEDBACK_DISPLAY_KIND)
	);
}
