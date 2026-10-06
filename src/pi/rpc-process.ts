import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Logger } from "../core/logger.ts";
import { JsonlChannel } from "./rpc-channel.ts";

export interface RpcProcessOptions {
	/** The `pi` executable, or a `.js`/`.ts` CLI entry point run with this Node. */
	command: string;
	/** Arguments after `--mode rpc`. */
	args: readonly string[];
	cwd: string;
	env?: Record<string, string>;
	logger: Logger;
	/** Log fields identifying this process. */
	logFields?: Record<string, unknown>;
}

/** The `pi` executable could not be started at all (for example, it is not installed). */
export class PiStartError extends Error {}

const STDERR_TAIL = 2_000;
const STOP_GRACE_MS = 2_000;
const SCRIPT_EXTENSIONS = /\.(c|m)?(j|t)s$/;

/** The executable and leading arguments that run `command` (scripts run with this Node). */
export function spawnCommand(command: string): { file: string; args: string[] } {
	return SCRIPT_EXTENSIONS.test(command) ? { file: process.execPath, args: [command] } : { file: command, args: [] };
}

/** A started `pi --mode rpc` child: its pid, and an `RpcChannel` on its stdio. */
export interface RpcProcess {
	/** Undefined if the process could not be started (the channel then closes with a `PiStartError`). */
	readonly pid: number | undefined;
	readonly channel: JsonlChannel;
}

/**
 * Starts one `pi --mode rpc` child.
 * Closing the channel shuts pi down: stdin is closed (pi's orderly
 * shutdown), then SIGTERM and SIGKILL follow if pi does not exit.
 */
export function spawnRpcProcess(options: RpcProcessOptions): RpcProcess {
	const { logger } = options;
	const logFields = options.logFields ?? {};
	const { file, args } = spawnCommand(options.command);
	const child: ChildProcessWithoutNullStreams = spawn(file, [...args, "--mode", "rpc", ...options.args], {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	const channel = new JsonlChannel(
		{
			write: (text) => child.stdin.write(text),
			close: async () => {
				const exited = new Promise<void>((resolve) => channel.onClose(() => resolve()));
				child.stdin.end();
				for (const signal of ["SIGTERM", "SIGKILL"] as const) {
					const done = await Promise.race([exited.then(() => true), delay(STOP_GRACE_MS).then(() => false)]);
					if (done) return;
					child.kill(signal);
				}
				await exited;
			},
		},
		{ onInvalid: (line) => logger.debug("pi wrote a non-JSON line", { ...logFields, line: line.slice(0, 200) }) },
	);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => channel.push(chunk));
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-STDERR_TAIL);
		for (const line of chunk.split("\n")) {
			if (line.trim()) logger.debug("pi stderr", { ...logFields, line: line.trim() });
		}
	});
	child.stdin.on("error", () => {});
	child.once("error", (error) =>
		channel.end(new PiStartError(`Could not start pi (${options.command}): ${error.message}`)),
	);
	child.once("exit", (code, signal) => {
		const status = signal ? `signal ${signal}` : `code ${code}`;
		const detail = stderr.trim();
		channel.end(new Error(`pi exited with ${status}${detail ? `: ${detail}` : ""}`));
	});
	return { pid: child.pid, channel };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
