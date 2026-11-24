/**
 * Keeps the model list the host publishes to clients. pi lists its models through a short-lived
 * process, which can answer with none (a slow first start, a provider still checking credentials)
 * or fail or hang. An empty or failed listing never replaces a real one; while the published list is
 * empty the host keeps asking on a backoff, and it relists periodically so models added upstream
 * appear without a restart. See specs/models.md.
 */
import type { Logger } from "../core/logger.ts";
import type { PiModel } from "./models.ts";

/** Delays between listings while the published list is empty: 2 s up to 10 minutes. */
export const EMPTY_RETRY_DELAYS_MS: readonly number[] = [
	2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 120_000, 300_000, 600_000,
];

/** How often the host relists models once it has some. */
export const MODEL_REFRESH_INTERVAL_MS = 10 * 60_000;

/** The delay before listing attempt `attempt` (1-based) after `attempt` empty or failed listings. */
export function retryDelay(attempt: number, delays: readonly number[] = EMPTY_RETRY_DELAYS_MS): number {
	const last = delays[delays.length - 1] ?? 30_000;
	return delays[Math.max(0, attempt - 1)] ?? last;
}

/** What one listing produced: a non-empty list, or why there is none. */
export type ModelListing =
	| { kind: "models"; models: readonly PiModel[] }
	| { kind: "empty" }
	| { kind: "failed"; error: unknown };

/** Timer functions, injectable so tests drive time. */
export interface CatalogTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realTimers: CatalogTimers = {
	setTimeout: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		handle.unref();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** How long one listing may take before it counts as failed (a hung credential helper). */
export const LIST_TIMEOUT_MS = 30_000;

/**
 * Lists models once, giving up after `timeoutMs`, and classifies the result; never throws.
 * Aborts the signal passed to `load` on timeout or when `outerSignal` aborts.
 */
export async function listModels(
	load: (signal: AbortSignal) => Promise<readonly PiModel[]>,
	timeoutMs = LIST_TIMEOUT_MS,
	timers: CatalogTimers = realTimers,
	outerSignal?: AbortSignal,
): Promise<ModelListing> {
	const controller = new AbortController();
	let timer: unknown;
	let onOuterAbort: (() => void) | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		onOuterAbort = () => {
			const reason = outerSignal?.reason instanceof Error ? outerSignal.reason : new Error("Model listing aborted");
			controller.abort(reason);
			reject(reason);
		};
		if (outerSignal) {
			if (outerSignal.aborted) onOuterAbort();
			else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
		}
		timer = timers.setTimeout(() => {
			const error = new Error(`listing models timed out after ${timeoutMs} ms`);
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});
	try {
		const models = await Promise.race([load(controller.signal), cancelled]);
		return models.length > 0 ? { kind: "models", models } : { kind: "empty" };
	} catch (error) {
		return { kind: "failed", error };
	} finally {
		timers.clearTimeout(timer);
		if (onOuterAbort) outerSignal?.removeEventListener("abort", onOuterAbort);
	}
}

export interface ModelCatalogOptions {
	/** Lists pi's models (the backend's `models()`). */
	load: (signal: AbortSignal) => Promise<readonly PiModel[]>;
	/** Called with each non-empty list; the host publishes it only when it differs from root state. */
	publish: (models: readonly PiModel[]) => void;
	logger: Logger;
	timers?: CatalogTimers;
	retryDelays?: readonly number[];
	refreshIntervalMs?: number;
	/** Longest one listing may take before it counts as failed. */
	listTimeoutMs?: number;
}

/**
 * Lists models on demand (`refresh`), publishes only real lists, and schedules the next listing:
 * a backoff retry while it has none, or the periodic refresh once it has some.
 */
export class ModelCatalog {
	readonly #options: ModelCatalogOptions;
	readonly #timers: CatalogTimers;
	readonly #disposeController = new AbortController();
	#models: readonly PiModel[] = [];
	#failures = 0;
	#timer: unknown;
	#inFlight: Promise<ModelListing> | undefined;
	#disposed = false;

	constructor(options: ModelCatalogOptions) {
		this.#options = options;
		this.#timers = options.timers ?? realTimers;
	}

	/** The last non-empty list, or none before the first one. */
	get models(): readonly PiModel[] {
		return this.#models;
	}

	/**
	 * Lists models now (sharing a listing already in flight), publishes a real list, and schedules
	 * the next listing. Resolves with what this listing produced; never rejects.
	 */
	refresh(): Promise<ModelListing> {
		this.#inFlight ??= this.#run().finally(() => {
			this.#inFlight = undefined;
		});
		return this.#inFlight;
	}

	/** Stops scheduled listings and aborts any in-flight listing. */
	dispose(): void {
		this.#disposed = true;
		this.#disposeController.abort(new Error("ModelCatalog disposed"));
		this.#clearTimer();
	}

	async #run(): Promise<ModelListing> {
		const listing = await listModels(
			this.#options.load,
			this.#options.listTimeoutMs,
			this.#timers,
			this.#disposeController.signal,
		);
		if (this.#disposed) return listing;
		if (listing.kind === "models") this.#accept(listing.models);
		else this.#reject(listing);
		this.#schedule();
		return listing;
	}

	#accept(models: readonly PiModel[]): void {
		if (this.#failures > 0)
			this.#options.logger.info("models available", { count: models.length, attempts: this.#failures + 1 });
		this.#failures = 0;
		this.#models = models;
		this.#options.publish(models);
	}

	#reject(listing: Exclude<ModelListing, { kind: "models" }>): void {
		this.#failures++;
		const fields = {
			attempt: this.#failures,
			keeping: this.#models.length,
			...(listing.kind === "failed"
				? { error: listing.error instanceof Error ? listing.error.message : String(listing.error) }
				: {}),
		};
		this.#options.logger.warn(listing.kind === "empty" ? "pi listed no models" : "could not list models", fields);
	}

	#schedule(): void {
		this.#clearTimer();
		const delay =
			this.#models.length === 0
				? retryDelay(this.#failures, this.#options.retryDelays)
				: (this.#options.refreshIntervalMs ?? MODEL_REFRESH_INTERVAL_MS);
		this.#timer = this.#timers.setTimeout(() => {
			this.#timer = undefined;
			void this.refresh();
		}, delay);
	}

	#clearTimer(): void {
		if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
