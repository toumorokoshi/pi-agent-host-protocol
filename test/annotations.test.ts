import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type Annotation,
	type Message,
	type MessageAnnotationsAttachment,
	MessageAttachmentKind,
	MessageKind,
} from "@microsoft/agent-host-protocol";
import { annotationsUri, fileUri, parseChannel } from "../src/core/uris.ts";
import {
	annotationStorePath,
	fileAnnotationStore,
	parseAnnotations,
	serializeAnnotations,
} from "../src/host/annotation-store.ts";
import { ACT_ON_FEEDBACK_PROMPT, isActOnFeedback, referencedComments } from "../src/pi/annotations.ts";
import { newSession, PI_MODES, startHost, TestClient, type TestHost } from "./helpers.ts";

const CWD = "/work/repo";
const CHANNEL = "pi:/s1/annotations";

/** A review comment as VS Code's annotations backend writes it (`feedbackToAnnotation`). */
function comment(id: string, options: { path?: string; resolved?: boolean; replies?: string[] } = {}): Annotation {
	return {
		id,
		origin: { session: "pi:/s1" },
		resource: fileUri(options.path ?? `${CWD}/src/app.ts`),
		range: { start: { line: 2, character: 0 }, end: { line: 3, character: 5 } },
		resolved: options.resolved ?? false,
		entries: [
			{ id: `${id}:0`, text: "Rename this", _meta: { "vscode.agentFeedback": { author: "user" } } },
			...(options.replies ?? []).map((text, index) => ({
				id: `${id}:r${index}`,
				text,
				_meta: { "vscode.agentFeedback": { author: "agent" } },
			})),
		],
		_meta: {
			"vscode.agentFeedback": {
				kind: "user",
				state: "accepted",
				sessionResource: "pi:/s1",
				codeSelection: "const x = 1;",
			},
		},
	};
}

/** VS Code's submit attachment for one comment (`_toAgentFeedbackAttachment`). */
function submitted(id: string, resource = CHANNEL, meta?: Record<string, unknown>): MessageAnnotationsAttachment {
	return {
		type: MessageAttachmentKind.Annotations,
		label: "1 comment",
		displayKind: "agentFeedback",
		resource,
		annotationIds: [id],
		...(meta ? { _meta: { agentFeedback: { sessionResource: "pi:/s1", feedbackItems: [meta] } } } : {}),
	};
}

function message(text: string, attachments: MessageAnnotationsAttachment[]): Message {
	return { text, origin: { kind: MessageKind.User }, attachments };
}

describe("annotations channel URIs", () => {
	test("a session's annotations channel is its URI plus /annotations, in either scheme", () => {
		assert.equal(annotationsUri("s1"), "pi:/s1/annotations");
		assert.equal(annotationsUri("s1", "ahp-session"), "ahp-session:/s1/annotations");
		assert.deepEqual(parseChannel("ahp-session:/s1/annotations"), { kind: "annotations", sessionId: "s1" });
		assert.deepEqual(parseChannel("pi:/s1/annotations"), { kind: "annotations", sessionId: "s1" });
		assert.deepEqual(parseChannel("pi:/s1/other"), { kind: "unknown" });
	});
});

