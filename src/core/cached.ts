/**
 * `load`, its result shared for `ttlMs`; a failed load is not kept, and neither is a result
 * `shouldCache` rejects (callers already waiting on it still get it).
 */
export function cached<T>(
	ttlMs: number,
	load: () => Promise<T>,
	now = Date.now,
	shouldCache: (value: T) => boolean = () => true,
): () => Promise<T> {
	const get = cachedBy<undefined, T>(ttlMs, load, now, shouldCache);
	return () => get(undefined);
}

/**
 * `load` per key, each result shared for `ttlMs`; a failed load, or a result `shouldCache`
 * rejects, is not kept. Expired entries are dropped whenever a key is loaded.
 */
export function cachedBy<K, T>(
	ttlMs: number,
	load: (key: K) => Promise<T>,
	now = Date.now,
	shouldCache: (value: T) => boolean = () => true,
): (key: K) => Promise<T> {
	const entries = new Map<K, { at: number; value: Promise<T> }>();
	return (key) => {
		const at = now();
		const entry = entries.get(key);
		if (entry && at - entry.at <= ttlMs) return entry.value;
		for (const [other, { at: loaded }] of entries) {
			if (at - loaded > ttlMs) entries.delete(other);
		}
		const current = { at, value: load(key) };
		entries.set(key, current);
		const drop = () => {
			if (entries.get(key) === current) entries.delete(key);
		};
		// One reaction, registered before any caller's, so the entry is gone before a caller can ask again.
		current.value.then((value) => {
			if (!shouldCache(value)) drop();
		}, drop);
		return current.value;
	};
}
