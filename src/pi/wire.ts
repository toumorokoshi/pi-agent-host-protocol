import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Converts an SDK session event to pi's RPC wire form, the way `pi --mode rpc`
 * does: `message_update` drops the cumulative `message` and `partial`
 * snapshots (keeping streams linear in size), and `toolcall_start` carries
 * the tool call's `id` and `toolName` instead. pi does not export its own
 * converter.
 */
export function toWireEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type !== "message_update") return event as JsonAgentSessionEvent;
	const { partial, ...rest } = event.assistantMessageEvent as typeof event.assistantMessageEvent & {
		partial?: { content?: Array<{ type: string; id?: string; name?: string }> };
	};
	let assistantMessageEvent: Record<string, unknown> = rest;
	if (rest.type === "toolcall_start") {
		const block = partial?.content?.[rest.contentIndex];
		assistantMessageEvent = { ...rest, id: block?.id ?? "", toolName: block?.name ?? "" };
	}
	return { type: "message_update", assistantMessageEvent } as unknown as JsonAgentSessionEvent;
}
