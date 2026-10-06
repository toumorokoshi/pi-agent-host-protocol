import { execFile } from "node:child_process";

/** Parent pid of every process, keyed by pid. */
export type ProcessTable = ReadonlyMap<number, number>;

/** Parses `ps -A -o pid=,ppid=` output. Lines that are not two numbers are skipped. */
export function parseProcessTable(output: string): ProcessTable {
	const table = new Map<number, number>();
	for (const line of output.split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid as number, ppid as number);
	}
	return table;
}

/** Direct children of `pid`. */
export function childrenOf(table: ProcessTable, pid: number): Set<number> {
	const children = new Set<number>();
	for (const [child, parent] of table) if (parent === pid) children.add(child);
	return children;
}

/**
 * Children of `pid` that were not there when the baseline was taken: processes
 * pi started since (background jobs, subagents, a tool still running).
 * Processes started at pi's startup, such as MCP servers, are in the baseline.
 */
export function newChildren(table: ProcessTable, pid: number, baseline: ReadonlySet<number>): number[] {
	return [...childrenOf(table, pid)].filter((child) => !baseline.has(child));
}

/** Reads the system's process table with `ps` (Linux and macOS). */
export function readProcessTable(): Promise<ProcessTable> {
	return new Promise((resolve, reject) => {
		execFile("ps", ["-A", "-o", "pid=,ppid="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(parseProcessTable(stdout));
		});
	});
}
