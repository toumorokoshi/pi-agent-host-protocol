import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cached } from "../src/core/cached.ts";

describe("cached", () => {
	test("shares a result until it is older than the ttl", async () => {
		let now = 0;
		let loads = 0;
		const get = cached(
			10,
			async () => ++loads,
			() => now,
		);
		assert.equal(await get(), 1);
		now = 10;
		assert.equal(await get(), 1);
		now = 11;
		assert.equal(await get(), 2);
	});

	test("does not keep a failed load", async () => {
		let fail = true;
		const get = cached(
			1000,
			async () => {
				if (fail) throw new Error("no");
				return "ok";
			},
			() => 0,
		);
		await assert.rejects(get(), /no/);
		fail = false;
		assert.equal(await get(), "ok");
	});
});
