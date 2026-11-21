import { realpath, stat } from "node:fs/promises";
import { dirname, join, matchesGlob, relative, sep } from "node:path";
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

/** Characters that make a path a glob for `@parcel/watcher`. */
const GLOB_CHARACTERS = /[*?[\]{}()!+@\\]/;
/** Syntax whose `@parcel/watcher` (picomatch) meaning on an absolute path may differ from `matchesGlob` on a root-relative one. */
const AMBIGUOUS_GLOB_SYNTAX = /[!()[\]\\]/;

/**
 * The client excludes `@parcel/watcher` can safely take as `ignore`, so excluded trees are not
 * watched at all. The watcher matches globs against absolute paths and resolves plain paths
 * from the watched directory, whereas `watchFilter` matches root-relative paths, so only
 * patterns that mean the same in both are passed on:
 * - `**\/…` globs, which match at any depth in either;
 * - plain paths (no glob characters), made absolute under the root.
 * Any other glob (`build/**`, `*.log`) is left to `watchFilter`, which stays the source of truth
 * for what is reported.
 */
export function parcelIgnore(realRoot: string, excludes: string[] = []): string[] {
	return excludes.flatMap((exclude) => {
		if (exclude.startsWith("**/")) return AMBIGUOUS_GLOB_SYNTAX.test(exclude) ? [] : [exclude];
		return GLOB_CHARACTERS.test(exclude) || exclude.startsWith("/") || exclude.split("/").includes("..")
			? []
			: [join(realRoot, exclude)];
	});
}

interface CreateWatchInput {
	uri: unknown;
	recursive: boolean;
	includes?: { items: string[] };
	excludes?: { items: string[] };
}

interface ActiveWatch {
	/**
	 * The OS watch, attached in the background: on a large tree (a cruise/cruise checkout)
	 * `@parcel/watcher` takes tens of seconds to start, and the connection's next requests, such
	 * as opening a session, would wait behind it. Undefined if it failed to start.
	 */
	subscription: Promise<watcher.AsyncSubscription | undefined>;
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
	readonly #subscribe: typeof watcher.subscribe;
	readonly #watches = new Map<string, ActiveWatch>();
	/**
	 * Each connection's watches attach one at a time. `@parcel/watcher` runs each subscribe on
	 * libuv's thread pool (4 threads by default) and the subscribes wait on each other there, so a
	 * few recursive watches on big trees (VS Code asks for `~/workspaces` and each checkout) filled
	 * the pool, and every other file operation in the host, such as reading a session file, waited
	 * for them. The queue is per connection so one client's slow tree doesn't hold up another's.
	 */
	readonly #attachQueues = new WeakMap<object, Promise<unknown>>();
	/** Unsubscribes that have started and not finished, so `disposeAll` can wait for them. */
	readonly #unsubscribing = new Set<Promise<void>>();

	/** `subscribe` is the OS watch; tests replace it. */
	constructor(store: StateStore, logger: Logger, subscribe: typeof watcher.subscribe = watcher.subscribe) {
		this.#store = store;
		this.#logger = logger;
		this.#subscribe = subscribe;
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
		const started = Date.now();
		const ignore = info.isFile() ? [] : parcelIgnore(realRoot, excludes);
		const attach = () =>
			this.#subscribe(
				info.isFile() ? dirname(realRoot) : realRoot,
				(error, events) => {
					if (error) {
						this.#logger.warn("resource watch error", { watch: channel, error: error.message });
						return;
					}
					const items: ResourceChange[] = events
						.filter((event) => accept(event.path))
						.map((event) => ({ uri: fileUri(clientPath(event.path, realRoot, root)), type: CHANGE_TYPES[event.type] }));
					if (items.length > 0 && this.#watches.has(channel)) {
						this.#store.dispatch(channel, { type: ActionType.ResourceWatchChanged, changes: { items } });
					}
				},
				ignore.length > 0 ? { ignore } : undefined,
			);
		const watch: ActiveWatch = { subscription: Promise.resolve(undefined), owner };
		watch.subscription = (this.#attachQueues.get(owner) ?? Promise.resolve())
			.then(() => (this.#watches.get(channel) === watch ? attach() : undefined))
			.then(
				(attached) => {
					this.#logger.debug("resource watch attached", { watch: channel, ms: Date.now() - started });
					return attached;
				},
				(error: unknown) => {
					this.#logger.warn("resource watch error", {
						watch: channel,
						phase: "attach",
						error: error instanceof Error ? error.message : String(error),
					});
					// A watch that cannot attach would never report anything: take its channel away.
					if (this.#watches.get(channel) === watch) {
						this.#watches.delete(channel);
						this.#store.removeChannel(channel);
					}
					return undefined;
				},
			);
		this.#attachQueues.set(owner, watch.subscription);
		this.#store.addChannel(channel, {
			kind: "resourceWatch",
			state: {
				root: fileUri(root),
				recursive,
				...(excludes ? { excludes: { items: excludes } } : {}),
				...(includes ? { includes: { items: includes } } : {}),
			},
		});
		this.#watches.set(channel, watch);
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
	 * Resolves once the released watches have unsubscribed, which waits for any that
	 * are still attaching; callers on a request path don't await it.
	 */
	async release(isSubscribed: (channel: string) => boolean, closedOwner?: object): Promise<void> {
		const unsubscribes: Promise<void>[] = [];
		for (const [channel, watch] of [...this.#watches]) {
			if (isSubscribed(channel)) continue;
			if (watch.owner !== undefined && watch.owner !== closedOwner) continue;
			this.#watches.delete(channel);
			this.#store.removeChannel(channel);
			unsubscribes.push(this.#unsubscribe(watch));
			this.#logger.debug("resource watch released", { watch: channel });
		}
		await Promise.all(unsubscribes);
	}

	/** Releases every watch and waits for all unsubscribes, including ones an earlier `release` started. */
	async disposeAll(): Promise<void> {
		await this.release(() => false, undefined);
		for (const [channel, watch] of [...this.#watches]) {
			this.#watches.delete(channel);
			void this.#unsubscribe(watch);
		}
		await Promise.all([...this.#unsubscribing]);
	}

	#unsubscribe(watch: ActiveWatch): Promise<void> {
		const done: Promise<void> = unsubscribe(watch).finally(() => this.#unsubscribing.delete(done));
		this.#unsubscribing.add(done);
		return done;
	}
}

/** Stops a watch's OS watcher once it has attached; never rejects. */
async function unsubscribe(watch: ActiveWatch): Promise<void> {
	const subscription = await watch.subscription;
	await subscription?.unsubscribe().catch(() => {});
}
