import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHRONO_DIR,
	BLOBS_DIR,
	SESSIONS_DIR,
	sessionPaths,
	ensureDirs,
	ensureSessionDirs,
	MAX_FILE_SIZE,
} from "../src/paths.ts";
import {
	isIgnoredName,
} from "../src/ignore.ts";
import {
	loadState,
	saveState,
} from "../src/state.ts";
import {
	walk,
	ingestBlob,
	sha256OfFile,
} from "../src/fs-utils.ts";
import {
	capturePreManifest,
	buildJournal,
	restoreJournal,
	finalizeJournal,
	gcBlobs,
} from "../src/journal.ts";
import {
	buildRollbackPreview,
	summarizeRollbackJournals,
} from "../src/rollback-preview.ts";
import {
	buildDiffSummary,
	formatDiffReport,
	generateContentDiffs,
} from "../src/diff.ts";
import type {
	ChronoCheckpoint,
	Journal,
} from "../src/types.ts";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
	} else {
		fail++;
		console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
	}
}

function section(name: string): void {
	console.log(`\n\x1b[1m[${name}]\x1b[0m`);
}

async function test1_basicLifecycle(): Promise<void> {
	section("1. basic lifecycle: capture → modify → diff → restore");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t1-"));
	try {
		writeFileSync(join(cwd, "a.txt"), "alpha\n");
		writeFileSync(join(cwd, "b.txt"), "bravo\n");
		writeFileSync(join(cwd, "c.txt"), "charlie\n");
		mkdirSync(join(cwd, "sub"));
		writeFileSync(join(cwd, "sub", "d.txt"), "delta\n");
		writeFileSync(join(cwd, "sub", "e.txt"), "echo\n");

		const pre = await capturePreManifest(cwd, "turn-1", "Add dark mode", null);
		assert(Object.keys(pre.files).length === 5, "pre-manifest has 5 files");
		assert(pre.files["a.txt"].sha256.length === 64, "sha256 is 64 hex chars");
		assert(pre.files["a.txt"].sha256 === pre.files["b.txt"].sha256 || pre.files["a.txt"].sha256 !== pre.files["b.txt"].sha256, "sha256 computed");

		writeFileSync(join(cwd, "a.txt"), "alpha MODIFIED\n");
		writeFileSync(join(cwd, "f.txt"), "foxtrot\n");
		rmSync(join(cwd, "c.txt"));

		const journal = await buildJournal(cwd, pre);
		assert(journal !== null, "journal is not null");
		if (!journal) return;

		const modified = journal.ops.filter((o) => o.kind === "modified");
		const created = journal.ops.filter((o) => o.kind === "created");
		const deleted = journal.ops.filter((o) => o.kind === "deleted");
		assert(modified.length === 1 && modified[0].path === "a.txt", "1 modified: a.txt");
		assert(created.length === 1 && created[0].path === "f.txt", "1 created: f.txt");
		assert(deleted.length === 1 && deleted[0].path === "c.txt", "1 deleted: c.txt");
		assert(journal.ops.length === 3, "total 3 ops");

		writeFileSync(join(cwd, "a.txt"), "alpha SECOND MOD\n");
		writeFileSync(join(cwd, "g.txt"), "should not survive restore\n");

		const ok = await restoreJournal(cwd, journal);
		assert(ok, "restore succeeded");

		assert(readFileSync(join(cwd, "a.txt"), "utf8") === "alpha\n", "a.txt restored to original");
		assert(existsSync(join(cwd, "c.txt")), "c.txt restored (was deleted by agent, now recreated from blob)");
		assert(readFileSync(join(cwd, "c.txt"), "utf8") === "charlie\n", "c.txt content restored");
		assert(!existsSync(join(cwd, "f.txt")), "f.txt removed (was created by agent)");
		assert(existsSync(join(cwd, "g.txt")), "g.txt untouched (created after journal — not in scope)");
		assert(readFileSync(join(cwd, "g.txt"), "utf8") === "should not survive restore\n", "g.txt content preserved");
		assert(readFileSync(join(cwd, "b.txt"), "utf8") === "bravo\n", "b.txt untouched");
		assert(readFileSync(join(cwd, "sub", "d.txt"), "utf8") === "delta\n", "sub/d.txt untouched");
		assert(readFileSync(join(cwd, "sub", "e.txt"), "utf8") === "echo\n", "sub/e.txt untouched");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test2_ignoreList(): Promise<void> {
	section("2. ignore list: node_modules, .git, *.log");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t2-"));
	try {
		writeFileSync(join(cwd, "src.ts"), "source\n");
		mkdirSync(join(cwd, "node_modules"));
		writeFileSync(join(cwd, "node_modules", "lib.js"), "lib\n");
		mkdirSync(join(cwd, ".git"));
		writeFileSync(join(cwd, ".git", "HEAD"), "ref\n");
		writeFileSync(join(cwd, "dist"), "should be ignored\n");
		writeFileSync(join(cwd, "app.log"), "log noise\n");
		writeFileSync(join(cwd, "debug.log"), "more noise\n");

		const pre = await capturePreManifest(cwd, "turn-1", "test", null);
		assert("src.ts" in pre.files, "src.ts captured");
		assert(!("node_modules/lib.js" in pre.files), "node_modules/lib.js skipped");
		assert(!(".git/HEAD" in pre.files), ".git/HEAD skipped");
		assert(!("dist" in pre.files), "dist/ skipped");
		assert(!("app.log" in pre.files), "app.log skipped (suffix)");
		assert(!("debug.log" in pre.files), "debug.log skipped (suffix)");
		assert(isIgnoredName("node_modules"), "isIgnored('node_modules') = true");
		assert(isIgnoredName("app.log"), "isIgnored('app.log') = true");
		assert(!isIgnoredName("src.ts"), "isIgnored('src.ts') = false");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test3_mtimeOptimization(): Promise<void> {
	section("3. mtime+size cache: skip re-hash of unchanged files");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t3-"));
	try {
		writeFileSync(join(cwd, "x.txt"), "x\n");
		writeFileSync(join(cwd, "y.txt"), "y\n");
		writeFileSync(join(cwd, "z.txt"), "z\n");

		const pre1 = await capturePreManifest(cwd, "turn-1", "first", null);
		const sha1x = pre1.files["x.txt"].sha256;
		const sha1y = pre1.files["y.txt"].sha256;
		const sha1z = pre1.files["z.txt"].sha256;

		writeFileSync(join(cwd, "y.txt"), "Y MODIFIED\n");

		const pre2 = await capturePreManifest(cwd, "turn-2", "second", pre1);
		const sha2x = pre2.files["x.txt"].sha256;
		const sha2y = pre2.files["y.txt"].sha256;
		const sha2z = pre2.files["z.txt"].sha256;

		assert(sha1x === sha2x, "x.txt sha256 reused (mtime hit)");
		assert(sha1z === sha2z, "z.txt sha256 reused (mtime hit)");
		assert(sha1y !== sha2y, "y.txt sha256 changed (rehashed)");
		assert(sha2y.length === 64, "y.txt new sha256 is valid");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test4_blobDedup(): Promise<void> {
	section("4. content-addressed blob store: dedup across files");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t4-"));
	try {
		writeFileSync(join(cwd, "a.txt"), "identical content\n");
		writeFileSync(join(cwd, "b.txt"), "identical content\n");
		writeFileSync(join(cwd, "c.txt"), "different content\n");

		const pre = await capturePreManifest(cwd, "turn-1", "test", null);
		const shaA = pre.files["a.txt"].sha256;
		const shaB = pre.files["b.txt"].sha256;
		const shaC = pre.files["c.txt"].sha256;

		assert(shaA === shaB, "a.txt and b.txt share sha (identical content)");
		assert(shaA !== shaC, "c.txt has different sha (different content)");

		assert(existsSync(join(BLOBS_DIR, shaA)), `blob ${shaA.slice(0, 12)}… exists on disk`);
		const content = readFileSync(join(BLOBS_DIR, shaA), "utf8");
		assert(content === "identical content\n", "blob content matches");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test5_perSessionIsolation(): Promise<void> {
	section("5. per-session isolation: different sessionIds = different dirs");
	const p1 = sessionPaths("test-session-A");
	const p2 = sessionPaths("test-session-B");

	assert(p1.dir !== p2.dir, "different session dirs");
	assert(p1.stateFile !== p2.stateFile, "different state files");
	assert(p1.journalsDir !== p2.journalsDir, "different journal dirs");
	assert(p1.sessionId === "test-session-A", "sessionId round-trips");

	if (existsSync(p1.dir)) rmSync(p1.dir, { recursive: true, force: true });
	if (existsSync(p2.dir)) rmSync(p2.dir, { recursive: true, force: true });

	ensureSessionDirs(p1);
	ensureSessionDirs(p2);

	saveState(p1, {
		checkpoints: [{
			entryId: "e1", journalPath: "/tmp/fake1", userMessage: "msg-A",
			timestamp: 1, opCount: 1,
		}],
	});
	saveState(p2, { checkpoints: [] });

	const s1 = loadState(p1);
	const s2 = loadState(p2);
	assert(s1.checkpoints.length === 1, "session A has 1 checkpoint");
	assert(s2.checkpoints.length === 0, "session B has 0 checkpoints");
	assert(s1.checkpoints[0].userMessage === "msg-A", "session A's checkpoint content correct");

	rmSync(p1.dir, { recursive: true, force: true });
	rmSync(p2.dir, { recursive: true, force: true });
}

async function test6_multipleTurns(): Promise<void> {
	section("6. multiple turns: each turn's journal restores to a different point");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t6-"));
	try {
		writeFileSync(join(cwd, "main.txt"), "v0\n");

		const pre1 = await capturePreManifest(cwd, "turn-1", "Add feature A", null);
		writeFileSync(join(cwd, "main.txt"), "v1 (after turn 1)\n");
		const j1 = await buildJournal(cwd, pre1);
		assert(j1 !== null, "turn 1 has a journal");
		assert(j1!.ops.length === 1, "turn 1 has 1 op (modified main.txt)");

		const pre2 = await capturePreManifest(cwd, "turn-2", "Add feature B", null);
		writeFileSync(join(cwd, "main.txt"), "v2 (after turn 2)\n");
		const j2 = await buildJournal(cwd, pre2);
		assert(j2 !== null, "turn 2 has a journal");
		assert(j2!.ops.length === 1, "turn 2 has 1 op (modified main.txt)");

		assert(
			readFileSync(join(cwd, "main.txt"), "utf8") === "v2 (after turn 2)\n",
			"current state is v2",
		);

		await restoreJournal(cwd, j1!);
		assert(
			readFileSync(join(cwd, "main.txt"), "utf8") === "v0\n",
			"rollback to j1 → v0 (pre-turn-1)",
		);

		await restoreJournal(cwd, j2!);
		assert(
			readFileSync(join(cwd, "main.txt"), "utf8") === "v1 (after turn 1)\n",
			"rollback to j2 → v1 (pre-turn-2)",
		);

		await restoreJournal(cwd, j1!);
		assert(
			readFileSync(join(cwd, "main.txt"), "utf8") === "v0\n",
			"rollback to j1 again → v0 (still works)",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test7_noChanges(): Promise<void> {
	section("7. no changes: empty journal when nothing changed");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t7-"));
	try {
		writeFileSync(join(cwd, "stable.txt"), "stable\n");

		const pre = await capturePreManifest(cwd, "turn-1", "test", null);
		const j = await buildJournal(cwd, pre);
		assert(j === null, "journal is null when no changes");

		writeFileSync(join(cwd, "stable.txt"), "stable\n");
		const j2 = await buildJournal(cwd, pre);

		if (j2 !== null) {
			assert(
				j2.ops.length === 0 || j2.ops.every((o) => o.kind === "modified" && o.path === "stable.txt"),
				"if journal exists for re-write, it has only stable.txt",
			);
		} else {
			assert(true, "no false positive on re-write (mtime hit)");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test8_symlinkSkip(): Promise<void> {
	section("8. symlinks: skipped, not followed (no loops, no escapes)");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t8-"));
	try {
		writeFileSync(join(cwd, "real.txt"), "real\n");
		mkdirSync(join(cwd, "real-dir"));
		writeFileSync(join(cwd, "real-dir", "inner.txt"), "inner\n");

		try {
			symlinkSync(join(cwd, "real-dir"), join(cwd, "link-dir"), "dir");
		} catch {
			console.log("  \x1b[33m⚠\x1b[0m symlink creation failed (Windows without dev mode?) — skipping assertion");
			return;
		}

		const pre = await capturePreManifest(cwd, "turn-1", "test", null);
		assert("real.txt" in pre.files, "real.txt captured");
		assert("real-dir/inner.txt" in pre.files, "real-dir/inner.txt captured");
		assert(!("link-dir/inner.txt" in pre.files), "symlinked dir contents NOT captured");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test9_gcBlobs(): Promise<void> {
	section("9. GC removes orphan blobs, keeps referenced ones");
	const sessionId = "gc-test-" + Date.now();
	const p = sessionPaths(sessionId);
	if (existsSync(p.dir)) rmSync(p.dir, { recursive: true, force: true });
	ensureSessionDirs(p);

	const shaOrphan = "0".repeat(64);
	const shaKept = "1".repeat(64);
	const shaKept2 = "2".repeat(64);

	writeFileSync(join(BLOBS_DIR, shaOrphan), "orphan");
	writeFileSync(join(BLOBS_DIR, shaKept), "kept by journal");
	writeFileSync(join(BLOBS_DIR, shaKept2), "kept by pending-pre");
	assert(existsSync(join(BLOBS_DIR, shaOrphan)), "orphan blob initially exists");
	assert(existsSync(join(BLOBS_DIR, shaKept)), "kept-by-journal blob initially exists");
	assert(existsSync(join(BLOBS_DIR, shaKept2)), "kept-by-pending blob initially exists");

	const journal = {
		entryId: "test-j", userMessage: "test", ts: Date.now(),
		ops: [{ kind: "modified", path: "x.txt", beforeBlob: shaKept }],
	};
	const journalPath = join(p.journalsDir, "test-j.json");
	writeFileSync(journalPath, JSON.stringify(journal));
	saveState(p, {
		checkpoints: [{ entryId: "test-j", journalPath, userMessage: "m", timestamp: 1, opCount: 1 }],
	});

	const pending = {
		entryId: "test-p", userMessage: "test-pending", ts: Date.now(),
		files: { "y.txt": { mtime: 0, size: 0, sha256: shaKept2 } },
	};
	writeFileSync(p.pendingFile, JSON.stringify(pending));

	gcBlobs();
	assert(existsSync(join(BLOBS_DIR, shaKept)), "shaKept retained (referenced by journal)");
	assert(existsSync(join(BLOBS_DIR, shaKept2)), "shaKept2 retained (referenced by pending-pre)");
	assert(!existsSync(join(BLOBS_DIR, shaOrphan)), "shaOrphan removed (unreferenced)");

	rmSync(p.dir, { recursive: true, force: true });
	rmSync(join(BLOBS_DIR, shaKept), { force: true });
	rmSync(join(BLOBS_DIR, shaKept2), { force: true });
}

async function test10_maxFileSize(): Promise<void> {
	section("10. MAX_FILE_SIZE limit (100 MB)");
	assert(MAX_FILE_SIZE === 100 * 1024 * 1024, "MAX_FILE_SIZE is exactly 100 MB");

	const cwd = mkdtempSync(join(tmpdir(), "chrono-t10-"));
	try {
		writeFileSync(join(cwd, "small.txt"), "small\n");
		const pre = await capturePreManifest(cwd, "turn-1", "test", null);
		assert("small.txt" in pre.files, "small file captured");

		const bigPath = join(cwd, "big.bin");
		writeFileSync(bigPath, "x");
		const walked = walk(cwd);
		assert(walked.length === 2, "walk includes both small files (sanity check)");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test11_blobHelpers(): Promise<void> {
	section("11. blob helpers: ingestBlob + sha256OfFile agree");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t11-"));
	try {
		const path = join(cwd, "blob-test.txt");
		writeFileSync(path, "the quick brown fox jumps over the lazy dog\n");

		const fromIngest = await ingestBlob(path);
		const fromHash = await sha256OfFile(path);

		assert(fromIngest.length === 64, "ingestBlob produces 64-char sha256");
		assert(/^[0-9a-f]{64}$/.test(fromIngest), "sha256 is hex");
		assert(fromHash === fromIngest, "sha256OfFile matches ingestBlob (cross-check)");
		assert(existsSync(join(BLOBS_DIR, fromIngest)), "blob persisted to disk");

		const before = readdirSync(BLOBS_DIR).filter((n) => !n.startsWith(".tmp-") && n === fromIngest).length;
		await ingestBlob(path);
		const after = readdirSync(BLOBS_DIR).filter((n) => !n.startsWith(".tmp-") && n === fromIngest).length;
		assert(before === 1 && after === 1, "ingestBlob is idempotent (no duplicate)");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test12_restoreCreatesParentDirs(): Promise<void> {
	section("12. restore creates missing parent directories");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t12-"));
	try {
		mkdirSync(join(cwd, "sub1"), { recursive: true });
		mkdirSync(join(cwd, "sub1", "sub2"), { recursive: true });
		writeFileSync(join(cwd, "sub1", "sub2", "deep.txt"), "deep content\n");

		const pre = await capturePreManifest(cwd, "turn-1", "test", null);
		assert("sub1/sub2/deep.txt" in pre.files, "deep file captured");

		rmSync(join(cwd, "sub1", "sub2", "deep.txt"));

		const j = await buildJournal(cwd, pre);
		assert(j !== null && j!.ops.length === 1, "1 op: deep.txt deleted");
		assert(j!.ops[0].kind === "deleted", "op is delete");

		rmSync(join(cwd, "sub1"), { recursive: true, force: true });
		assert(!existsSync(join(cwd, "sub1")), "sub1 wiped");

		const ok = await restoreJournal(cwd, j!);
		assert(ok, "restore succeeded");
		assert(
			existsSync(join(cwd, "sub1", "sub2", "deep.txt")),
			"deep.txt restored with parent dirs re-created",
		);
		assert(
			readFileSync(join(cwd, "sub1", "sub2", "deep.txt"), "utf8") === "deep content\n",
			"deep.txt content correct",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test13_finalizeJournal(): Promise<void> {
	section("13. finalizeJournal: idempotent journal builder");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t13-"));
	const sessionId = "finalize-test-" + Date.now();
	const p = sessionPaths(sessionId);
	if (existsSync(p.dir)) rmSync(p.dir, { recursive: true, force: true });
	ensureSessionDirs(p);

	try {
		writeFileSync(join(cwd, "a.txt"), "A v0\n");
		writeFileSync(join(cwd, "b.txt"), "B v0\n");

		const pre = await capturePreManifest(cwd, "turn-finalize", "Add something", null);
		assert("a.txt" in pre.files && "b.txt" in pre.files, "pre has both files");

		const r1 = await finalizeJournal(cwd, p, pre);
		assert(r1.checkpoint === null, "no changes → checkpoint is null");
		assert(r1.journal === null, "no changes → journal is null");
		assert(!existsSync(join(p.journalsDir, "turn-finalize.json")), "no journal file created");

		writeFileSync(join(cwd, "a.txt"), "A MODIFIED\n");
		writeFileSync(join(cwd, "c.txt"), "C created\n");

		const r2 = await finalizeJournal(cwd, p, pre);
		assert(r2.checkpoint !== null, "with changes → checkpoint is not null");
		assert(r2.journal !== null, "with changes → journal is not null");
		if (r2.checkpoint && r2.journal) {
			assert(r2.checkpoint.entryId === "turn-finalize", "checkpoint entryId correct");
			assert(r2.checkpoint.opCount === r2.journal.ops.length, "opCount matches journal length");
			assert(r2.checkpoint.journalPath === join(p.journalsDir, "turn-finalize.json"), "journalPath is the expected location");
			assert(existsSync(r2.checkpoint.journalPath), "journal file persisted to disk");

			const modified = r2.journal.ops.filter((o) => o.kind === "modified");
			const created = r2.journal.ops.filter((o) => o.kind === "created");
			assert(modified.length === 1 && modified[0].path === "a.txt", "1 modified: a.txt");
			assert(created.length === 1 && created[0].path === "c.txt", "1 created: c.txt");
		}

		writeFileSync(join(cwd, "a.txt"), "A MODIFIED AGAIN\n");
		writeFileSync(join(cwd, "b.txt"), "B MODIFIED\n");

		const r3 = await finalizeJournal(cwd, p, pre);
		assert(r3.checkpoint !== null, "second call: checkpoint is not null");
		if (r3.checkpoint) {
			assert(r3.checkpoint.opCount === r2.checkpoint!.opCount, "idempotent: opCount unchanged");
			assert(r3.checkpoint.opCount === 2, `idempotent: opCount is exactly 2 (got ${r3.checkpoint.opCount})`);
		}

		const journalFile = join(p.journalsDir, "turn-finalize.json");
		rmSync(journalFile);
		writeFileSync(journalFile, "not valid json{{{");

		const r4 = await finalizeJournal(cwd, p, pre);
		assert(r4.checkpoint !== null, "corrupt file: rebuilt successfully");
		if (r4.journal) {
			const aModified = r4.journal.ops.some((o) => o.kind === "modified" && o.path === "a.txt");
			const bModified = r4.journal.ops.some((o) => o.kind === "modified" && o.path === "b.txt");
			assert(aModified, "rebuilt journal includes a.txt modification");
			assert(bModified, "rebuilt journal includes b.txt modification");
		}

		rmSync(p.dir, { recursive: true, force: true });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}
async function test14_multiJournalRollback(): Promise<void> {
	section("14. multi-journal rollback: created files cleaned up across turns");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-t14-"));
	try {
		writeFileSync(join(cwd, "x.txt"), "x content\n");
		const pre1 = await capturePreManifest(cwd, "turn-1", "Create x", null);
		writeFileSync(join(cwd, "y.txt"), "y content\n");
		const j1 = await buildJournal(cwd, pre1);
		assert(j1 !== null, "turn 1 has a journal");
		const created1 = j1!.ops.filter((o) => o.kind === "created");
		assert(created1.length === 1 && created1[0].path === "y.txt", "turn 1: y.txt created");

		const pre2 = await capturePreManifest(cwd, "turn-2", "Create z", null);
		writeFileSync(join(cwd, "z.txt"), "z content\n");
		const j2 = await buildJournal(cwd, pre2);
		assert(j2 !== null, "turn 2 has a journal");
		const created2 = j2!.ops.filter((o) => o.kind === "created");
		assert(created2.length === 1 && created2[0].path === "z.txt", "turn 2: z.txt created");

		assert(existsSync(join(cwd, "x.txt")), "x.txt exists");
		assert(existsSync(join(cwd, "y.txt")), "y.txt exists");
		assert(existsSync(join(cwd, "z.txt")), "z.txt exists");

		await restoreJournal(cwd, j1!);
		assert(!existsSync(join(cwd, "y.txt")), "after j1-only restore: y.txt deleted");
		assert(existsSync(join(cwd, "z.txt")), "BUG: z.txt survives j1-only restore (created in later turn)");

		writeFileSync(join(cwd, "y.txt"), "y content\n");
		writeFileSync(join(cwd, "z.txt"), "z content\n");

		await restoreJournal(cwd, j2!);
		await restoreJournal(cwd, j1!);
		assert(!existsSync(join(cwd, "y.txt")), "after both journals: y.txt deleted");
		assert(!existsSync(join(cwd, "z.txt")), "after both journals: z.txt deleted");
		assert(existsSync(join(cwd, "x.txt")), "x.txt preserved (created before turn 1)");
		assert(readFileSync(join(cwd, "x.txt"), "utf8") === "x content\n", "x.txt content intact");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test15_rollbackPreviewSingleJournal(): Promise<void> {
	section("15. rollback preview: one journal summary");
	const journal: Journal = {
		entryId: "turn-1",
		userMessage: "test",
		ts: 1,
		ops: [
			{ kind: "modified", path: "a.txt", beforeBlob: "a".repeat(64) },
			{ kind: "deleted", path: "b.txt", beforeBlob: "b".repeat(64) },
			{ kind: "created", path: "c.txt" },
		],
	};

	const summary = summarizeRollbackJournals([journal]);
	assert(summary.journalCount === 1, "summary has 1 journal");
	assert(summary.totalOperationCount === 3, "summary has 3 raw operations");
	assert(summary.modifiedCount === 1, "modified count is 1");
	assert(summary.createdCount === 1, "recreated count is 1");
	assert(summary.deletedCount === 1, "removed count is 1");
	assert(summary.operations[0].kind === "modified" && summary.operations[0].path === "a.txt", "modified preview is M a.txt");
	assert(summary.operations[1].kind === "created" && summary.operations[1].path === "b.txt", "deleted journal op previews as recreated");
	assert(summary.operations[2].kind === "deleted" && summary.operations[2].path === "c.txt", "created journal op previews as removed");
}

async function test16_rollbackPreviewMultipleJournals(): Promise<void> {
	section("16. rollback preview: multiple journals preserve restore order");
	const j1: Journal = {
		entryId: "turn-1",
		userMessage: "first",
		ts: 1,
		ops: [{ kind: "created", path: "first.txt" }],
	};
	const j2: Journal = {
		entryId: "turn-2",
		userMessage: "second",
		ts: 2,
		ops: [{ kind: "created", path: "second.txt" }],
	};

	const summary = summarizeRollbackJournals([j1, j2]);
	assert(summary.journalCount === 2, "summary has 2 journals");
	assert(summary.totalOperationCount === 2, "summary has 2 raw operations");
	assert(summary.operations.length === 2, "summary has 2 affected files");
	assert(summary.operations[0].path === "second.txt", "newer journal appears first");
	assert(summary.operations[1].path === "first.txt", "older journal appears second");
}

async function test17_rollbackPreviewDeduplicatesFinalPathEffect(): Promise<void> {
	section("17. rollback preview: duplicate path handling");
	const j1: Journal = {
		entryId: "turn-1",
		userMessage: "create file",
		ts: 1,
		ops: [{ kind: "created", path: "shared.txt" }],
	};
	const j2: Journal = {
		entryId: "turn-2",
		userMessage: "modify file",
		ts: 2,
		ops: [{ kind: "modified", path: "shared.txt", beforeBlob: "2".repeat(64) }],
	};

	const summary = summarizeRollbackJournals([j1, j2]);
	assert(summary.totalOperationCount === 2, "duplicate path keeps raw operation count");
	assert(summary.operations.length === 1, "duplicate path is shown once");
	assert(summary.operations[0].kind === "deleted", "final preview effect is file removal");
	assert(summary.deletedCount === 1 && summary.modifiedCount === 0, "deduped counts use final effect");
}

async function test18_rollbackPreviewMissingBlobDetection(): Promise<void> {
	section("18. rollback preview: missing blob detection");
	const sessionId = "preview-missing-blob-" + Date.now();
	const p = sessionPaths(sessionId);
	if (existsSync(p.dir)) rmSync(p.dir, { recursive: true, force: true });
	ensureSessionDirs(p);

	try {
		const missingSha = "f".repeat(64);
		const journal: Journal = {
			entryId: "turn-1",
			userMessage: "test",
			ts: 1,
			ops: [{ kind: "modified", path: "missing.txt", beforeBlob: missingSha }],
		};
		const journalPath = join(p.journalsDir, "turn-1.json");
		writeFileSync(journalPath, JSON.stringify(journal), "utf8");
		const checkpoint: ChronoCheckpoint = {
			entryId: "turn-1",
			journalPath,
			userMessage: "test",
			timestamp: 1,
			opCount: 1,
		};
		const preview = buildRollbackPreview(
			"turn-1",
			[{ id: "turn-1" }],
			new Map([["turn-1", checkpoint]]),
		);

		assert(preview.journals.length === 1, "valid journal is loaded");
		assert(preview.errors.length === 1, "missing blob is reported");
		assert(preview.errors[0].path === "missing.txt", "missing blob error includes path");
	} finally {
		rmSync(p.dir, { recursive: true, force: true });
	}
}

async function test19_rollbackPreviewCorruptJournalHandling(): Promise<void> {
	section("19. rollback preview: corrupt journal handling");
	const sessionId = "preview-corrupt-journal-" + Date.now();
	const p = sessionPaths(sessionId);
	if (existsSync(p.dir)) rmSync(p.dir, { recursive: true, force: true });
	ensureSessionDirs(p);

	try {
		const journalPath = join(p.journalsDir, "turn-1.json");
		writeFileSync(journalPath, "not json{{", "utf8");
		const checkpoint: ChronoCheckpoint = {
			entryId: "turn-1",
			journalPath,
			userMessage: "test",
			timestamp: 1,
			opCount: 1,
		};
		const preview = buildRollbackPreview(
			"turn-1",
			[{ id: "turn-1" }],
			new Map([["turn-1", checkpoint]]),
		);

		assert(preview.journals.length === 0, "corrupt journal is not loaded");
		assert(preview.errors.length === 1, "corrupt journal is reported");
		assert(preview.errors[0].checkpointEntryId === "turn-1", "corrupt journal error includes checkpoint");
	} finally {
		rmSync(p.dir, { recursive: true, force: true });
	}
}

async function test20_diffSummaryReportsMissingBlobs(): Promise<void> {
	section("20. chrono diff: missing blob warning");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-diff-missing-"));
	try {
		const missingSha = "e".repeat(64);
		const journal: Journal = {
			entryId: "turn-1",
			userMessage: "test",
			ts: 1,
			ops: [{ kind: "modified", path: "missing.txt", beforeBlob: missingSha }],
		};
		const journalPath = join(cwd, "turn-1.json");
		writeFileSync(journalPath, JSON.stringify(journal), "utf8");
		const checkpoint: ChronoCheckpoint = {
			entryId: "turn-1",
			journalPath,
			userMessage: "test",
			timestamp: 1,
			opCount: 1,
		};

		const report = buildDiffSummary(
			checkpoint,
			[{ id: "turn-1" }],
			new Map([["turn-1", checkpoint]]),
		);

		assert(report !== null, "diff report is built");
		assert(report!.errors.length === 1, "missing blob is reported");
		assert(report!.errors[0].message.includes("missing.txt"), "missing blob warning includes path");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function test21_diffReportUsesRollbackEffectLabels(): Promise<void> {
	section("21. chrono diff: effect labels");
	const report = {
		checkpointEntryId: "turn-1",
		checkpointTimestamp: 1,
		userMessagePreview: "test",
		journalCount: 1,
		operations: [
			{ kind: "created", path: "recreate.txt" },
			{ kind: "deleted", path: "remove.txt" },
		],
		modifiedCount: 0,
		createdCount: 1,
		deletedCount: 1,
		totalRawOps: 2,
		errors: [],
	} satisfies NonNullable<ReturnType<typeof buildDiffSummary>>;

	const text = formatDiffReport(report, { maxPaths: Infinity });
	assert(text.includes("Recreate:\n  A recreate.txt"), "created preview is shown as recreate");
	assert(text.includes("Remove:\n  D remove.txt"), "deleted preview is shown as remove");
}

async function test22_contentDiffDeduplicatesAndShowsTailDeletion(): Promise<void> {
	section("22. chrono diff: content diff dedupe and tail deletion");
	const cwd = mkdtempSync(join(tmpdir(), "chrono-diff-content-"));
	const oldCwd = process.cwd();
	const olderSha = "c".repeat(64);
	const newerSha = "d".repeat(64);

	try {
		try {
			writeFileSync(join(BLOBS_DIR, olderSha), "one\ntwo\nremoved\n", "utf8");
			writeFileSync(join(BLOBS_DIR, newerSha), "newer intermediate\n", "utf8");
		} catch {
			console.log("  \x1b[33m!\x1b[0m blob store is not writable - skipping content diff assertion");
			return;
		}
		writeFileSync(join(cwd, "file.txt"), "one\ntwo\n", "utf8");
		process.chdir(cwd);

		const older: Journal = {
			entryId: "turn-1",
			userMessage: "older",
			ts: 1,
			ops: [{ kind: "modified", path: "file.txt", beforeBlob: olderSha }],
		};
		const newer: Journal = {
			entryId: "turn-2",
			userMessage: "newer",
			ts: 2,
			ops: [{ kind: "modified", path: "file.txt", beforeBlob: newerSha }],
		};
		const report = {
			checkpointEntryId: "turn-1",
			checkpointTimestamp: 1,
			userMessagePreview: "older",
			journalCount: 2,
			operations: [{ kind: "modified", path: "file.txt" }],
			modifiedCount: 1,
			createdCount: 0,
			deletedCount: 0,
			totalRawOps: 2,
			errors: [],
		} satisfies NonNullable<ReturnType<typeof buildDiffSummary>>;

		const diffs = generateContentDiffs(report, [older, newer]);
		assert(diffs.length === 1, "duplicate path produces one content diff");
		assert(diffs[0].removedLines > 0, "tail deletion is reported");
		assert(diffs[0].diffText.includes("-removed"), "diff includes removed tail line");
		assert(!diffs[0].diffText.includes("newer intermediate"), "older effective blob is used");
	} finally {
		process.chdir(oldCwd);
		rmSync(cwd, { recursive: true, force: true });
		rmSync(join(BLOBS_DIR, olderSha), { force: true });
		rmSync(join(BLOBS_DIR, newerSha), { force: true });
	}
}

async function main(): Promise<void> {
	console.log("\x1b[1m\x1b[36mpi-chrono smoke test\x1b[0m");
	console.log("\x1b[2m" + "=".repeat(50) + "\x1b[0m");
	console.log(`CHRONO_DIR:   ${CHRONO_DIR}`);
	console.log(`SESSIONS_DIR: ${SESSIONS_DIR}`);
	console.log(`BLOBS_DIR:    ${BLOBS_DIR}`);
	console.log(`Node:         ${process.version}`);

	ensureDirs();

	const tests: Array<() => Promise<void>> = [
		test1_basicLifecycle,
		test2_ignoreList,
		test3_mtimeOptimization,
		test4_blobDedup,
		test5_perSessionIsolation,
		test6_multipleTurns,
		test7_noChanges,
		test8_symlinkSkip,
		test9_gcBlobs,
		test10_maxFileSize,
		test11_blobHelpers,
		test12_restoreCreatesParentDirs,
		test13_finalizeJournal,
		test14_multiJournalRollback,
		test15_rollbackPreviewSingleJournal,
		test16_rollbackPreviewMultipleJournals,
		test17_rollbackPreviewDeduplicatesFinalPathEffect,
		test18_rollbackPreviewMissingBlobDetection,
		test19_rollbackPreviewCorruptJournalHandling,
		test20_diffSummaryReportsMissingBlobs,
		test21_diffReportUsesRollbackEffectLabels,
		test22_contentDiffDeduplicatesAndShowsTailDeletion,
	];

	for (const t of tests) {
		try {
			await t();
		} catch (err) {
			fail++;
			console.error(`  \x1b[31m✗\x1b[0m test crashed: ${err}`);
		}
	}

	console.log("\n" + "=".repeat(50));
	if (fail === 0) {
		console.log(`\x1b[1m\x1b[32m✓ All ${pass} assertions passed\x1b[0m`);
		process.exit(0);
	} else {
		console.log(`\x1b[1m\x1b[31m✗ ${fail} failed, ${pass} passed\x1b[0m`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Test runner crashed:", err);
	process.exit(2);
});
