#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createLogger, LOG_LEVELS, type Logger, parseLogLevel } from "../core/logger.ts";
import { AgentHost } from "../host/agent-host.ts";
import { loadSettings, saveSettings, settingsPath } from "../host/settings.ts";
import { PI_MODES, type PiBackend, type PiMode, parsePiMode } from "../pi/agent.ts";
import { EmbeddedBackend } from "../pi/embedded-backend.ts";
import { RpcBackend } from "../pi/rpc-backend.ts";
import { PiStartError } from "../pi/rpc-process.ts";
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
  --pi-mode <mode>   How to run pi: ${PI_MODES.join(" or ")} (default: rpc, or $PI_AGENT_HOST_PI_MODE)
                     rpc runs each session in its own \`pi --mode rpc\` process;
                     embedded runs pi's SDK inside this process
  --pi <path>        The pi executable for rpc mode (default: pi on PATH)
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
			"pi-mode": { type: "string" },
			pi: { type: "string" },
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

	const piMode = parsePiMode(values["pi-mode"] ?? process.env.PI_AGENT_HOST_PI_MODE ?? settings.piMode ?? "rpc");
	const backend = await createBackend(piMode, values.pi ?? settings.pi, logger);
	logger.info("pi backend", { mode: piMode });
	const agentHost = new AgentHost({
		backend,
		defaultDirectory: values.cwd ?? process.cwd(),
		serverVersion: packageVersion(),
		logger,
	});
	await agentHost.refreshAgents().catch((error) => {
		if (error instanceof PiStartError) {
			throw new Error(`${error.message}\nInstall pi, pass --pi <path>, or use --pi-mode embedded.`);
		}
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

async function createBackend(mode: PiMode, pi: string | undefined, logger: Logger): Promise<PiBackend> {
	if (mode === "embedded") return EmbeddedBackend.create();
	return new RpcBackend({ pi, logger });
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
