import { realpath, stat } from "node:fs/promises";
import { dirname, matchesGlob, relative, sep } from "node:path";
import { ActionType, type ResourceChange, ResourceChangeType } from "@microsoft/agent-host-protocol";
import watcher from "@parcel/watcher";
import type { Logger } from "../core/logger.ts";
import type { StateStore } from "../core/state-store.ts";
import { fileUri, pathFromFileUri } from "../core/uris.ts";
import { ProtocolError } from "../protocol/jsonrpc.ts";

const CHANGE_TYPES: Record<watcher.EventType, ResourceChangeType> = {
	create: ResourceChangeType.Added,
	update: ResourceChangeType.Updated,
	delete: ResourceChangeType.Deleted,
};

export interface WatchFilterOptions {
	/** The watched path (a directory, or a single file). */
	root: string;
	isFile: boolean;
	recursive: boolean;
	includes?: string[];
	excludes?: string[];
}

/**
 * Maps a path reported by the OS (always symlink-resolved, e.g. macOS
 * `/private/var/...`) back under the root the client asked for (`/var/...`).
 */
export function clientPath(path: string, realRoot: string, root: string): string {
	return path === realRoot || path.startsWith(realRoot + sep) ? root + path.slice(realRoot.length) : path;
}

/** Path segments from the root to `path`, posix-separated (`a/b/c.ts` → `a`, `a/b`, `a/b/c.ts`). */
function prefixes(rel: string): string[] {
	const parts = rel.split("/");
	return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * Builds the predicate that decides whether a changed path is reported.
 * Globs match the path relative to the root. An exclude also matches when it
 * names any ancestor directory, so `**\/node_modules` hides everything below
 * it.
 */
export function watchFilter(options: WatchFilterOptions): (path: string) => boolean {
	const { root, isFile, recursive, includes = [], excludes = [] } = options;
	return (path) => {
		if (isFile) return path === root;
		const rel = relative(root, path).split(sep).join("/");
		if (rel === "" || rel.startsWith("..")) return false;
		if (!recursive && rel.includes("/")) return false;
		if (prefixes(rel).some((prefix) => excludes.some((glob) => matchesGlob(prefix, glob)))) return false;
		return includes.length === 0 || includes.some((glob) => matchesGlob(rel, glob));
	};
}

interface CreateWatchInput {
	uri: unknown;
	recursive: boolean;
	includes?: { items: string[] };
	excludes?: { items: string[] };
}

interface ActiveWatch {
	subscription: watcher.AsyncSubscription;
	/** Connection that created the watch, until it first subscribes. */
	owner: object | undefined;
}

/**
 * Filesystem watches for the resource-watch channel, backed by
 * `@parcel/watcher`. Each watch is released once no connection is subscribed
 * to it.
 */
export class ResourceWatchService {
	readonly #store: StateStore;
	readonly #logger: Logger;
	readonly #watches = new Map<string, ActiveWatch>();

	constructor(store: StateStore, logger: Logger) {
		this.#store = store;
		this.#logger = logger;
	}

	async create(input: CreateWatchInput, owner: object): Promise<{ channel: string }> {
		const root = typeof input.uri === "string" ? pathFromFileUri(input.uri) : undefined;
		if (!root) throw ProtocolError.invalidParams(`Unsupported resource URI: ${String(input.uri)}`);
		const info = await stat(root).catch(() => undefined);
		if (!info) throw ProtocolError.notFound(String(input.uri));

		const { recursive } = input;
		const includes = input.includes?.items;
		const excludes = input.excludes?.items;
		const realRoot = await realpath(root);
		const accept = watchFilter({ root: realRoot, isFile: info.isFile(), recursive, includes, excludes });
		const channel = `ahp-resource-watch:/${crypto.randomUUID()}`;
		const subscription = await watcher.subscribe(info.isFile() ? dirname(realRoot) : realRoot, (error, events) => {
			if (error) {
				this.#logger.warn("resource watch error", { watch: channel, error: error.message });
				return;
			}
			const items: ResourceChange[] = events
				.filter((event) => accept(event.path))
				.map((event) => ({ uri: fileUri(clientPath(event.path, realRoot, root)), type: CHANGE_TYPES[event.type] }));
			if (items.length > 0)
				this.#store.dispatch(channel, { type: ActionType.ResourceWatchChanged, changes: { items } });
		});
		this.#store.addChannel(channel, {
			kind: "resourceWatch",
			state: {
				root: fileUri(root),
				recursive,
				...(excludes ? { excludes: { items: excludes } } : {}),
				...(includes ? { includes: { items: includes } } : {}),
			},
		});
		this.#watches.set(channel, { subscription, owner });
		this.#logger.debug("resource watch created", { watch: channel, root, recursive });
		return { channel };
	}

	/** Records that a connection subscribed, so the watch now lives as long as it has subscribers. */
	subscribed(channel: string): void {
		const watch = this.#watches.get(channel);
		if (watch) watch.owner = undefined;
	}

	/**
	 * Releases every watch without a subscriber. A watch that was created but
	 * not yet subscribed survives until its creating connection goes away.
	 */
	async release(isSubscribed: (channel: string) => boolean, closedOwner?: object): Promise<void> {
		for (const [channel, watch] of [...this.#watches]) {
			if (isSubscribed(channel)) continue;
			if (watch.owner !== undefined && watch.owner !== closedOwner) continue;
			this.#watches.delete(channel);
			this.#store.removeChannel(channel);
			await watch.subscription.unsubscribe().catch(() => {});
			this.#logger.debug("resource watch released", { watch: channel });
		}
	}

	async disposeAll(): Promise<void> {
		await this.release(() => false, undefined);
		for (const [channel, watch] of [...this.#watches]) {
			this.#watches.delete(channel);
			await watch.subscription.unsubscribe().catch(() => {});
		}
	}
}
