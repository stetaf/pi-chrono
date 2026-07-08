
import { createReadStream, existsSync, readdirSync, statSync, copyFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildIgnoreMatcher } from "./ignore.ts";
import type { WalkEntry, WalkOptions } from "./types.ts";
import { BLOBS_DIR, MAX_FILE_SIZE } from "./paths.ts";

export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(): Promise<void> {
		while (next < items.length) {
			const idx = next++;
			results[idx] = await fn(items[idx]);
		}
	}

	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

export function walk(cwd: string, options?: WalkOptions): WalkEntry[] {
	const prefix = options?.prefix ?? "";
	const m = options?.matcher ?? buildIgnoreMatcher();
	const out: WalkEntry[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(join(cwd, prefix), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.isSymbolicLink()) continue;

		const rel = prefix ? `${prefix}/${e.name}` : e.name;

		if (m.isIgnoredEntry(e.name)) continue;
		if (m.matchesGlob(rel)) continue;

		if (e.isDirectory()) {
			out.push(...walk(cwd, { prefix: rel, matcher: m }));
		} else if (e.isFile()) {
			try {
				const s = statSync(join(cwd, rel));
				if (s.size > MAX_FILE_SIZE) continue;
				out.push({ path: rel, mtime: s.mtimeMs, size: s.size });
			} catch { /* skip */ }
		}
	}
	return out;
}

export async function ingestBlob(srcPath: string): Promise<string> {
	const sha = await sha256OfFile(srcPath);
	const dest = join(BLOBS_DIR, sha);
	if (!existsSync(dest)) {
		copyFileSync(srcPath, dest);
	}
	return sha;
}

export function sha256OfFile(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
}
