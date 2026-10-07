import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { MessageAttachmentKind, MessageKind } from "@microsoft/agent-host-protocol";
import { fileUri } from "../src/core/uris.ts";
import {
	completionMeta,
	containerDir,
	slashCompletions,
	toCustomizations,
	type UserCommand,
	userCommands,
	withFrontmatter,
	withFrontmatterFields,
} from "../src/pi/customizations.ts";
import { promptInput } from "../src/pi/pi-session.ts";
import { newSession, PI_MODES, startHost, TestClient, type TestHost } from "./helpers.ts";

function info(name: string, source: SlashCommandInfo["source"], path: string, baseDir?: string): SlashCommandInfo {
	return {
		name,
		description: `${name} description`,
		source,
		sourceInfo: { path, source: "auto", scope: "user", origin: "top-level", ...(baseDir ? { baseDir } : {}) },
	};
}

const SKILL: UserCommand = {
	name: "skill:pdf",
	description: "Work with PDFs",
	kind: "skill",
	path: "/home/u/.pi/agent/skills/pdf/SKILL.md",
	baseDir: "/home/u/.pi/agent",
};
const NESTED_SKILL: UserCommand = {
	name: "skill:inner",
	kind: "skill",
	path: "/home/u/.pi/agent/skills/group/inner/SKILL.md",
	baseDir: "/home/u/.pi/agent",
};
const PROMPT: UserCommand = {
	name: "fix-tests",
	description: "Fix failing tests",
	kind: "prompt",
	path: "/home/u/.pi/agent/prompts/fix-tests.md",
	baseDir: "/home/u/.pi/agent",
};
const LOOSE_SKILL: UserCommand = { name: "skill:loose", kind: "skill", path: "/opt/skills/loose/SKILL.md" };

