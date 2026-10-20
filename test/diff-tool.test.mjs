import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundDiff, buildDiffArgs, LEAD_DIFF_MAX_CHARS, runDiff, validateDiffPath } from "../src/lead/diff-tool.js";

test("rejects option-like, absolute and parent paths", () => {
	for (const bad of ["-p", "/etc/passwd", "C:/x", "../x", "a/../../x"]) assert.throws(() => validateDiffPath(bad), undefined, bad);
});

test("accepts a relative path and ignores blank", () => {
	assert.equal(validateDiffPath("src/a.js"), "src/a.js");
	assert.equal(validateDiffPath("  "), undefined);
});

test("builds read-only git diff args, path after --", () => {
	assert.deepEqual(buildDiffArgs({ stat: true, path: "a.js" }), ["diff", "--no-ext-diff", "--no-color", "--stat", "HEAD", "--", "a.js"]);
	assert.deepEqual(buildDiffArgs({}), ["diff", "--no-ext-diff", "--no-color", "HEAD"]);
});

test("caps output and says how much was cut", () => {
	const out = boundDiff("x".repeat(LEAD_DIFF_MAX_CHARS + 500));
	assert.ok(out.length <= LEAD_DIFF_MAX_CHARS);
	assert.match(out, /characters omitted/);
	assert.equal(boundDiff("short"), "short");
});

test("shows a real change, and reports a clean tree", () => {
	const dir = mkdtempSync(join(tmpdir(), "pw-diff-"));
	try {
		const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
		git("init", "-q");
		writeFileSync(join(dir, "f.txt"), "one\n");
		git("add", "-A");
		git("commit", "-qm", "init");
		assert.equal(runDiff(dir, {}), "No changes against HEAD.");
		writeFileSync(join(dir, "f.txt"), "two\n");
		assert.match(runDiff(dir, { path: "f.txt" }), /\+two/);
		assert.match(runDiff(dir, { stat: true }), /f\.txt/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fails loud outside a git repo", () => {
	const dir = mkdtempSync(join(tmpdir(), "pw-nogit-"));
	try {
		assert.throws(() => runDiff(dir, {}), /worker_diff failed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lists untracked files a worker created, and honours the path filter", () => {
	const dir = mkdtempSync(join(tmpdir(), "pw-untracked-"));
	try {
		const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
		git("init", "-q");
		writeFileSync(join(dir, "f.txt"), "one\n");
		git("add", "-A");
		git("commit", "-qm", "init");
		writeFileSync(join(dir, "new-file.js"), "x\n");
		const all = runDiff(dir, {});
		assert.match(all, /Untracked \(new\) files/);
		assert.match(all, /new-file\.js/);
		assert.doesNotMatch(runDiff(dir, { path: "f.txt" }), /new-file\.js/);
		assert.notEqual(runDiff(dir, {}), "No changes against HEAD.");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
