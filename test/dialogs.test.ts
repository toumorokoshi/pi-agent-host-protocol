import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type ChatInputAnswer,
	ChatInputAnswerState,
	type ChatInputAnswerValue,
	ChatInputAnswerValueKind,
	ChatInputQuestionKind,
	ChatInputResponseKind,
	type ResponsePart,
	SessionStatus,
} from "@microsoft/agent-host-protocol";
import { silentLogger } from "../src/core/logger.ts";
import {
	ANSWER_ID,
	CANCELLED,
	dialogAnswer,
	dialogRequest,
	noticeMarkdown,
	notifyLevel,
	type PiDialog,
	type PiDialogAnswer,
	parseDialog,
} from "../src/pi/dialogs.ts";
import { RpcAgent } from "../src/pi/rpc-agent.ts";
import type { RpcRecord } from "../src/pi/rpc-channel.ts";
import { channelPair, newSession, startHost, startTurn, TestClient, type TestHost } from "./helpers.ts";

const DIALOGS_EXTENSION = fileURLToPath(new URL("./fixtures/dialogs.ts", import.meta.url));

const SELECT: PiDialog = { id: "d1", method: "select", title: "Pick a color", options: ["red", "green"] };
const CONFIRM: PiDialog = { id: "d2", method: "confirm", title: "Proceed?", message: "This continues." };
const INPUT: PiDialog = { id: "d3", method: "input", title: "Your name", placeholder: "first name" };
const EDITOR: PiDialog = { id: "d4", method: "editor", title: "Edit", prefill: "draft" };

const submitted = (value: ChatInputAnswerValue): Record<string, ChatInputAnswer> => ({
	[ANSWER_ID]: { state: ChatInputAnswerState.Submitted, value },
});
const selected = (id: string) => submitted({ kind: ChatInputAnswerValueKind.Selected, value: id });
const text = (value: string) => submitted({ kind: ChatInputAnswerValueKind.Text, value });
const boolean = (value: boolean) => submitted({ kind: ChatInputAnswerValueKind.Boolean, value });

describe("extension dialogs", () => {
	test("parses pi's dialog requests", () => {
		assert.deepEqual(parseDialog({ id: "d1", method: "select", title: "Pick", options: ["a", "b"], timeout: 500 }), {
			id: "d1",
			method: "select",
			title: "Pick",
			options: ["a", "b"],
			timeout: 500,
		});
		assert.deepEqual(parseDialog({ id: "d2", method: "confirm", title: "Sure?" }), {
			id: "d2",
			method: "confirm",
			title: "Sure?",
			message: "",
		});
		assert.deepEqual(parseDialog({ id: "d3", method: "input", title: "Name", placeholder: "x", timeout: 0 }), {
			id: "d3",
			method: "input",
			title: "Name",
			placeholder: "x",
		});
		assert.deepEqual(parseDialog({ id: "d4", method: "editor", title: "Edit", prefill: "y" }), {
			id: "d4",
			method: "editor",
			title: "Edit",
			prefill: "y",
		});
	});

	test("ignores malformed dialogs and other UI methods", () => {
		assert.equal(parseDialog({ method: "confirm", title: "No id" }), undefined);
		assert.equal(parseDialog({ id: "d", method: "input" }), undefined);
		assert.equal(parseDialog({ id: "d", method: "select", title: "T", options: [1, 2] }), undefined);
		assert.equal(parseDialog({ id: "d", method: "setStatus", title: "T" }), undefined);
	});

	test("asks one required question per dialog", () => {
		assert.deepEqual(dialogRequest(SELECT), {
			id: "d1",
			questions: [
				{
					id: ANSWER_ID,
					title: "Pick a color",
					required: true,
					kind: ChatInputQuestionKind.SingleSelect,
					message: "",
					options: [
						{ id: "0", label: "red" },
						{ id: "1", label: "green" },
					],
					allowFreeformInput: false,
				},
			],
		});
		const confirm = dialogRequest(CONFIRM).questions?.[0];
		assert.deepEqual(confirm, {
			id: ANSWER_ID,
			title: "Proceed?",
			required: true,
			kind: ChatInputQuestionKind.Boolean,
			message: "This continues.",
		});
		const input = dialogRequest(INPUT).questions?.[0];
		assert.deepEqual(input, {
			id: ANSWER_ID,
			title: "Your name",
			required: true,
			kind: ChatInputQuestionKind.Text,
			message: "first name",
		});
		const editor = dialogRequest(EDITOR).questions?.[0];
		assert.deepEqual(editor, {
			id: ANSWER_ID,
			title: "Edit",
			required: true,
			kind: ChatInputQuestionKind.Text,
			message: "",
			defaultValue: "draft",
		});
	});

	test("maps accepted answers to pi's responses", () => {
		const accept = ChatInputResponseKind.Accept;
		assert.deepEqual(dialogAnswer(SELECT, accept, selected("1")), { value: "green" });
		assert.deepEqual(dialogAnswer(CONFIRM, accept, boolean(false)), { confirmed: false });
		assert.deepEqual(dialogAnswer(INPUT, accept, text("Ada")), { value: "Ada" });
		assert.deepEqual(dialogAnswer(EDITOR, accept, text("")), { value: "" });
	});

	test("anything but a submitted answer of the right kind cancels", () => {
		const accept = ChatInputResponseKind.Accept;
		assert.deepEqual(dialogAnswer(SELECT, ChatInputResponseKind.Decline, selected("0")), CANCELLED);
		assert.deepEqual(dialogAnswer(INPUT, ChatInputResponseKind.Cancel, text("Ada")), CANCELLED);
		assert.deepEqual(dialogAnswer(INPUT, accept, undefined), CANCELLED);
		const skipped = { [ANSWER_ID]: { state: ChatInputAnswerState.Skipped } as ChatInputAnswer };
		assert.deepEqual(dialogAnswer(INPUT, accept, skipped), CANCELLED);
		assert.deepEqual(dialogAnswer(SELECT, accept, selected("2")), CANCELLED, "no such option");
		assert.deepEqual(dialogAnswer(SELECT, accept, selected("length")), CANCELLED);
		assert.deepEqual(dialogAnswer(SELECT, accept, text("red")), CANCELLED, "free text is not an option");
		assert.deepEqual(dialogAnswer(CONFIRM, accept, text("yes")), CANCELLED);
	});

	test("marks warnings and errors in notices", () => {
		assert.equal(noticeMarkdown("saved", "info"), "saved");
		assert.equal(noticeMarkdown("slow", "warning"), "**Warning:** slow");
		assert.equal(noticeMarkdown("failed", "error"), "**Error:** failed");
		assert.equal(notifyLevel("error"), "error");
		assert.equal(notifyLevel("debug"), "info");
		assert.equal(notifyLevel(undefined), "info");
	});
});

