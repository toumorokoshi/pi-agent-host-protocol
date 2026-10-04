import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { type AttachRequest, type AttachResult, BRIDGE_PROTOCOL } from "../bridge/protocol.ts";
import type { Logger } from "../core/logger.ts";
import { JsonlChannel, type RpcChannel, type RpcCommand, type RpcRecord } from "../pi/rpc-channel.ts";

/** Receives live TUI sessions as they attach. */
export interface LiveSessionHandler {
	/** `channel` speaks pi's RPC protocol for this session until pi detaches or disconnects. */
	attachLive(info: AttachRequest, channel: RpcChannel): Promise<void>;
}

/** Another host already serves the bridge socket. */
export class HostAlreadyRunningError extends Error {}

/**
 * Serves the bridge socket that interactive `pi` processes connect to. Each
 * connection is one pi process; each `attach` hands the host a `SessionLink`
 * for the session that process has open.
 */
export class BridgeServer {
	readonly path: string;
	readonly #server: Server;
	/** The AHP URL sent to bridges so they can show it; known once the WebSocket listener is up. */
	readonly #url = Promise.withResolvers<string | undefined>();
	readonly #handler: LiveSessionHandler;
	readonly #logger: Logger;
	readonly #sockets = new Set<Socket>();

	private constructor(path: string, server: Server, handler: LiveSessionHandler, logger: Logger) {
		this.path = path;
		this.#server = server;
		this.#handler = handler;
		this.#logger = logger;
		server.on("connection", (socket) => this.#onConnection(socket));
	}

	/**
	 * Listens on `path` (mode 0600). A stale socket file is replaced; a live
	 * one means another host is running and throws `HostAlreadyRunningError`.
	 */
	static async listen(path: string, handler: LiveSessionHandler, logger: Logger): Promise<BridgeServer> {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const server = createServer();
		const bridge = new BridgeServer(path, server, handler, logger);
		try {
			await listenOn(server, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			if (await isListening(path))
				throw new HostAlreadyRunningError(`A pi-agent-host-protocol is already running (${path})`);
			await unlink(path);
			await listenOn(server, path);
		}
		await chmod(path, 0o600);
		return bridge;
	}

	/** Sets the URL bridges show to the user. Attaches wait for it (briefly), since the socket opens first. */
	setUrl(url: string | undefined): void {
		this.#url.resolve(url);
	}

	async close(): Promise<void> {
		this.#url.resolve(undefined);
		for (const socket of this.#sockets) socket.destroy();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}

	#onConnection(socket: Socket): void {
		this.#sockets.add(socket);
		socket.setEncoding("utf8");
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		const channel = new JsonlChannel(
			{
				write: (text) => socket.write(text),
				close: async () => {
					socket.end();
					await closed;
				},
			},
			{ idPrefix: "host" },
		);
		let link: SessionLink | undefined;
		const logFields = () => ({ pid: link?.pid, session: link?.sessionId });
		socket.on("data", (chunk: string) => channel.push(chunk));
		socket.on("error", () => {});
		socket.once("close", () => {
			this.#sockets.delete(socket);
			channel.end(new Error("pi disconnected"));
		});
		channel.onClose((error) => {
			if (link) this.#logger.info("live session detached", { ...logFields(), reason: error.message });
			link?.end(error);
			link = undefined;
		});
		channel.onRecord(async (record) => {
			switch (record.type) {
				case "attach": {
					const info = record as unknown as AttachRequest;
					if (info.protocol !== BRIDGE_PROTOCOL) {
						channel.respond(record, {
							error: `pi-agent-host-protocol speaks bridge protocol ${BRIDGE_PROTOCOL}, but this extension speaks ${info.protocol}. Update both.`,
						});
						return;
					}
					link?.end(new Error("pi switched to another session"));
					link = new SessionLink(channel, info.sessionId, info.pid);
					const attached = link;
					const result: AttachResult = { url: await Promise.race([this.#url.promise, delay(URL_WAIT_MS)]) };
					channel.respond(record, { data: result });
					if (attached.closed) return;
					this.#logger.info("live session attached", { ...logFields(), cwd: info.cwd });
					void this.#handler.attachLive(info, attached).catch((error) => {
						this.#logger.warn("could not attach live session", {
							...logFields(),
							error: error instanceof Error ? error.message : String(error),
						});
						attached.end(error instanceof Error ? error : new Error(String(error)));
					});
					return;
				}
				case "detach":
					if (link && link.sessionId === record.sessionId) {
						this.#logger.info("live session detached", { ...logFields(), reason: "detached by pi" });
						link.end(new Error("pi detached the session"));
						link = undefined;
					}
					channel.respond(record, {});
					return;
				default:
					link?.deliver(record);
			}
		});
	}
}

/**
 * The RPC channel of one attached session on a bridge connection. It closes
 * when pi detaches the session, switches to another one or disconnects.
 * Closing it from the host side only releases the session: the TUI keeps
 * running.
 */
export class SessionLink implements RpcChannel {
	readonly sessionId: string;
	readonly pid: number;
	readonly #channel: RpcChannel;
	readonly #listeners = new Set<(record: RpcRecord) => void>();
	readonly #closeListeners = new Set<(error: Error) => void>();
	#closeError: Error | undefined;

	constructor(channel: RpcChannel, sessionId: string, pid: number) {
		this.#channel = channel;
		this.sessionId = sessionId;
		this.pid = pid;
	}

	get closed(): boolean {
		return this.#closeError !== undefined;
	}

	request<T = unknown>(command: RpcCommand): Promise<T> {
		return this.#closeError ? Promise.reject(this.#closeError) : this.#channel.request<T>(command);
	}

	send(record: Record<string, unknown>): void {
		if (!this.#closeError) this.#channel.send(record);
	}

	respond(command: RpcRecord, result: { data?: unknown } | { error: string }): void {
		if (!this.#closeError) this.#channel.respond(command, result);
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

	async close(): Promise<void> {
		this.end(new Error("Released by the host"));
	}

	deliver(record: RpcRecord): void {
		if (this.#closeError) return;
		for (const listener of [...this.#listeners]) listener(record);
	}

	end(error: Error): void {
		if (this.#closeError) return;
		this.#closeError = error;
		for (const listener of [...this.#closeListeners]) listener(error);
		this.#closeListeners.clear();
	}
}

const URL_WAIT_MS = 5_000;

function delay(ms: number): Promise<undefined> {
	return new Promise((resolve) => setTimeout(() => resolve(undefined), ms).unref());
}

function listenOn(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function isListening(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}
