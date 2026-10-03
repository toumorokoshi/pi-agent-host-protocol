/**
 * pi-agent-host's pi extension: shares the session of every interactive pi
 * with the host, so the VS Code Agents window can follow and drive it. See
 * specs/live-tui-sessions.md.
 */
import type { AgentSessionEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ahpResume from "../pi/extensions/ahp-resume.ts";
import { bridgeClient } from "./client.ts";

/** The session events the host needs to mirror turns. */
const FORWARDED = [
	"agent_start",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"agent_settled",
] as const;

const USAGE = "Usage: /ahp [status|on|off|start]";

export default function piAgentHostBridge(pi: ExtensionAPI): void {
	// Inside the host's own `pi --mode rpc` children (which inherit this), stay out of the way.
	if (process.env.PI_AGENT_HOST_DAEMON) return;
	ahpResume(pi);
	const client = bridgeClient();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Never block pi's startup on the host.
		void client.sessionStarted(pi, ctx);
	});
	pi.on("session_shutdown", async (event) => {
		await client.sessionEnding(event.reason);
	});
	for (const type of FORWARDED) {
		pi.on(type as "agent_start", (event) => client.forward(event as unknown as AgentSessionEvent));
	}

	pi.registerCommand("ahp", {
		description: "Share this session with VS Code through pi-agent-host: /ahp [status|on|off|start]",
		handler: async (args, ctx) => {
			switch (args.trim() || "status") {
				case "status":
					break;
				case "on":
				case "start":
					await client.enable();
					break;
				case "off":
					await client.disable();
					break;
				default:
					ctx.ui.notify(USAGE, "warning");
					return;
			}
			ctx.ui.notify(client.status(), "info");
		},
	});
}
