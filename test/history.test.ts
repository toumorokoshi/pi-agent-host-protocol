import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { MessageKind } from "@microsoft/agent-host-protocol";
import { forkKeep } from "../src/pi/forks.ts";
import { CONTINUED, turnsFromEntries } from "../src/pi/history.ts";
import { recordedUserTurns } from "../src/pi/truncation.ts";

const at = "2026-01-01T00:00:00.000Z";
const user = (id: string) => ({ type: "message", id, timestamp: at, message: { role: "user", content: id } });
const reply = (id: string, stopReason = "stop") => ({
	type: "message",
	id,
	timestamp: at,
	message: { role: "assistant", content: [{ type: "text", text: id }], stopReason },
});
const custom = (id: string, customType: string) => ({
	type: "custom_message",
	id,
	timestamp: at,
	customType,
	content: id,
	display: false,
});
const turns = (entries: unknown[]) => turnsFromEntries(entries as SessionEntry[]);
const texts = (entries: unknown[]) => turns(entries).map((turn) => turn.message.text);

describe("rebuilt history", () => {
	test("a custom message that wakes the agent after a run starts its own turn", () => {
		const rebuilt = turns([
			user("start"),
			reply("started"),
			custom("child-done", "subagent-incremental-child-notify"),
			custom("done", "subagent-notify"),
			reply("report"),
		]);
		assert.deepEqual(
			rebuilt.map((turn) => [turn.id, turn.message.text, turn.message.origin.kind]),
			[
				["start", "start", MessageKind.User],
				["child-done", CONTINUED, MessageKind.SystemNotification],
			],
		);
		assert.equal(rebuilt[1]?.responseParts.length, 1);
	});

	test("a custom message during a run stays in its turn", () => {
		assert.deepEqual(texts([user("start"), reply("tool", "toolUse"), custom("steer", "note"), reply("done")]), [
			"start",
		]);
	});

	test("resuming an errored turn continues it", () => {
		assert.deepEqual(texts([user("start"), reply("failed", "error"), custom("resume", "ahp-resume"), reply("done")]), [
			"start",
		]);
	});

	test("a custom message that no run follows adds no turn", () => {
		assert.deepEqual(texts([user("start"), reply("done"), custom("late", "subagent-notify")]), ["start"]);
	});

	test("a wake-up turn is not counted as a user turn by forks and truncation", () => {
		const rebuilt = turns([
			user("one"),
			reply("a1"),
			custom("woken", "subagent-notify"),
			reply("report"),
			user("two"),
			reply("a2"),
		]);
		assert.deepEqual(
			rebuilt.map((turn) => turn.id),
			["one", "woken", "two"],
		);
		assert.equal(recordedUserTurns(rebuilt, new Set()), 2);
		// Forking after the wake-up keeps one user message (and what followed it, the wake-up included).
		assert.equal(forkKeep(rebuilt, "woken", new Set()), 1);
		assert.equal(forkKeep(rebuilt, "two", new Set()), 2);
	});

	test("a compaction entry changes no turn's usage, and a call with empty usage keeps the last real call's", () => {
		const call = (id: string, stopReason: string, usage: object) => ({
			type: "message",
			id,
			timestamp: at,
			message: { role: "assistant", content: [], stopReason, usage, model: "m" },
		});
		const compaction = {
			type: "compaction",
			id: "c",
			timestamp: at,
			summary: "x".repeat(8_000),
			firstKeptEntryId: "a",
			tokensBefore: 40_000,
		};
		const rebuilt = turns([
			user("one"),
			call("a", "toolUse", { input: 40_000, output: 5 }),
			call("b", "error", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
			compaction,
			user("two"),
		]);
		assert.equal(rebuilt[0]?.usage?.inputTokens, 40_000);
		assert.equal(rebuilt[1]?.usage, undefined);
	});
});
