/** `load`, its result shared for `ttlMs`; a failed load is not kept. */
export function cached<T>(ttlMs: number, load: () => Promise<T>, now = Date.now): () => Promise<T> {
	let entry: { at: number; value: Promise<T> } | undefined;
	return () => {
		const at = now();
		if (!entry || at - entry.at > ttlMs) {
			const current = { at, value: load() };
			entry = current;
			current.value.catch(() => {
				if (entry === current) entry = undefined;
			});
		}
		return entry.value;
	};
}
