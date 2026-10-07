/**
 * pi's skills and prompt templates as AHP session customizations and
 * slash-command completions. See specs/skills.md.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
	type ChildCustomization,
	type CompletionItem,
	CustomizationLoadStatus,
	CustomizationType,
	type DirectoryCustomization,
	MessageAttachmentKind,
} from "@microsoft/agent-host-protocol";
import { fileUri } from "../core/uris.ts";

/** Characters that ask the client for `completions`. pi expands `/name` only at the start of a message. */
export const COMPLETION_TRIGGER_CHARACTERS = ["/"];

const SKILL_PREFIX = "skill:";
const SKILL_FILE = "SKILL.md";

/** A command a user can type: a skill (`skill:<name>`) or a prompt template, with its file. */
export interface UserCommand {
	readonly name: string;
	readonly description?: string;
	readonly kind: "skill" | "prompt";
	/** The skill's `SKILL.md` or the template's markdown file. */
	readonly path: string;
	/** pi's resource base directory (for example `~/.pi/agent` or `<cwd>/.agents`). */
	readonly baseDir?: string;
	/** The skill's `disable-model-invocation` frontmatter flag. */
	readonly disableModelInvocation?: boolean;
	/** The `argument-hint` frontmatter field: what to type after the command. */
	readonly argumentHint?: string;
}

/**
 * Skills and prompt templates from pi's command list. Extension commands
 * are left out: they act on pi's own UI rather than starting a turn.
 */
export function userCommands(commands: readonly SlashCommandInfo[]): UserCommand[] {
	return commands.flatMap((command): UserCommand[] => {
		if (command.source !== "skill" && command.source !== "prompt") return [];
		const path = command.sourceInfo?.path;
		if (!path) return [];
		return [
			{
				name: command.name,
				...(command.description ? { description: command.description } : {}),
				kind: command.source,
				path,
				...(command.sourceInfo.baseDir ? { baseDir: command.sourceInfo.baseDir } : {}),
			},
		];
	});
}

/**
 * Adds the frontmatter details pi's command list does not carry: each
 * skill's `disable-model-invocation` flag and every command's
 * `argument-hint`. Unreadable files keep the command unchanged.
 */
export function withFrontmatter(commands: readonly UserCommand[]): Promise<UserCommand[]> {
	return Promise.all(
		commands.map(async (command) => {
			try {
				const { frontmatter } = parseFrontmatter(await readFile(command.path, "utf8"));
				return withFrontmatterFields(command, frontmatter);
			} catch {
				return command;
			}
		}),
	);
}

/** The command with the details read from its parsed frontmatter. */
export function withFrontmatterFields(command: UserCommand, frontmatter: Record<string, unknown>): UserCommand {
	const hint = frontmatter["argument-hint"];
	return {
		...command,
		...(command.kind === "skill" && frontmatter["disable-model-invocation"] === true
			? { disableModelInvocation: true }
			: {}),
		...(typeof hint === "string" && hint.trim().length > 0 ? { argumentHint: hint.trim() } : {}),
	};
}

function isWithin(dir: string, path: string): boolean {
	const rel = relative(dir, path);
	return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/");
}

/**
 * The directory a command was discovered in: `<baseDir>/skills` or
 * `<baseDir>/prompts` for pi's standard locations, otherwise the folder
 * holding the skill directory or template file.
 */
export function containerDir(command: UserCommand): string {
	const standard = command.baseDir && join(command.baseDir, command.kind === "skill" ? "skills" : "prompts");
	if (standard && isWithin(standard, command.path)) return standard;
	const fileDir = dirname(command.path);
	return command.kind === "skill" && basename(command.path) === SKILL_FILE ? dirname(fileDir) : fileDir;
}

function childCustomization(command: UserCommand): ChildCustomization {
	const uri = fileUri(command.path);
	const description = command.description ? { description: command.description } : {};
	if (command.kind === "prompt")
		return { type: CustomizationType.Prompt, id: uri, uri, name: command.name, ...description };
	return {
		type: CustomizationType.Skill,
		id: uri,
		uri,
		name: skillName(command),
		...description,
		...(command.disableModelInvocation ? { disableModelInvocation: true } : {}),
	};
}

/**
 * One read-only directory customization per discovery folder and kind, in
 * the order pi found them, each listing its skills or prompts by name.
 */
export function toCustomizations(commands: readonly UserCommand[]): DirectoryCustomization[] {
	const groups = new Map<string, { dir: string; kind: UserCommand["kind"]; commands: UserCommand[] }>();
	for (const command of commands) {
		const dir = containerDir(command);
		const key = `${command.kind}:${dir}`;
		const group = groups.get(key) ?? { dir, kind: command.kind, commands: [] };
		group.commands.push(command);
		groups.set(key, group);
	}
	return [...groups.entries()].map(([key, group]) => ({
		type: CustomizationType.Directory,
		id: key,
		uri: fileUri(group.dir),
		name: group.dir,
		enabled: true,
		writable: false,
		contents: group.kind === "skill" ? CustomizationType.Skill : CustomizationType.Prompt,
		load: { kind: CustomizationLoadStatus.Loaded },
		children: group.commands.map(childCustomization).sort((a, b) => a.name.localeCompare(b.name)),
	}));
}

/** The skill's name as users see it: the command name without `skill:`. */
function skillName(command: UserCommand): string {
	return command.name.startsWith(SKILL_PREFIX) ? command.name.slice(SKILL_PREFIX.length) : command.name;
}

/**
 * VS Code's completion details for a command, in the `_meta` shapes its own
 * agent hosts use: a skill reference (`uri`, `name`, `displayName`,
 * `description`) for skills, and a command (`command`, `description`,
 * `argumentHint`) for prompt templates. VS Code shows the description next
 * to the item, a chip for the accepted reference, and the argument hint as
 * placeholder text.
 */
export function completionMeta(command: UserCommand): Record<string, unknown> {
	const description = command.description ? { description: command.description } : {};
	if (command.kind === "skill") {
		return { uri: fileUri(command.path), name: skillName(command), displayName: command.name, ...description };
	}
	return {
		command: command.name,
		...description,
		...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
	};
}

function matches(command: UserCommand, query: string): boolean {
	const name = command.name.toLowerCase();
	return name.startsWith(query) || (name.startsWith(SKILL_PREFIX) && name.slice(SKILL_PREFIX.length).startsWith(query));
}

/**
 * Completions for a `/name` typed at the start of a message: every command
 * whose name (or skill name without `skill:`) starts with what was typed.
 * The item replaces the whole word around the cursor. Its attachment
 * carries the command's details for display but no model representation,
 * since pi expands the inserted `/name`.
 */
export function slashCompletions(commands: readonly UserCommand[], text: string, offset: number): CompletionItem[] {
	const typed = /^\/(\S*)$/.exec(text.slice(0, offset))?.[1];
	if (typed === undefined) return [];
	const end = text.slice(offset).search(/\s/);
	const rangeEnd = end === -1 ? text.length : offset + end;
	const query = typed.toLowerCase();
	return commands
		.filter((command) => matches(command, query))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((command) => ({
			insertText: `/${command.name} `,
			rangeStart: 0,
			rangeEnd,
			attachment: {
				type: MessageAttachmentKind.Simple,
				label: `/${command.name}`,
				_meta: completionMeta(command),
			},
		}));
}
