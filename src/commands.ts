import type { ChronoCommand, ParsedChronoResult } from "./types.ts";

const SUBCOMMANDS: Record<string, ChronoCommand> = {
	status: "status",
	diff: "diff",
};

export function parseChronoCommand(args?: readonly string[]): ParsedChronoResult {
	const nonEmpty = (args ?? []).filter((a): a is string => typeof a === "string" && a.length > 0);
	if (nonEmpty.length === 0) return { kind: "command", name: "rollback" };

	const [subcommand] = nonEmpty;
	const command = SUBCOMMANDS[subcommand];
	if (!command) return { kind: "help", unknownArgs: nonEmpty };

	return { kind: "command", name: command };
}
