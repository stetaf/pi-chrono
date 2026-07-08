
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionPaths } from "./types.ts";

export const CHRONO_DIR = join(homedir(), ".pi", "chrono");
export const SESSIONS_DIR = join(CHRONO_DIR, "sessions");
export const BLOBS_DIR = join(CHRONO_DIR, "blobs");
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

export function ensureDirs(): void {
	for (const d of [CHRONO_DIR, SESSIONS_DIR, BLOBS_DIR]) {
		if (!existsSync(d)) mkdirSync(d, { recursive: true });
	}
}

export function sessionPaths(sessionId: string): SessionPaths {
	const dir = join(SESSIONS_DIR, sessionId);
	return {
		sessionId,
		dir,
		stateFile: join(dir, "state.json"),
		pendingFile: join(dir, "pending-pre.json"),
		journalsDir: join(dir, "journals"),
	};
}

export function ensureSessionDirs(p: SessionPaths): void {
	for (const d of [p.dir, p.journalsDir]) {
		if (!existsSync(d)) mkdirSync(d, { recursive: true });
	}
}

