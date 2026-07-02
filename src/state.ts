
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import type { ChronoCheckpoint, PersistedState, PreManifest, SessionPaths } from "./types.ts";
import { ensureSessionDirs } from "./paths.ts";

export function loadState(p: SessionPaths): PersistedState {
	try {
		if (existsSync(p.stateFile)) {
			const raw = readFileSync(p.stateFile, "utf8");
			const parsed = JSON.parse(raw) as PersistedState;
			return {
				checkpoints: (parsed.checkpoints ?? []).filter(
					(cp): cp is ChronoCheckpoint =>
						typeof cp.entryId === "string" &&
						typeof cp.journalPath === "string" &&
						typeof cp.userMessage === "string" &&
						typeof cp.timestamp === "number",
				),
			};
		}
	} catch {
		// Corrupted file → start fresh
	}
	return { checkpoints: [] };
}

export function saveState(p: SessionPaths, state: PersistedState): void {
	try {
		ensureSessionDirs(p);
		writeFileSync(p.stateFile, JSON.stringify(state, null, 2), "utf8");
	} catch {
		// Best-effort
	}
}

export function loadPendingPre(p: SessionPaths): PreManifest | null {
	try {
		if (existsSync(p.pendingFile)) {
			const raw = readFileSync(p.pendingFile, "utf8");
			const parsed = JSON.parse(raw) as PreManifest;
			if (parsed && typeof parsed.entryId === "string" && parsed.files && typeof parsed.files === "object") {
				return parsed;
			}
		}
	} catch {
		// Corrupted → discard
	}
	return null;
}

export function savePendingPre(p: SessionPaths, pre: PreManifest | null): void {
	try {
		ensureSessionDirs(p);
		if (pre === null) {
			if (existsSync(p.pendingFile)) rmSync(p.pendingFile, { force: true });
		} else {
			writeFileSync(p.pendingFile, JSON.stringify(pre), "utf8");
		}
	} catch {
		// Best-effort
	}
}
