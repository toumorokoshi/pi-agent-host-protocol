import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type LogFields, type Logger, silentLogger } from "../src/core/logger.ts";
import { AgentHost } from "../src/host/agent-host.ts";
import { type CatalogTimers, listModels, ModelCatalog, retryDelay } from "../src/pi/model-catalog.ts";
import type { PiModel } from "../src/pi/models.ts";
import { RpcBackend } from "../src/pi/rpc-backend.ts";
import { PiStartError } from "../src/pi/rpc-process.ts";
import { listen } from "../src/transport/websocket.ts";
import { FakeBackend } from "./fake-pi.ts";
import { TestClient, waitUntil } from "./helpers.ts";

const model = (id: string): PiModel => ({ provider: "locksmith", id });

/** Timers that only fire when the test advances them. */
function fakeTimers() {
	let now = 0;
	const pending = new Map<number, { at: number; callback: () => void }>();
	let next = 1;
	const timers: CatalogTimers = {
		setTimeout: (callback, ms) => {
			const id = next++;
			pending.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout: (handle) => {
			pending.delete(handle as number);
		},
	};
	return {
		timers,
		/** Delays (from now) of the timers waiting to fire. */
		delays: () => [...pending.values()].map((timer) => timer.at - now),
		/** Moves time forward by `ms`, firing due timers, and lets the listings they start finish. */
		async advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...pending]) {
				if (timer.at <= now) {
					pending.delete(id);
					timer.callback();
				}
			}
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

function recordingLogger() {
	const lines: { level: string; message: string; fields?: LogFields }[] = [];
	const at =
		(level: string) =>
		(message: string, fields?: LogFields): void => {
			lines.push({ level, message, fields });
		};
	const logger: Logger = { level: "debug", error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") };
	return { logger, lines };
}

/** A backend that answers with the next scripted result each time it's asked. */
function scripted(results: (readonly PiModel[] | Error)[]) {
	let calls = 0;
	return {
		load: async () => {
			const result = results[Math.min(calls++, results.length - 1)];
			if (result instanceof Error) throw result;
			return result ?? [];
		},
		calls: () => calls,
	};
}

describe("model catalog", () => {
	test("retry delays back off to 30 s", () => {
		assert.deepEqual(
			[1, 2, 3, 4, 5, 6, 20].map((attempt) => retryDelay(attempt)),
			[2000, 4000, 8000, 16000, 30000, 30000, 30000],
		);
	});

	test("listModels classifies empty, failed and real listings", async () => {
		assert.deepEqual(await listModels(async () => []), { kind: "empty" });
		assert.equal((await listModels(async () => [model("a")])).kind, "models");
		const failed = await listModels(async () => {
			throw new Error("boom");
		});
		assert.equal(failed.kind, "failed");
	});

	test("listModels counts a listing that never finishes as failed", async () => {
		const listing = await listModels(() => new Promise(() => {}), 10);
		assert.equal(listing.kind, "failed");
		assert.match((listing as { error: Error }).error.message, /timed out after 10 ms/);
	});

	test("a hung listing is logged as failed, clears the in-flight listing, and the retry succeeds", async () => {
		const clock = fakeTimers();
		const { logger, lines } = recordingLogger();
		let calls = 0;
		const published: string[][] = [];
		const catalog = new ModelCatalog({
			load: () => (++calls === 1 ? new Promise<PiModel[]>(() => {}) : Promise.resolve([model("a")])),
			publish: (models) => published.push(models.map((m) => m.id)),
			logger,
			timers: clock.timers,
			listTimeoutMs: 5000,
		});

		const first = catalog.refresh();
		assert.deepEqual(clock.delays(), [5000], "only the listing's deadline is waiting");
		await clock.advance(5000);
		assert.equal((await first).kind, "failed");
		assert.equal(lines[0]?.message, "could not list models");
		assert.match(String(lines[0]?.fields?.error), /timed out/);
		assert.deepEqual(clock.delays(), [2000], "the retry is on the backoff");
		await clock.advance(2000);
		assert.equal(calls, 2);
		assert.deepEqual(published, [["a"]]);
		catalog.dispose();
	});

	test("never publishes an empty list, retries on the backoff, and publishes the first real list", async () => {
		const clock = fakeTimers();
		const { logger, lines } = recordingLogger();
		const backend = scripted([[], new Error("pi exited with 1"), [], [model("a"), model("b")]]);
		const published: string[][] = [];
		const catalog = new ModelCatalog({
			load: backend.load,
			publish: (models) => published.push(models.map((m) => m.id)),
			logger,
			timers: clock.timers,
		});

		assert.equal((await catalog.refresh()).kind, "empty");
		assert.deepEqual(published, []);
		assert.deepEqual(clock.delays(), [2000]);
		await clock.advance(2000);
		assert.deepEqual(clock.delays(), [4000]);
		await clock.advance(4000);
		assert.deepEqual(clock.delays(), [8000]);
		assert.deepEqual(published, []);
		await clock.advance(8000);

		assert.deepEqual(published, [["a", "b"]]);
		assert.equal(backend.calls(), 4);
		assert.deepEqual(clock.delays(), [10 * 60_000], "periodic refresh once there are models");
		assert.deepEqual(
			lines.map((line) => `${line.level} ${line.message} ${line.fields?.attempt ?? ""}`),
			[
				"warn pi listed no models 1",
				"warn could not list models 2",
				"warn pi listed no models 3",
				"info models available ",
			],
		);
		assert.equal(lines[1]?.fields?.error, "pi exited with 1");
		assert.equal(lines[3]?.fields?.count, 2);
		catalog.dispose();
	});

	test("keeps the published list when a later listing is empty or fails", async () => {
		const clock = fakeTimers();
		const { logger } = recordingLogger();
		const backend = scripted([[model("a")], [], new Error("no"), [model("a")], [model("a"), model("c")]]);
		const published: string[][] = [];
		const catalog = new ModelCatalog({
			load: backend.load,
			publish: (models) => published.push(models.map((m) => m.id)),
			logger,
			timers: clock.timers,
			refreshIntervalMs: 1000,
		});

		await catalog.refresh();
		await clock.advance(1000); // empty: kept
		assert.deepEqual(
			catalog.models.map((m) => m.id),
			["a"],
		);
		assert.deepEqual(clock.delays(), [1000], "still on the periodic refresh, not the empty backoff");
		await clock.advance(1000); // failed: kept
		await clock.advance(1000); // same list: handed to publish again; the host drops unchanged ones
		await clock.advance(1000); // changed
		assert.deepEqual(published, [["a"], ["a"], ["a", "c"]]);
		catalog.dispose();
	});

	test("concurrent refreshes share one listing, and dispose stops the schedule", async () => {
		const clock = fakeTimers();
		const { logger } = recordingLogger();
		const backend = scripted([[model("a")]]);
		const catalog = new ModelCatalog({ load: backend.load, publish: () => {}, logger, timers: clock.timers });
		await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
		assert.equal(backend.calls(), 1);
		catalog.dispose();
		assert.deepEqual(clock.delays(), []);
	});
});

describe("agent host model list", () => {
	test("a connected client gets the first real model list without reconnecting", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-models-"));
		const backend = new FakeBackend(dir);
		backend.modelListings = [[], new Error("pi exited with 1"), [{ provider: "faux", id: "faux-1" }]];
		const { logger, lines } = recordingLogger();
		const host = new AgentHost({
			backend,
			defaultDirectory: dir,
			logger,
			modelRetryDelaysMs: [20, 20, 20],
		});
		const listener = await listen(host, { host: "127.0.0.1", port: 0, token: undefined });
		const client = await TestClient.connect(listener.url);
		try {
			await host.refreshAgents();
			await client.initialize();
			const published = () => client.root?.agents[0]?.models.map((model) => model.id) ?? [];
			assert.deepEqual(published(), [], "an empty listing isn't published as models");
			await waitUntil(() => published().length > 0, 5_000);
			assert.deepEqual(published(), ["faux/faux-1"]);
			assert.ok(backend.modelCalls >= 3);
			assert.ok(lines.some((line) => line.level === "warn" && line.message === "pi listed no models"));
			assert.ok(lines.some((line) => line.level === "info" && line.message === "models available"));
		} finally {
			client.close();
			await listener.close();
			await host.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an rpc backend that lists no models is told apart from a failure, and the empty answer isn't cached", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-models-rpc-"));
		const script = join(dir, "pi.mjs");
		await writeFile(
			script,
			`import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const answers = [[], [{ provider: "faux", id: "faux-1" }]];
const counter = ${JSON.stringify(join(dir, "count"))};
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(n + 1));
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id } = JSON.parse(line);
	console.log(JSON.stringify({ type: "response", id, command: "get_available_models", success: true, data: { models: answers[Math.min(n, answers.length - 1)] } }));
});
`,
		);
		const { logger, lines } = recordingLogger();
		const backend = new RpcBackend({ pi: script, logger: silentLogger });
		const catalog = new ModelCatalog({
			load: () => backend.models(),
			publish: () => {},
			logger,
			timers: fakeTimers().timers,
		});
		try {
			assert.equal((await catalog.refresh()).kind, "empty");
			assert.equal(lines[0]?.message, "pi listed no models");
			assert.equal(lines[0]?.level, "warn");
			assert.equal((await catalog.refresh()).kind, "models", "the empty answer was not kept by the 30 s cache");
			assert.equal(Number(await readFile(join(dir, "count"), "utf8")), 2);
			assert.equal((await catalog.refresh()).kind, "models");
			assert.equal(Number(await readFile(join(dir, "count"), "utf8")), 2, "a real list is cached");
		} finally {
			catalog.dispose();
			await backend.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("refreshAgents rejects when pi can't be started, so the CLI can say so", async () => {
		const host = new AgentHost({
			backend: new RpcBackend({ pi: "/nonexistent/pi-agent-host-protocol-test/pi" }),
			defaultDirectory: tmpdir(),
		});
		try {
			await assert.rejects(host.refreshAgents(), (error: unknown) => error instanceof PiStartError);
		} finally {
			await host.dispose();
		}
	});
});
