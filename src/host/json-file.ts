import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Reads a text file the host keeps beside its settings; `undefined` when it does not exist yet. */
export async function readOptional(path: string): Promise<string | undefined> {
	return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
}

/** Writes a file's whole contents, one write at a time. */
export interface FileWriter {
	/** Queues `text` as the file's new contents. Failures are reported through `onError`. */
	write(text: string): void;
	/** Resolves once every queued write has finished. */
	flush(): Promise<void>;
}

/**
 * Writes are serialized and atomic (temp file plus rename), so a crash never
 * leaves a truncated file. The file and its directory are private to the user.
 */
export function atomicWriter(path: string, onError: (error: unknown) => void = () => {}): FileWriter {
	let writes = Promise.resolve();
	return {
		write: (text) => {
			writes = writes
				.then(async () => {
					await mkdir(dirname(path), { recursive: true, mode: 0o700 });
					const temp = `${path}.${process.pid}.tmp`;
					await writeFile(temp, text, { mode: 0o600 });
					await rename(temp, path);
				})
				.catch(onError);
		},
		flush: () => writes,
	};
}
