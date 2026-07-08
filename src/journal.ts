
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildIgnoreMatcher } from "./ignore.ts";
import type { PreManifest, FileMeta, Journal, FsOp, WalkEntry, FinalizeResult, PersistedState, SessionPaths } from "./types.ts";
import { BLOBS_DIR, SESSIONS_DIR, sessionPaths, ensureDirs, ensureSessionDirs } from "./paths.ts";
import { walk, ingestBlob, sha256OfFile, mapLimit } from "./fs-utils.ts";
import { DEFAULT_HASH_CONCURRENCY, DEFAULT_STRICT_HASH } from "./config.ts";

export async function capturePreManifest(
	cwd: string,
	entryId: string,
	userMessage: string,
	prev: PreManifest | null,
): Promise<PreManifest> {
	ensureDirs();
	const matcher = buildIgnoreMatcher({ rootDir: cwd });
	const walked = walk(cwd, { matcher });
	const files: Record<string, FileMeta> = {};

	await mapLimit(walked, DEFAULT_HASH_CONCURRENCY, async (entry) => {
		const prevMeta = prev?.files[entry.path];
		if (
			prevMeta &&
			prevMeta.mtime === entry.mtime &&
			prevMeta.size === entry.size &&
			existsSync(join(BLOBS_DIR, prevMeta.sha256))
		) {
			files[entry.path] = prevMeta;
			return;
		}
		try {
			const sha = await ingestBlob(join(cwd, entry.path));
			files[entry.path] = { mtime: entry.mtime, size: entry.size, sha256: sha };
		} catch {
			// File unreadable — skip
		}
	});

	return { entryId, userMessage, ts: Date.now(), files };
}

export async function buildJournal(cwd: string, pre: PreManifest): Promise<Journal | null> {
	const matcher = buildIgnoreMatcher({ rootDir: cwd });
	const strictHash = DEFAULT_STRICT_HASH;

	const post = walk(cwd, { matcher });
	const postMap = new Map(post.map((f) => [f.path, f]));
	const ops: FsOp[] = [];

	for (const [path, meta] of Object.entries(pre.files)) {
		if (!postMap.has(path)) {
			ops.push({ kind: "deleted", path, beforeBlob: meta.sha256 });
		}
	}

	for (const f of post) {
		if (!(f.path in pre.files)) {
			ops.push({ kind: "created", path: f.path });
		}
	}

	const candidates: WalkEntry[] = [];
	for (const f of post) {
		const before = pre.files[f.path];
		if (!before) continue;

		if (!strictHash && before.mtime === f.mtime && before.size === f.size) {
			continue;
		}

		candidates.push(f);
	}

	const postSha = new Map<string, string>();
	await mapLimit(candidates, DEFAULT_HASH_CONCURRENCY, async (f) => {
		try {
			const sha = await sha256OfFile(join(cwd, f.path));
			postSha.set(f.path, sha);
		} catch { /* unreadable, skip */ }
	});

	for (const f of candidates) {
		const before = pre.files[f.path];
		const after = postSha.get(f.path);
		if (after && after !== before.sha256) {
			ops.push({ kind: "modified", path: f.path, beforeBlob: before.sha256 });
		}
	}

	if (ops.length === 0) return null;
	return { entryId: pre.entryId, userMessage: pre.userMessage, ts: pre.ts, ops };
}

export async function finalizeJournal(
	cwd: string,
	p: SessionPaths,
	pre: PreManifest,
): Promise<FinalizeResult> {
	ensureSessionDirs(p);
	const journalPath = join(p.journalsDir, `${pre.entryId}.json`);

	if (existsSync(journalPath)) {
		try {
			const existing = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
			return {
				checkpoint: {
					entryId: pre.entryId,
					journalPath,
					userMessage: pre.userMessage,
					timestamp: pre.ts,
					opCount: existing.ops.length,
				},
				journal: existing,
			};
		} catch { /* corrupted */ }
	}

	const journal = await buildJournal(cwd, pre);
	if (!journal) {
		return { checkpoint: null, journal: null };
	}

	writeFileSync(journalPath, JSON.stringify(journal), "utf8");
	return {
		checkpoint: {
			entryId: pre.entryId,
			journalPath,
			userMessage: pre.userMessage,
			timestamp: pre.ts,
			opCount: journal.ops.length,
		},
		journal,
	};
}

export async function restoreJournal(cwd: string, journal: Journal): Promise<boolean> {
	try {
		for (const op of journal.ops) {
			const destPath = join(cwd, op.path);
			switch (op.kind) {
				case "modified":
				case "deleted": {
					const blobPath = join(BLOBS_DIR, op.beforeBlob);
					if (!existsSync(blobPath)) {
						throw new Error(`Missing blob ${op.beforeBlob} for ${op.path}`);
					}
					const buf = readFileSync(blobPath);
					const parent = join(destPath, "..");
					if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
					writeFileSync(destPath, buf);
					break;
				}
				case "created":
					rmSync(destPath, { recursive: true, force: true });
					break;
			}
		}
		return true;
	} catch (err) {
		return false;
	}
}

export function gcBlobs(): void {
	if (!existsSync(BLOBS_DIR)) return;

	try {
		const referenced = new Set<string>();

		if (existsSync(SESSIONS_DIR)) {
			for (const sessionId of readdirSync(SESSIONS_DIR)) {
				const p = sessionPaths(sessionId);
				if (!existsSync(p.stateFile)) continue;
				try {
					const state = JSON.parse(readFileSync(p.stateFile, "utf8")) as PersistedState;
					for (const cp of state.checkpoints) {
						if (!existsSync(cp.journalPath)) continue;
						try {
							const j = JSON.parse(readFileSync(cp.journalPath, "utf8")) as Journal;
							for (const op of j.ops) {
								if (op.kind === "modified" || op.kind === "deleted") {
									referenced.add(op.beforeBlob);
								}
							}
						} catch {
							// Bad journal — skip
						}
					}
				} catch {
					continue;
				}

				if (existsSync(p.pendingFile)) {
					try {
						const pre = JSON.parse(readFileSync(p.pendingFile, "utf8")) as PreManifest;
						for (const meta of Object.values(pre.files)) {
							referenced.add(meta.sha256);
						}
					} catch {
						// Bad pending — skip
					}
				}
			}
		}

		for (const name of readdirSync(BLOBS_DIR)) {
			if (name.startsWith(".tmp-")) {
				rmSync(join(BLOBS_DIR, name), { force: true });
				continue;
			}
			if (!referenced.has(name)) {
				rmSync(join(BLOBS_DIR, name), { force: true });
			}
		}
	} catch {
		// Best-effort: if anything fails, leave blobs in place
	}
}
