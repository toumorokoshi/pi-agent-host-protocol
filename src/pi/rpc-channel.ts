/**
 * pi's RPC framing (JSONL commands, `response` records and events) over any
 * transport: a child's stdio (`RpcProcess`) or a unix socket (the TUI bridge).
 * It works in both directions: `request` correlates responses to commands
 * this side sends, and every other record (events, or commands from the other
 * side, answered with `respond`) goes to `onRecord` listeners.
 */

/** A record that is not a response to one of our requests. */
export type RpcRecord = { type: string; [key: string]: unknown };

export interface RpcCommand {
	type: string;
	[key: string]: unknown;
}

interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

/** The commands, events and lifecycle of one JSONL connection to pi (or to a bridge). */
export interface RpcChannel {
	readonly closed: boolean;
	/** Sends a command and resolves with its response `data`; rejects on failure or close. */
	request<T = unknown>(command: RpcCommand): Promise<T>;
	/** Writes one record without waiting for a response. */
	send(record: Record<string, unknown>): void;
	/** Answers a command received from the other side. */
	respond(command: RpcRecord, result: { data?: unknown } | { error: string }): void;
	/** Receives every record that is not a response to our own requests. */
	onRecord(listener: (record: RpcRecord) => void): () => void;
	/** Called once when the connection ends, with the reason. */
	onClose(listener: (error: Error) => void): () => void;
	/** Ends the connection (for a child process: an orderly shutdown). */
	close(): Promise<void>;
}

/**
 * Splits buffered input into complete JSONL records. pi frames records with
 * LF only; JSON strings may contain U+2028/U+2029, so a generic line reader
 * (which also splits on those) must not be used.
 */
export function splitRecords(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
	return { lines, rest };
}

export interface JsonlTransport {
	write(text: string): void;
	/** Ends the transport; `JsonlChannel.end` must be called once it has ended. */
	close(): Promise<void>;
}

/** An `RpcChannel` over a transport that the owner feeds with `push` and ends with `end`. */
export class JsonlChannel implements RpcChannel {
	readonly #transport: JsonlTransport;
	readonly #prefix: string;
	readonly #onInvalid: (line: string) => void;
	readonly #pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
	readonly #listeners = new Set<(record: RpcRecord) => void>();
	readonly #closeListeners = new Set<(error: Error) => void>();
	#nextId = 0;
	#buffer = "";
	#closeError: Error | undefined;

	/**
	 * @param idPrefix Prefix of request ids, so each side's ids stay distinct.
	 * @param onInvalid Called with each line that is not JSON.
	 */
	constructor(transport: JsonlTransport, options: { idPrefix?: string; onInvalid?: (line: string) => void } = {}) {
		this.#transport = transport;
		this.#prefix = options.idPrefix ?? "ahp";
		this.#onInvalid = options.onInvalid ?? (() => {});
	}

	get closed(): boolean {
		return this.#closeError !== undefined;
	}

	request<T = unknown>(command: RpcCommand): Promise<T> {
		if (this.#closeError) return Promise.reject(this.#closeError);
		const id = `${this.#prefix}-${++this.#nextId}`;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
			this.send({ ...command, id });
		});
	}

	send(record: Record<string, unknown>): void {
		if (this.#closeError) return;
		this.#transport.write(`${JSON.stringify(record)}\n`);
	}

	respond(command: RpcRecord, result: { data?: unknown } | { error: string }): void {
		const base = { type: "response", id: command.id, command: command.type };
		this.send(
			"error" in result ? { ...base, success: false, error: result.error } : { ...base, success: true, ...result },
		);
	}

	onRecord(listener: (record: RpcRecord) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	onClose(listener: (error: Error) => void): () => void {
		if (this.#closeError) {
			listener(this.#closeError);
			return () => {};
		}
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	close(): Promise<void> {
		return this.#closeError ? Promise.resolve() : this.#transport.close();
	}

	/** Feeds received text. */
	push(chunk: string): void {
		const { lines, rest } = splitRecords(this.#buffer + chunk);
		this.#buffer = rest;
		for (const line of lines) this.#onLine(line);
	}

	/** Marks the transport as ended: pending requests fail with `error`. Idempotent. */
	end(error: Error): void {
		if (this.#closeError) return;
		this.#closeError = error;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		for (const listener of [...this.#closeListeners]) listener(error);
		this.#closeListeners.clear();
	}

	#onLine(line: string): void {
		let record: RpcRecord;
		try {
			record = JSON.parse(line) as RpcRecord;
		} catch {
			this.#onInvalid(line);
			return;
		}
		if (record.type === "response") {
			const response = record as unknown as RpcResponse;
			const pending = response.id ? this.#pending.get(response.id) : undefined;
			if (pending) {
				this.#pending.delete(response.id!);
				if (response.success) pending.resolve(response.data);
				else pending.reject(new Error(response.error ?? `Rejected ${response.command}`));
				return;
			}
		}
		for (const listener of [...this.#listeners]) listener(record);
	}
}