describe("pi commands as customizations", () => {
	test("keeps skills and prompt templates and drops extension commands", () => {
		const commands = userCommands([
			info("mcp", "extension", "builtin:mcp"),
			info("skill:pdf", "skill", SKILL.path, SKILL.baseDir),
			info("fix-tests", "prompt", PROMPT.path, PROMPT.baseDir),
		]);
		assert.deepEqual(
			commands.map((command) => [command.name, command.kind, command.baseDir]),
			[
				["skill:pdf", "skill", "/home/u/.pi/agent"],
				["fix-tests", "prompt", "/home/u/.pi/agent"],
			],
		);
	});

	test("groups each command under the folder pi discovered it in", () => {
		assert.equal(containerDir(SKILL), "/home/u/.pi/agent/skills");
		assert.equal(containerDir(NESTED_SKILL), "/home/u/.pi/agent/skills");
		assert.equal(containerDir(PROMPT), "/home/u/.pi/agent/prompts");
		assert.equal(containerDir(LOOSE_SKILL), "/opt/skills");
		assert.equal(containerDir({ ...PROMPT, baseDir: undefined }), "/home/u/.pi/agent/prompts");
	});

	test("publishes one read-only directory per folder and kind, children sorted by name", () => {
		const [skills, prompts, loose] = toCustomizations([
			SKILL,
			PROMPT,
			{ ...NESTED_SKILL, disableModelInvocation: true },
			LOOSE_SKILL,
		]);
		assert.deepEqual(skills, {
			type: "directory",
			id: "skill:/home/u/.pi/agent/skills",
			uri: fileUri("/home/u/.pi/agent/skills"),
			name: "/home/u/.pi/agent/skills",
			enabled: true,
			writable: false,
			contents: "skill",
			load: { kind: "loaded" },
			children: [
				{
					type: "skill",
					id: fileUri(NESTED_SKILL.path),
					uri: fileUri(NESTED_SKILL.path),
					name: "inner",
					disableModelInvocation: true,
				},
				{
					type: "skill",
					id: fileUri(SKILL.path),
					uri: fileUri(SKILL.path),
					name: "pdf",
					description: "Work with PDFs",
				},
			],
		});
		assert.equal(prompts?.contents, "prompt");
		assert.deepEqual(prompts?.children, [
			{
				type: "prompt",
				id: fileUri(PROMPT.path),
				uri: fileUri(PROMPT.path),
				name: "fix-tests",
				description: "Fix failing tests",
			},
		]);
		assert.equal(loose?.name, "/opt/skills");
	});

	test("reads argument-hint from frontmatter and ignores empty or non-string hints", () => {
		assert.equal(withFrontmatterFields(PROMPT, { "argument-hint": " <file> " }).argumentHint, "<file>");
		assert.equal(withFrontmatterFields(SKILL, { "argument-hint": "[topic]" }).argumentHint, "[topic]");
		assert.equal(withFrontmatterFields(PROMPT, { "argument-hint": "  " }).argumentHint, undefined);
		assert.equal(withFrontmatterFields(PROMPT, { "argument-hint": 3 }).argumentHint, undefined);
		assert.equal(withFrontmatterFields(PROMPT, { "disable-model-invocation": true }).disableModelInvocation, undefined);
	});

	test("reads disable-model-invocation from SKILL.md", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-skill-"));
		try {
			const manual = join(dir, "manual.md");
			const auto = join(dir, "auto.md");
			await writeFile(manual, "---\nname: manual\ndescription: d\ndisable-model-invocation: true\n---\nbody\n");
			await writeFile(auto, "---\nname: auto\ndescription: d\n---\nbody\n");
			const [first, second, missing, prompt] = await withFrontmatter([
				{ ...SKILL, path: manual },
				{ ...SKILL, path: auto },
				{ ...SKILL, path: join(dir, "missing.md") },
				{ ...PROMPT, path: manual },
			]);
			assert.equal(first?.disableModelInvocation, true);
			assert.equal(second?.disableModelInvocation, undefined);
			assert.equal(missing?.disableModelInvocation, undefined);
			assert.equal(prompt?.disableModelInvocation, undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("slash completions", () => {
	const commands = [SKILL, PROMPT, NESTED_SKILL];

	test("lists every command for a bare slash", () => {
		assert.deepEqual(
			slashCompletions(commands, "/", 1).map((item) => item.insertText),
			["/fix-tests ", "/skill:inner ", "/skill:pdf "],
		);
	});

	test("matches skill names with or without the skill: prefix", () => {
		assert.deepEqual(
			slashCompletions(commands, "/pd", 3).map((item) => item.insertText),
			["/skill:pdf "],
		);
		assert.deepEqual(
			slashCompletions(commands, "/SKILL:i", 8).map((item) => item.insertText),
			["/skill:inner "],
		);
	});

	test("replaces the whole word around the cursor with a simple attachment", () => {
		const [item] = slashCompletions(commands, "/fixes now", 2);
		assert.deepEqual(item, {
			insertText: "/fix-tests ",
			rangeStart: 0,
			rangeEnd: 6,
			attachment: {
				type: "simple",
				label: "/fix-tests",
				_meta: { command: "fix-tests", description: "Fix failing tests" },
			},
		});
	});

	test("describes skills as skill references and prompts as commands", () => {
		assert.deepEqual(completionMeta(SKILL), {
			uri: fileUri(SKILL.path),
			name: "pdf",
			displayName: "skill:pdf",
			description: "Work with PDFs",
		});
		assert.deepEqual(completionMeta(NESTED_SKILL), {
			uri: fileUri(NESTED_SKILL.path),
			name: "inner",
			displayName: "skill:inner",
		});
		assert.deepEqual(completionMeta({ ...PROMPT, argumentHint: "<file>" }), {
			command: "fix-tests",
			description: "Fix failing tests",
			argumentHint: "<file>",
		});
	});

	test("only completes a slash at the start of the message", () => {
		assert.deepEqual(slashCompletions(commands, "run /pdf", 8), []);
		assert.deepEqual(slashCompletions(commands, " /pdf", 5), []);
		assert.deepEqual(slashCompletions(commands, "/pdf x", 6), []);
	});
});

for (const mode of PI_MODES) {
	describe(`skills in sessions (${mode})`, () => {
		let host: TestHost;
		let client: TestClient;
		before(async () => {
			host = await startHost({ mode });
			const agentDir = join(host.dir, "agent");
			await mkdir(join(agentDir, "skills", "demo"), { recursive: true });
			await writeFile(
				join(agentDir, "skills", "demo", "SKILL.md"),
				"---\nname: demo\ndescription: A demo skill\ndisable-model-invocation: true\n---\nSay demo.\n",
			);
			await mkdir(join(agentDir, "prompts"), { recursive: true });
			await writeFile(
				join(agentDir, "prompts", "review.md"),
				"---\ndescription: Review the code\nargument-hint: <path>\n---\nReview $1.\n",
			);
			client = await TestClient.connect(host.url);
			await client.initialize();
		});
		after(async () => {
			client.close();
			await host.cleanup();
		});

		test("advertises / as a completion trigger", async () => {
			const other = await TestClient.connect(host.url);
			const result = await other.initialize();
			assert.deepEqual(result.completionTriggerCharacters, ["/"]);
			other.close();
		});

		test("publishes pi's skills and prompts as session customizations", async () => {
			const { session } = await newSession(host, client);
			const state = client.sessions.get(session);
			if (!state?.customizations?.length) await client.waitForAction("session/customizationsChanged");
			const customizations = client.sessions.get(session)?.customizations ?? [];
			const skills = customizations.find((entry) => entry.uri === fileUri(join(host.dir, "agent", "skills")));
			assert.equal(skills?.type, "directory");
			const demo = skills && "children" in skills ? skills.children?.find((child) => child.name === "demo") : undefined;
			assert.deepEqual(demo, {
				type: "skill",
				id: fileUri(join(host.dir, "agent", "skills", "demo", "SKILL.md")),
				uri: fileUri(join(host.dir, "agent", "skills", "demo", "SKILL.md")),
				name: "demo",
				description: "A demo skill",
				disableModelInvocation: true,
			});
			const prompts = customizations.find((entry) => entry.uri === fileUri(join(host.dir, "agent", "prompts")));
			assert.equal(prompts && "children" in prompts ? prompts.children?.[0]?.name : undefined, "review");
		});

		test("completes skills and prompts typed after a slash", async () => {
			const { chat } = await newSession(host, client);
			const result = await client.request("completions", {
				kind: "userMessage",
				channel: chat,
				text: "/dem",
				offset: 4,
			});
			assert.deepEqual(
				result.items.map((item: { insertText: string }) => item.insertText),
				["/skill:demo "],
			);
			assert.deepEqual(result.items[0].attachment._meta, {
				uri: fileUri(join(host.dir, "agent", "skills", "demo", "SKILL.md")),
				name: "demo",
				displayName: "skill:demo",
				description: "A demo skill",
			});
			const prompts = await client.request("completions", {
				kind: "userMessage",
				channel: chat,
				text: "/rev",
				offset: 4,
			});
			assert.deepEqual(
				prompts.items.map((item: { insertText: string }) => item.insertText),
				["/review "],
			);
			assert.deepEqual(prompts.items[0].attachment._meta, {
				command: "review",
				description: "Review the code",
				argumentHint: "<path>",
			});
		});

		test("returns no completions for unknown channels or other text", async () => {
			const { chat } = await newSession(host, client);
			assert.deepEqual(
				await client.request("completions", { kind: "userMessage", channel: chat, text: "hi", offset: 2 }),
				{
					items: [],
				},
			);
			assert.deepEqual(
				await client.request("completions", { kind: "userMessage", channel: "pi:/missing", text: "/", offset: 1 }),
				{ items: [] },
			);
		});
	});
}

describe("accepted completions in a sent message", () => {
	test("leave the /name text for pi and add nothing for the chip", () => {
		const input = promptInput({
			text: "/skill:pdf summarize",
			origin: { kind: MessageKind.User },
			attachments: [
				{
					type: MessageAttachmentKind.Simple,
					label: "/skill:pdf",
					displayKind: "skill",
					_meta: completionMeta(SKILL),
				},
			],
		});
		assert.deepEqual(input, { text: "/skill:pdf summarize", images: [] });
	});
});
