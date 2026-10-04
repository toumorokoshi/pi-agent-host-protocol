import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type IPty, spawn } from "@lydell/node-pty";
import { FAUX_EXTENSION, PI_CLI, startHost, startTurn, TestClient, type TestHost, vscodeChatUri } from "./helpers.ts";

const BRIDGE_EXTENSION = fileURLToPath(new URL("../src/extension/index.ts", import.meta.url));

/** Strips terminal escape sequences so assertions can read the TUI's text. */
function screenText(output: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes
	return output.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Starts an interactive pi in a pseudo-terminal, with the bridge extension and the faux model. */
function startTui(host: TestHost): { pty: IPty; output: () => string } {
	const { PI_AGENT_HOST_PROTOCOL_DAEMON: _daemon, ...env } = process.env;
	let output = "";
	const pty = spawn(
		process.execPath,
		[PI_CLI, "-e", FAUX_EXTENSION, "-e", BRIDGE_EXTENSION, "--provider", "faux", "--model", "faux-1"],
		{
			cols: 120,
			rows: 40,
			cwd: host.cwd,
			env: {
				...env,
				TERM: "xterm-256color",
				HOME: host.dir,
				PI_CODING_AGENT_DIR: join(host.dir, "agent"),
				PI_CODING_AGENT_SESSION_DIR: join(host.dir, "sessions"),
				PI_AGENT_HOST_PROTOCOL_DIR: host.dir,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_AGENT_HOST_PROTOCOL_FAUX_URL: host.fauxUrl!,
			},
		},
	);
	pty.onData((data) => {
		output += data;
	});
	return { pty, output: () => screenText(output) };
}

async function type(pty: IPty, text: string): Promise<void> {
	pty.write(text);
	await new Promise((resolve) => setTimeout(resolve, 200));
	pty.write("\r");
}

describe("a live pi TUI session in VS Code", () => {
	let host: TestHost;
	let client: TestClient;
	before(async () => {
		host = await startHost({ mode: "rpc", bridge: true });
		client = await TestClient.connect(host.url);
		await client.initialize();
	});
	after(async () => {
		client.close();
		await host.cleanup();
	});

	test("runs typed in the terminal and sent from VS Code both reach the other side", async () => {
		const tui = startTui(host);
		try {
			const added = await client.waitFor((m) => m.method === "root/sessionAdded", 20_000);
			const session = added.params.summary.resource as string;
			const chat = vscodeChatUri(session);
			await client.subscribe(chat);

			// Typed in the TUI: shows up in VS Code.
			host.faux.setResponses([fauxAssistantMessage("Hello from the terminal run")]);
			await type(tui.pty, "typed in the tui");
			const started = await client.waitFor(
				(m) => m.params?.action?.type === "chat/turnStarted" && m.params.action.message.text === "typed in the tui",
				20_000,
			);
			assert.equal(started.params.origin, undefined);
			await client.waitFor(
				(m) =>
					m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === started.params.action.turnId,
				20_000,
			);
			assert.equal(
				client.chats
					.get(chat)!
					.turns.at(-1)!
					.responseParts.find((part) => part.kind === "markdown")?.content,
				"Hello from the terminal run",
			);

			// Sent from VS Code: runs in the TUI, which shows it.
			host.faux.setResponses([fauxAssistantMessage("Answer shown in the terminal")]);
			const turnId = startTurn(client, chat, "asked from vscode");
			await client.waitFor(
				(m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId,
				20_000,
			);
			await waitUntil(() => tui.output().includes("Answer shown in the terminal"));
			assert.ok(tui.output().includes("asked from vscode"), "the TUI shows the prompt from VS Code");
			assert.equal(client.chats.get(chat)!.turns.length, 2, "the VS Code run is not counted twice");

			// The TUI quits: the session continues in a pi started by the host.
			tui.pty.kill();
			await waitUntil(() => client.chats.get(chat)!.activeTurn === undefined);
			await new Promise((resolve) => setTimeout(resolve, 200));
			host.faux.setResponses([fauxAssistantMessage("Continued by the host")]);
			const next = startTurn(client, chat, "after the terminal closed");
			await client.waitFor(
				(m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === next,
				20_000,
			);
			assert.equal(client.chats.get(chat)!.turns.at(-1)!.responseParts.at(-1)?.kind, "markdown");
		} finally {
			tui.pty.kill();
		}
	});
});

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
