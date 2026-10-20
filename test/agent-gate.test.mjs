import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAgentConfig, checkUnitOverrides, collectUnits, pinNeeded, resolveUnitAgents } from "../src/lead/agent-gate.js";
import { gateLaunch } from "../src/lead/delegate-gate.js";
import { BLOCKED_ACTIONS, blockedActionError, createDelegateWrapper } from "../src/lead/delegate-wrapper.js";

const SONNET = "claude/claude-sonnet-5-5";
const ALLOWED = ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"];
const settings = { enabledModels: [SONNET] };

const agents = [
	{ name: "worker", tools: ["read", "edit", "bash"], thinking: "medium" },
	{ name: "deep", tools: ["read"], thinking: "high" },
	{ name: "bare", tools: ["read"] },
	{ name: "fan", tools: ["read", "delegate_task"] },
	{ name: "nested", tools: ["read"], allowNestedSubagents: true },
	{ name: "notools" },
	{ name: "ext", tools: ["read"], runner: { type: "external-cli" } },
];
const resolveAgent = (name, list) => ({ agent: list.find((a) => a.name === name) });
const env = (sessionThinking) => ({ agents, resolveAgent, sessionThinking });
const launch = (agent, extra = {}) => ({ agent, task: "t", model: SONNET, ...extra });

test("collectUnits walks single, tasks, chain and chain parallel", () => {
	const labels = collectUnits({
		tasks: [{ agent: "a" }],
		chain: [{ agent: "b" }, { parallel: [{ agent: "c" }] }],
	}).map((u) => u.label);
	assert.deepEqual(labels, ["tasks[0]", "chain[0]", "chain[1].parallel[0]"]);
	assert.deepEqual(collectUnits({ agent: "x", task: "t" }).map((u) => u.label), ["task"]);
});

test("a per-child model or thinking is refused so it cannot dodge the allowlist or clamp", () => {
	assert.match(checkUnitOverrides({ tasks: [{ agent: "a", task: "t", model: "x/y:high" }] }), /tasks\[0\].*own model/);
	assert.match(checkUnitOverrides({ chain: [{ parallel: [{ agent: "a", task: "t", thinking: "high" }] }] }), /own thinking/);
	assert.equal(checkUnitOverrides({ tasks: [{ agent: "a", task: "t" }] }), undefined);
	assert.equal(checkUnitOverrides({ agent: "a", task: "t", model: SONNET }), undefined);
});

test("the override check reaches gateLaunch for every shape", () => {
	for (const params of [
		{ model: SONNET, tasks: [{ agent: "worker", task: "t", model: "claude/claude-haiku-5-5:high" }] },
		{ model: SONNET, chain: [{ agent: "worker", task: "t", thinking: "high" }] },
		{ model: SONNET, chain: [{ parallel: [{ agent: "worker", task: "t", model: "x/y" }] }] },
	]) {
		assert.match(gateLaunch(params, settings, 0, env("low")).error, /sets its own/);
	}
});

test("agents with external runners, nested delegation, no tools list or off-list tools are refused", () => {
	assert.match(checkAgentConfig(agents[6], ALLOWED), /external runner/);
	assert.match(checkAgentConfig(agents[4], ALLOWED), /delegate further/);
	assert.match(checkAgentConfig(agents[5], ALLOWED), /no tools list/);
	assert.match(checkAgentConfig(agents[3], ALLOWED), /outside piWorker.allowedTools: delegate_task/);
	assert.equal(checkAgentConfig(agents[0], ALLOWED), undefined);
});

test("a worker-written agent file with delegate_task is refused at launch even though no role write was seen", () => {
	const gated = gateLaunch(launch("fan"), settings, 0, env("low"));
	assert.match(gated.error, /task: agent 'fan' has tools outside/);
});

test("every unit is checked, including ones inside chain parallel groups", () => {
	const gated = gateLaunch({ model: SONNET, chain: [{ agent: "worker", task: "t" }, { parallel: [{ agent: "fan", task: "t" }] }] }, settings, 0, env("low"));
	assert.match(gated.error, /chain\[1\]\.parallel\[0\]: agent 'fan'/);
});

test("unknown agent names pass through so the runner can list the valid ones", () => {
	assert.equal(resolveUnitAgents({ agent: "ghost", task: "t" }, agents, resolveAgent, ALLOWED).error, undefined);
});

