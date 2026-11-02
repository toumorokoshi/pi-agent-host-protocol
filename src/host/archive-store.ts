import { dirname, join } from "node:path";
import { atomicWriter, readOptional } from "./json-file.ts";

/** The archive file, next to the host's settings file. */
export function archivePath(settingsFile: string): string {
	return join(dirname(settingsFile), "archived-sessions.json");
}

/**
 * Which sessions a client archived ("marked as done"). pi's session files
 * have no such flag, so the host keeps it in its own file; without it every
 * archived session would come back unarchived after a host restart.
 */
export interface ArchiveStore {
	isArchived(sessionId: string): boolean;
	/** Records the flag. Persisting is asynchronous; failures are reported through `onError`. */
	setArchived(sessionId: string, archived: boolean): void;
	/** Resolves once every pending write has finished. */
	flush(): Promise<void>;
}

/** On-disk format of the archive file. */
interface ArchiveFile {
	version: 1;
	archived: string[];
}

/** Parses the archive file's contents. Malformed content yields an empty set. */
export function parseArchive(text: string): ReadonlySet<string> {
	try {
		const raw = JSON.parse(text) as Partial<ArchiveFile>;
		return new Set(Array.isArray(raw.archived) ? raw.archived.filter((id) => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

/** Serializes archived session ids, sorted so the file is stable. */
export function serializeArchive(archived: ReadonlySet<string>): string {
	const file: ArchiveFile = { version: 1, archived: [...archived].sort() };
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/** Returns `archived` with `sessionId` added or removed. */
export function withArchived(archived: ReadonlySet<string>, sessionId: string, value: boolean): ReadonlySet<string> {
	if (archived.has(sessionId) === value) return archived;
	const next = new Set(archived);
	if (value) next.add(sessionId);
	else next.delete(sessionId);
	return next;
}

/** An archive kept only in memory (tests, and hosts without a state directory). */
export function memoryArchiveStore(initial: Iterable<string> = []): ArchiveStore {
	let archived: ReadonlySet<string> = new Set(initial);
	return {
		isArchived: (sessionId) => archived.has(sessionId),
		setArchived: (sessionId, value) => {
			archived = withArchived(archived, sessionId, value);
		},
		flush: async () => {},
	};
}

/**
 * Loads the archive file at `path` (missing means nothing is archived) and
 * writes it back on every change. Writes are serialized and atomic (temp
 * file plus rename), so a crash never leaves a truncated file.
 */
export async function fileArchiveStore(
	path: string,
	onError: (error: unknown) => void = () => {},
): Promise<ArchiveStore> {
	const text = await readOptional(path);
	let archived = text === undefined ? new Set<string>() : parseArchive(text);
	const writer = atomicWriter(path, onError);
	return {
		isArchived: (sessionId) => archived.has(sessionId),
		setArchived: (sessionId, value) => {
			const next = withArchived(archived, sessionId, value);
			if (next === archived) return;
			archived = next;
			writer.write(serializeArchive(next));
		},
		flush: writer.flush,
	};
}
