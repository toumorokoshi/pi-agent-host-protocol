import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Logger } from "../core/logger.ts";

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

/** A record pi writes on stdout that is not a command response (session events, extension UI requests). */
export type RpcRecord = { type: string; [key: string]: unknown };

interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

/** The `pi` executable could not be started at all (for example, it is not installed). */
export class PiStartError extends Error {}

const STDERR_TAIL = 2_000;
const STOP_GRACE_MS = 2_000;
const SCRIPT_EXTENSIONS = /\.(c|m)?(j|t)s$/;

/**
 * Splits buffered stdout into complete JSONL records. pi frames records with
 * LF only; JSON strings may contain U+2028/U+2029, so a generic line reader
 * (which also splits on those) must not be used.
 */
export function splitRecords(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
	return { lines, rest };
}

/** The executable and leading arguments that run `command` (scripts run with this Node). */
export function spawnCommand(command: string): { file: string; args: string[] } {
	return SCRIPT_EXTENSIONS.test(command) ? { file: process.execPath, args: [command] } : { file: command, args: [] };
}

/** One `pi --mode rpc` child process with request/response correlation. */
export class RpcProcess {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #logger: Logger;
	readonly #logFields: Record<string, unknown>;
	readonly #pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
	readonly #listeners = new Set<(record: RpcRecord) => void>();
	readonly #exitListeners = new Set<(error: Error) => void>();
	#nextId = 0;
	#stdout = "";
	#stderr = "";
	#exitError: Error | undefined;

	constructor(options: RpcProcessOptions) {
		this.#logger = options.logger;
		this.#logFields = options.logFields ?? {};
		const { file, args } = spawnCommand(options.command);
		this.#child = spawn(file, [...args, "--mode", "rpc", ...options.args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child.stdout.setEncoding("utf8");
		this.#child.stderr.setEncoding("utf8");
		this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
		this.#child.stderr.on("data", (chunk: string) => this.#onStderr(chunk));
		this.#child.stdin.on("error", () => {});
		this.#child.once("error", (error) =>
			this.#onExit(new PiStartError(`Could not start pi (${options.command}): ${error.message}`)),
		);
		this.#child.once("exit", (code, signal) => {
			const status = signal ? `signal ${signal}` : `code ${code}`;
			const detail = this.#stderr.trim();
			this.#onExit(new Error(`pi exited with ${status}${detail ? `: ${detail}` : ""}`));
		});
	}

	get exited(): boolean {
		return this.#exitError !== undefined;
	}

	/** Sends a command and resolves with its response `data`; rejects on failure or exit. */
	request<T = unknown>(command: { type: string; [key: string]: unknown }): Promise<T> {
		if (this.#exitError) return Promise.reject(this.#exitError);
		const id = `ahp-${++this.#nextId}`;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
			this.send({ ...command, id });
		});
	}

	/** Writes one record without waiting for a response (e.g. `extension_ui_response`). */
	send(record: Record<string, unknown>): void {
		if (this.#exitError) return;
		this.#child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	/** Receives every non-response record. */
	onRecord(listener: (record: RpcRecord) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Called once if the process exits or fails to start. */
	onExit(listener: (error: Error) => void): () => void {
		if (this.#exitError) {
			listener(this.#exitError);
			return () => {};
		}
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	/** Closes stdin (pi's orderly shutdown), then escalates to signals if pi does not exit. */
	async stop(): Promise<void> {
		if (this.#exitError) return;
		const exited = new Promise<void>((resolve) => this.onExit(() => resolve()));
		this.#child.stdin.end();
		const escalate = (signal: NodeJS.Signals) =>
			Promise.race([exited.then(() => true), delay(STOP_GRACE_MS).then(() => false)]).then((done) => {
				if (!done) this.#child.kill(signal);
			});
		await escalate("SIGTERM");
		await escalate("SIGKILL");
		await exited;
	}

	#onStdout(chunk: string): void {
		const { lines, rest } = splitRecords(this.#stdout + chunk);
		this.#stdout = rest;
		for (const line of lines) this.#onLine(line);
	}

	#onLine(line: string): void {
		let record: RpcRecord;
		try {
			record = JSON.parse(line) as RpcRecord;
		} catch {
			this.#logger.debug("pi wrote a non-JSON line", { ...this.#logFields, line: line.slice(0, 200) });
			return;
		}
		if (record.type === "response") {
			const response = record as unknown as RpcResponse;
			const pending = response.id ? this.#pending.get(response.id) : undefined;
			if (!pending) return;
			this.#pending.delete(response.id!);
			if (response.success) pending.resolve(response.data);
			else pending.reject(new Error(response.error ?? `pi rejected ${response.command}`));
			return;
		}
		for (const listener of [...this.#listeners]) listener(record);
	}

	#onStderr(chunk: string): void {
		this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL);
		for (const line of chunk.split("\n")) {
			if (line.trim()) this.#logger.debug("pi stderr", { ...this.#logFields, line: line.trim() });
		}
	}

	#onExit(error: Error): void {
		if (this.#exitError) return;
		this.#exitError = error;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		for (const listener of [...this.#exitListeners]) listener(error);
		this.#exitListeners.clear();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