describe("rpc agent extension UI", () => {
	function connect() {
		const [host, pi] = channelPair();
		const agent = new RpcAgent(host, {}, { resume: false, truncate: false }, silentLogger);
		const responses: RpcRecord[] = [];
		pi.onRecord((record) => {
			if (record.type === "extension_ui_response") responses.push(record);
		});
		const request = (record: Record<string, unknown>) => pi.send({ type: "extension_ui_request", ...record });
		const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
		return { agent, responses, request, settle };
	}

	test("cancels dialogs when nothing can show them", async () => {
		const { agent, responses, request, settle } = connect();
		request({ id: "a", method: "confirm", title: "Sure?" });
		agent.setUiHandler({ dialog: () => undefined, notify: () => {} });
		request({ id: "b", method: "input", title: "Name" });
		request({ id: "c", method: "select", title: "Bad", options: "red" });
		await settle();
		assert.deepEqual(responses, [
			{ type: "extension_ui_response", id: "a", cancelled: true },
			{ type: "extension_ui_response", id: "b", cancelled: true },
			{ type: "extension_ui_response", id: "c", cancelled: true },
		]);
	});

	test("answers with what the handler resolves, and passes notifications on", async () => {
		const { agent, responses, request, settle } = connect();
		const dialogs: PiDialog[] = [];
		const notices: string[] = [];
		let answer: (value: PiDialogAnswer) => void = () => {};
		agent.setUiHandler({
			dialog: (dialog) => {
				dialogs.push(dialog);
				return new Promise((resolve) => {
					answer = resolve;
				});
			},
			notify: (message, level) => notices.push(`${level}: ${message}`),
		});
		request({ id: "a", method: "select", title: "Pick", options: ["x", "y"] });
		request({ id: "n", method: "notify", message: "careful", notifyType: "warning" });
		request({ id: "s", method: "setStatus", statusKey: "k", statusText: "busy" });
		await settle();
		assert.deepEqual(dialogs, [{ id: "a", method: "select", title: "Pick", options: ["x", "y"] }]);
		assert.deepEqual(notices, ["warning: careful"]);
		assert.deepEqual(responses, [], "fire-and-forget methods get no response");
		answer({ value: "y" });
		await settle();
		assert.deepEqual(responses, [{ type: "extension_ui_response", id: "a", value: "y" }]);
	});
});

