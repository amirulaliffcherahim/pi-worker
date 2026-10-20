import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanWrites, firstOverlap, isGlob, isUnbounded, literalPrefix, normalizeScope, scopesOverlap } from "../src/lead/write-scope.js";
import { checkWriterOverlap, checkWritesDeclared, parallelGroups, writerMap, launchableAgents } from "../src/lead/agent-gate.js";
import { DEFAULT_ALLOWED_TOOLS, gateLaunch } from "../src/lead/delegate-gate.js";

const SONNET = "claude/claude-sonnet-5-5";
const settings = { enabledModels: [SONNET] };
const agents = [
	{ name: "worker", description: "Builds", tools: ["read", "edit", "bash"] },
	{ name: "delegate", description: "Chores", tools: ["read", "edit", "write"] },
	{ name: "scout", description: "Recon", tools: ["read", "grep", "bash"] },
	{ name: "reviewer", description: "Review", tools: ["read", "bash"] },
];
const resolveAgent = (name, list) => ({ agent: list.find((a) => a.name === name) });
const env = { agents, resolveAgent, sessionThinking: "low" };
const w = (agent, task, writes) => ({ agent, task, ...(writes ? { writes } : {}) });

test("normalizeScope folds case, separators, ./ and trailing slashes", () => {
	assert.equal(normalizeScope(" .\\Src\\App.JS "), "src/app.js");
	assert.equal(normalizeScope("src//auth/"), "src/auth");
});

test("literalPrefix cuts a glob back to a whole directory", () => {
	assert.equal(literalPrefix("src/auth/**"), "src/auth");
	assert.equal(literalPrefix("src/au*.js"), "src");
	assert.equal(literalPrefix("**/*.test.js"), "");
	assert.equal(literalPrefix("src/a.js"), "src/a.js");
	assert.equal(isGlob("src/**"), true);
	assert.equal(isGlob("src/a.js"), false);
});

test("exact files overlap only when equal", () => {
	assert.equal(scopesOverlap("src/a.js", "SRC\\A.js"), true);
	assert.equal(scopesOverlap("src/a.js", "src/b.js"), false);
	assert.equal(scopesOverlap("src/a.js", "src/a.jsx"), false);
});

test("a glob claims everything under its directory", () => {
	assert.equal(scopesOverlap("src/auth/**", "src/auth/login.js"), true);
	assert.equal(scopesOverlap("src/auth/**", "src/auth/deep/x.js"), true);
	assert.equal(scopesOverlap("src/auth/**", "src/billing/x.js"), false);
	assert.equal(scopesOverlap("src/auth/**", "src/authz/x.js"), false);
});

test("two globs overlap when one directory contains the other; sibling directories do not", () => {
	assert.equal(scopesOverlap("src/**", "src/auth/**"), true);
	assert.equal(scopesOverlap("src/auth/**", "src/**"), true);
	assert.equal(scopesOverlap("src/auth/**", "src/billing/**"), false);
});

test("a root glob overlaps everything, so it is treated as unbounded and refused", () => {
	assert.equal(scopesOverlap("**/*.js", "src/a.js"), true);
	for (const bad of ["*", "**", "**/*", ".", " "]) assert.equal(isUnbounded(bad), true, bad);
	assert.equal(isUnbounded("src/**"), false);
});

test("cleanWrites keeps non-empty strings only", () => {
	assert.deepEqual(cleanWrites(["a.js", "", "  ", 5, null, "b.js"]), ["a.js", "b.js"]);
	assert.deepEqual(cleanWrites("a.js"), []);
	assert.deepEqual(cleanWrites(undefined), []);
});

test("firstOverlap reports the pair that collided", () => {
	assert.deepEqual(firstOverlap(["a.js", "src/**"], ["src/x.js"]), { left: "src/**", right: "src/x.js" });
	assert.equal(firstOverlap(["a.js"], ["b.js"]), undefined);
});

