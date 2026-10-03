export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
	readonly level: LogLevel;
	error(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	debug(message: string, fields?: LogFields): void;
}

export function parseLogLevel(value: string): LogLevel {
	const level = value.toLowerCase();
	if (!(LOG_LEVELS as readonly string[]).includes(level)) {
		throw new Error(`Invalid log level: ${value} (expected one of ${LOG_LEVELS.join(", ")})`);
	}
	return level as LogLevel;
}

/** Whether a message at `level` is emitted by a logger configured at `threshold`. */
export function isEnabled(threshold: LogLevel, level: LogLevel): boolean {
	return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(threshold);
}

function formatValue(value: string | number | boolean): string {
	return typeof value === "string" && (value === "" || /[\s"=]/.test(value)) ? JSON.stringify(value) : String(value);
}

/** Formats one log line: `<ISO time> <LEVEL> <message> key=value ...`. */
export function formatLine(time: Date, level: LogLevel, message: string, fields: LogFields = {}): string {
	const pairs = Object.entries(fields)
		.filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
		.map(([key, value]) => `${key}=${formatValue(value)}`);
	return [time.toISOString(), level.toUpperCase().padEnd(5), message, ...pairs].join(" ");
}

export interface LoggerOptions {
	write?: (line: string) => void;
	now?: () => Date;
}

/** Creates a logger that writes lines at or above `threshold` (to stderr by default). */
export function createLogger(threshold: LogLevel, options: LoggerOptions = {}): Logger {
	const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
	const now = options.now ?? (() => new Date());
	const log = (level: LogLevel) => (message: string, fields?: LogFields) => {
		if (isEnabled(threshold, level)) write(formatLine(now(), level, message, fields));
	};
	return { level: threshold, error: log("error"), warn: log("warn"), info: log("info"), debug: log("debug") };
}

export const silentLogger: Logger = createLogger("error", { write: () => {} });
