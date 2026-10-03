import { readdir, readFile, stat } from "node:fs/promises";
import {
	AhpErrorCodes,
	ContentEncoding,
	type DirectoryEntry,
	type ResourceListResult,
	type ResourceReadResult,
	type ResourceResolveResult,
	ResourceType,
} from "@microsoft/agent-host-protocol";
import { fileUri, pathFromFileUri } from "../core/uris.ts";
import { ProtocolError } from "../protocol/jsonrpc.ts";

const MAX_READ_BYTES = 16 * 1024 * 1024;

/**
 * Read-only access to host-local `file:` resources, which clients use to
 * browse for working directories and open files the agent touched.
 */
export class ResourceService {
	async read(uri: unknown, encoding: unknown): Promise<ResourceReadResult> {
		const path = this.#path(uri);
		const info = await this.#stat(path, uri);
		if (!info.isFile()) throw new ProtocolError(AhpErrorCodes.NotFound, `Not a file: ${uri}`);
		if (info.size > MAX_READ_BYTES) throw ProtocolError.invalidParams(`File too large: ${info.size} bytes`);
		const data = await readFile(path);
		return encoding === ContentEncoding.Utf8
			? { data: data.toString("utf8"), encoding: ContentEncoding.Utf8 }
			: { data: data.toString("base64"), encoding: ContentEncoding.Base64 };
	}

	async list(uri: unknown): Promise<ResourceListResult> {
		const path = this.#path(uri);
		const dirents = await readdir(path, { withFileTypes: true }).catch(() => {
			throw ProtocolError.notFound(String(uri));
		});
		const entries: DirectoryEntry[] = [];
		for (const dirent of dirents) {
			let directory = dirent.isDirectory();
			if (dirent.isSymbolicLink()) {
				directory = (await stat(`${path}/${dirent.name}`).catch(() => undefined))?.isDirectory() ?? false;
			}
			entries.push({ name: dirent.name, type: directory ? "directory" : "file" });
		}
		return { entries };
	}

	async resolve(uri: unknown): Promise<ResourceResolveResult> {
		const path = this.#path(uri);
		const info = await this.#stat(path, uri);
		return {
			uri: fileUri(path),
			type: info.isDirectory() ? ResourceType.Directory : ResourceType.File,
			size: info.size,
			mtime: info.mtime.toISOString(),
			ctime: info.ctime.toISOString(),
		};
	}

	denied(method: string): never {
		throw new ProtocolError(AhpErrorCodes.PermissionDenied, `${method} is not permitted by this host`, {});
	}

	#path(uri: unknown): string {
		const path = typeof uri === "string" ? pathFromFileUri(uri) : undefined;
		if (!path) throw ProtocolError.invalidParams(`Unsupported resource URI: ${String(uri)}`);
		return path;
	}

	async #stat(path: string, uri: unknown) {
		try {
			return await stat(path);
		} catch {
			throw ProtocolError.notFound(String(uri));
		}
	}
}
