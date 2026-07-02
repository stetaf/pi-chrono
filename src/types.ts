export interface ChronoCheckpoint {
	entryId: string;
	journalPath: string;
	userMessage: string;
	timestamp: number;
	opCount: number;
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
