import { test } from "node:test";
import assert from "node:assert/strict";
import { checkParallelism, checkSlices, checkWriterOverlap, launchableAgents, maxConcurrentUnits, parallelGroups, pathsInBrief, writerMap } from "../src/lead/agent-gate.js";
import { gateLaunch, DEFAULT_ALLOWED_TOOLS } from "../src/lead/delegate-gate.js";
import { DEFAULT_CATEGORIES, renderLeadPrompt, renderRoster, renderSlicingRules, resolveBriefTemplate, resolveSlicing } from "../src/lead/lead-prompt.js";
import { estimateTokens } from "../src/lead/delegate-gate.js";

const SONNET = "claude/claude-sonnet-5-5";
const settings = { enabledModels: [SONNET] };
const agents = [
	{ name: "worker", description: "Implementation agent", tools: ["read", "edit", "bash"] },
	{ name: "scout", description: "Fast recon", tools: ["read", "grep", "bash", "write"] },
	{ name: "reviewer", description: "Review specialist", tools: ["read", "grep", "bash"] },
	{ name: "fan", description: "Delegates", tools: ["read", "delegate_task"] },
	{ name: "ext", description: "External", tools: ["read"], runner: { type: "external-cli" } },
	{ name: "off", description: "Disabled", tools: ["read"], disabled: true },
];
const resolveAgent = (name, list) => ({ agent: list.find((a) => a.name === name) });
const env = { agents, resolveAgent, sessionThinking: "low" };
const unit = (agent, task) => ({ agent, task });
const launch = (extra) => ({ model: SONNET, ...extra });

test("roster lists only agents the gate would launch, sorted, with a writes/read-only tag", () => {
	const roster = launchableAgents(agents, DEFAULT_ALLOWED_TOOLS);
	assert.deepEqual(roster.map((a) => a.name), ["reviewer", "scout", "worker"]);
	const text = renderRoster(roster);
	assert.match(text, /- worker \[writes\]/);
	assert.match(text, /- reviewer \[read-only\]/);
	assert.doesNotMatch(text, /fan|ext|off/);
});

test("roster descriptions are cut short and an empty roster renders nothing", () => {
	const long = renderRoster([{ name: "a", description: "x".repeat(500), tools: ["read"] }]);
	assert.ok(long.length < 200);
	assert.equal(renderRoster([]), "");
	assert.equal(renderRoster(undefined), "");
});

test("default categories map to the builtin workers", () => {
	assert.deepEqual(DEFAULT_CATEGORIES.map((c) => c.agent), ["scout", "worker", "reviewer", "oracle", "researcher", "evidence-auditor", "delegate"]);
});

test("categories are editable: rename, retarget, disable; junk falls back", () => {
	const slicing = resolveSlicing({ piWorker: { categories: [{ key: "ui", title: "UI", agent: "worker", hint: "front end" }, { agent: "scout", enabled: false }], maxParallel: 2 } });
	assert.deepEqual(slicing.categories.map((c) => c.title), ["UI"]);
	assert.equal(slicing.maxParallel, 2);
	for (const bad of ["x", 5, [], [{ title: "no agent" }], [null]]) {
		assert.equal(resolveSlicing({ piWorker: { categories: bad } }).categories.length, DEFAULT_CATEGORIES.length, JSON.stringify(bad));
	}
	assert.equal(resolveSlicing({ piWorker: { maxParallel: -1 } }).maxParallel, 4);
});

test("slicing rules only offer categories whose worker is launchable", () => {
	const roster = launchableAgents(agents, DEFAULT_ALLOWED_TOOLS);
	const text = renderSlicingRules(resolveSlicing({}), roster);
	assert.match(text, /Recon -> scout/);
	assert.match(text, /Build -> worker/);
	assert.match(text, /Review -> reviewer/);
	assert.doesNotMatch(text, /Decide -> oracle/);
	assert.match(text, /at most 4/);
	assert.match(text, /Only one Build slice may touch a file/);
});

test("lead prompt carries the roster, the slicing rules and stays small", () => {
	const roster = launchableAgents(agents, DEFAULT_ALLOWED_TOOLS);
	const prompt = renderLeadPrompt(resolveBriefTemplate({}), { roster, slicing: resolveSlicing({}) });
	assert.match(prompt, /Workers available now:/);
	assert.match(prompt, /slice it before delegating/);
	assert.match(prompt, /xhigh and max are not available/);
	assert.ok(estimateTokens(prompt) < 1100, `lead prompt is ${estimateTokens(prompt)} tokens`);
});

