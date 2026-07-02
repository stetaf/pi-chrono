import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	ensureDirs,
	ensureSessionDirs,
	sessionPaths,
} from "./paths.ts";
import {
	loadState,
	saveState,
	loadPendingPre,
	savePendingPre,
} from "./state.ts";
import {
	capturePreManifest,
	finalizeJournal,
	restoreJournal,
	gcBlobs,
} from "./journal.ts";
import type {
	SessionPaths,
	PreManifest,
	ChronoCheckpoint,
	Journal,
} from "./types.ts";

const PENDING_ENTRY_ID_PREFIX = "__chrono_pending__:";

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function truncate(text: string, max = 80): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "…";
}

function isUserMessageEntry(entry: unknown): entry is { id: string; type: "message"; message: { role: "user" } } {
	if (!entry || typeof entry !== "object") return false;
	const record = entry as Record<string, unknown>;
	const message = record.message as Record<string, unknown> | undefined;
	return record.type === "message" && message?.role === "user" && typeof record.id === "string";
}

function latestUserEntry(ctx: ExtensionContext): { id: string; type: "message"; message: { role: "user" } } | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isUserMessageEntry(entry)) return entry;
	}
	return null;
}

export default function chronoExtension(pi: ExtensionAPI): void {
	const checkpoints = new Map<string, ChronoCheckpoint>();
	let pendingPre: PreManifest | null = null;
	let currentPaths: SessionPaths | null = null;
	let isChronoInitiatedFork = false;

	function paths(ctx: ExtensionContext): SessionPaths | null {
		try {
			const id = ctx.sessionManager.getSessionId();
			return sessionPaths(id);
		} catch {
			return null;
		}
	}

	function markCheckpoint(pre: PreManifest): void {
		pi.appendEntry("chrono-checkpoint", {
			entryId: pre.entryId,
			userMessage: pre.userMessage,
			timestamp: pre.ts,
			fileCount: Object.keys(pre.files).length,
		});
	}

	function bindPendingPreToUserEntry(ctx: ExtensionContext): void {
		if (!pendingPre?.entryId.startsWith(PENDING_ENTRY_ID_PREFIX)) return;

		const userEntry = latestUserEntry(ctx);
		if (!userEntry) return;

		pendingPre = {
			...pendingPre,
			entryId: userEntry.id,
		};

		const p = paths(ctx);
		if (p) {
			savePendingPre(p, pendingPre);
		}
		markCheckpoint(pendingPre);
	}

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		ensureDirs();
		const p = paths(ctx);
		if (!p) return;
		currentPaths = p;
		ensureSessionDirs(p);

		const state = loadState(p);
		checkpoints.clear();
		for (const cp of state.checkpoints) {
			if (existsSync(cp.journalPath)) {
				checkpoints.set(cp.entryId, cp);
			}
		}

		pendingPre = loadPendingPre(p);
		queueMicrotask(() => gcBlobs());
	});

	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		const p = paths(ctx);
		if (!p) return;
		bindPendingPreToUserEntry(ctx);

		if (pendingPre && !pendingPre.entryId.startsWith(PENDING_ENTRY_ID_PREFIX)) {
			try {
				const result = await finalizeJournal(process.cwd(), p, pendingPre);
				if (result.checkpoint) {
					checkpoints.set(result.checkpoint.entryId, result.checkpoint);
				}
			} catch {
				// Best-effort
			}
		}

		saveState(p, { checkpoints: Array.from(checkpoints.values()) });
	});

	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		const p = paths(ctx);
		if (!p) return;

		const userMessage = event.prompt;
		if (!userMessage) return;

		const entryId = `${PENDING_ENTRY_ID_PREFIX}${Date.now()}`;

		try {
			const newPre = await capturePreManifest(
				process.cwd(),
				entryId,
				userMessage,
				pendingPre,
			);
			pendingPre = newPre;
			savePendingPre(p, newPre);

		} catch {
			// Walk failed — skip snapshot for this turn
		}
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		const p = paths(ctx);
		if (!p || !pendingPre) return;
		bindPendingPreToUserEntry(ctx);
		if (pendingPre.entryId.startsWith(PENDING_ENTRY_ID_PREFIX)) return;

		try {
			const result = await finalizeJournal(process.cwd(), p, pendingPre);
			if (result.checkpoint) {
				checkpoints.set(result.checkpoint.entryId, result.checkpoint);
			}
		} catch {
			// Best-effort
		}
	});

	pi.on("session_before_fork", async (event, ctx: ExtensionContext): Promise<{ cancel?: boolean; skipConversationRestore?: boolean; } | void> => {
		const checkpoint = checkpoints.get(event.entryId);
		if (!checkpoint) {
			return;
		}

		let sessionEntry: unknown;

		sessionEntry = ctx.sessionManager.getEntry(event.entryId);

		if (!isUserMessageEntry(sessionEntry)) {
			if (ctx.hasUI) {
				ctx.ui.notify("Rollback point is invalid; choose a user-message checkpoint", "error");
			}
			return { cancel: true };
		}

		if (!ctx.hasUI) return;

		let shouldRestore = isChronoInitiatedFork;
		if (!shouldRestore) {
			const choice = await ctx.ui.confirm(
				"Restore workspace?",
				`Restore files to before "${truncate(checkpoint.userMessage)}"?`,
			);
			shouldRestore = !!choice;
		}

		if (shouldRestore) {
			try {
				const branch = ctx.sessionManager.getBranch();
				const forkIndex = branch.findIndex((e) => e.id === event.entryId);
				const journalsToApply: Journal[] = [];

				if (forkIndex !== -1) {
					for (let i = forkIndex; i < branch.length; i++) {
						const cp = checkpoints.get(branch[i].id);
						if (cp && existsSync(cp.journalPath)) {
							try {
								const j = JSON.parse(
									readFileSync(cp.journalPath, "utf8"),
								) as Journal;
								journalsToApply.push(j);
							} catch {
								// Skip corrupt journals
							}
						}
					}
				}

				if (journalsToApply.length === 0 && existsSync(checkpoint.journalPath)) {
					try {
						journalsToApply.push(
							JSON.parse(readFileSync(checkpoint.journalPath, "utf8")),
						);
					} catch {
						// Corrupt
					}
				}

				if (journalsToApply.length === 0) {
					ctx.ui.notify("No valid journals found — cannot restore", "error");
					return;
				}

				let allOk = true;
				for (let i = journalsToApply.length - 1; i >= 0; i--) {
					const ok = await restoreJournal(process.cwd(), journalsToApply[i]);
					if (!ok) {
						allOk = false;
						break;
					}
				}

				if (allOk) {
					pendingPre = null;
					const p = currentPaths ?? paths(ctx);
					if (p) {
						savePendingPre(p, null);

						for (const journal of journalsToApply) {
							checkpoints.delete(journal.entryId);
							try {
								const jp = join(p.journalsDir, `${journal.entryId}.json`);
								if (existsSync(jp)) rmSync(jp, { force: true });
							} catch {
								// Best-effort
							}
						}
						saveState(p, { checkpoints: Array.from(checkpoints.values()) });
					}
					if (!isChronoInitiatedFork) {
						ctx.ui.notify("Workspace restored to pre-turn state", "info");
					}
					return { skipConversationRestore: true };
				} else {
					ctx.ui.notify("Failed to restore workspace — check disk state", "error");
				}
			} catch (err) {
				ctx.ui.notify(`Failed to restore workspace: ${err}`, "error");
			}
		}
	});

	pi.registerCommand("chrono", {
		description: "List rollback points and restore the session to before a previous message",
		handler: async (_args, ctx) => {
			const p = paths(ctx);

			if (pendingPre && p) {
				bindPendingPreToUserEntry(ctx);
				if (pendingPre.entryId.startsWith(PENDING_ENTRY_ID_PREFIX)) return;
				try {
					const result = await finalizeJournal(process.cwd(), p, pendingPre);
					if (result.checkpoint) {
						checkpoints.set(result.checkpoint.entryId, result.checkpoint);
					}
				} catch {
					// Best-effort
				}
			}

			const branch = ctx.sessionManager.getBranch();
			const branchIds = new Set(branch.map((e) => e.id));
			const available: ChronoCheckpoint[] = [];

			for (const cp of checkpoints.values()) {
				const entry = ctx.sessionManager.getEntry(cp.entryId);
				if (branchIds.has(cp.entryId) && existsSync(cp.journalPath) && isUserMessageEntry(entry)) {
					available.push(cp);
				}
			}
			available.sort((a, b) => b.timestamp - a.timestamp);

			if (available.length === 0) {
				ctx.ui.notify("No rollback points available", "info");
				return;
			}

			const labels = available.map((cp, i) => {
				const time = formatTime(cp.timestamp);
				const preview = truncate(cp.userMessage.replace(/\n/g, " "), 55);
				return `${String(i + 1).padStart(2, " ")}. [${time}] ${preview} (${cp.opCount} ops)`;
			});

			const choice = await ctx.ui.select(
				"Rollback to before which message? (files + session will restore)",
				labels,
			);

			if (!choice) return;

			const idx = labels.indexOf(choice);
			if (idx === -1) return;

			const selected = available[idx];

			ctx.ui.notify(
				"THIS ACTION WILL RESTORE THE WORKTREE STATUS AND FORK THE SESSION — IT CANNOT BE UNDONE.",
				"error",
			);
			const confirmed = await ctx.ui.confirm(
				"Confirm rollback?",
				`Roll back to before "${truncate(selected.userMessage, 50)}" and restore ${selected.opCount} file operation(s)?`,
			);
			if (!confirmed) return;

			try {
				isChronoInitiatedFork = true;
				await ctx.fork(selected.entryId, {
					position: "before",
					withSession: async (forkCtx) => {
						try {
							forkCtx.ui.notify(
								`⏱ Rolled back to before "${truncate(selected.userMessage, 50)}"`,
								"info",
							);
							forkCtx.ui.setEditorText(selected.userMessage);
						} catch (err) {
							console.warn("Rollback notification failed:", err);
						}
					},
				});
			} catch (err) {
				ctx.ui.notify(`Rollback failed: ${err}`, "error");
			} finally {
				isChronoInitiatedFork = false;
			}
		},
	});
}
