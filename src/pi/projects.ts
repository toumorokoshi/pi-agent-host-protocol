import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { ProjectInfo } from "@microsoft/agent-host-protocol";
import { fileUri } from "../core/uris.ts";

/**
 * The project a session reports, which VS Code's Agents window uses to name and group sessions.
 * Without one it falls back to the last part of the working directory, so two `cruise` checkouts
 * in different workspaces share one group. See specs/projects.md.
 */

/** Where the session's working directory sits, as far as naming it goes. */
export interface ProjectContext {
	readonly home: string;
	/** The nearest directory at or above the working directory that holds `.git`, if any. */
	readonly gitRoot: string | undefined;
}

/**
 * The project for a working directory, by the first rule that applies:
 * 1. under `~/workspaces/<ws>/`: that workspace, named `<ws>`;
 * 2. under `~/.cache/cfs/workspaces/<name>/worktree`: that CFS workspace, named `<name>`;
 * 3. inside a git repository: the repository, named `<parent>/<repo>`;
 * 4. otherwise the directory itself, named by its path relative to home (`~/…`), or absolute.
 */
export function projectFor(cwd: string, context: ProjectContext): ProjectInfo {
	const { home, gitRoot } = context;
	const inHome = relative(home, cwd);
	const parts = inHome && !inHome.startsWith("..") ? inHome.split(sep) : [];
	if (parts[0] === "workspaces" && parts[1]) {
		return { uri: fileUri(join(home, "workspaces", parts[1])), displayName: parts[1] };
	}
	if (parts[0] === ".cache" && parts[1] === "cfs" && parts[2] === "workspaces" && parts[3]) {
		return { uri: fileUri(join(home, ".cache", "cfs", "workspaces", parts[3])), displayName: parts[3] };
	}
	if (gitRoot) {
		const parent = basename(dirname(gitRoot));
		return { uri: fileUri(gitRoot), displayName: parent ? `${parent}/${basename(gitRoot)}` : basename(gitRoot) };
	}
	return { uri: fileUri(cwd), displayName: parts.length > 0 ? `~/${parts.join("/")}` : cwd };
}

/**
 * The nearest directory below home at or above `cwd` that holds `.git` (a directory or a
 * worktree's file). Home itself and anything above it never count: a dotfiles repository at `~`
 * would otherwise put every plain folder under home in one project.
 */
export function findGitRoot(cwd: string, home = homedir()): string | undefined {
	let dir = cwd;
	for (;;) {
		const parent = dirname(dir);
		if (parent === dir || dir === home) return undefined;
		if (existsSync(join(dir, ".git"))) return dir;
		dir = parent;
	}
}

const PROJECT_CACHE_MS = 60_000;
/** Enough for every session on a busy machine; the oldest entries go first. */
const PROJECT_CACHE_MAX = 1_000;
const projects = new Map<string, { at: number; project: ProjectInfo }>();

/**
 * The project for a working directory on this machine. Session lists ask for every session, so
 * each directory's answer is kept for a minute (finding a git root reads the directories above it),
 * in a cache of at most `PROJECT_CACHE_MAX` directories.
 *
 * The lookup stays synchronous: `summary()` and the catalog build summaries synchronously, and an
 * uncached lookup is a handful of `existsSync` calls on directories the session already uses.
 */
export function projectOf(cwd: string, home = homedir(), now = Date.now()): ProjectInfo {
	const cached = projects.get(cwd);
	if (cached && now - cached.at < PROJECT_CACHE_MS) return cached.project;
	const project = projectFor(cwd, { home, gitRoot: findGitRoot(cwd, home) });
	projects.delete(cwd);
	projects.set(cwd, { at: now, project });
	for (const key of projects.keys()) {
		if (projects.size <= PROJECT_CACHE_MAX) break;
		projects.delete(key);
	}
	return project;
}

/** Entries in the project cache (tests check it stays bounded). */
export function projectCacheSize(): number {
	return projects.size;
}
