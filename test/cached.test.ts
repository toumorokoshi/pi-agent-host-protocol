import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cached, cachedBy } from "../src/core/cached.ts";

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

describe("cachedBy", () => {
	test("shares a result per key until it is older than the ttl", async () => {
		let now = 0;
		const loads: string[] = [];
		const get = cachedBy(
			10,
			async (key: string) => {
				loads.push(key);
				return `${key}${loads.length}`;
			},
			() => now,
		);
		assert.equal(await get("a"), "a1");
		assert.equal(await get("b"), "b2");
		now = 10;
		assert.equal(await get("a"), "a1");
		now = 11;
		assert.equal(await get("a"), "a3");
		assert.equal(await get("b"), "b4");
		assert.deepEqual(loads, ["a", "b", "a", "b"]);
	});

	test("does not keep a failed load", async () => {
		let fail = true;
		const get = cachedBy(
			1000,
			async (key: string) => {
				if (fail) throw new Error("no");
				return key;
			},
			() => 0,
		);
		await assert.rejects(get("a"), /no/);
		fail = false;
		assert.equal(await get("a"), "a");
	});
});