test("agent frontmatter thinking above the ceiling is pinned to the ceiling", () => {
	const gated = gateLaunch(launch("deep"), settings, 0, env("low"));
	assert.equal(gated.params.model, SONNET + ":medium");
	assert.match(gated.notices.join(" "), /pinned to 'medium'/);
});

test("a session default above the ceiling is pinned when the agent file sets nothing", () => {
	assert.equal(gateLaunch(launch("bare"), settings, 0, env("high")).params.model, SONNET + ":medium");
	assert.equal(gateLaunch(launch("bare"), settings, 0, env("low")).params.model, SONNET);
});

test("no pin when the agent and session are within the ceiling", () => {
	assert.equal(gateLaunch(launch("worker"), settings, 0, env("low")).params.model, SONNET);
});

test("an explicit suffix wins and is clamped as before; no second pin", () => {
	const gated = gateLaunch(launch("deep", { model: SONNET + ":low" }), settings, 0, env("high"));
	assert.equal(gated.params.model, SONNET + ":low");
	assert.deepEqual(gated.notices, []);
});

test("after 2 failures the ceiling lifts to high: an agent declaring high runs unpinned, a higher session default is pinned to high", () => {
	const gated = gateLaunch(launch("deep"), settings, 2, env("low"));
	assert.equal(gated.params.model, SONNET);
	assert.deepEqual(gated.notices, []);
	const bare = gateLaunch(launch("bare"), settings, 2, env("max"));
	assert.equal(bare.params.model, SONNET + ":high");
});

test("pinNeeded checks every unit's agent, not just the first", () => {
	const pin = pinNeeded({ suffixLevel: undefined, configs: [agents[0], agents[1]], sessionDefault: "low", allowed: "medium" });
	assert.equal(pin, "medium");
	assert.equal(pinNeeded({ suffixLevel: undefined, configs: [agents[0]], sessionDefault: "max", allowed: "medium" }), undefined);
});

test("launches are forced to foreground and fresh context", () => {
	for (const extra of [{}, { async: true }, { context: "fork" }]) {
		const gated = gateLaunch(launch("worker", extra), settings, 0, env("low"));
		assert.equal(gated.params.async, false);
		assert.equal(gated.params.context, "fresh");
	}
});

test("resume, steer, append-step and reuse are blocked because they skip every launch gate", () => {
	assert.deepEqual([...BLOCKED_ACTIONS].sort(), ["append-step", "resume", "reuse", "steer"]);
	for (const action of BLOCKED_ACTIONS) assert.match(blockedActionError({ action }), /bypasses/);
	assert.equal(blockedActionError({ action: "status" }), undefined);
	assert.equal(blockedActionError({}), undefined);
});

test("wrapper refuses blocked actions before reaching the runner and still passes status", async () => {
	const guarded = createDelegateWrapper(() => settings);
	let reached = 0;
	const run = async () => { reached++; return { content: [] }; };
	await assert.rejects(() => guarded({ action: "steer", id: "a", message: "do X" }, run), /bypasses/);
	await assert.rejects(() => guarded({ action: "resume", id: "a", task: "do Y" }, run), /bypasses/);
	assert.equal(reached, 0);
	await guarded({ action: "status", id: "a" }, run);
	assert.equal(reached, 1);
});

test("wrapper uses the live env: a bad agent file stops the launch before the runner", async () => {
	const guarded = createDelegateWrapper(() => settings, undefined, () => env("low"));
	let reached = 0;
	const run = async () => { reached++; return { content: [], details: { results: [] } }; };
	await assert.rejects(() => guarded(launch("fan"), run), /outside piWorker.allowedTools/);
	assert.equal(reached, 0);
	await guarded(launch("worker"), run);
	assert.equal(reached, 1);
});

test("before 2 failures the high agent is pinned to medium; on the third launch it runs at its own high", async () => {
	const seen = [];
	const guarded = createDelegateWrapper(() => settings, undefined, () => env("low"));
	const fail = () => guarded(launch("deep", { taskId: "T" }), async (l) => { seen.push(l.model); throw new Error("crash"); });
	await assert.rejects(fail, /crash/);
	await assert.rejects(fail, /crash/);
	await assert.rejects(fail, /crash/);
	assert.deepEqual(seen, [SONNET + ":medium", SONNET + ":medium", SONNET]);
});
