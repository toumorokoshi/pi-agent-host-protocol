import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { chatUri, parseChatUri, parseSessionUri, sessionSchemeOf, sessionUri } from "../src/core/uris.ts";
import {
	fileSchemeStore,
	memorySchemeStore,
	parseSchemes,
	schemeStorePath,
	serializeSchemes,
	withScheme,
} from "../src/host/scheme-store.ts";

describe("session URI schemes", () => {
	test("builds and parses session and default chat URIs under either scheme", () => {
		assert.equal(sessionUri("s"), "pi:/s");
		assert.equal(sessionUri("s", "ahp-session"), "ahp-session:/s");
		assert.equal(sessionSchemeOf("pi:/s"), "pi");
		assert.equal(sessionSchemeOf("AHP-Session:/s"), "ahp-session");
		assert.equal(sessionSchemeOf("ahp-chat:/s"), undefined);
		assert.equal(parseSessionUri("ahp-session:/s"), "s");
		assert.equal(parseSessionUri("pi:/s"), "s");
		assert.notEqual(chatUri("s", "ahp-session"), chatUri("s"));
		assert.equal(parseChatUri(chatUri("s", "ahp-session")), "s");
	});

	test("reads only the default authority as a session's default chat", () => {
		const encoded = Buffer.from(sessionUri("s", "ahp-session"), "utf8").toString("base64url");
		assert.equal(parseChatUri(`ahp-chat://DEFAULT/${encoded}`), "s");
		assert.equal(parseChatUri(`ahp-chat://chat-2/${encoded}`), undefined, "a forked chat VS Code named");
	});
});

describe("scheme store", () => {
	test("parses and serializes the scheme file", () => {
		assert.deepEqual([...parseSchemes(serializeSchemes(new Set(["b", "a"])))], ["a", "b"]);
		assert.deepEqual([...parseSchemes("not json")], []);
		assert.deepEqual([...parseSchemes('{"ahpSession":["a",1,null]}')], ["a"]);
	});

	test("withScheme returns the same set when nothing changes", () => {
		const set = new Set(["a"]);
		assert.equal(withScheme(set, "a", "ahp-session"), set);
		assert.equal(withScheme(set, "b", "pi"), set);
		assert.deepEqual([...withScheme(set, "a", "pi")], []);
		assert.deepEqual([...set], ["a"], "input is not mutated");
	});

	test("memory store defaults to the pi scheme", () => {
		const store = memorySchemeStore();
		assert.equal(store.schemeOf("a"), "pi");
		store.setScheme("a", "ahp-session");
		assert.equal(store.schemeOf("a"), "ahp-session");
	});

	test("file store persists schemes and reloads them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-schemes-"));
		try {
			const path = schemeStorePath(join(dir, "settings.json"));
			assert.equal(path, join(dir, "session-schemes.json"));
			const first = await fileSchemeStore(path);
			first.setScheme("a", "ahp-session");
			first.setScheme("b", "ahp-session");
			first.setScheme("b", "pi");
			await first.flush();
			assert.deepEqual(JSON.parse(await readFile(path, "utf8")).ahpSession, ["a"]);

			const second = await fileSchemeStore(path);
			assert.equal(second.schemeOf("a"), "ahp-session");
			assert.equal(second.schemeOf("b"), "pi");

			await writeFile(path, "{corrupt");
			assert.equal((await fileSchemeStore(path)).schemeOf("a"), "pi", "a corrupt file is treated as empty");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