describe("annotation store", () => {
	test("serializes sessions with annotations and drops malformed ones on parse", () => {
		const sessions = new Map([
			["b", [comment("c2")]],
			["a", [comment("c1")]],
		]);
		const text = serializeAnnotations(sessions);
		assert.deepEqual(Object.keys(JSON.parse(text).sessions), ["a", "b"]);
		assert.deepEqual(
			[...parseAnnotations(text)],
			[...sessions].sort(([a], [b]) => a.localeCompare(b)),
		);
		const malformed = JSON.stringify({ version: 1, sessions: { a: [{ id: 1 }, comment("ok")], b: "x" } });
		assert.deepEqual([...parseAnnotations(malformed)], [["a", [comment("ok")]]]);
		assert.deepEqual([...parseAnnotations("not json")], []);
	});

	test("file store persists annotations and reloads them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-annotations-"));
		try {
			const path = annotationStorePath(join(dir, "settings.json"));
			assert.equal(path, join(dir, "annotations.json"));
			const first = await fileAnnotationStore(path);
			first.setAnnotations("s1", [comment("c1")]);
			first.setAnnotations("s2", [comment("c2")]);
			first.setAnnotations("s2", []);
			await first.flush();
			const second = await fileAnnotationStore(path);
			assert.deepEqual(second.annotationsOf("s1"), [comment("c1")]);
			assert.deepEqual(second.annotationsOf("s2"), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("review comments in prompts", () => {
	test("writes each referenced comment with its file, lines, selection and thread", () => {
		const annotations = [comment("c1", { replies: ["Done?"] }), comment("c2")];
		const result = referencedComments(message("/act-on-feedback", [submitted("c1")]), CHANNEL, annotations, CWD);
		assert.deepEqual(result.ids, ["c1"]);
		assert.equal(
			result.text,
			[
				"Review comments:",
				"src/app.ts:3-4\nSelection:\n```\nconst x = 1;\n```\nComment (user): Rename this\nReply (agent): Done?",
			].join("\n\n"),
		);
	});

	test("an attachment without ids refers to every unresolved comment on the channel", () => {
		const annotations = [comment("c1"), comment("c2", { resolved: true }), comment("c3")];
		const all = { ...submitted("x"), annotationIds: undefined };
		assert.deepEqual(referencedComments(message("go", [all]), CHANNEL, annotations, CWD).ids, ["c1", "c3"]);
	});

	test("reads a comment the channel does not have from the attachment", () => {
		const meta = {
			id: "gone",
			text: "Fix the typo",
			resourceUri: fileUri("/elsewhere/README.md"),
			range: { start: { line: 9, character: 0 }, end: { line: 9, character: 4 } },
			replies: ["Which one?"],
		};
		const result = referencedComments(message("go", [submitted("gone", CHANNEL, meta)]), CHANNEL, [], CWD);
		assert.deepEqual(result.ids, [], "nothing on the channel to resolve");
		assert.equal(result.text, "Review comments:\n\n/elsewhere/README.md:10\nComment: Fix the typo\nReply: Which one?");
	});

	test("ignores another session's channel except through the attachment, and repeats", () => {
		const attachments = [submitted("c1", "pi:/other/annotations"), submitted("c2"), submitted("c2")];
		const result = referencedComments(message("go", attachments), CHANNEL, [comment("c1"), comment("c2")], CWD);
		assert.deepEqual(result.ids, ["c2"]);
		assert.equal(result.text?.split("Comment (user)").length, 2, "c2 appears once and c1 not at all");
	});

	test("recognizes VS Code's submit message only with a review-comment attachment", () => {
		assert.ok(isActOnFeedback(message(" /act-on-feedback ", [submitted("c1")])));
		assert.ok(!isActOnFeedback(message("/act-on-feedback", [])));
		assert.ok(!isActOnFeedback(message("please /act-on-feedback", [submitted("c1")])));
	});
});

function userText(context: Context): string {
	const user = context.messages.findLast((entry) => entry.role === "user");
	const content = user?.content;
	return typeof content === "string"
		? content
		: (content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
}

for (const mode of PI_MODES) {
	describe(`annotations channel (${mode})`, () => {
		let host: TestHost;
		let client: TestClient;

		before(async () => {
			host = await startHost({ mode });
			client = await TestClient.connect(host.url);
			await client.initialize();
		});

		after(async () => {
			client.close();
			await host.cleanup();
		});

		const complete = (turnId: string) =>
			client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
		const submit = (chat: string, channel: string, id: string) => {
			const turnId = crypto.randomUUID();
			client.dispatch(chat, {
				type: "chat/turnStarted",
				turnId,
				startedAt: new Date().toISOString(),
				message: message("/act-on-feedback", [submitted(id, channel)]),
			});
			return turnId;
		};

		test("advertises the channel and keeps comments clients add", async () => {
			const { session } = await newSession(host, client);
			const channel = `${session}/annotations`;
			assert.deepEqual(client.sessions.get(session)?.annotations, {
				resource: channel,
				annotationCount: 0,
				entryCount: 0,
			});
			await client.subscribe(channel);
			const seq = client.dispatch(channel, {
				type: "annotations/set",
				annotation: comment("c1", { path: join(host.cwd, "src/app.ts"), replies: ["ok"] }),
			});
			const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === seq);
			assert.equal(echo.params.rejectionReason, undefined);
			const notice = await client.waitFor(
				(m) => m.method === "root/sessionSummaryChanged" && m.params.changes.annotations?.annotationCount === 1,
			);
			assert.deepEqual(notice.params.changes.annotations, { resource: channel, annotationCount: 1, entryCount: 2 });
			assert.deepEqual(
				client.annotations.get(channel)?.annotations.map((annotation) => annotation.id),
				["c1"],
			);
		});

		test("rejects actions that are not annotations actions", async () => {
			const { session } = await newSession(host, client);
			const seq = client.dispatch(`${session}/annotations`, { type: "session/isReadChanged", isRead: true });
			const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === seq);
			assert.match(echo.params.rejectionReason, /Unsupported action/);
		});

		test("submitted comments reach the model, and a completed turn resolves them", async () => {
			const { session, chat } = await newSession(host, client);
			const channel = `${session}/annotations`;
			await client.subscribe(channel);
			client.dispatch(channel, {
				type: "annotations/set",
				annotation: comment("c1", { path: join(host.cwd, "src/app.ts") }),
			});
			client.dispatch(channel, {
				type: "annotations/set",
				annotation: comment("c2", { path: join(host.cwd, "lib.ts") }),
			});
			let prompt = "";
			host.faux.setResponses([
				(context) => {
					prompt = userText(context);
					return fauxAssistantMessage("Renamed.");
				},
			]);
			await complete(submit(chat, channel, "c1"));
			assert.ok(prompt.startsWith(`${ACT_ON_FEEDBACK_PROMPT}\n\nReview comments:\n\nsrc/app.ts:3-4\n`), prompt);
			assert.ok(prompt.includes("Comment (user): Rename this"), prompt);
			assert.ok(!prompt.includes("lib.ts"), "only the submitted comment");
			await client.waitFor(
				(m) =>
					m.method === "action" &&
					m.params.channel === channel &&
					m.params.action.type === "annotations/updated" &&
					m.params.action.annotationId === "c1",
			);
			const resolved = client.annotations
				.get(channel)
				?.annotations.map((annotation) => [annotation.id, annotation.resolved]);
			assert.deepEqual(resolved, [
				["c1", true],
				["c2", false],
			]);
		});

		test("a failed turn leaves its comments open", async () => {
			const { session, chat } = await newSession(host, client);
			const channel = `${session}/annotations`;
			await client.subscribe(channel);
			client.dispatch(channel, { type: "annotations/set", annotation: comment("c1") });
			host.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
			const turnId = submit(chat, channel, "c1");
			await client.waitFor((m) => m.params?.action?.type === "chat/error" && m.params.action.turnId === turnId);
			assert.equal(client.annotations.get(channel)?.annotations[0]?.resolved, false);
		});
	});
}

describe("annotations persistence", () => {
	test("a restarted host serves a saved session's comments, loading the session", async () => {
		const first = await startHost({ mode: "embedded" });
		const client = await TestClient.connect(first.url);
		await client.initialize();
		const { session, chat } = await newSession(first, client);
		const channel = `${session}/annotations`;
		await client.subscribe(channel);
		client.dispatch(channel, { type: "annotations/set", annotation: comment("c1") });
		first.faux.setResponses([fauxAssistantMessage("Hi.")]);
		const turnId = crypto.randomUUID();
		client.dispatch(chat, {
			type: "chat/turnStarted",
			turnId,
			startedAt: new Date().toISOString(),
			message: { text: "hello", origin: { kind: MessageKind.User } },
		});
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
		client.close();
		await first.stop();

		const second = await startHost({ mode: "embedded", dir: first.dir });
		try {
			const again = await TestClient.connect(second.url);
			await again.initialize();
			const listed = await again.request("listSessions", {});
			const summary = listed.items.find((item: { resource: string }) => item.resource === session);
			assert.deepEqual(summary?.annotations, { resource: channel, annotationCount: 1, entryCount: 1 });
			const snapshot = await again.subscribe(channel);
			assert.deepEqual(snapshot.state, { annotations: [comment("c1")] });
			again.close();
		} finally {
			await second.cleanup();
		}
	});
});
