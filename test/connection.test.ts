import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ActionEnvelope, ActionType } from "@microsoft/agent-host-protocol";
import { silentLogger } from "../src/core/logger.ts";
import { Connection } from "../src/host/connection.ts";

const handler = { request: async () => null, notification: () => {} };
const envelope: ActionEnvelope = {
	channel: "pi:/s",
	action: { type: ActionType.SessionTitleChanged, title: "New" },
	serverSeq: 1,
	origin: undefined,
};

function connection(): { connection: Connection; sent: ActionEnvelope[] } {
	const sent: ActionEnvelope[] = [];
	const connection = new Connection("test", (text) => sent.push(JSON.parse(text).params), handler, silentLogger);
	connection.protocolVersion = "1.0.0";
	return { connection, sent };
}

describe("Connection subscriptions", () => {
	test("delivers in the client's spelling", () => {
		const { connection: c, sent } = connection();
		c.subscribe("pi:/s", "ahp-session:/s");
		c.deliver(envelope);
		assert.deepEqual(
			sent.map((e) => e.channel),
			["ahp-session:/s"],
		);
	});

	test("dropping one of two spellings keeps the other", () => {
		const { connection: c, sent } = connection();
		c.subscribe("pi:/s", "ahp-session:/s");
		c.subscribe("pi:/s", "pi:/s");
		c.unsubscribe("ahp-session:/s", "pi:/s");
		assert.ok(c.isSubscribed("pi:/s"));
		c.deliver(envelope);
		assert.deepEqual(
			sent.map((e) => e.channel),
			["pi:/s"],
		);
	});

	test("unsubscribing by an unused spelling drops the channel", () => {
		const { connection: c } = connection();
		c.subscribe("pi:/s", "ahp-session:/s");
		c.unsubscribe("pi:/s", "pi:/s");
		assert.equal(c.isSubscribed("pi:/s"), false);
	});
});
