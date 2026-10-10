import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	archivePath,
	fileArchiveStore,
	memoryArchiveStore,
	parseArchive,
	serializeArchive,
	withArchived,
} from "../src/host/archive-store.ts";

describe("archive store", () => {
	test("parses and serializes the archive file", () => {
		assert.deepEqual([...parseArchive(serializeArchive(new Set(["b", "a"])))], ["a", "b"]);
		assert.deepEqual([...parseArchive("not json")], []);
		assert.deepEqual([...parseArchive('{"archived":["a",1,null]}')], ["a"]);
		assert.deepEqual([...parseArchive("{}")], []);
	});

	test("withArchived returns the same set when nothing changes", () => {
		const set = new Set(["a"]);
		assert.equal(withArchived(set, "a", true), set);
		assert.equal(withArchived(set, "b", false), set);
		assert.deepEqual([...withArchived(set, "b", true)].sort(), ["a", "b"]);
		assert.deepEqual([...withArchived(set, "a", false)], []);
		assert.deepEqual([...set], ["a"], "input is not mutated");
	});

	test("memory store tracks flags", () => {
		const store = memoryArchiveStore(["a"]);
		assert.equal(store.isArchived("a"), true);
		store.setArchived("a", false);
		assert.equal(store.isArchived("a"), false);
	});

	test("file store persists flags and reloads them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-archive-"));
		try {
			const path = archivePath(join(dir, "nested", "settings.json"));
			assert.equal(path, join(dir, "nested", "archived-sessions.json"));
			const first = await fileArchiveStore(path);
			assert.equal(first.isArchived("a"), false, "a missing file means nothing is archived");
			first.setArchived("a", true);
			first.setArchived("b", true);
			first.setArchived("b", false);
			await first.flush();
			assert.deepEqual(JSON.parse(await readFile(path, "utf8")).archived, ["a"]);

			const second = await fileArchiveStore(path);
			assert.equal(second.isArchived("a"), true);
			assert.equal(second.isArchived("b"), false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("file store treats a corrupt file as empty and reports write failures", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-archive-"));
		try {
			const path = join(dir, "archived-sessions.json");
			await writeFile(path, "{corrupt");
			const store = await fileArchiveStore(path);
			assert.equal(store.isArchived("a"), false);

			const errors: unknown[] = [];
			const blockedDir = join(dir, "blocked");
			const blocked = await fileArchiveStore(join(blockedDir, "archived-sessions.json"), (error) => errors.push(error));
			// A file where the directory should be makes the write fail.
			await writeFile(blockedDir, "");
			blocked.setArchived("a", true);
			await blocked.flush();
			assert.equal(errors.length, 1, "a failed write is reported, not thrown");
			assert.equal(blocked.isArchived("a"), true, "the flag is still kept in memory");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
