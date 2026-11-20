import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatAction } from "@microsoft/agent-host-protocol";
import type { PiEvent } from "../src/pi/agent.ts";
import { turnsFromEntries } from "../src/pi/history.ts";
import { TurnMapper } from "../src/pi/turn-mapper.ts";
import { addCall, afterCompaction, usageInfo } from "../src/pi/usage.ts";

// Two model calls in one turn, as a tool call makes: the second's prompt
// repeats the first's (mostly from the cache) and adds the tool result.
const FIRST = { input: 11_000, output: 200, cacheRead: 0, cacheWrite: 30_000 };
const SECOND = { input: 1_222, output: 300, cacheRead: 30_879, cacheWrite: 0 };
const EXPECTED = { inputTokens: 32_101, outputTokens: 500, cacheReadTokens: 30_879, model: "m" };

const usages = (actions: ChatAction[]) =>
	actions.flatMap((action) => (action.type === "chat/usage" && "usage" in action ? [action.usage] : []));

describe("turn usage", () => {
	test("reports the last call's full prompt and the turn's summed output", () => {
		const turn = addCall(addCall(undefined, FIRST, "m"), SECOND, undefined);
		assert.ok(turn);
		assert.deepEqual(usageInfo(turn), EXPECTED);
	});

	test("counts cache writes as context and omits a zero cache read", () => {
		const turn = addCall(undefined, { input: 5, output: 1, cacheWrite: 7 }, undefined);
		assert.ok(turn);
		assert.deepEqual(usageInfo(turn), { inputTokens: 12, outputTokens: 1 });
	});

	test("has nothing to report until a call reports usage", () => {
		assert.equal(addCall(undefined, undefined, "m"), undefined);
	});

	test("live turns and rebuilt history agree", () => {
		const actions: ChatAction[] = [];
		const mapper = new TurnMapper("t", (action) => actions.push(action));
		for (const usage of [FIRST, SECOND]) {
			const message = { role: "assistant", content: [], usage, model: "m" };
			mapper.handle({ type: "message_end", message } as unknown as PiEvent);
		}
		mapper.finish({ kind: "complete" }, 0);
		const live = usages(actions).at(-1);
		assert.deepEqual(live, EXPECTED);

		const at = "2026-01-01T00:00:00.000Z";
		const entries = [
			{ type: "message", id: "u", timestamp: at, message: { role: "user", content: "hi" } },
			...[FIRST, SECOND].map((usage, index) => ({
				type: "message",
				id: `a${index}`,
				timestamp: at,
				message: { role: "assistant", content: [], usage, model: "m" },
			})),
		] as unknown as SessionEntry[];
		assert.deepEqual(turnsFromEntries(entries)[0]?.usage, EXPECTED);
	});

	test("is reported after each call, so the gauge follows a long turn", () => {
		const actions: ChatAction[] = [];
		const mapper = new TurnMapper("t", (action) => actions.push(action));
		mapper.handle({
			type: "message_end",
			message: { role: "assistant", content: [], usage: FIRST, model: "m" },
		} as unknown as PiEvent);
		assert.equal(usages(actions).at(-1)?.inputTokens, 41_000);
		mapper.handle({
			type: "message_end",
			message: { role: "assistant", content: [], usage: SECOND, model: "m" },
		} as unknown as PiEvent);
		assert.equal(usages(actions).at(-1)?.inputTokens, 32_101);
	});

	test("drops to the compacted size after automatic compaction, and the next call replaces it", () => {
		const actions: ChatAction[] = [];
		const mapper = new TurnMapper("t", (action) => actions.push(action));
		mapper.handle({
			type: "message_end",
			message: { role: "assistant", content: [], usage: SECOND, model: "m" },
		} as unknown as PiEvent);
		mapper.handle({ type: "compaction_start", reason: "threshold" } as unknown as PiEvent);
		mapper.handle({
			type: "compaction_end",
			reason: "threshold",
			result: { summary: "s", firstKeptEntryId: "x", tokensBefore: 32_101, estimatedTokensAfter: 4_000 },
			aborted: false,
			willRetry: false,
		} as unknown as PiEvent);
		assert.deepEqual(usages(actions).at(-1), { inputTokens: 4_000, outputTokens: 300, model: "m" });
		mapper.handle({
			type: "message_end",
			message: { role: "assistant", content: [], usage: { input: 4_500, output: 10 }, model: "m" },
		} as unknown as PiEvent);
		assert.equal(usages(actions).at(-1)?.inputTokens, 4_500);
	});

	test("a compaction keeps the turn's output and model", () => {
		assert.deepEqual(afterCompaction(addCall(undefined, SECOND, "m"), 100), {
			context: 100,
			cacheRead: 0,
			output: 300,
			model: "m",
		});
		assert.deepEqual(afterCompaction(undefined, 100), { context: 100, cacheRead: 0, output: 0 });
	});

	test("a failed call with empty usage keeps the last real call's context", () => {
		const actions: ChatAction[] = [];
		const mapper = new TurnMapper("t", (action) => actions.push(action));
		mapper.handle({
			type: "message_end",
			message: { role: "assistant", content: [], usage: FIRST, model: "m" },
		} as unknown as PiEvent);
		mapper.handle({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "429",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				model: "m",
			},
		} as unknown as PiEvent);
		assert.deepEqual(usages(actions).at(-1), { inputTokens: 41_000, outputTokens: 200, model: "m" });
	});

	test("addCall keeps the context across an empty call, and reports none for an empty first call", () => {
		const real = addCall(undefined, SECOND, "m");
		assert.deepEqual(addCall(real, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "m"), real);
		assert.equal(addCall(undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, undefined), undefined);
	});

	test("rebuilt history ignores an aborted call with empty usage, as the live turn does", () => {
		const at = "2026-01-01T00:00:00.000Z";
		const entries = [
			{ type: "message", id: "u", timestamp: at, message: { role: "user", content: "hi" } },
			{
				type: "message",
				id: "a",
				timestamp: at,
				message: { role: "assistant", content: [], stopReason: "toolUse", usage: SECOND, model: "m" },
			},
			{
				type: "message",
				id: "b",
				timestamp: at,
				message: { role: "assistant", content: [], stopReason: "aborted", usage: { input: 0, output: 0 }, model: "m" },
			},
		] as unknown as SessionEntry[];
		assert.equal(turnsFromEntries(entries)[0]?.usage?.inputTokens, 32_101);
	});

	test("rebuilt history leaves a compaction to the next call: pi's file has no size after, and no /compact message", () => {
		const at = "2026-01-01T00:00:00.000Z";
		const entries = [
			{ type: "message", id: "u", timestamp: at, message: { role: "user", content: "hi" } },
			{
				type: "message",
				id: "a",
				timestamp: at,
				message: { role: "assistant", content: [], usage: SECOND, model: "m" },
			},
			// What `/compact` leaves in pi's file: the compaction entry alone.
			{
				type: "compaction",
				id: "c",
				timestamp: at,
				summary: "x".repeat(8_000),
				firstKeptEntryId: "a",
				tokensBefore: 32_101,
			},
			{ type: "message", id: "u2", timestamp: at, message: { role: "user", content: "go on" } },
			{
				type: "message",
				id: "b",
				timestamp: at,
				message: { role: "assistant", content: [], usage: { input: 4_500, output: 10 }, model: "m" },
			},
		] as unknown as SessionEntry[];
		const turns = turnsFromEntries(entries);
		assert.equal(turns[0]?.usage?.inputTokens, 32_101, "the turn before keeps its own call's context");
		assert.equal(turns[1]?.usage?.inputTokens, 4_500, "the next turn reports the call after the compaction");
	});
});
