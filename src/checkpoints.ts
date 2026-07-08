import { existsSync } from "node:fs";
import type { ChronoCheckpoint, UserMessageEntry } from "./types.ts";

export function isUserMessageEntry(entry: unknown): entry is UserMessageEntry {
	if (!entry || typeof entry !== "object") return false;
	const record = entry as Record<string, unknown>;
	const message = record.message as Record<string, unknown> | undefined;
	return record.type === "message" && message?.role === "user" && typeof record.id === "string";
}

export function listAvailableCheckpoints(
	checkpoints: Iterable<ChronoCheckpoint>,
	branch: readonly { id?: string }[],
	getEntry: (entryId: string) => unknown,
): ChronoCheckpoint[] {
	const branchIds = new Set(branch.map((e) => e.id));
	const available: ChronoCheckpoint[] = [];

	for (const cp of checkpoints) {
		const entry = getEntry(cp.entryId);
		if (branchIds.has(cp.entryId) && existsSync(cp.journalPath) && isUserMessageEntry(entry)) {
			available.push(cp);
		}
	}

	return available.sort((a, b) => b.timestamp - a.timestamp);
}
