import {
	type ActionEnvelope,
	JsonRpcErrorCodes,
	type ProtocolNotificationMethod,
} from "@microsoft/agent-host-protocol";
import type { LogFields, Logger } from "../core/logger.ts";
import { ROOT_CHANNEL } from "../core/uris.ts";
import { errorResponse, ProtocolError, parseMessage, successResponse } from "../protocol/jsonrpc.ts";
import { actionVisibleTo, FALLBACK_PROTOCOL_VERSION, notificationVisibleTo } from "../protocol/version.ts";

/** Returned by a request handler that already sent its response via `Reply`. */
export const RESPONDED = Symbol("responded");

export type Reply = (result: unknown) => typeof RESPONDED;

export interface ConnectionHandler {
	request(connection: Connection, method: string, params: Record<string, unknown>, reply: Reply): Promise<unknown>;
	notification(connection: Connection, method: string, params: Record<string, unknown>): Promise<void> | void;
}

const PRE_INITIALIZE_METHODS = new Set(["initialize", "reconnect", "ping"]);

/**
 * One client connection. Owns protocol-level bookkeeping (handshake state,
 * subscriptions, version-aware delivery) and processes incoming messages in
 * order, except `ping`, which is answered immediately so liveness checks
 * never queue behind slow requests.
 */
export class Connection {
	/** Remote address, for logs. */
	readonly label: string;
	clientId: string | undefined;
	/** `clientInfo.name` from the handshake (e.g. `vscode-agents-window`). */
	clientName: string | undefined;
	protocolVersion = FALLBACK_PROTOCOL_VERSION;
	initialized = false;
	readonly #send: (text: string) => void;
	readonly #handler: ConnectionHandler;
	readonly #logger: Logger;
	/** Subscribed channels: canonical URI → the spelling this client used. */
	readonly #subscriptions = new Map<string, string>();
	#queue: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(label: string, send: (text: string) => void, handler: ConnectionHandler, logger: Logger) {
		this.label = label;
		this.#send = send;
		this.#handler = handler;
		this.#logger = logger;
	}

	/** Identifies this connection in log lines. */
	get logFields(): LogFields {
		return { client: this.label, clientName: this.clientName };
	}

	receive(text: string): void {
		const parsed = parseMessage(text);
		if (parsed.kind === "request" && parsed.message.method === "ping") {
			this.#write(successResponse(parsed.message.id, null));
			return;
		}
		this.#queue = this.#queue.then(() => this.#process(parsed)).catch(() => {});
	}

	close(): void {
		this.#closed = true;
		this.#subscriptions.clear();
	}

	subscribe(canonical: string, spelling: string): void {
		this.#subscriptions.set(canonical, spelling);
	}

	unsubscribe(channel: string, canonical: string | undefined): void {
		if (canonical) this.#subscriptions.delete(canonical);
		for (const [key, spelling] of this.#subscriptions) {
			if (spelling === channel) this.#subscriptions.delete(key);
		}
	}

	isSubscribed(canonical: string): boolean {
		return this.#subscriptions.has(canonical);
	}

	/** Rewrites an envelope's channel into this client's spelling, or `undefined` if not deliverable. */
	present(envelope: ActionEnvelope): ActionEnvelope | undefined {
		const spelling = this.#subscriptions.get(envelope.channel);
		if (spelling === undefined || !actionVisibleTo(envelope.action, this.protocolVersion)) return undefined;
		return spelling === envelope.channel ? envelope : { ...envelope, channel: spelling };
	}

	deliver(envelope: ActionEnvelope): void {
		const presented = this.present(envelope);
		if (presented) this.#write({ jsonrpc: "2.0", method: "action", params: presented });
	}

	/** Sends an envelope regardless of subscriptions (rejections go only to their origin). */
	sendEnvelope(envelope: ActionEnvelope): void {
		this.#write({ jsonrpc: "2.0", method: "action", params: envelope });
	}

	notifyRoot(method: ProtocolNotificationMethod, params: Record<string, unknown>): void {
		if (!this.#subscriptions.has(ROOT_CHANNEL) || !notificationVisibleTo(method, this.protocolVersion)) return;
		this.#write({ jsonrpc: "2.0", method, params: { channel: ROOT_CHANNEL, ...params } });
	}

	async #process(parsed: ReturnType<typeof parseMessage>): Promise<void> {
		switch (parsed.kind) {
			case "invalid":
				this.#write(errorResponse(parsed.id, parsed.error));
				return;
			case "response":
				// The host never sends requests to clients.
				return;
			case "notification": {
				if (!this.initialized) return;
				try {
					await this.#handler.notification(
						this,
						parsed.message.method,
						(parsed.message.params ?? {}) as Record<string, unknown>,
					);
				} catch {
					// Notifications have no response channel.
				}
				return;
			}
			case "request": {
				const { id, method } = parsed.message;
				const params = (parsed.message.params ?? {}) as Record<string, unknown>;
				const fields = {
					...this.logFields,
					method,
					channel: typeof params.channel === "string" ? params.channel : undefined,
				};
				if (!this.initialized && !PRE_INITIALIZE_METHODS.has(method)) {
					this.#logger.warn("request before initialize", fields);
					this.#write(
						errorResponse(id, new ProtocolError(JsonRpcErrorCodes.InvalidRequest, "Connection is not initialized")),
					);
					return;
				}
				let responded = false;
				const reply: Reply = (result) => {
					responded = true;
					this.#write(successResponse(id, result));
					return RESPONDED;
				};
				const started = Date.now();
				this.#logger.debug("request", fields);
				try {
					const result = await this.#handler.request(this, method, params, reply);
					if (!responded && result !== RESPONDED) this.#write(successResponse(id, result));
					this.#logger.debug("request done", { ...fields, ms: Date.now() - started });
				} catch (error) {
					if (!responded) this.#write(errorResponse(id, error));
					this.#logger.warn("request failed", {
						...fields,
						ms: Date.now() - started,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
		}
	}

	#write(message: object): void {
		if (this.#closed) return;
		this.#send(JSON.stringify(message));
	}
}
