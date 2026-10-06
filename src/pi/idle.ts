/** Minutes a session's pi process may sit idle before the host stops it, unless configured. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;

/** How often the host looks for idle sessions, at most. */
export const MAX_SWEEP_INTERVAL_MS = 60_000;

/** Parses an idle timeout in minutes (`0` disables suspension) and returns milliseconds. */
export function parseIdleTimeout(value: string | number): number {
	const minutes = typeof value === "number" ? value : Number(value.trim());
	if (!Number.isFinite(minutes) || minutes < 0 || (typeof value === "string" && value.trim() === "")) {
		throw new Error(`Invalid idle timeout: ${value} (expected minutes, 0 to disable)`);
	}
	return Math.round(minutes * 60_000);
}

/** How often to sweep for a given timeout: often enough to stop a process within about 1.5× the timeout. */
export function sweepInterval(timeoutMs: number): number {
	return Math.max(1_000, Math.min(MAX_SWEEP_INTERVAL_MS, Math.floor(timeoutMs / 2)));
}

/** What a session is doing, as far as suspending its pi process is concerned. */
export interface IdleState {
	/** The session has a pi process the host may stop (its own `pi --mode rpc` child). */
	suspendable: boolean;
	/** A turn is running, from the host or typed in a terminal. */
	running: boolean;
	/** Steering or queued messages are waiting. */
	pending: boolean;
	/** When the session was last used (ms since the epoch). */
	lastActivity: number;
}

/**
 * Why a session's pi process must keep running, or `undefined` if it has
 * been idle since `cutoff` and may be stopped.
 */
export function suspendBlocker(state: IdleState, cutoff: number): string | undefined {
	if (!state.suspendable) return "not suspendable";
	if (state.running) return "running";
	if (state.pending) return "pending messages";
	if (state.lastActivity > cutoff) return "recently active";
	return undefined;
}
