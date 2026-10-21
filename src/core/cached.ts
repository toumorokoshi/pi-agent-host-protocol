/** `load`, its result shared for `ttlMs`; a failed load is not kept. */
export function cached<T>(ttlMs: number, load: () => Promise<T>, now = Date.now): () => Promise<T> {
	const get = cachedBy<undefined, T>(ttlMs, load, now);
	return () => get(undefined);
}

/**
 * `load` per key, each result shared for `ttlMs`; a failed load is not kept.
 * Expired entries are dropped whenever a key is loaded.
 */
export function cachedBy<K, T>(ttlMs: number, load: (key: K) => Promise<T>, now = Date.now): (key: K) => Promise<T> {
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
		current.value.catch(() => {
			if (entries.get(key) === current) entries.delete(key);
		});
		return current.value;
	};
}
