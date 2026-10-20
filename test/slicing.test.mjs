import { test } from "node:test";
import assert from "node:assert/strict";
import { checkParallelism, checkSlices, checkWriterOverlap, launchableAgents, maxConcurrentUnits, parallelGroups, writerMap } from "../src/lead/agent-gate.js";
import { gateLaunch, DEFAULT_ALLOWED_TOOLS } from "../src/lead/delegate-gate.js";
import { DEFAULT_CATEGORIES, renderLeadPrompt, renderRoster, renderSlicingRules, resolveBriefTemplate, resolveSlicing } from "../src/lead/lead-prompt.js";
import { estimateTokens } from "../src/lead/delegate-gate.js";

const SONNET = "claude/claude-sonnet-5-5";
const settings = { enabledModels: [SONNET] };
const agents = [
	{ name: "worker", description: "Implementation agent", tools: ["read", "edit", "bash"] },
	{ name: "scout", description: "Fast recon", tools: ["read", "grep", "bash"] },
	{ name: "reviewer", description: "Review specialist", tools: ["read", "grep", "bash"] },
	{ name: "fan", description: "Delegates", tools: ["read", "delegate_task"] },
	{ name: "ext", description: "External", tools: ["read"], runner: { type: "external-cli" } },
	{ name: "off", description: "Disabled", tools: ["read"], disabled: true },
];
const resolveAgent = (name, list) => ({ agent: list.find((a) => a.name === name) });
const env = { agents, resolveAgent, sessionThinking: "low" };
const unit = (agent, task, writes) => ({ agent, task, ...(writes ? { writes } : {}) });
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
	assert.match(text, /must carry writes/);
	assert.match(text, /ONE delegate_task call per turn/);
	assert.match(text, /Review at most 2 rounds/);
	assert.match(text, /more than 5 files, or anything touching migrations, auth, deletion, config, CI or a public API/);
	assert.match(text, /Small jobs is for docs, config and renames/);
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
	assert.equal(checkParallelism({ tasks: [1, 2, 3, 4].map((n) => unit("worker", "t", ["f" + n + ".js"])) }, 4), undefined);
	assert.match(checkParallelism({ tasks: [1, 2, 3, 4, 5].map((n) => unit("worker", "t", ["f" + n + ".js"])) }, 4), /5 workers would run at once.*limit of 4/);
});

test("gateLaunch enforces maxParallel from settings", () => {
	const five = launch({ tasks: [1, 2, 3, 4, 5].map((n) => unit("reviewer", `look at file${n}`)) });
	assert.match(gateLaunch(five, settings, 0, env).error, /over the limit of 4/);
	const loose = { ...settings, piWorker: { maxParallel: 6 } };
	assert.equal(gateLaunch(five, loose, 0, env).error, undefined);
	const tight = { ...settings, piWorker: { maxParallel: 1 } };
	assert.match(gateLaunch(launch({ tasks: [unit("reviewer", "a"), unit("reviewer", "b")] }), tight, 0, env).error, /over the limit of 1/);
});

