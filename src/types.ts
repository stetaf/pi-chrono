import type { IgnoreMatcher } from "./ignore";

export interface ChronoCheckpoint {
	entryId: string;
	journalPath: string;
	userMessage: string;
	timestamp: number;
	opCount: number;
}

export interface UserMessageEntry {
	id: string;
	type: "message";
	message: { role: "user" };
}

export interface PersistedState {
	checkpoints: ChronoCheckpoint[];
}

export interface FileMeta {
	mtime: number;
	size: number;
	sha256: string;
}

export interface PreManifest {
	entryId: string;
	userMessage: string;
	ts: number;
	files: Record<string, FileMeta>;
}

export type FsOp =
	| { kind: "modified"; path: string; beforeBlob: string }
	| { kind: "created"; path: string }
	| { kind: "deleted"; path: string; beforeBlob: string };

export interface Journal {
	entryId: string;
	userMessage: string;
	ts: number;
	ops: FsOp[];
}

export interface SessionPaths {
	sessionId: string;
	dir: string;
	stateFile: string;
	pendingFile: string;
	journalsDir: string;
}

export interface WalkEntry {
	path: string;
	mtime: number;
	size: number;
}

export interface FinalizeResult {
	checkpoint: ChronoCheckpoint | null;
	journal: Journal | null;
}

export type ChronoCommand = "rollback" | "status" | "diff";

export interface ParsedChronoCommand {
	kind: "command";
	name: ChronoCommand;
}

export interface UnknownSubcommandHelp {
	kind: "help";
	unknownArgs: string[];
}

export type ParsedChronoResult = ParsedChronoCommand | UnknownSubcommandHelp | null;

export interface CheckpointStatusItem {
	entryId: string;
	timestamp?: number | null;
	userMessagePreview: string;
	operationCount: number;
	journalExists: boolean;
	journalReadable: boolean;
	inCurrentBranch: boolean;
	missingBlobPaths: string[];
}

export interface StatusReport {
	lines: string[];
	hasError: boolean;
	hasWarning: boolean;
}

export interface BlobStats {
	count: number;
	totalBytes: bigint;
}

export interface JournalReadResult {
	journal: Journal | null;
	corrupt: boolean;
}

export interface JournalDiskStats {
	totalFiles: number;
	readableFiles: number;
	corruptFiles: number;
}

export interface PendingStatus {
	exists: boolean;
	boundToUserMessage: boolean;
	fileCount: number;
}

export type RollbackPreviewKind = "modified" | "deleted" | "created";

export interface RollbackPreviewOperation {
	kind: RollbackPreviewKind;
	path: string;
}

export interface RollbackPreviewSummary {
	journalCount: number;
	totalOperationCount: number;
	modifiedCount: number;
	deletedCount: number;
	createdCount: number;
	operations: RollbackPreviewOperation[];
}

export interface RollbackPreviewValidationError {
	checkpointEntryId?: string;
	path?: string;
	message: string;
}

export interface RollbackPreviewResult {
	journals: Journal[];
	summary: RollbackPreviewSummary;
	errors: RollbackPreviewValidationError[];
}

export interface DiffSummaryOptions {
    maxPaths?: number;
}

export interface DiffFileReport {
	checkpointEntryId: string;
	checkpointTimestamp: number;
	userMessagePreview: string;
	journalCount: number;
	operations: RollbackPreviewOperation[];
	modifiedCount: number;
	deletedCount: number;
	createdCount: number;
	totalRawOps: number;
	errors: Array<{ message: string }>;
}

export interface ContentDiffEntry {
	path: string;
	addedLines: number;
	removedLines: number;
	diffText: string;
}

export interface IgnoreRule {
	kind: "name" | "suffix" | "glob";
	value: string;
}

export interface ChronoIgnoreOptions {
	rootDir: string;
}

export interface WalkOptions {
	prefix?: string;
	matcher?: IgnoreMatcher;
}
