import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createLogger, formatLine, isEnabled, parseLogLevel } from "../src/core/logger.ts";
import { newSession, startHost, startTurn, TestClient } from "./helpers.ts";

const TIME = new Date("2026-10-03T12:00:00.000Z");

describe("logger", () => {
	test("formats time, level, message and fields, quoting values that need it", () => {
		assert.equal(
			formatLine(TIME, "debug", "action accepted", {
				action: "chat/turnStarted",
				clientSeq: 3,
				reason: "No active turn",
			}),
			'2026-10-03T12:00:00.000Z DEBUG action accepted action=chat/turnStarted clientSeq=3 reason="No active turn"',
		);
	});

	test("omits undefined fields", () => {
		assert.equal(
			formatLine(TIME, "info", "hi", { a: undefined, b: false }),
			"2026-10-03T12:00:00.000Z INFO  hi b=false",
		);
	});

	test("filters by level", () => {
		assert.equal(isEnabled("info", "debug"), false);
		assert.equal(isEnabled("info", "warn"), true);
		assert.equal(isEnabled("debug", "debug"), true);
		const lines: string[] = [];
		const logger = createLogger("info", { write: (line) => lines.push(line), now: () => TIME });
		logger.debug("hidden");
		logger.info("shown");
		assert.deepEqual(lines, ["2026-10-03T12:00:00.000Z INFO  shown"]);
	});

	test("parses log levels case-insensitively and rejects unknown ones", () => {
		assert.equal(parseLogLevel("DEBUG"), "debug");
		assert.throws(() => parseLogLevel("verbose"), /Invalid log level/);
	});
});

describe("host logging", () => {
	test("logs connections at info and session interactions at debug", async () => {
		const lines: string[] = [];
		const logger = createLogger("debug", { write: (line) => lines.push(line) });
		const host = await startHost({ logger });
		try {
			const client = await TestClient.connect(host.url);
			await client.initialize();
			const { chat } = await newSession(host, client);
			host.faux.setResponses([fauxAssistantMessage("Logged.")]);
			const turnId = startTurn(client, chat, "Hello");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
			client.close();
			await new Promise((resolve) => setTimeout(resolve, 50));

			const has = (pattern: RegExp) => lines.some((line) => pattern.test(line));
			assert.ok(has(/ INFO {2}client connected client=127\.0\.0\.1:\d+/), "connection is logged");
			assert.ok(has(/ INFO {2}client initialized .*clientName=test-client .*protocolVersion=0\.9\.0/));
			assert.ok(has(/ DEBUG request .*method=createSession/));
			assert.ok(has(/ DEBUG session created /));
			assert.ok(has(/ DEBUG action accepted .*action=chat\/turnStarted/));
			assert.ok(has(new RegExp(` DEBUG turn started .*turn=${turnId}.*model=faux/faux-1 chars=5`)));
			assert.ok(has(new RegExp(` DEBUG turn finished .*turn=${turnId} outcome=complete`)));
			assert.ok(has(/ INFO {2}client disconnected /));
			assert.ok(!lines.some((line) => line.includes("Hello")), "prompt text is not logged");
		} finally {
			await host.cleanup();
		}
	});
});
