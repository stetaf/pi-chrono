import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	BlobStats,
	CheckpointStatusItem,
	ChronoCheckpoint,
	FsOp,
	Journal,
	JournalDiskStats,
	JournalReadResult,
	PendingStatus,
	PreManifest,
	SessionPaths,
	StatusReport,
} from "./types.ts";
import { CHRONO_DIR, BLOBS_DIR } from "./paths.ts";
import { PENDING_ENTRY_ID_PREFIX } from "./state.ts";

const MAX_STATUS_CHECKPOINTS = 16;

function truncate(text: string, max = 60): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "...";
}

function fmtTs(ts?: number | null): string {
	if (ts == null || typeof ts !== "number" || isNaN(ts)) return "--";
	const d = new Date(ts);
	return `${String(d.getDate()).padStart(2, "0")}/${String(
		d.getMonth() + 1,
	).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
		d.getMinutes(),
	).padStart(2, "0")}`;
}

function fmtSize(bytes: bigint): string {
	if (bytes === 0n) return "0 B";
	if (bytes < 1_048_576n) return Number(bytes / 1024n).toString() + " KiB";
	return Number(bytes / 1_048_576n).toFixed(1) + " MiB";
}

function isFsOp(value: unknown): value is FsOp {
	if (!value || typeof value !== "object") return false;
	const op = value as Record<string, unknown>;
	if (typeof op.path !== "string") return false;

	switch (op.kind) {
		case "created":
			return true;
		case "deleted":
		case "modified":
			return typeof op.beforeBlob === "string";
		default:
			return false;
	}
}

function isJournal(value: unknown): value is Journal {
	if (!value || typeof value !== "object") return false;
	const journal = value as Record<string, unknown>;
	return (
		typeof journal.entryId === "string" &&
		typeof journal.userMessage === "string" &&
		typeof journal.ts === "number" &&
		Array.isArray(journal.ops) &&
		journal.ops.every(isFsOp)
	);
}

export function loadJournalSafe(journalPath?: string | null): JournalReadResult {
	if (!journalPath || !existsSync(journalPath)) {
		return { journal: null, corrupt: false };
	}

	try {
		const raw = readFileSync(journalPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isJournal(parsed)) return { journal: null, corrupt: true };
		return { journal: parsed, corrupt: false };
	} catch {
		return { journal: null, corrupt: true };
	}
}

export function detectMissingBlobsInJournal(ops: readonly FsOp[]): string[] {
	const missingPaths: string[] = [];

	for (const op of ops) {
		if (op.kind === "created") continue;
		if (!existsSync(join(BLOBS_DIR, op.beforeBlob))) {
			missingPaths.push(op.beforeBlob);
		}
	}

	return missingPaths;
}

export function computeCheckpointStatusItems(
	checkpoints: readonly ChronoCheckpoint[],
	branchIds: ReadonlySet<string>,
): CheckpointStatusItem[] {
	const items: CheckpointStatusItem[] = [];

	for (const cp of checkpoints) {
		const journalExists = existsSync(cp.journalPath);
		const readResult = loadJournalSafe(cp.journalPath);

		if (!readResult.journal) {
			items.push({
				entryId: cp.entryId,
				timestamp: cp.timestamp,
				userMessagePreview: truncate(cp.userMessage, 60),
				operationCount: 0,
				journalExists,
				journalReadable: journalExists && !readResult.corrupt,
				inCurrentBranch: branchIds.has(cp.entryId),
				missingBlobPaths: [],
			});
			continue;
		}

		const journal = readResult.journal;
		items.push({
			entryId: cp.entryId,
			timestamp: journal.ts,
			userMessagePreview: truncate(journal.userMessage, 60),
			operationCount: journal.ops.length,
			journalExists: true,
			journalReadable: true,
			inCurrentBranch: branchIds.has(cp.entryId),
			missingBlobPaths: detectMissingBlobsInJournal(journal.ops),
		});
	}

	return items;
}

export function countSessionJournalsOnDisk(p: SessionPaths): JournalDiskStats {
	let totalFiles = 0;
	let readableFiles = 0;
	let corruptFiles = 0;

	if (!existsSync(p.journalsDir)) {
		return { totalFiles, readableFiles, corruptFiles };
	}

	try {
		for (const file of readdirSync(p.journalsDir)) {
			if (!file.endsWith(".json")) continue;
			totalFiles++;

			const readResult = loadJournalSafe(join(p.journalsDir, file));
			if (readResult.journal) {
				readableFiles++;
			} else {
				corruptFiles++;
			}
		}
	} catch {
		return { totalFiles: 0, readableFiles: 0, corruptFiles: 0 };
	}

	return { totalFiles, readableFiles, corruptFiles };
}

function countBlobs(): BlobStats {
	let count = 0;
	let totalBytes = 0n;

	if (!existsSync(BLOBS_DIR)) return { count, totalBytes };

	try {
		for (const name of readdirSync(BLOBS_DIR)) {
			try {
				totalBytes += BigInt(statSync(join(BLOBS_DIR, name)).size);
				count++;
			} catch {
				continue;
			}
		}
	} catch {
		// Directory unreadable: keep best-effort zero stats.
	}

	return { count, totalBytes };
}

