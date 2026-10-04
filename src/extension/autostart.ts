import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The host's entry point in this package (`.ts` from source, `.js` once built). */
export function hostBinPath(): string {
	const here = fileURLToPath(import.meta.url);
	return join(dirname(here), "..", "bin", `pi-agent-host-protocol${extname(here)}`);
}

/**
 * Starts the host in the background, detached from this pi process so it
 * outlives the terminal. Its output (including the URL) goes to `logFile`.
 */
export function startHostDetached(logFile: string): void {
	mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
	const fd = openSync(logFile, "a", 0o600);
	const { PI_AGENT_HOST_PROTOCOL_DAEMON: _daemon, ...env } = process.env;
	try {
		spawn(process.execPath, [hostBinPath()], {
			detached: true,
			stdio: ["ignore", fd, fd],
			env,
			cwd: homedir(),
		}).unref();
	} finally {
		closeSync(fd);
	}
}
