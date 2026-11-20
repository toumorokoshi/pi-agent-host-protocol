import { dirname, join } from "node:path";
import type { Annotation } from "@microsoft/agent-host-protocol";
import { atomicWriter, readOptional } from "./json-file.ts";

/** The annotations file, next to the host's settings file. */
export function annotationStorePath(settingsFile: string): string {
	return join(dirname(settingsFile), "annotations.json");
}

/**
 * Each session's annotations (VS Code's review comments), which pi's session
 * files cannot hold. Without it, comments a user left but had not submitted
 * would vanish when the host restarts. See specs/annotations.md.
 */
export interface AnnotationStore {
	annotationsOf(sessionId: string): readonly Annotation[];
	/** Replaces a session's annotations. Persisting is asynchronous; failures are reported through `onError`. */
	setAnnotations(sessionId: string, annotations: readonly Annotation[]): void;
	/** Resolves once every pending write has finished. */
	flush(): Promise<void>;
}

/** On-disk format of the annotations file. */
interface AnnotationFile {
	version: 1;
	sessions: Record<string, readonly Annotation[]>;
}

type Sessions = ReadonlyMap<string, readonly Annotation[]>;

function isAnnotation(value: unknown): value is Annotation {
	const candidate = value as Partial<Annotation> | null;
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		typeof candidate.id === "string" &&
		typeof candidate.resource === "string" &&
		Array.isArray(candidate.entries)
	);
}

/** Parses the annotations file's contents. Malformed content, or malformed annotations, are dropped. */
export function parseAnnotations(text: string): Sessions {
	try {
		const raw = JSON.parse(text) as Partial<AnnotationFile>;
		const sessions = new Map<string, Annotation[]>();
		for (const [id, list] of Object.entries(raw.sessions ?? {})) {
			const annotations = Array.isArray(list) ? list.filter(isAnnotation) : [];
			if (annotations.length > 0) sessions.set(id, annotations);
		}
		return sessions;
	} catch {
		return new Map();
	}
}

/** Serializes the sessions that have annotations, sorted by id so the file is stable. */
export function serializeAnnotations(sessions: Sessions): string {
	const entries = [...sessions].sort(([a], [b]) => a.localeCompare(b));
	const file: AnnotationFile = { version: 1, sessions: Object.fromEntries(entries) };
	return `${JSON.stringify(file, null, "\t")}\n`;
}

function withAnnotations(sessions: Sessions, sessionId: string, annotations: readonly Annotation[]): Sessions {
	const next = new Map(sessions);
	if (annotations.length > 0) next.set(sessionId, annotations);
	else next.delete(sessionId);
	return next;
}

/** An annotation store kept only in memory (tests, and hosts without a state directory). */
export function memoryAnnotationStore(): AnnotationStore {
	let sessions: Sessions = new Map();
	return {
		annotationsOf: (sessionId) => sessions.get(sessionId) ?? [],
		setAnnotations: (sessionId, annotations) => {
			sessions = withAnnotations(sessions, sessionId, annotations);
		},
		flush: async () => {},
	};
}

/**
 * Loads the annotations file at `path` (missing means no annotations) and
 * writes it back on every change. Writes are serialized and atomic (temp file
 * plus rename), so a crash never leaves a truncated file.
 */
export async function fileAnnotationStore(
	path: string,
	onError: (error: unknown) => void = () => {},
): Promise<AnnotationStore> {
	const text = await readOptional(path);
	let sessions = text === undefined ? new Map<string, readonly Annotation[]>() : parseAnnotations(text);
	const writer = atomicWriter(path, onError);
	return {
		annotationsOf: (sessionId) => sessions.get(sessionId) ?? [],
		setAnnotations: (sessionId, annotations) => {
			if (annotations.length === 0 && !sessions.has(sessionId)) return;
			sessions = withAnnotations(sessions, sessionId, annotations);
			writer.write(serializeAnnotations(sessions));
		},
		flush: writer.flush,
	};
}
