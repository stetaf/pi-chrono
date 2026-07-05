import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ChronoCheckpoint,
	ContentDiffEntry,
	DiffFileReport,
	Journal,
	RollbackPreviewOperation,
    DiffSummaryOptions
} from "./types.ts";
import { BLOBS_DIR } from "./paths.ts";
import {
	loadJournalFromCheckpoint,
	resolveRollbackCheckpoints,
	summarizeRollbackJournals,
	validateRollbackJournals,
} from "./rollback-preview.ts";

const MAX_DIFF_PATHS = 40;
const MAX_CONTENT_DIFF_FILES = 6;
const MAX_TEXT_FILE_BYTES = 512 * 1024;

function isTextFile(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, 512);
    return !/[\x00-\x08\x0E-\x1F]/.test(sample.toString("latin1"));
}

function formatTimestamp(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function truncateText(text: string, max = 60): string {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 3)) + "...";
}

export function operationPrefix(kind: RollbackPreviewOperation["kind"]): string {
    switch (kind) {
        case "modified": return "M";
        case "deleted":  return "D";
        case "created":  return "A";
    }
}

export function buildDiffSummary(
    targetCheckpoint: ChronoCheckpoint,
    branch: readonly { id?: string }[],
    checkpointsMap: ReadonlyMap<string, ChronoCheckpoint>,
): DiffFileReport | null {
    const affected = resolveRollbackCheckpoints(targetCheckpoint.entryId, branch, checkpointsMap);
    if (affected.length === 0) return null;

    const journals: Journal[] = [];
    const errors: Array<{ message: string }> = [];

    for (const cp of affected) {
        const result = loadJournalFromCheckpoint(cp);
        if (result.error) {
            errors.push({ message: result.error.message });
            continue;
        }
        if (result.journal) journals.push(result.journal);
    }

    errors.push(...validateRollbackJournals(journals).map((err) => ({ message: err.message })));

    const summary = summarizeRollbackJournals(journals);

    return {
        checkpointEntryId: targetCheckpoint.entryId,
        checkpointTimestamp: targetCheckpoint.timestamp,
        userMessagePreview: truncateText(targetCheckpoint.userMessage.replace(/\n/g, " "), 50),
        journalCount: journals.length,
        operations: summary.operations,
        modifiedCount: summary.modifiedCount,
        deletedCount: summary.deletedCount,
        createdCount: summary.createdCount,
        totalRawOps: summary.totalOperationCount,
        errors,
    };
}

export function formatDiffReport(report: DiffFileReport, options?: DiffSummaryOptions): string {
    const maxPaths = options?.maxPaths ?? MAX_DIFF_PATHS;
    const lines: string[] = [];

    const ts = formatTimestamp(report.checkpointTimestamp);
    lines.push(`Chrono diff - ${ts}`);
    lines.push(`Before "${report.userMessagePreview}"`);
    lines.push("");

    if (report.errors.length > 0) {
        lines.push("Warnings:");
        for (const err of report.errors.slice(0, 3)) {
            lines.push(`  ! ${err.message}`);
        }
        if (report.errors.length > 3) {
            lines.push(`  ... and ${report.errors.length - 3} more error(s)`);
        }
        lines.push("");
    }

    if (report.operations.length === 0 && report.errors.length === 0) {
        lines.push("No file changes to show.");
        return lines.join("\n");
    }

    if (report.journalCount > 1) {
        lines.push(`${report.journalCount} journal(s), ${report.totalRawOps} raw operation(s)`);
    } else if (report.totalRawOps !== 0) {
        lines.push(`${report.totalRawOps} raw operation(s)`);
    }
    lines.push(`M ${report.modifiedCount}   D ${report.deletedCount}   A ${report.createdCount}`);

    const groups: Array<{ label: string; paths: string[] }> = [
        { label: "Modified", paths: report.operations.filter((o) => o.kind === "modified").map((op) => `  M ${op.path}`) },
        { label: "Recreate", paths: report.operations.filter((o) => o.kind === "created").map((op) => `  A ${op.path}`) },
        { label: "Remove", paths: report.operations.filter((o) => o.kind === "deleted").map((op) => `  D ${op.path}`) },
    ];

    let shownTotal = 0;

    for (const group of groups) {
        if (!group.paths.length) continue;

        if (shownTotal >= maxPaths && report.operations.length > maxPaths) break;

        const remainingSlots = Math.max(maxPaths - shownTotal, 1);
        const visible = group.paths.slice(0, Math.min(group.paths.length, remainingSlots));

        lines.push("");
        lines.push(group.label + ":");

        for (const line of visible) {
            lines.push(line);
            shownTotal++;
        }

        if (group.paths.length !== visible.length) {
            const hidden = group.paths.length - visible.length;
            let moreGroupsHidden = 0;
            for (let i = groups.indexOf(group) + 1; i < groups.length; i++) {
                moreGroupsHidden += groups[i].paths.length;
            }
            const totalRemaining = hidden + moreGroupsHidden;
            lines.push(`  ... and ${totalRemaining} more file(s)`);
            break;
        }
    }

    if (report.operations.length > maxPaths) {
        lines.push("");
        lines.push(`${report.operations.length - shownTotal} file(s) truncated - use \`/chrono diff --full\` to show all`);
    }

    return lines.join("\n");
}

