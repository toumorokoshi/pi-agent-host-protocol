import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface HostSettings {
	host: string;
	/** 0 picks a free port on first run, which is then persisted. */
	port: number;
	/** `null` disables the connection token. */
	token: string | null;
}

export function settingsPath(): string {
	const dir = process.env.PI_AGENT_HOST_DIR;
	if (dir && !isAbsolute(dir)) throw new Error("PI_AGENT_HOST_DIR must be an absolute path");
	return join(dir ?? join(homedir(), ".pi", "agent-host"), "settings.json");
}

/** Reads `~/.pi/agent-host/settings.json`, creating it with a random token on first run. */
export async function loadSettings(path = settingsPath()): Promise<{ settings: HostSettings; created: boolean }> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as Partial<HostSettings>;
		return {
			settings: {
				host: typeof raw.host === "string" ? raw.host : "127.0.0.1",
				port: typeof raw.port === "number" ? raw.port : 0,
				token: raw.token === null ? null : typeof raw.token === "string" ? raw.token : randomToken(),
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
