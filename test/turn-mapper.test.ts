import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatAction } from "@microsoft/agent-host-protocol";
import type { PiEvent } from "../src/pi/agent.ts";
import { ACTIVITY_RESPONDING, ACTIVITY_THINKING, TurnMapper } from "../src/pi/turn-mapper.ts";

function mapper(): { mapper: TurnMapper; activities: () => Array<string | undefined> } {
	const actions: ChatAction[] = [];
	return {
		mapper: new TurnMapper("turn-1", (action) => actions.push(action)),
		activities: () => actions.flatMap((action) => (action.type === "chat/activityChanged" ? [action.activity] : [])),
	};
}

const assistant = { role: "assistant", content: [] };
const event = (value: unknown) => value as PiEvent;

describe("TurnMapper activity", () => {
	test("describes thinking, responding, each tool, and clears at the end", () => {
		const { mapper: m, activities } = mapper();
		m.handle(event({ type: "message_start", message: assistant }));
		m.handle(event({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }));
		m.handle(event({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } }));
		m.handle(
			event({
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "bash",
				args: { command: "npm `test`" },
			}),
		);
		m.handle(event({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false }));
		m.finish({ kind: "complete" }, 10);
		assert.deepEqual(activities(), [
			ACTIVITY_THINKING,
			ACTIVITY_RESPONDING,
			"Running npm 'test'",
			ACTIVITY_THINKING,
			undefined,
		]);
	});

	test("shows a generic tool label while the arguments stream", () => {
		const { mapper: m, activities } = mapper();
		m.handle(event({ type: "message_start", message: assistant }));
		m.handle(
			event({
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" },
			}),
		);
		m.handle(
			event({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { id: "c1", name: "bash", arguments: { command: "ls" } },
				},
			}),
		);
		assert.deepEqual(activities(), [ACTIVITY_THINKING, "Running command", "Running ls"]);
	});

	test("does not repeat an unchanged activity", () => {
		const { mapper: m, activities } = mapper();
		m.handle(event({ type: "message_start", message: assistant }));
		m.handle(event({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }));
		assert.deepEqual(activities(), [ACTIVITY_THINKING]);
	});

	test("falls back to a tool still running when a parallel one completes", () => {
		const { mapper: m, activities } = mapper();
		m.handle(event({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.txt" } }));
		m.handle(event({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "b.txt" } }));
		m.handle(event({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: {}, isError: false }));
		assert.deepEqual(activities(), ["Reading a.txt", "Reading b.txt", "Reading a.txt"]);
	});
});
