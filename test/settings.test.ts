import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { migrateSettings } from "../src/host/settings.ts";

describe("settings migration", () => {
	test("copies settings from the old directory once, and never overwrites new ones", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-settings-"));
		try {
			const from = join(dir, "agent-host", "settings.json");
			const to = join(dir, "agent-host-protocol", "settings.json");
			assert.equal(await migrateSettings(from, to), false, "nothing to copy");

			await mkdir(join(dir, "agent-host"));
			await writeFile(from, '{"port":63877,"token":"old"}');
			assert.equal(await migrateSettings(from, to), true);
			assert.equal(await readFile(to, "utf8"), '{"port":63877,"token":"old"}');

			await writeFile(from, '{"port":1,"token":"changed"}');
			assert.equal(await migrateSettings(from, to), false, "existing new settings are kept");
			assert.equal(await readFile(to, "utf8"), '{"port":63877,"token":"old"}');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
