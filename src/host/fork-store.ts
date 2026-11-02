import { dirname, join } from "node:path";
import { atomicWriter, readOptional } from "./json-file.ts";

/** The forked-chats file, next to the host's settings file. */
export function forkStorePath(settingsFile: string): string {
	return join(dirname(settingsFile), "forked-chats.json");
}

/**
 * A chat forked from another chat of an AHP session. It is backed by its own
 * pi session file (written by pi's `createBranchedSession`), which is not
 * listed as a session of its own.
 */
export interface ForkRecord {
	/** Id of the AHP session (and pi session) the chat belongs to. */
	readonly session: string;
	/** The chat URI the client chose. */
	readonly chat: string;
	/** URI of the chat it was forked from. */
	readonly source: string;
	/** The source turn it was forked at. */
	readonly turnId: string;
}

/** Forked chats, keyed by the id of the pi session backing each one. */
export type Forks = ReadonlyMap<string, ForkRecord>;

/**
 * Which pi sessions are chats forked inside another session. pi's session
 * files only record a parent file, which pi's own `/fork` also writes for
 * sessions meant to stand alone, so the host keeps its forks in its own file.
 */
export interface ForkStore {
	all(): Forks;
	add(id: string, record: ForkRecord): void;
	/** Resolves once every pending write has finished. */
	flush(): Promise<void>;
}

/** On-disk format of the forked-chats file. */
interface ForkFile {
	version: 1;
	forks: Record<string, ForkRecord>;
}

function isRecord(value: unknown): value is ForkRecord {
	const record = value as Partial<ForkRecord> | null;
	return (
		typeof record === "object" &&
		record !== null &&
		typeof record.session === "string" &&
		typeof record.chat === "string" &&
		typeof record.source === "string" &&
		typeof record.turnId === "string"
	);
}

/** Parses the forked-chats file. Malformed content, or malformed entries, are left out. */
export function parseForks(text: string): Forks {
	try {
		const raw = JSON.parse(text) as Partial<ForkFile>;
		const entries = typeof raw.forks === "object" && raw.forks !== null ? Object.entries(raw.forks) : [];
		return new Map(entries.filter((entry): entry is [string, ForkRecord] => isRecord(entry[1])));
	} catch {
		return new Map();
	}
}

/** Serializes forks, sorted by id so the file is stable. */
export function serializeForks(forks: Forks): string {
	const file: ForkFile = {
		version: 1,
		forks: Object.fromEntries([...forks].sort(([a], [b]) => a.localeCompare(b))),
	};
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/** The fork whose chat URI is `chat`, as `[id, record]`. */
export function forkByChat(forks: Forks, chat: string): [string, ForkRecord] | undefined {
	return [...forks].find(([, record]) => record.chat === chat);
}

/**
 * The forks belonging to the AHP session `sessionId`, as `[id, record]`,
 * oldest first (pi's session ids are UUIDv7s, which sort by creation time).
 */
export function forksOf(forks: Forks, sessionId: string): [string, ForkRecord][] {
	return [...forks].filter(([, record]) => record.session === sessionId).sort(([a], [b]) => a.localeCompare(b));
}

/** Forks kept only in memory (tests, and hosts without a state directory). */
export function memoryForkStore(initial: Iterable<[string, ForkRecord]> = []): ForkStore {
	const forks = new Map(initial);
	return {
		all: () => forks,
		add: (id, record) => {
			forks.set(id, record);
		},
		flush: async () => {},
	};
}

/** Loads the forked-chats file at `path` (missing means none) and writes it back on every change. */
export async function fileForkStore(path: string, onError: (error: unknown) => void = () => {}): Promise<ForkStore> {
	const text = await readOptional(path);
	const forks = new Map(text === undefined ? [] : parseForks(text));
	const writer = atomicWriter(path, onError);
	return {
		all: () => forks,
		add: (id, record) => {
			forks.set(id, record);
			writer.write(serializeForks(forks));
		},
		flush: writer.flush,
	};
}