test("maxConcurrentUnits is the widest parallel group, not the chain length", () => {
	assert.equal(maxConcurrentUnits({ agent: "a", task: "t" }), 0);
	assert.equal(maxConcurrentUnits({ tasks: [1, 2, 3].map(() => unit("a", "t")) }), 3);
	assert.equal(maxConcurrentUnits({ chain: [unit("a", "t"), unit("a", "t"), unit("a", "t"), unit("a", "t"), unit("a", "t")] }), 0);
	assert.equal(maxConcurrentUnits({ chain: [unit("a", "t"), { parallel: [1, 2, 3, 4, 5].map(() => unit("a", "t")) }] }), 5);
});

test("more parallel workers than piWorker.maxParallel is refused, at the limit passes", () => {
	assert.equal(checkParallelism({ tasks: [1, 2, 3, 4].map(() => unit("worker", "t")) }, 4), undefined);
	assert.match(checkParallelism({ tasks: [1, 2, 3, 4, 5].map(() => unit("worker", "t")) }, 4), /5 workers would run at once.*limit of 4/);
});

test("gateLaunch enforces maxParallel from settings", () => {
	const five = launch({ tasks: [1, 2, 3, 4, 5].map((n) => unit("reviewer", `look at file${n}`)) });
	assert.match(gateLaunch(five, settings, 0, env).error, /over the limit of 4/);
	const loose = { ...settings, piWorker: { maxParallel: 6 } };
	assert.equal(gateLaunch(five, loose, 0, env).error, undefined);
	const tight = { ...settings, piWorker: { maxParallel: 1 } };
	assert.match(gateLaunch(launch({ tasks: [unit("reviewer", "a"), unit("reviewer", "b")] }), tight, 0, env).error, /over the limit of 1/);
});

test("pathsInBrief finds file names with directories, drive letters and backslashes", () => {
	const found = pathsInBrief("Edit src/app.js lines 1-9 and C:\\proj\\lib\\util.ts, plus ./README.md. Not a path: e.g. and 3.5");
	assert.ok(found.has("src/app.js"));
	assert.ok(found.has("c:/proj/lib/util.ts"));
	assert.ok(found.has("readme.md"));
});

test("two parallel writers naming the same file are refused", () => {
	const params = launch({ tasks: [unit("worker", "Fix the bug in src/app.js"), unit("worker", "Add tests that import src/app.js")] });
	const error = gateLaunch(params, settings, 0, env).error;
	assert.match(error, /tasks\[0\] and tasks\[1\] both write 'src\/app\.js'/);
});

test("path case and separators do not hide an overlap", () => {
	const group = parallelGroups({ tasks: [unit("worker", "edit SRC\\App.js"), unit("worker", "edit ./src/app.js")] })[0];
	assert.match(checkWriterOverlap(group, writerMap(agents)), /both write 'src\/app\.js'/);
});

test("disjoint writers, and a writer next to a reader on the same file, are allowed", () => {
	const disjoint = launch({ tasks: [unit("worker", "Fix src/a.js"), unit("worker", "Fix src/b.js")] });
	assert.equal(gateLaunch(disjoint, settings, 0, env).error, undefined);
	const mixed = launch({ tasks: [unit("worker", "Fix src/a.js"), unit("reviewer", "Review src/a.js")] });
	assert.equal(gateLaunch(mixed, settings, 0, env).error, undefined);
});

test("the overlap check covers chain parallel groups but not sequential chain steps", () => {
	const inGroup = launch({ chain: [{ parallel: [unit("worker", "edit src/a.js"), unit("worker", "edit src/a.js")] }] });
	assert.match(gateLaunch(inGroup, settings, 0, env).error, /chain\[0\]\.parallel\[0\] and chain\[0\]\.parallel\[1\]/);
	const sequential = launch({ chain: [unit("worker", "edit src/a.js"), unit("worker", "edit src/a.js")] });
	assert.equal(gateLaunch(sequential, settings, 0, env).error, undefined);
});

test("checkSlices passes a single launch and unknown agents are treated as read-only", () => {
	assert.equal(checkSlices({ agent: "worker", task: "edit src/a.js" }, { maxParallel: 4, agents }), undefined);
	const group = parallelGroups({ tasks: [unit("ghost", "edit src/a.js"), unit("ghost", "edit src/a.js")] })[0];
	assert.equal(checkWriterOverlap(group, writerMap(agents)), undefined);
});
