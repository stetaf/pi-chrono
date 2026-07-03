
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync, rmSync, renameSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { WalkEntry } from "./types.ts";
import { BLOBS_DIR, MAX_FILE_SIZE, isIgnored } from "./paths.ts";

export function walk(cwd: string, prefix = ""): WalkEntry[] {
	const out: WalkEntry[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(join(cwd, prefix), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (isIgnored(e.name)) continue;
		if (e.isSymbolicLink()) continue;
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		if (e.isDirectory()) {
			out.push(...walk(cwd, rel));
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

export function ingestBlob(srcPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const tmpPath = join(
			BLOBS_DIR,
			`.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		const tmpStream = createWriteStream(tmpPath);
		const srcStream = createReadStream(srcPath);

		srcStream.on("data", (chunk: Buffer | string) => hash.update(chunk));
		srcStream.on("error", (err) => {
			rmSync(tmpPath, { force: true });
			reject(err);
		});
		srcStream.pipe(tmpStream);

		tmpStream.on("finish", () => {
			try {
				const sha = hash.digest("hex");
				const dest = join(BLOBS_DIR, sha);
				if (!existsSync(dest)) {
					renameSync(tmpPath, dest);
				} else {
					rmSync(tmpPath, { force: true });
				}
				resolve(sha);
			} catch (err) {
				reject(err);
			}
		});
		tmpStream.on("error", (err) => {
			rmSync(tmpPath, { force: true });
			reject(err);
		});
	});
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