function pendingPreReport(pre: PreManifest | null | undefined): PendingStatus {
	if (!pre) return { exists: false, boundToUserMessage: false, fileCount: 0 };
	return {
		exists: true,
		boundToUserMessage: !pre.entryId.startsWith(PENDING_ENTRY_ID_PREFIX),
		fileCount: Object.keys(pre.files).length,
	};
}

function statusKind(hasError: boolean, hasWarning: boolean): "error" | "warning" | "ok" {
	if (hasError) return "error";
	if (hasWarning) return "warning";
	return "ok";
}

function pendingLine(pending: PendingStatus): string {
	const state = pending.boundToUserMessage ? "ready" : "waiting for message id";
	return `  PENDING  ${state} (${pending.fileCount} file(s))`;
}

function journalsLine(stats: JournalDiskStats): string {
	return [
		`  JOURNALS ${stats.totalFiles} file(s)`,
		`(${stats.readableFiles} ok, ${stats.corruptFiles} corrupt)`,
	].join(" ");
}

function checkpointBadge(item: CheckpointStatusItem): string {
	if (!item.journalExists) return " [missing journal]";
	if (!item.journalReadable) return " [corrupt journal]";
	if (item.missingBlobPaths.length > 0) {
		return ` [${item.missingBlobPaths.length} missing blob(s)]`;
	}
	if (!item.inCurrentBranch && item.operationCount > 0) return " [out-of-branch]";
	return "";
}

function pushStorageSummary(
	lines: string[],
	blobStats: BlobStats,
	journalDiskCount: JournalDiskStats,
): void {
	lines.push(journalsLine(journalDiskCount));
	lines.push(`  BLOBS    ${blobStats.count} file(s), ~${fmtSize(blobStats.totalBytes)}`);
	lines.push(`  STORAGE  ${CHRONO_DIR}`);
}

export function buildStatusReport(
	sessionId?: string | null,
	checkpointsInMemory: readonly ChronoCheckpoint[] = [],
	branchIds?: ReadonlySet<string>,
	sessionPathsInfo?: SessionPaths | null,
	pendingPreState?: PreManifest | null,
): StatusReport {
	const branchSet = new Set(branchIds ?? []);
	const pending = pendingPreReport(pendingPreState);
	const blobStats = countBlobs();
	const checkpointItems = computeCheckpointStatusItems(checkpointsInMemory, branchSet);
	const journalDiskCount = sessionPathsInfo
		? countSessionJournalsOnDisk(sessionPathsInfo)
		: { totalFiles: 0, readableFiles: 0, corruptFiles: 0 };

	let hasError = false;
	let hasWarning = false;

	for (const item of checkpointItems) {
		if (!item.journalExists || !item.journalReadable) hasError = true;
		else if (item.missingBlobPaths.length > 0) hasWarning = true;
		else if (!item.inCurrentBranch && item.operationCount > 0) hasWarning = true;
	}

	if (journalDiskCount.corruptFiles > 0) hasError = true;
	if (pending.exists && !pending.boundToUserMessage) hasWarning = true;

	const lines: string[] = [];
	lines.push("Chrono status:");

	if (sessionId && typeof sessionId === "string") {
		lines.push(`  SESSION  ${truncate(sessionId, 40)}`);
	}

	lines.push(`  STATUS   ${statusKind(hasError, hasWarning)}`);

	if (!checkpointItems.length) {
		lines.push("  MEMORY   no checkpoints loaded");
		pushStorageSummary(lines, blobStats, journalDiskCount);
		if (pending.exists) {
			lines.push(pendingLine(pending));
		}
		return { lines, hasError, hasWarning };
	}

	const totalOps = checkpointItems.reduce((sum, i) => sum + i.operationCount, 0);
	lines.push(`  MEMORY   ${checkpointsInMemory.length} checkpoint(s) - ${totalOps} op(s)`);
	pushStorageSummary(lines, blobStats, journalDiskCount);

	lines.push("");
	lines.push("Checkpoints:");

	for (let i = 0; i < checkpointItems.length && i < MAX_STATUS_CHECKPOINTS; i++) {
		const item = checkpointItems[i];
		const ts = fmtTs(item.timestamp);
		const msg = truncate(item.userMessagePreview, 50);
		const badge = checkpointBadge(item);
		const ops = item.operationCount > 0 ? ` (${item.operationCount} op(s))` : "";
		lines.push(`  ${ts}  ${msg}${ops}${badge}`);
	}

	if (checkpointItems.length > MAX_STATUS_CHECKPOINTS) {
		const remaining = checkpointItems.length - MAX_STATUS_CHECKPOINTS;
		lines.push(`  ... and ${remaining} more checkpoint(s)`);
	}

	if (pending.exists) {
		lines.push("");
		lines.push(pendingLine(pending));
	}

	if (hasWarning && !hasError) {
		lines.push("");
		lines.push('  HINT     run "/chrono" to inspect rollback points');
	}

	return { lines, hasError, hasWarning };
}
