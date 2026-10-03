import {
	AhpErrorCodes,
	JsonRpcErrorCodes,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from "@microsoft/agent-host-protocol";

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** An error that is reported to the client as a JSON-RPC error response. */
export class ProtocolError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}

	static invalidParams(message: string): ProtocolError {
		return new ProtocolError(JsonRpcErrorCodes.InvalidParams, message);
	}

	static sessionNotFound(uri: string): ProtocolError {
		return new ProtocolError(AhpErrorCodes.SessionNotFound, `Session not found: ${uri}`);
	}

	static notFound(uri: string): ProtocolError {
		return new ProtocolError(AhpErrorCodes.NotFound, `Not found: ${uri}`);
	}
}

export type ParsedMessage =
	| { kind: "request"; message: JsonRpcRequest }
	| { kind: "notification"; message: JsonRpcNotification }
	| { kind: "response"; message: JsonRpcResponse }
	| { kind: "invalid"; id: number | null; error: ProtocolError };

/** Parses one WebSocket text frame into a JSON-RPC message. */
export function parseMessage(text: string): ParsedMessage {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: "invalid", id: null, error: new ProtocolError(JsonRpcErrorCodes.ParseError, "Parse error") };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { kind: "invalid", id: null, error: new ProtocolError(JsonRpcErrorCodes.InvalidRequest, "Invalid request") };
	}
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "number" ? record.id : null;
	if (typeof record.method === "string") {
		if (record.params !== undefined && (typeof record.params !== "object" || record.params === null)) {
			return { kind: "invalid", id, error: ProtocolError.invalidParams("params must be an object") };
		}
		return "id" in record
			? { kind: "request", message: record as unknown as JsonRpcRequest }
			: { kind: "notification", message: record as unknown as JsonRpcNotification };
	}
	if ("result" in record || "error" in record) {
		return { kind: "response", message: record as unknown as JsonRpcResponse };
	}
	return { kind: "invalid", id, error: new ProtocolError(JsonRpcErrorCodes.InvalidRequest, "Invalid request") };
}

export function successResponse(id: number, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result: result ?? null };
}

export function errorResponse(id: number | null, error: unknown): object {
	if (error instanceof ProtocolError) {
		return {
			jsonrpc: "2.0",
			id,
			error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) },
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return { jsonrpc: "2.0", id, error: { code: JsonRpcErrorCodes.InternalError, message } };
}
