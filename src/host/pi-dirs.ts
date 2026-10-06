import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Where pi keeps its state. Unset fields fall back to pi's own defaults. */
export interface PiDirs {
	/** pi's agent directory (`PI_CODING_AGENT_DIR`); sessions are grouped per cwd under `<agentDir>/sessions`. */
	agentDir?: string;
	/** A flat session directory, like pi's `--session-dir` (`PI_CODING_AGENT_SESSION_DIR`). */
	sessionDir?: string;
}

/** The environment variables pi reads these directories from. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/** Expands a leading `~` and makes the path absolute. */
export function expandPath(path: string, cwd = process.cwd(), home = homedir()): string {
	const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Picks pi's directories: command-line flags first, then settings, then the
 * environment pi itself reads. Returns only the directories that were set.
 */
export function resolvePiDirs(
	flags: PiDirs,
	settings: PiDirs,
	env: Record<string, string | undefined>,
	cwd = process.cwd(),
): PiDirs {
	const pick = (...candidates: (string | undefined)[]) => {
		const value = candidates.find((candidate) => candidate !== undefined && candidate !== "");
		return value === undefined ? undefined : expandPath(value, cwd);
	};
	const agentDir = pick(flags.agentDir, settings.agentDir, env[PI_AGENT_DIR_ENV]);
	const sessionDir = pick(flags.sessionDir, settings.sessionDir, env[PI_SESSION_DIR_ENV]);
	return { ...(agentDir ? { agentDir } : {}), ...(sessionDir ? { sessionDir } : {}) };
}

/**
 * The environment that makes pi use `dirs`. The host sets it on itself so that
 * pi's SDK (session listing, models) and every pi child it starts agree.
 */
export function piDirsEnv(dirs: PiDirs): Record<string, string> {
	return {
		...(dirs.agentDir ? { [PI_AGENT_DIR_ENV]: dirs.agentDir } : {}),
		...(dirs.sessionDir ? { [PI_SESSION_DIR_ENV]: dirs.sessionDir } : {}),
	};
}
