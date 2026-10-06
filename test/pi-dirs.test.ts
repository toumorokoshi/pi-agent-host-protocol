import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { expandPath, piDirsEnv, resolvePiDirs } from "../src/host/pi-dirs.ts";
import { loadSettings } from "../src/host/settings.ts";

describe("pi directories", () => {
	test("expands ~ and resolves relative paths", () => {
		assert.equal(expandPath("~", "/work", "/home/me"), "/home/me");
		assert.equal(expandPath("~/.av-pi/agent", "/work", "/home/me"), "/home/me/.av-pi/agent");
		assert.equal(expandPath("sessions", "/work", "/home/me"), "/work/sessions");
		assert.equal(expandPath("/abs", "/work", "/home/me"), "/abs");
	});

	test("prefers flags, then settings, then pi's environment variables", () => {
		const env = { PI_CODING_AGENT_DIR: "/env/agent", PI_CODING_AGENT_SESSION_DIR: "/env/sessions" };
		assert.deepEqual(resolvePiDirs({}, {}, {}, "/work"), {});
		assert.deepEqual(resolvePiDirs({}, {}, env, "/work"), { agentDir: "/env/agent", sessionDir: "/env/sessions" });
		assert.deepEqual(resolvePiDirs({}, { agentDir: "/settings/agent" }, env, "/work"), {
			agentDir: "/settings/agent",
			sessionDir: "/env/sessions",
		});
		assert.deepEqual(
			resolvePiDirs({ agentDir: "flag", sessionDir: "" }, { sessionDir: "/settings/sessions" }, env, "/work"),
			{ agentDir: "/work/flag", sessionDir: "/settings/sessions" },
		);
	});

	test("maps directories to the environment pi reads", () => {
		assert.deepEqual(piDirsEnv({}), {});
		assert.deepEqual(piDirsEnv({ agentDir: "/a", sessionDir: "/s" }), {
			PI_CODING_AGENT_DIR: "/a",
			PI_CODING_AGENT_SESSION_DIR: "/s",
		});
	});

	test("settings may hold agentDir and sessionDir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-dirs-"));
		try {
			const path = join(dir, "settings.json");
			await writeFile(path, JSON.stringify({ port: 1, token: "t", agentDir: "~/.av-pi/agent", sessionDir: 3 }));
			const { settings } = await loadSettings(path);
			assert.equal(settings.agentDir, "~/.av-pi/agent");
			assert.equal(settings.sessionDir, undefined, "non-string values are ignored");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