test("a writer with no writes is refused with an example; a read-only agent needs none", () => {
	const error = gateLaunch({ model: SONNET, agent: "worker", task: "t" }, settings, 0, env).error;
	assert.match(error, /edits files but declares no writes/);
	assert.match(error, /writes:\["src\/a\.js"/);
	assert.equal(gateLaunch({ model: SONNET, agent: "reviewer", task: "t" }, settings, 0, env).error, undefined);
	assert.equal(gateLaunch({ model: SONNET, agent: "scout", task: "t" }, settings, 0, env).error, undefined);
});

test("an unbounded writes entry is refused", () => {
	for (const writes of [["**"], ["*"], ["src/a.js", "**/*"]]) {
		assert.match(gateLaunch({ model: SONNET, agent: "worker", task: "t", writes }, settings, 0, env).error, /allows every file/);
	}
});

test("every writer unit is checked: tasks, chain steps and chain parallel groups", () => {
	assert.match(gateLaunch({ model: SONNET, tasks: [w("worker", "t", ["a.js"]), w("worker", "t")] }, settings, 0, env).error, /'tasks\[1\]' \(worker\) edits files/);
	assert.match(gateLaunch({ model: SONNET, chain: [w("scout", "t"), w("worker", "t")] }, settings, 0, env).error, /'chain\[1\]' \(worker\)/);
	assert.match(gateLaunch({ model: SONNET, chain: [{ parallel: [w("worker", "t", ["a.js"]), w("delegate", "t")] }] }, settings, 0, env).error, /chain\[0\]\.parallel\[1\]' \(delegate\)/);
});

test("a file only READ in a brief never causes a refusal: only declared writes are compared", () => {
	const params = {
		model: SONNET,
		tasks: [
			w("worker", "Read src/types.ts for the interfaces, then update src/a.ts", ["src/a.ts"]),
			w("worker", "Read src/types.ts for the interfaces, then update src/b.ts", ["src/b.ts"]),
		],
	};
	assert.equal(gateLaunch(params, settings, 0, env).error, undefined);
});

test("two parallel writers with overlapping writes are refused, naming both", () => {
	const params = { model: SONNET, tasks: [w("worker", "x", ["src/auth/**"]), w("delegate", "y", ["src/auth/login.js"])] };
	const error = gateLaunch(params, settings, 0, env).error;
	assert.match(error, /tasks\[0\] and tasks\[1\] both write/);
	assert.match(error, /src\/auth\/\*\*/);
});

test("overlap inside a chain parallel group is refused, sequential steps may reuse a file", () => {
	const inGroup = { model: SONNET, chain: [{ parallel: [w("worker", "x", ["a.js"]), w("worker", "y", ["A.JS"])] }] };
	assert.match(gateLaunch(inGroup, settings, 0, env).error, /chain\[0\]\.parallel\[0\] and chain\[0\]\.parallel\[1\]/);
	const sequential = { model: SONNET, chain: [w("worker", "x", ["a.js"]), w("worker", "y", ["a.js"])] };
	assert.equal(gateLaunch(sequential, settings, 0, env).error, undefined);
});

test("a read-only agent that declares writes is ignored by the overlap check", () => {
	const group = parallelGroups({ tasks: [w("worker", "x", ["a.js"]), w("reviewer", "y", ["a.js"])] })[0];
	assert.equal(checkWriterOverlap(group, writerMap(agents)), undefined);
});

test("scout and researcher style agents with no edit or write tool are not writers", () => {
	const map = writerMap(agents);
	assert.equal(map.get("scout"), false);
	assert.equal(map.get("worker"), true);
	assert.equal(map.get("delegate"), true);
	assert.equal(checkWritesDeclared({ agent: "scout", task: "t" }, map), undefined);
});

test("the builtin roster has exactly two writers: worker and delegate", async () => {
	const { discoverAgents } = await import("../src/agents/agents.js");
	const roster = launchableAgents(discoverAgents(process.cwd(), "both", "claude").agents, DEFAULT_ALLOWED_TOOLS);
	const writers = roster.filter((a) => (a.tools ?? []).some((t) => t === "edit" || t === "write")).map((a) => a.name);
	assert.deepEqual(writers.sort(), ["delegate", "worker"]);
});
