import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type PiMode, parsePiMode } from "../pi/agent.ts";

export interface HostSettings {
	host: string;
	/** 0 picks a free port on first run, which is then persisted. */
	port: number;
	/** `null` disables the connection token. */
	token: string | null;
	/** How to run pi (`rpc` when unset). */
	piMode?: PiMode;
	/** The `pi` executable for RPC mode (`pi` on `PATH` when unset). */
	pi?: string;
	/** pi's agent directory (see `--agent-dir`). */
	agentDir?: string;
	/** A flat pi session directory (see `--session-dir`). */
	sessionDir?: string;
	/** Minutes before an idle session's pi process is stopped (see `--idle-timeout`). */
	idleTimeoutMinutes?: number;
}

export function settingsPath(): string {
	const dir = process.env.PI_AGENT_HOST_PROTOCOL_DIR;
	if (dir && !isAbsolute(dir)) throw new Error("PI_AGENT_HOST_PROTOCOL_DIR must be an absolute path");
	return join(dir ?? join(homedir(), ".pi", "agent-host-protocol"), "settings.json");
}

/** Where settings lived before the project was renamed from `pi-agent-host`. */
export function legacySettingsPath(): string {
	return join(homedir(), ".pi", "agent-host", "settings.json");
}

/**
 * Copies the settings of the project's old name (`~/.pi/agent-host`) to the
 * new location if there are none there yet, so the port and token, and
 * therefore the URL already added to VS Code, stay the same. Returns whether
 * it copied.
 */
export async function migrateSettings(from = legacySettingsPath(), to = settingsPath()): Promise<boolean> {
	try {
		await readFile(to);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		await mkdir(dirname(to), { recursive: true, mode: 0o700 });
		await copyFile(from, to);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Reads `~/.pi/agent-host-protocol/settings.json`, creating it with a random token on first run. */
export async function loadSettings(path = settingsPath()): Promise<{ settings: HostSettings; created: boolean }> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as Partial<HostSettings>;
		return {
			settings: {
				host: typeof raw.host === "string" ? raw.host : "127.0.0.1",
				port: typeof raw.port === "number" ? raw.port : 0,
				token: raw.token === null ? null : typeof raw.token === "string" ? raw.token : randomToken(),
				...(typeof raw.piMode === "string" ? { piMode: parsePiMode(raw.piMode) } : {}),
				...(typeof raw.pi === "string" ? { pi: raw.pi } : {}),
				...(typeof raw.agentDir === "string" ? { agentDir: raw.agentDir } : {}),
				...(typeof raw.sessionDir === "string" ? { sessionDir: raw.sessionDir } : {}),
				...(typeof raw.idleTimeoutMinutes === "number" ? { idleTimeoutMinutes: raw.idleTimeoutMinutes } : {}),
			},
			created: false,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const settings: HostSettings = { host: "127.0.0.1", port: 0, token: randomToken() };
		return { settings, created: true };
	}
}

export async function saveSettings(settings: HostSettings, path = settingsPath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function randomToken(): string {
	return randomBytes(24).toString("base64url");
}