export function generateContentDiffs(report: DiffFileReport, journals: Journal[]): ContentDiffEntry[] {
    const entries: ContentDiffEntry[] = [];
    const blobByPath = buildEffectiveBeforeBlobMap(journals);

    for (const op of report.operations.filter((o) => o.kind === "modified")) {
        if (entries.length >= MAX_CONTENT_DIFF_FILES) break;

        const beforeBlob = blobByPath.get(op.path);
        if (!beforeBlob) continue;

        const result = computeFileDiff(op.path, beforeBlob);
        if (!result) continue;

        entries.push({
            path: op.path,
            addedLines: result.added,
            removedLines: result.removed,
            diffText: result.text,
        });
    }

    return entries;
}

function buildEffectiveBeforeBlobMap(journals: readonly Journal[]): Map<string, string> {
    const blobByPath = new Map<string, string>();

    for (let journalIndex = journals.length - 1; journalIndex >= 0; journalIndex--) {
        const journal = journals[journalIndex];
        for (const op of journal.ops) {
            if (op.kind === "created") {
                blobByPath.delete(op.path);
            } else {
                blobByPath.set(op.path, op.beforeBlob);
            }
        }
    }

    return blobByPath;
}

function computeFileDiff(fileRelPath: string, blobName: string): { text: string; added: number; removed: number } | null {
    let currentContent: Buffer;
    try {
        const fullPath = join(process.cwd(), fileRelPath.replace(/^\.\//g, ""));
        currentContent = readFileSync(fullPath);
    } catch {
        return null;
    }

    if (currentContent.length > MAX_TEXT_FILE_BYTES) return null;

    let blobContent: Buffer;
    try {
        const blobPath = join(BLOBS_DIR, blobName);
        if (!existsSync(blobPath)) return null;
        blobContent = readFileSync(blobPath);
    } catch {
        return null;
    }

    if (blobContent.length > MAX_TEXT_FILE_BYTES) return null;
    if (!isTextFile(currentContent) || !isTextFile(blobContent)) return null;

    const currentLines = currentContent.toString("utf8").split("\n");
    const beforeLines  = blobContent.toString("utf8").split("\n");

    return computeUnifiedDiff(fileRelPath, beforeLines, currentLines);
}

function computeUnifiedDiff(
    label: string,
    oldLines: string[],
    newLines: string[],
): { text: string; added: number; removed: number } | null {
    if (oldLines.length === newLines.length &&
        oldLines.every((l, i) => l === newLines[i])) {
        return null;
    }

    let start = 0;
    while (start < newLines.length && start < oldLines.length &&
           newLines[start] === oldLines[start]) {
        start++;
    }

    let endNew = newLines.length - 1;
    let endOld = oldLines.length - 1;

    while (endNew >= start && endOld >= start &&
           newLines[endNew] === oldLines[endOld]) {
        --endNew;
        --endOld;
    }

    const oldRange = oldLines.slice(start, endOld + 1);
    const newRange = newLines.slice(start, endNew + 1);
    if (oldRange.length === 0 && newRange.length === 0) return null;

    const contextLen = Math.min(3, start);
    const lines: string[] = [];
    lines.push(`--- a/${label}`);
    lines.push(`+++ b/${label}`);
    lines.push("@@");

    for (let i = Math.max(0, start - contextLen); i < start; i++) {
        lines.push(` ${newLines[i]}`);
    }
    for (const l of oldRange) {
        lines.push(`-${l}`);
    }
    for (const l of newRange) {
        lines.push(`+${l}`);
    }

    const suffixStart = endNew + 1;
    for (let i = suffixStart; i < Math.min(suffixStart + contextLen, newLines.length); i++) {
        lines.push(` ${newLines[i]}`);
    }

    return { text: lines.join("\n"), added: newRange.length, removed: oldRange.length };
}
