import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { AgentHost } from "../host/agent-host.ts";

export interface ListenOptions {
	host: string;
	port: number;
	/** Connection token clients must pass as `?tkn=`; `undefined` disables the check. */
	token: string | undefined;
}

export interface Listener {
	readonly url: string;
	readonly port: number;
	close(): Promise<void>;
}

function tokenMatches(request: IncomingMessage, token: string | undefined): boolean {
	if (token === undefined) return true;
	const provided = new URL(request.url ?? "/", "http://localhost").searchParams.get("tkn") ?? "";
	const a = Buffer.from(provided);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Serves AHP over WebSocket: one JSON-RPC message per text frame. */
export async function listen(host: AgentHost, options: ListenOptions): Promise<Listener> {
	const server: Server = createServer((_request, response) => {
		response.writeHead(426, { "content-type": "text/plain" }).end("WebSocket upgrade required\n");
	});
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

	server.on("upgrade", (request, socket, head) => {
		if (!tokenMatches(request, options.token)) {
			host.logger.warn("connection rejected: missing or invalid token", {
				client: `${request.socket.remoteAddress ?? "?"}:${request.socket.remotePort ?? "?"}`,
			});
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
	});

	wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
		const label = `${request.socket.remoteAddress ?? "?"}:${request.socket.remotePort ?? "?"}`;
		const connection = host.connect(label, (text) => {
			if (ws.readyState === ws.OPEN) ws.send(text);
		});
		ws.on("message", (data, isBinary) => {
			if (!isBinary) connection.receive(data.toString());
		});
		ws.on("close", () => host.disconnect(connection));
		ws.on("error", () => ws.terminate());
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const { port } = server.address() as AddressInfo;
	const hostname = options.host.includes(":") ? `[${options.host}]` : options.host;
	const query = options.token === undefined ? "" : `?tkn=${encodeURIComponent(options.token)}`;
	return {
		url: `ws://${hostname}:${port}${query}`,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const client of wss.clients) client.terminate();
				wss.close();
				server.close(() => resolve());
			}),
	};
}
