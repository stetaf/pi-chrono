import { existsSync } from "node:fs";
import { join } from "node:path";
import { BLOBS_DIR } from "./paths.ts";
import { loadJournalSafe } from "./status.ts";
import type {
	ChronoCheckpoint,
	FsOp,
	Journal,
	RollbackPreviewOperation,
	RollbackPreviewResult,
	RollbackPreviewSummary,
	RollbackPreviewValidationError,
} from "./types.ts";

const MAX_PREVIEW_OPERATIONS = 40;

function toPreviewKind(kind: FsOp["kind"]): RollbackPreviewOperation["kind"] {
	switch (kind) {
		case "modified":
			return "modified";
		case "deleted":
			return "created";
		case "created":
			return "deleted";
	}
}

function operationPrefix(kind: RollbackPreviewOperation["kind"]): string {
	switch (kind) {
		case "modified":
			return "M";
		case "deleted":
			return "D";
		case "created":
			return "A";
	}
}

export function loadJournalFromCheckpoint(
	checkpoint: ChronoCheckpoint,
): { journal: Journal | null; error: RollbackPreviewValidationError | null } {
	if (!existsSync(checkpoint.journalPath)) {
		return {
			journal: null,
			error: {
				checkpointEntryId: checkpoint.entryId,
				message: `Missing journal for checkpoint ${checkpoint.entryId}`,
			},
		};
	}

	const result = loadJournalSafe(checkpoint.journalPath);
	if (!result.journal) {
		return {
			journal: null,
			error: {
				checkpointEntryId: checkpoint.entryId,
				message: `Corrupt journal for checkpoint ${checkpoint.entryId}`,
			},
		};
	}

	return { journal: result.journal, error: null };
}

export function resolveRollbackCheckpoints(
	targetEntryId: string,
	branch: readonly { id?: string }[],
	checkpoints: ReadonlyMap<string, ChronoCheckpoint>,
): ChronoCheckpoint[] {
	const forkIndex = branch.findIndex((e) => e.id === targetEntryId);
	if (forkIndex === -1) {
		const checkpoint = checkpoints.get(targetEntryId);
		return checkpoint ? [checkpoint] : [];
	}

	const affected: ChronoCheckpoint[] = [];
	for (let i = forkIndex; i < branch.length; i++) {
		const entryId = branch[i].id;
		if (!entryId) continue;
		const checkpoint = checkpoints.get(entryId);
		if (checkpoint) affected.push(checkpoint);
	}
	return affected;
}

export function summarizeRollbackJournals(journals: readonly Journal[]): RollbackPreviewSummary {
	const operations: RollbackPreviewOperation[] = [];
	const indexByPath = new Map<string, number>();
	let totalOperationCount = 0;

	for (let journalIndex = journals.length - 1; journalIndex >= 0; journalIndex--) {
		const journal = journals[journalIndex];
		totalOperationCount += journal.ops.length;

		for (const op of journal.ops) {
			const previewOp: RollbackPreviewOperation = {
				kind: toPreviewKind(op.kind),
				path: op.path,
			};
			const existingIndex = indexByPath.get(op.path);
			if (existingIndex !== undefined) {
				operations.splice(existingIndex, 1);
				indexByPath.clear();
				for (let i = 0; i < operations.length; i++) {
					indexByPath.set(operations[i].path, i);
				}
			}
			indexByPath.set(op.path, operations.length);
			operations.push(previewOp);
		}
	}

	let modifiedCount = 0;
	let deletedCount = 0;
	let createdCount = 0;
	for (const op of operations) {
		if (op.kind === "modified") modifiedCount++;
		if (op.kind === "deleted") deletedCount++;
		if (op.kind === "created") createdCount++;
	}

	return {
		journalCount: journals.length,
		totalOperationCount,
		modifiedCount,
		deletedCount,
		createdCount,
		operations,
	};
}

export function validateRollbackJournals(journals: readonly Journal[]): RollbackPreviewValidationError[] {
	const errors: RollbackPreviewValidationError[] = [];

	for (const journal of journals) {
		for (const op of journal.ops) {
			if (op.kind === "created") continue;
			if (!existsSync(join(BLOBS_DIR, op.beforeBlob))) {
				errors.push({
					checkpointEntryId: journal.entryId,
					path: op.path,
					message: `Missing blob for ${op.path} in checkpoint ${journal.entryId}`,
				});
			}
		}
	}

	return errors;
}

export function buildRollbackPreview(
	targetEntryId: string,
	branch: readonly { id?: string }[],
	checkpoints: ReadonlyMap<string, ChronoCheckpoint>,
): RollbackPreviewResult {
	const affected = resolveRollbackCheckpoints(targetEntryId, branch, checkpoints);
	const journals: Journal[] = [];
	const errors: RollbackPreviewValidationError[] = [];

	for (const checkpoint of affected) {
		const result = loadJournalFromCheckpoint(checkpoint);
		if (result.error) {
			errors.push(result.error);
			continue;
		}
		if (result.journal) journals.push(result.journal);
	}

	errors.push(...validateRollbackJournals(journals));

	return {
		journals,
		summary: summarizeRollbackJournals(journals),
		errors,
	};
}

export function formatRollbackPreview(summary: RollbackPreviewSummary, maxOperations = MAX_PREVIEW_OPERATIONS): string {
	const lines: string[] = [];
	lines.push("Rollback preview:");
	lines.push(
		`  ${summary.journalCount} journal(s), ${summary.operations.length} affected file(s), ${summary.totalOperationCount} raw operation(s)`,
	);
	lines.push(
		`  M ${summary.modifiedCount}  D ${summary.deletedCount}  A ${summary.createdCount}`,
	);

	if (summary.operations.length > 0) {
		lines.push("");
		const visible = summary.operations.slice(0, maxOperations);
		for (const op of visible) {
			lines.push(`  ${operationPrefix(op.kind)} ${op.path}`);
		}

		const remaining = summary.operations.length - visible.length;
		if (remaining > 0) {
			lines.push(`  ... and ${remaining} more file(s)`);
		}
	}

	return lines.join("\n");
}
