import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import type watcher from "@parcel/watcher";
import { silentLogger } from "../src/core/logger.ts";
import { StateStore } from "../src/core/state-store.ts";
import { parcelIgnore, ResourceWatchService } from "../src/host/resource-watches.ts";

type Subscribe = typeof watcher.subscribe;

/** A subscribe that waits for `gate` and records what ran, instead of touching the OS. */
function fakeSubscribe(options: { gate?: Promise<void>; fail?: boolean; delayMs?: number } = {}) {
	const calls: { dir: string; options: watcher.Options | undefined }[] = [];
	const unsubscribed: string[] = [];
	let running = 0;
	let most = 0;
	const subscribe: Subscribe = async (dir, _fn, opts) => {
		calls.push({ dir, options: opts });
		running++;
		most = Math.max(most, running);
		try {
			await options.gate;
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			if (options.fail) throw new Error("ENOSPC");
		} finally {
			running--;
		}
		return {
			unsubscribe: async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				unsubscribed.push(dir);
			},
		};
	};
	return { subscribe, calls, unsubscribed, mostRunning: () => most };
}

function newService(subscribe: Subscribe) {
	const store = new StateStore({ agents: [], activeSessions: 0, terminals: [] });
	return { store, service: new ResourceWatchService(store, silentLogger, subscribe) };
}

describe("resource watches attach in the background", () => {
	let dir: string;
	let uri: string;
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-watch-"));
		uri = pathToFileURL(dir).href;
	});
	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("createResourceWatch answers before the OS watch attaches", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = fakeSubscribe({ gate });
		const { service } = newService(fake.subscribe);
		const { channel } = await service.create({ uri, recursive: true }, {});
		assert.match(channel, /^ahp-resource-watch:\//);
		release();
		await service.disposeAll();
		assert.equal(fake.unsubscribed.length, 1, "disposeAll waited for the attach, then unsubscribed");
	});

	test("one connection's watches attach one at a time", async () => {
		const fake = fakeSubscribe({ delayMs: 30 });
		const { service } = newService(fake.subscribe);
		const connection = {};
		await Promise.all([1, 2, 3, 4].map(() => service.create({ uri, recursive: true }, connection)));
		for (let tries = 0; tries < 100 && fake.calls.length < 4; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await service.disposeAll();
		assert.equal(fake.calls.length, 4);
		assert.equal(fake.mostRunning(), 1);
	});

	test("a slow attach on one connection does not hold up another connection", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let slow = true;
		const fast = fakeSubscribe();
		const blocked = fakeSubscribe({ gate });
		const subscribe: Subscribe = (...args) => {
			if (slow) {
				slow = false;
				return blocked.subscribe(...args);
			}
			return fast.subscribe(...args);
		};
		const { service } = newService(subscribe);
		await service.create({ uri, recursive: true }, {});
		const second = await service.create({ uri, recursive: true }, {});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(fast.calls.length, 1, "the other connection's watch attached while the first was stuck");
		release();
		await service.disposeAll();
		assert.match(second.channel, /^ahp-resource-watch:\//);
	});

	test("release and disposeAll wait for in-flight and active unsubscribes", async () => {
		const fake = fakeSubscribe({ delayMs: 20 });
		const { service } = newService(fake.subscribe);
		const connection = {};
		const first = await service.create({ uri, recursive: false }, connection);
		await service.create({ uri, recursive: false }, connection);
		// Released while still attaching: release resolves only after the attach and the unsubscribe.
		await service.release((channel) => channel !== first.channel, connection);
		assert.equal(fake.unsubscribed.length, 1);
		// Subscribed watches are released by `release(() => false)`; disposeAll leaves none behind.
		await service.disposeAll();
		assert.equal(fake.unsubscribed.length, 2);
	});

	test("a watch that fails to attach loses its channel", async () => {
		const fake = fakeSubscribe({ fail: true });
		const { store, service } = newService(fake.subscribe);
		const { channel } = await service.create({ uri, recursive: true }, {});
		assert.equal(store.resolve(channel), channel, "registered while attaching");
		for (let tries = 0; tries < 50 && store.resolve(channel); tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(store.resolve(channel), undefined, "removed once the attach failed");
		await service.disposeAll();
		assert.equal(fake.unsubscribed.length, 0);
	});

	test("passes only translatable excludes to the watcher as ignore", async () => {
		const fake = fakeSubscribe();
		const { service } = newService(fake.subscribe);
		await service.create({ uri, recursive: true, excludes: { items: ["**/node_modules", "build/**", "dist"] } }, {});
		await service.disposeAll();
		assert.deepEqual(fake.calls[0]?.options, { ignore: ["**/node_modules", join(dir, "dist")] });
		const none = fakeSubscribe();
		const second = newService(none.subscribe);
		await second.service.create({ uri, recursive: true, excludes: { items: ["*.log"] } }, {});
		await second.service.disposeAll();
		assert.equal(none.calls[0]?.options, undefined);
	});
});

describe("parcelIgnore", () => {
	const root = "/work/tree";
	test("keeps any-depth globs and makes plain paths absolute", () => {
		assert.deepEqual(parcelIgnore(root, ["**/node_modules", "**/.git/**", "out", "a/b"]), [
			"**/node_modules",
			"**/.git/**",
			"/work/tree/out",
			"/work/tree/a/b",
		]);
	});
	test("leaves root-relative globs, absolute paths, parent paths and odd syntax to the post-event filter", () => {
		assert.deepEqual(parcelIgnore(root, ["build/**", "*.log", "/etc", "../x", "**/[ab]", "**/!(x)", "a{b,c}"]), []);
		assert.deepEqual(parcelIgnore(root, undefined), []);
	});
});
