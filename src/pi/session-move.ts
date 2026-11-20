import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface MoveSessionOptions {
	agentDir?: string;
	sessionDir?: string;
}

/**
 * Rewrites the `cwd` field of a pi JSONL session file's header line without
 * touching any subsequent entries.
 */
export function rewriteSessionHeaderCwd(content: string, newCwd: string): string {
	const nl = content.indexOf("\n");
	const firstLine = nl === -1 ? content : content.slice(0, nl);
	let parsed: unknown;
	try {
		parsed = JSON.parse(firstLine);
	} catch {
		throw new Error("Invalid pi session header: malformed JSON");
	}
	if (typeof parsed !== "object" || parsed === null || (parsed as { type?: unknown }).type !== "session") {
		throw new Error("Invalid pi session header: missing session header");
	}
	const updatedHeader = { ...(parsed as Record<string, unknown>), cwd: newCwd };
	return `${JSON.stringify(updatedHeader)}${nl === -1 ? "" : content.slice(nl)}`;
}

function defaultSessionDir(cwd: string, agentDir?: string): string {
	if (!agentDir) return SessionManager.create(cwd).getSessionDir();
	const resolvedCwd = resolve(cwd);
	const resolvedAgentDir = resolve(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

/**
 * Moves a pi `SessionManager` to `newCwd`, updating its session file header and
 * relocating the file into `newCwd`'s default session directory when pi groups
 * sessions per working directory.
 */
export async function moveSessionManager(
	manager: SessionManager,
	newCwd: string,
	options: MoveSessionOptions = {},
): Promise<SessionManager> {
	const resolvedCwd = resolve(newCwd);
	const oldFile = manager.getSessionFile();
	if (!oldFile || !existsSync(oldFile)) {
		const next = SessionManager.create(resolvedCwd, options.sessionDir, { id: manager.getSessionId() });
		const name = manager.getSessionName();
		if (name) next.appendSessionInfo(name);
		return next;
	}

	const content = await readFile(oldFile, "utf8");
	const updated = rewriteSessionHeaderCwd(content, resolvedCwd);
	const targetFile =
		options.sessionDir || !manager.usesDefaultSessionDir()
			? oldFile
			: join(defaultSessionDir(resolvedCwd, options.agentDir), basename(oldFile));

	await mkdir(dirname(targetFile), { recursive: true });
	const tmpFile = join(dirname(targetFile), `.${basename(targetFile)}.tmp-${process.pid}-${crypto.randomUUID()}`);
	await writeFile(tmpFile, updated, "utf8");
	await rename(tmpFile, targetFile);
	if (resolve(targetFile) !== resolve(oldFile)) {
		await unlink(oldFile).catch(() => {});
	}
	return SessionManager.open(targetFile, options.sessionDir);
}
