import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, rmSync } from "node:fs";
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
	PENDING_ENTRY_ID_PREFIX,
} from "./state.ts";
import {
	capturePreManifest,
	finalizeJournal,
	restoreJournal,
	gcBlobs,
} from "./journal.ts";
import { parseChronoCommand } from "./commands.ts";
import { buildStatusReport } from "./status.ts";
import {
	buildRollbackPreview,
	formatRollbackPreview,
} from "./rollback-preview.ts";

import {
	buildDiffSummary,
	formatDiffReport,
	truncateText,
	generateContentDiffs,
} from "./diff.ts";
import {
	isUserMessageEntry,
	listAvailableCheckpoints,
} from "./checkpoints.ts";
import type {
	SessionPaths,
	PreManifest,
	ChronoCheckpoint,
} from "./types.ts";

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function truncate(text: string, max = 80): string {
	if (text.length <= max) return text;
	return text.slice(0, Math.max(0, max - 3)) + "...";
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

	async function finalizePendingPre(ctx: ExtensionContext, p: SessionPaths): Promise<boolean> {
		if (!pendingPre) return true;

		bindPendingPreToUserEntry(ctx);
		if (pendingPre.entryId.startsWith(PENDING_ENTRY_ID_PREFIX)) return false;

		try {
			const result = await finalizeJournal(process.cwd(), p, pendingPre);
			if (result.checkpoint) {
				checkpoints.set(result.checkpoint.entryId, result.checkpoint);
			}
		} catch {
			// Best-effort
		}

		return true;
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
		await finalizePendingPre(ctx, p);

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
			// Walk failed - skip snapshot for this turn
		}
	});

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		const p = paths(ctx);
		if (!p || !pendingPre) return;
		await finalizePendingPre(ctx, p);
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
				const preview = buildRollbackPreview(event.entryId, branch, checkpoints);
				const journalsToApply = preview.journals;

				if (preview.errors.length > 0) {
					ctx.ui.notify(preview.errors[0].message, "error");
					return { cancel: true };
				}

				if (journalsToApply.length === 0) {
					ctx.ui.notify("No valid journals found - cannot restore", "error");
					return { cancel: true };
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
					ctx.ui.notify("Failed to restore workspace - check disk state", "error");
				}
			} catch (err) {
				ctx.ui.notify(`Failed to restore workspace: ${err}`, "error");
			}
		}
	});

	pi.registerCommand("chrono", {
		description: "Rollback & chrono management. Subcommands: status, diff",
		getArgumentCompletions: (prefix) => {
			if (prefix.startsWith("diff ")) {
				const options = [
					{ value: "diff --content", label: "diff --content - Include text-level diffs for modified files" },
					{ value: "diff --full", label: "diff --full - Show all affected paths" },
				];
				return options.filter((s) => s.value.startsWith(prefix));
			}

			const subs = [
				{ value: "status", label: "status - Show chrono health & storage state" },
				{ value: "diff", label: "diff [--content] [--full] - Inspect what a checkpoint would roll back" },
			];
			const filtered = subs.filter((s) => s.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (_args, ctx) => {
			const p = paths(ctx);
			if (!p) {
				ctx.ui.notify("Cannot determine session paths", "error");
				return;
			}

			const tokens = (_args ?? "").trim().split(/\s+/).filter(Boolean);
			const parsed = parseChronoCommand(tokens);

			if (parsed && parsed.kind === "help") {
				const helpMsg = [
					"Commands:",
					"  /chrono           - list and restore rollback points",
					"  /chrono status    - show chrono health & storage state",
					"  /chrono diff [--content] [--full]",
					"                    - inspect file-level changes before rollback",
					"                    --content: include text-level diffs for modified files",
					"                    --full: show all affected paths",
				].join("\n");
				ctx.ui.notify(helpMsg, "info");
				return;
			}

			if (parsed && parsed.name === "status") {
				await finalizePendingPre(ctx, p);

				const branch = ctx.sessionManager.getBranch();
				const branchIds = new Set(branch.map((e) => e.id));
				const sessionId = ctx.sessionManager.getSessionId();

				const report = buildStatusReport(
					sessionId,
					Array.from(checkpoints.values()),
					branchIds,
					p,
					pendingPre,
				);

				ctx.ui.notify(
					report.lines.join("\n"),
					report.hasError ? "error" : report.hasWarning ? "warning" : "info",
				);
				return;
			}


			if (parsed && parsed.name === "diff") {
				if (!(await finalizePendingPre(ctx, p))) return;

				const branch = ctx.sessionManager.getBranch();
				const available = listAvailableCheckpoints(
					checkpoints.values(),
					branch,
					(entryId) => ctx.sessionManager.getEntry(entryId),
				);

				if (available.length === 0) {
					ctx.ui.notify("No rollback points available", "info");
					return;
				}

				const fullOutput = tokens.includes("--full");
				const labels = available.map((cp, i) => {
					const time = formatTime(cp.timestamp);
					const preview = truncateText(cp.userMessage.replace(/\n/g, " "), 55);
					return `${String(i + 1).padStart(2, " ")}. [${time}] ${preview} (${cp.opCount} ops)`;
				});

				const choice = await ctx.ui.select(
					"Diff against which checkpoint?",
					labels,
				);

				if (!choice) return;

				const idx = labels.indexOf(choice);
				if (idx === -1) return;

				const selected = available[idx];
				const report = buildDiffSummary(selected, branch, checkpoints);

				if (!report) {
					ctx.ui.notify("No valid journals found - cannot show diff", "error");
					return;
				}

				const output: string[] = [
					formatDiffReport(report, { maxPaths: fullOutput ? Infinity : undefined }),
				];

				if (tokens.includes("--content")) {
					const preview = buildRollbackPreview(selected.entryId, branch, checkpoints);
					const contentDiffs = generateContentDiffs(report, preview.journals);
					for (const entry of contentDiffs.slice(0, 3)) {
						output.push("");
						output.push(`Diff for ${entry.path} (+${entry.addedLines}/-${entry.removedLines}):`);

						const diffLines = entry.diffText.split("\n");
						for (const line of diffLines.slice(0, 48)) {
							output.push(line.trimEnd());
						}
						if (diffLines.length > 48) {
							output.push(`... (${diffLines.length - 48} more lines)`);
						}
					}
				} else if (!fullOutput) {
					output.push("");
					output.push("Use /chrono diff --content to also see text-level diffs");
				}

				ctx.ui.notify(output.join("\n"), "info");
				return;
			}

			if (!(await finalizePendingPre(ctx, p))) return;

			const branch = ctx.sessionManager.getBranch();
			const available = listAvailableCheckpoints(
				checkpoints.values(),
				branch,
				(entryId) => ctx.sessionManager.getEntry(entryId),
			);

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
			const preview = buildRollbackPreview(selected.entryId, branch, checkpoints);
			if (preview.errors.length > 0) {
				ctx.ui.notify(preview.errors[0].message, "error");
				return;
			}
			if (preview.journals.length === 0) {
				ctx.ui.notify("No valid journals found - cannot restore", "error");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Confirm rollback?",
				[
					formatRollbackPreview(preview.summary),
					"",
					`Restore state before "${truncate(selected.userMessage, 50)}" and apply ${preview.summary.operations.length} file change(s)? This will fork the session. This action cannot be undone.`,
				].join("\n"),
			);
			if (!confirmed) return;

			try {
				isChronoInitiatedFork = true;
				await ctx.fork(selected.entryId, {
					position: "before",
					withSession: async (forkCtx) => {
						try {
							forkCtx.ui.notify(
								`Rolled back to before "${truncate(selected.userMessage, 50)}"`,
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