describe("extension dialogs over AHP (rpc)", () => {
	let host: TestHost;
	let client: TestClient;

	before(async () => {
		host = await startHost({ mode: "rpc", extensions: [DIALOGS_EXTENSION] });
		client = await TestClient.connect(host.url);
		await client.initialize();
	});

	after(async () => {
		client.close();
		await host.cleanup();
	});

	const requested = (chat: string) =>
		client.waitFor(
			(m) => m.method === "action" && m.params.channel === chat && m.params.action.type === "chat/inputRequested",
		);
	const complete = (turnId: string) =>
		client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
	const markdown = (chat: string, turnId: string) =>
		client.chats
			.get(chat)!
			.turns.find((turn) => turn.id === turnId)!
			.responseParts.flatMap((part: ResponsePart) => (part.kind === "markdown" ? [part.content.trim()] : []));
	const inputPart = (chat: string, turnId: string) =>
		client.chats
			.get(chat)!
			.turns.find((turn) => turn.id === turnId)!
			.responseParts.find((part: ResponsePart) => part.kind === "inputRequest");

	test("asks the client and returns its answer to the extension", async () => {
		const { chat } = await newSession(host, client);
		const turnId = startTurn(client, chat, "/dialog select");
		const request = (await requested(chat)).params.action.request;
		assert.deepEqual(
			request.questions[0].options.map((option: { label: string }) => option.label),
			["red", "green"],
		);
		assert.equal(client.chats.get(chat)!.status, SessionStatus.InputNeeded);

		client.dispatch(chat, {
			type: "chat/inputCompleted",
			turnId,
			requestId: request.id,
			response: ChatInputResponseKind.Accept,
			answers: selected("1"),
		});
		await complete(turnId);
		assert.deepEqual(markdown(chat, turnId), ['**Warning:** answer: "green"']);
		assert.equal(inputPart(chat, turnId)?.response, ChatInputResponseKind.Accept);
	});

	test("uses the answer the client synced when completing without one", async () => {
		const { chat } = await newSession(host, client);
		const turnId = startTurn(client, chat, "/dialog input");
		const request = (await requested(chat)).params.action.request;
		client.dispatch(chat, {
			type: "chat/inputAnswerChanged",
			turnId,
			requestId: request.id,
			questionId: ANSWER_ID,
			answer: text("Ada")[ANSWER_ID],
		});
		client.dispatch(chat, {
			type: "chat/inputCompleted",
			turnId,
			requestId: request.id,
			response: ChatInputResponseKind.Accept,
		});
		await complete(turnId);
		assert.deepEqual(markdown(chat, turnId), ['**Warning:** answer: "Ada"']);
	});

	test("a declined dialog resolves with the extension's default", async () => {
		const { chat } = await newSession(host, client);
		const turnId = startTurn(client, chat, "/dialog confirm");
		const request = (await requested(chat)).params.action.request;
		client.dispatch(chat, {
			type: "chat/inputCompleted",
			turnId,
			requestId: request.id,
			response: ChatInputResponseKind.Decline,
		});
		await complete(turnId);
		assert.deepEqual(markdown(chat, turnId), ["**Warning:** answer: false"]);
	});

	test("closes a dialog when its timeout passes", async () => {
		const { chat } = await newSession(host, client);
		const turnId = startTurn(client, chat, "/dialog select 300");
		await requested(chat);
		await complete(turnId);
		assert.deepEqual(markdown(chat, turnId), ["**Warning:** answer: null"]);
		assert.equal(inputPart(chat, turnId)?.response, ChatInputResponseKind.Cancel);
	});

	test("cancelling the turn dismisses its dialog", async () => {
		const { chat } = await newSession(host, client);
		const cancelled = startTurn(client, chat, "/dialog editor");
		await requested(chat);
		client.dispatch(chat, { type: "chat/turnCancelled", turnId: cancelled, duration: 5 });
		await client.waitFor(
			(m) => m.params?.action?.type === "chat/turnCancelled" && m.params.action.turnId === cancelled,
		);

		const next = startTurn(client, chat, "/dialog last");
		await complete(next);
		// The cancelled command's own notice can land in this turn when pi sends it late.
		assert.equal(markdown(chat, next).at(-1), "last: null", "the extension saw the dialog dismissed");
	});

	test("dismisses a dialog opened outside a turn, and rejects answers to it", async () => {
		const { chat } = await newSession(host, client);
		const later = startTurn(client, chat, "/dialog later confirm");
		await complete(later);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const next = startTurn(client, chat, "/dialog last");
		await complete(next);
		assert.deepEqual(markdown(chat, next), ["last: false"]);
		assert.ok(
			!client.envelopes.some((envelope) => envelope.channel === chat && envelope.action.type === "chat/inputRequested"),
		);

		const seq = client.dispatch(chat, {
			type: "chat/inputCompleted",
			turnId: next,
			requestId: "nope",
			response: ChatInputResponseKind.Accept,
		});
		const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === seq);
		assert.equal(echo.params.rejectionReason, "No open input request");
	});
});
