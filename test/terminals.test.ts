import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { type TerminalContentPart, TerminalLifecycleStatus } from "@microsoft/agent-host-protocol";
import { clientPath, watchFilter } from "../src/host/resource-watches.ts";
import { defaultShell, shellEnv, trimContent } from "../src/host/terminals.ts";
import { startHost, TestClient, type TestHost } from "./helpers.ts";

describe("terminal helpers", () => {
	test("trimContent keeps the newest output within the limit", () => {
		const content: TerminalContentPart[] = [
			{ type: "unclassified", value: "aaaa" },
			{ type: "unclassified", value: "bbbb" },
		];
		assert.equal(trimContent(content, 100), content);
		assert.deepEqual(trimContent(content, 6), [
			{ type: "unclassified", value: "aa" },
			{ type: "unclassified", value: "bbbb" },
		]);
		assert.deepEqual(trimContent(content, 3), [{ type: "unclassified", value: "bbb" }]);
	});

	test("shellEnv sets TERM and drops the host marker", () => {
		const env = shellEnv({ PATH: "/bin", PI_AGENT_HOST_PROTOCOL_DAEMON: "1", EMPTY: undefined });
		assert.deepEqual(env, { PATH: "/bin", TERM: "xterm-256color" });
	});

	test("defaultShell prefers $SHELL", () => {
		assert.equal(defaultShell({ SHELL: "/bin/zsh" }, "darwin"), "/bin/zsh");
		assert.equal(defaultShell({}, "linux"), "/bin/sh");
		assert.equal(defaultShell({ COMSPEC: "cmd.exe" }, "win32"), "cmd.exe");
	});
});

describe("watch filter", () => {
	const root = "/w";
	test("non-recursive watches report direct children only", () => {
		const accept = watchFilter({ root, isFile: false, recursive: false });
		assert.equal(accept("/w/a.ts"), true);
		assert.equal(accept("/w/dir/a.ts"), false);
		assert.equal(accept("/other/a.ts"), false);
	});

	test("excludes hide matching paths and everything below them", () => {
		const accept = watchFilter({ root, isFile: false, recursive: true, excludes: ["**/node_modules", "**/*.log"] });
		assert.equal(accept("/w/src/a.ts"), true);
		assert.equal(accept("/w/node_modules/x/index.js"), false);
		assert.equal(accept("/w/pkg/node_modules/y.js"), false);
		assert.equal(accept("/w/debug.log"), false);
	});

	test("includes restrict reported paths", () => {
		const accept = watchFilter({ root, isFile: false, recursive: true, includes: ["**/*.ts"] });
		assert.equal(accept("/w/src/a.ts"), true);
		assert.equal(accept("/w/src/a.js"), false);
	});

	test("maps symlink-resolved paths back under the requested root", () => {
		assert.equal(clientPath("/private/var/w/a.ts", "/private/var/w", "/var/w"), "/var/w/a.ts");
		assert.equal(clientPath("/private/var/wx/a.ts", "/private/var/w", "/var/w"), "/private/var/wx/a.ts");
	});

	test("file watches report only that file", () => {
		const accept = watchFilter({ root: "/w/a.ts", isFile: true, recursive: false });
		assert.equal(accept("/w/a.ts"), true);
		assert.equal(accept("/w/b.ts"), false);
	});
});

