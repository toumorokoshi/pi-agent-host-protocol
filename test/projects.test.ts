import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fileUri, parseSessionUri } from "../src/core/uris.ts";
import { findGitRoot, projectCacheSize, projectFor, projectOf } from "../src/pi/projects.ts";
import { newSession, startHost, startTurn, TestClient } from "./helpers.ts";

const HOME = "/home/alice";

describe("projectFor", () => {
	test("names a ~/workspaces checkout after its workspace, so two cruise repos stay apart", () => {
		const a = projectFor(`${HOME}/workspaces/cruise-3/src/github.robot.car/cruise/cruise`, {
			home: HOME,
			gitRoot: `${HOME}/workspaces/cruise-3/src/github.robot.car/cruise/cruise`,
		});
		const b = projectFor(`${HOME}/workspaces/automedon-2/src/github.robot.car/cruise/cruise/projects/x`, {
			home: HOME,
			gitRoot: `${HOME}/workspaces/automedon-2/src/github.robot.car/cruise/cruise`,
		});
		assert.deepEqual(a, { uri: fileUri(`${HOME}/workspaces/cruise-3`), displayName: "cruise-3" });
		assert.deepEqual(b, { uri: fileUri(`${HOME}/workspaces/automedon-2`), displayName: "automedon-2" });
		assert.equal(projectFor(`${HOME}/workspaces/cruise-3`, { home: HOME, gitRoot: undefined }).displayName, "cruise-3");
	});

	test("names a CFS worktree after its workspace", () => {
		const project = projectFor(`${HOME}/.cache/cfs/workspaces/bolt-planfile/worktree/packages/plugins`, {
			home: HOME,
			gitRoot: `${HOME}/.cache/cfs/workspaces/bolt-planfile/worktree`,
		});
		assert.deepEqual(project, {
			uri: fileUri(`${HOME}/.cache/cfs/workspaces/bolt-planfile`),
			displayName: "bolt-planfile",
		});
	});

	test("names another git repository by its parent and its own name", () => {
		const project = projectFor(`${HOME}/src/pi-agent-host-protocol/src/pi`, {
			home: HOME,
			gitRoot: `${HOME}/src/pi-agent-host-protocol`,
		});
		assert.deepEqual(project, {
			uri: fileUri(`${HOME}/src/pi-agent-host-protocol`),
			displayName: "src/pi-agent-host-protocol",
		});
	});

	test("names anything else by its path from home, or its absolute path", () => {
		assert.deepEqual(projectFor(`${HOME}/plans`, { home: HOME, gitRoot: undefined }), {
			uri: fileUri(`${HOME}/plans`),
			displayName: "~/plans",
		});
		assert.equal(projectFor("/opt/data", { home: HOME, gitRoot: undefined }).displayName, "/opt/data");
		assert.equal(projectFor(HOME, { home: HOME, gitRoot: undefined }).displayName, HOME);
	});
});

describe("findGitRoot and projectOf", () => {
	test("finds the nearest .git directory or worktree file, and stops at home", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-projects-"));
		try {
			await mkdir(join(home, "src", "repo", ".git"), { recursive: true });
			await mkdir(join(home, "src", "repo", "a", "b"), { recursive: true });
			await mkdir(join(home, "src", "wt", "c"), { recursive: true });
			await writeFile(join(home, "src", "wt", ".git"), "gitdir: elsewhere\n");
			await mkdir(join(home, "plain"), { recursive: true });
			assert.equal(findGitRoot(join(home, "src", "repo", "a", "b"), home), join(home, "src", "repo"));
			assert.equal(findGitRoot(join(home, "src", "wt", "c"), home), join(home, "src", "wt"));
			assert.equal(findGitRoot(join(home, "plain"), home), undefined);
			assert.equal(projectOf(join(home, "src", "repo", "a"), home).displayName, "src/repo");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("findGitRoot with a repository at home", () => {
	test("does not treat home itself as the repository, so plain folders keep their own names", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-projects-"));
		try {
			await mkdir(join(home, ".git"), { recursive: true });
			await mkdir(join(home, "plans"), { recursive: true });
			await mkdir(join(home, "src", "repo", ".git"), { recursive: true });
			assert.equal(findGitRoot(join(home, "plans"), home), undefined);
			assert.equal(findGitRoot(home, home), undefined);
			assert.equal(findGitRoot(join(home, "src", "repo"), home), join(home, "src", "repo"));
			assert.equal(projectOf(join(home, "plans"), home).displayName, "~/plans");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("projectOf cache", () => {
	test("stays bounded however many directories are asked about", () => {
		for (let index = 0; index < 1_500; index++) projectOf(`/opt/bounded-cache/${index}`, HOME);
		assert.ok(projectCacheSize() <= 1_000, `cache holds ${projectCacheSize()} entries`);
		assert.equal(projectOf("/opt/bounded-cache/1499", HOME).displayName, "/opt/bounded-cache/1499");
	});
});

describe("sessions report their project", () => {
	test("in the session state, and in the catalog once the session has a turn", async () => {
		const host = await startHost({ mode: "embedded" });
		const client = await TestClient.connect(host.url);
		try {
			await client.initialize();
			const { session, chat } = await newSession(host, client);
			const expected = projectOf(host.cwd);
			assert.deepEqual(client.sessions.get(session)?.project, expected);

			host.faux.setResponses([fauxAssistantMessage("ok")]);
			const turnId = startTurn(client, chat, "Say ok");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
			const list = await client.request("listSessions", { channel: "ahp-root://" });
			const listed = list.items.find(
				(item: { resource: string }) => parseSessionUri(item.resource) === parseSessionUri(session),
			);
			assert.deepEqual(listed?.project, expected);
		} finally {
			client.close();
			await host.cleanup();
		}
	});
});
