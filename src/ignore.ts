import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IgnoreRule, ChronoIgnoreOptions } from "./types.ts";

export const DEFAULT_IGNORE_RULES: IgnoreRule[] = [
	// JS / Node
	{ kind: "name", value: "node_modules" },
	{ kind: "name", value: ".next" },
	{ kind: "name", value: ".nuxt" },
	{ kind: "name", value: "dist" },
	{ kind: "name", value: "build" },
	{ kind: "name", value: ".turbo" },
	{ kind: "name", value: ".parcel-cache" },

	// Python
	{ kind: "name", value: "__pycache__" },
	{ kind: "name", value: ".venv" },
	{ kind: "name", value: "venv" },
	{ kind: "name", value: ".pytest_cache" },
	{ kind: "name", value: ".mypy_cache" },
	{ kind: "name", value: ".ruff_cache" },
	{ kind: "name", value: ".tox" },

	// PHP / Laravel
	{ kind: "name", value: "vendor" },
	{ kind: "glob", value: "**/storage/framework/cache/**" },
	{ kind: "glob", value: "**/storage/framework/views/**" },
	{ kind: "glob", value: "**/storage/logs/**" },
	{ kind: "glob", value: "**/storage/framework/sessions/**" },
	{ kind: "glob", value: "**/storage/framework/testing/**" },
	{ kind: "name", value: "bootstrap/cache" },

	// Build / cache generic
	{ kind: "name", value: "target" },
	{ kind: "name", value: "out" },
	{ kind: "name", value: ".cache" },
	{ kind: "name", value: "coverage" },
	{ kind: "name", value: ".nyc_output" },
	{ kind: "name", value: "tmp" },
	{ kind: "name", value: "temp" },
	{ kind: "name", value: ".dart_tool" },
	{ kind: "name", value: ".gradle" },
	{ kind: "name", value: ".m2" },
	{ kind: "name", value: "Pods" },
	{ kind: "name", value: ".pub-cache" },
	{ kind: "name", value: ".svelte-kit" },
	{ kind: "name", value: ".astro" },
	{ kind: "name", value: ".output" },
	{ kind: "name", value: ".eggs" },
	{ kind: "glob", value: "**/*.egg-info/**" },

	// VCS
	{ kind: "name", value: ".git" },
	{ kind: "name", value: ".svn" },
	{ kind: "name", value: ".hg" },

	// IDE / Editor
	{ kind: "name", value: ".idea" },
	{ kind: "name", value: ".vscode" },
	{ kind: "glob", value: "**/*.swp" },

	// OS / Logs + temp
	{ kind: "name", value: ".DS_Store" },
	{ kind: "name", value: "Thumbs.db" },
	{ kind: "suffix", value: ".log" },
	{ kind: "suffix", value: ".tmp" },
	{ kind: "suffix", value: ".temp" },
	{ kind: "suffix", value: ".bak" },
	{ kind: "suffix", value: "~" },
];

export class IgnoreMatcher {
	private readonly nameSet: Set<string>;
	private readonly suffixes: string[];
	private readonly globRegexes: RegExp[];

	constructor(rules: ReadonlyArray<IgnoreRule>) {
		const nameSet = new Set<string>();
		const suffixes: string[] = [];
		const globRegexes: RegExp[] = [];

		for (const r of rules) {
			switch (r.kind) {
				case "name":
					nameSet.add(r.value);
					break;
				case "suffix":
					suffixes.push(r.value.toLowerCase());
					break;
				case "glob": {
					const re = globToRegex(r.value);
					if (re) globRegexes.push(re);
					break;
				}
			}
		}

		this.nameSet = nameSet;
		this.suffixes = suffixes.sort((a, b) => b.length - a.length);
		this.globRegexes = globRegexes;
	}

	matchesGlob(relativePath: string): boolean {
		if (!this.globRegexes.length) return false;
		for (const re of this.globRegexes) {
			if (re.test(relativePath)) return true;
		}
		return false;
	}

	isIgnoredDir(dirName: string): boolean {
		return this.nameSet.has(dirName);
	}

	isIgnoredFile(fileName: string): boolean {
		if (this.nameSet.has(fileName)) return true;
		const lower = fileName.toLowerCase();
		for (const suf of this.suffixes) {
			if (lower.endsWith(suf)) return true;
		}
		return false;
	}

	isIgnoredEntry(dirOrFileName: string, relativePathForGlob?: string): boolean {
		if (this.nameSet.has(dirOrFileName)) return true;
		const lower = dirOrFileName.toLowerCase();
		for (const suf of this.suffixes) {
			if (lower.endsWith(suf)) return true;
		}
		if (relativePathForGlob && this.matchesGlob(relativePathForGlob)) return true;
		return false;
	}
}

function parseChronoIgnoreFile(filePath: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return [];
	}

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("!")) continue;

		if (line.endsWith("/")) {
			rules.push({ kind: "glob", value: `**/${line}**` });
			continue;
		}

		if (line.includes("/")) {
			const p = line.replace(/^\//, "");
			rules.push({ kind: "glob", value: `**/${p}` });
			continue;
		}

		if (/[*?[\]!+]/.test(line)) {
			if (line.startsWith("*.")) {
				rules.push({ kind: "suffix", value: line.slice(1) });
			} else if (line.startsWith(".") && !line.includes("*")) {
				rules.push({ kind: "name", value: line });
			} else {
				rules.push({ kind: "glob", value: `**/${line}` });
			}
			continue;
		}

		rules.push({ kind: "name", value: line });
	}

	return rules;
}

export function buildIgnoreMatcher(options?: ChronoIgnoreOptions): IgnoreMatcher {
	const userRules: IgnoreRule[] = [];
	if (options) {
		const chronoignorePath = join(options.rootDir, ".chronoignore");
		if (existsSync(chronoignorePath)) {
			userRules.push(...parseChronoIgnoreFile(chronoignorePath));
		}
	}
	return new IgnoreMatcher([...DEFAULT_IGNORE_RULES, ...userRules]);
}

export function isIgnoredName(name: string): boolean {
	return buildIgnoreMatcher().isIgnoredEntry(name);
}

function globToRegex(pattern: string): RegExp | null {
	if (!pattern || pattern.includes("!")) return null;

	const hasLeadingDoubleStar = pattern.startsWith("**/");
	const hasTrailingDoubleStar = pattern.endsWith("/**");
	const clean = pattern
		.replace(/^\*\*\//, "")
		.replace(/\/\*\*$/, "");

	const segments = clean.split("/");
	const parts: string[] = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg === "**") {
			parts.push("(?:.+/)?");
		} else {
			parts.push(escapeAndWildcard(seg));
		}
	}

	let regexStr = parts.join("/");

	if (hasTrailingDoubleStar) {
		regexStr = `${regexStr}/.+`;
	} else {
		regexStr = `${regexStr}(?:$|/)`;
	}

	if (hasLeadingDoubleStar) {
		regexStr = `(?:^|.+/|/)${regexStr}`;
	} else {
		regexStr = `^(?:^|.+/)?${regexStr}`;
	}

	if (!pattern.includes("/") && !hasLeadingDoubleStar) {
		regexStr = `^(?:.+/)?${parts.join("/")}(?:$|/)`;
	}

	try {
		return new RegExp(regexStr, "i");
	} catch {
		return null;
	}
}

function escapeAndWildcard(segment: string): string {
	let out = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "*") {
			out += "[^/]*";
		} else if (ch === "?") {
			out += "[^/]";
		} else if ("[](){}+.$\\|^".includes(ch)) {
			out += "\\" + ch;
		} else {
			out += ch;
		}
	}
	return out;
}