describe("terminal channel", () => {
	let host: TestHost;
	let client: TestClient;
	const shell = process.env.SHELL;
	before(async () => {
		process.env.SHELL = "/bin/sh";
		host = await startHost();
		client = await TestClient.connect(host.url);
		await client.initialize();
	});
	after(async () => {
		process.env.SHELL = shell;
		client.close();
		await host.cleanup();
	});

	test("runs a shell that echoes input, resizes, exits and is disposed", async () => {
		// VS Code chooses terminal URIs in its own scheme.
		const terminal = `agenthost-terminal:/${crypto.randomUUID()}`;
		await client.request("createTerminal", {
			channel: terminal,
			claim: { kind: "client", clientId: client.clientId },
			cwd: pathToFileURL(host.cwd).href,
			cols: 100,
			rows: 30,
		});
		await client.waitFor(
			(m) => m.params?.action?.type === "root/terminalsChanged" && m.params.action.terminals.length === 1,
		);
		assert.equal(client.root?.terminals?.[0]?.resource, terminal);

		const snapshot = await client.request("subscribe", { channel: terminal });
		assert.equal(snapshot.snapshot.state.isPty, true);
		assert.equal(snapshot.snapshot.state.cols, 100);

		client.dispatch(terminal, { type: "terminal/input", data: "echo hello-$((40+2))\r" });
		await client.waitFor((m) => {
			if (m.params?.channel !== terminal) return false;
			const output = client.envelopes
				.filter((envelope) => envelope.channel === terminal && envelope.action.type === "terminal/data")
				.map((envelope) => (envelope.action as { data: string }).data)
				.join("");
			return output.includes("hello-42");
		});

		const resized = client.dispatch(terminal, { type: "terminal/resized", cols: 120, rows: 40 });
		const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === resized);
		assert.equal(echo.params.rejectionReason, undefined);

		client.dispatch(terminal, { type: "terminal/input", data: "exit 3\r" });
		const exited = await client.waitFor((m) => m.params?.action?.type === "terminal/exited");
		assert.equal(exited.params.action.exitCode, 3);
		await client.waitFor(
			(m) =>
				m.params?.action?.type === "root/terminalsChanged" &&
				m.params.action.terminals[0]?.lifecycle.status === TerminalLifecycleStatus.Exited,
		);

		await client.request("disposeTerminal", { channel: terminal });
		await client.waitFor(
			(m) => m.params?.action?.type === "root/terminalsChanged" && m.params.action.terminals.length === 0,
		);
		await assert.rejects(client.request("subscribe", { channel: terminal }));
	});

	test("rejects server-only terminal actions", async () => {
		const terminal = `agenthost-terminal:/${crypto.randomUUID()}`;
		await client.request("createTerminal", { channel: terminal, claim: { kind: "client", clientId: client.clientId } });
		const seq = client.dispatch(terminal, { type: "terminal/data", data: "spoofed" });
		const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === seq);
		assert.match(echo.params.rejectionReason, /Unsupported action/);
		await client.request("disposeTerminal", { channel: terminal });
	});
});

describe("resource watch channel", () => {
	let host: TestHost;
	let client: TestClient;
	before(async () => {
		host = await startHost();
		client = await TestClient.connect(host.url);
		await client.initialize();
	});
	after(async () => {
		client.close();
		await host.cleanup();
	});

	test("reports file changes, honours excludes, and is released on unsubscribe", async () => {
		await mkdir(join(host.cwd, "ignored"), { recursive: true });
		const { channel } = await client.request("createResourceWatch", {
			channel: "ahp-root://",
			uri: pathToFileURL(host.cwd).href,
			recursive: true,
			excludes: { items: ["**/ignored"] },
		});
		assert.match(channel, /^ahp-resource-watch:\//);
		const { snapshot } = await client.request("subscribe", { channel });
		assert.equal(snapshot.state.recursive, true);

		await writeFile(join(host.cwd, "ignored", "skip.txt"), "x");
		const watched = join(host.cwd, "watched.txt");
		await writeFile(watched, "x");
		const change = await client.waitFor(
			(m) =>
				m.params?.channel === channel &&
				m.params.action.changes.items.some((item: { uri: string }) => item.uri.endsWith("/watched.txt")),
		);
		assert.equal(change.params.action.type, "resourceWatch/changed");
		const reported = client.envelopes
			.filter((envelope) => envelope.channel === channel)
			.flatMap((envelope) => (envelope.action as { changes: { items: { uri: string }[] } }).changes.items);
		assert.ok(!reported.some((item) => item.uri.includes("/ignored/")), "excluded paths are not reported");

		client.notifyUnsubscribe(channel);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await assert.rejects(client.request("subscribe", { channel }), "the watch is released");
	});

	test("rejects watching a missing path", async () => {
		await assert.rejects(
			client.request("createResourceWatch", {
				channel: "ahp-root://",
				uri: pathToFileURL(join(host.cwd, "missing")).href,
			}),
			(error: any) => error.code === -32008,
		);
	});
});
