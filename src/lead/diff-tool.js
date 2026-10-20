import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { Type } from "typebox";

// Read-only change inspector for the lead. The lead has no bash, so this is how it reviews what a worker did.
// Capped small on purpose: review a stat first, then one file, never the whole tree.
export const LEAD_DIFF_TOOL_NAME = "worker_diff";
export const LEAD_DIFF_MAX_CHARS = 6000;
const Params = Type.Object({
	path: Type.Optional(Type.String({ description: "One file or directory, relative to the repo root." })),
	stat: Type.Optional(Type.Boolean({ description: "Per-file change counts instead of the full diff. Use this first." })),
}, { additionalProperties: false });

export function validateDiffPath(value) {
	const trimmed = value?.trim();
	if (!trimmed)
		return undefined;
	if (trimmed.startsWith("-"))
		throw new Error("worker_diff path must not start with '-'.");
	if (path.isAbsolute(trimmed))
		throw new Error("worker_diff path must be relative to the repo root.");
	if (trimmed.split(/[\\/]/).includes(".."))
		throw new Error("worker_diff path must not contain '..'.");
	return trimmed;
}

export function boundDiff(text, max = LEAD_DIFF_MAX_CHARS) {
	if (text.length <= max)
		return text;
	const marker = `\n\n[... ${text.length - max} characters omitted; call again with a narrower path ...]`;
	return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

export function buildDiffArgs(params) {
	const relativePath = validateDiffPath(params.path);
	const args = ["diff", "--no-ext-diff", "--no-color", ...(params.stat ? ["--stat"] : []), "HEAD"];
	return relativePath ? [...args, "--", relativePath] : args;
}

function git(cwd, args) {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
	if (result.status !== 0) {
		throw new Error(`worker_diff failed: ${(result.stderr ?? "").trim() || "no valid Git HEAD in this directory"}`);
	}
	return result.stdout.trim();
}

/** New files are invisible to git diff HEAD, so list them. Names only: the lead reads a file it cares about. */
export function listUntracked(cwd, params) {
	const relativePath = validateDiffPath(params.path);
	const out = git(cwd, ["ls-files", "--others", "--exclude-standard", ...(relativePath ? ["--", relativePath] : [])]);
	return out ? out.split(/\r?\n/) : [];
}

export function runDiff(cwd, params) {
	const tracked = git(cwd, buildDiffArgs(params));
	const untracked = listUntracked(cwd, params);
	const parts = [];
	if (tracked)
		parts.push(tracked);
	if (untracked.length > 0) {
		parts.push(`Untracked (new) files, not in the diff above. Read one to see it:\n${untracked.map((name) => `  ${name}`).join("\n")}`);
	}
	return boundDiff(parts.join("\n\n") || "No changes against HEAD.");
}

export function registerDiffTool(pi) {
	pi.registerTool({
		name: LEAD_DIFF_TOOL_NAME,
		label: "Worker diff",
		description: "Read-only git diff against HEAD plus a list of new files, capped at 6000 chars. Pass stat:true first, then one path.",
		parameters: Params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: runDiff(ctx.cwd, params) }], details: {} };
		},
	});
}
