#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createLogger, LOG_LEVELS, parseLogLevel } from "../core/logger.ts";
import { AgentHost } from "../host/agent-host.ts";
import { loadSettings, saveSettings, settingsPath } from "../host/settings.ts";
import { PiServices } from "../pi/services.ts";
import { listen } from "../transport/websocket.ts";

const HELP = `Usage: pi-agent-host [options]

Serves pi sessions to Agent Host Protocol clients (e.g. the VS Code Agents window).

Options:
  --host <address>   Interface to listen on (default from settings, 127.0.0.1)
  --port <port>      Port to listen on (default from settings; a free port on first run)
  --no-token         Disable the connection token for this run
  --cwd <dir>        Default working directory offered to clients (default: current directory)
  --log-level <lvl>  Log level: ${LOG_LEVELS.join(", ")} (default: info, or $PI_AGENT_HOST_LOG_LEVEL)
  --debug            Shorthand for --log-level debug (logs every session interaction)
  -h, --help         Show this help

Settings are stored in ${settingsPath()}.`;

function packageVersion(): string {
	try {
		const url = new URL("../../package.json", import.meta.url);
		return (JSON.parse(readFileSync(url, "utf8")) as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			host: { type: "string" },
			port: { type: "string" },
			"no-token": { type: "boolean", default: false },
			cwd: { type: "string" },
			"log-level": { type: "string" },
			debug: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(HELP);
		return;
	}

	const logger = createLogger(
		values.debug ? "debug" : parseLogLevel(values["log-level"] ?? process.env.PI_AGENT_HOST_LOG_LEVEL ?? "info"),
	);
	const { settings, created } = await loadSettings();
	const host = values.host ?? settings.host;
	const port = values.port !== undefined ? Number.parseInt(values.port, 10) : settings.port;
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${values.port}`);
	const token = values["no-token"] ? undefined : (settings.token ?? undefined);

	// Marks this process so the pi-agent-host extension stays inactive inside it.
	process.env.PI_AGENT_HOST_DAEMON = "1";

	const services = await PiServices.create();
	const agentHost = new AgentHost({
		services,
		defaultDirectory: values.cwd ?? process.cwd(),
		serverVersion: packageVersion(),
		logger,
	});
	await agentHost.refreshAgents().catch((error) => {
		logger.warn("could not load models", { error: error instanceof Error ? error.message : String(error) });
	});

	const listener = await listen(agentHost, { host, port, token });
	if (created || settings.port === 0) {
		await saveSettings({ ...settings, port: listener.port });
	}

	console.log(`pi-agent-host listening on ${listener.url}`);
	if (token === undefined && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
		logger.warn("listening beyond localhost without a connection token");
	}

	const shutdown = async () => {
		await listener.close();
		await agentHost.dispose();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
