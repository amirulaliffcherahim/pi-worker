import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRole, DEFAULT_ALLOWED_TOOLS, gateLaunch } from "../src/lead/delegate-gate.js";
import { createDelegateWrapper } from "../src/lead/delegate-wrapper.js";
import { FORCED_DISABLED_FEATURES, forceWorkerFeatureLimits } from "../src/lead/feature-limits.js";

const SONNET = "claude/claude-sonnet-5-5";
const settings = { enabledModels: [SONNET, "claude/claude-haiku-5-5"] };

test("a launch without a model is refused and lists the choices", () => {
	const gated = gateLaunch({ agent: "worker", task: "t" }, settings, 0);
	assert.match(gated.error, /every launch needs a model/);
	assert.match(gated.error, /claude-sonnet-5-5/);
	assert.match(gateLaunch({ agent: "worker", task: "t", model: "  " }, settings, 0).error, /needs a model/);
});

test("every launch is forced to fresh context, whatever the lead asked for", () => {
	for (const context of [undefined, "fork", "profile"]) {
		const gated = gateLaunch({ agent: "w", task: "t", model: SONNET, ...(context ? { context } : {}) }, settings, 0);
		assert.equal(gated.params.context, "fresh", String(context));
	}
});

test("workflow scripts are refused so no task text or model can bypass the gates", () => {
	assert.match(gateLaunch({ workflow: "return 1", model: SONNET }, settings, 0).error, /workflow scripts are disabled/);
	assert.match(gateLaunch({ agent: "w", task: "t", workflow: "x", model: SONNET }, settings, 0).error, /workflow scripts are disabled/);
});

test("forced feature limits add workflow-scripts and keep the operator's own list", () => {
	assert.deepEqual(FORCED_DISABLED_FEATURES, ["workflow-scripts"]);
	assert.deepEqual(forceWorkerFeatureLimits({}).disabledFeatures, ["workflow-scripts"]);
	assert.deepEqual(forceWorkerFeatureLimits({ disabledFeatures: ["panes", "workflow-scripts"] }).disabledFeatures, ["panes", "workflow-scripts"]);
	assert.equal(forceWorkerFeatureLimits({ other: 1 }).other, 1);
});

test("role tools outside the allowlist are refused, delegate_task never allowed by default", () => {
	for (const tools of [["read", "delegate_task"], "read, subagent_supervisor", ["memory_write"]]) {
		const error = checkRole({ action: "create", config: { name: "x", description: "d", tools } }, settings);
		assert.match(error, /role tools not allowed/, JSON.stringify(tools));
	}
	assert.ok(!DEFAULT_ALLOWED_TOOLS.includes("delegate_task"));
	assert.equal(checkRole({ action: "create", config: { name: "x", description: "d", tools: ["read", "edit", "bash"] } }, settings), undefined);
});

test("allowedTools is editable in settings", () => {
	const custom = { ...settings, piWorker: { allowedTools: ["read", "web_search"] } };
	assert.equal(checkRole({ action: "create", config: { tools: "read, web_search" } }, custom), undefined);
	assert.match(checkRole({ action: "create", config: { tools: "bash" } }, custom), /role tools not allowed: bash/);
});

test("role thinking above the ceiling and unknown models are refused", () => {
	assert.match(checkRole({ action: "create", config: { thinking: "high" } }, settings), /above the medium ceiling/);
	assert.equal(checkRole({ action: "create", config: { thinking: "low" } }, settings), undefined);
	assert.match(checkRole({ action: "update", config: { model: "openai/gpt-9" } }, settings), /not in enabledModels/);
	assert.match(checkRole({ action: "update", config: { model: SONNET + ":high" } }, settings), /above the medium ceiling/);
	assert.equal(checkRole({ action: "update", config: { model: SONNET + ":low" } }, settings), undefined);
});

test("role config can arrive as a JSON string", () => {
	assert.match(checkRole({ action: "create", config: JSON.stringify({ tools: ["memory_write"] }) }, settings), /role tools not allowed/);
	assert.equal(checkRole({ action: "create", config: "not json" }, settings), undefined);
});

test("only create and update are role writes", () => {
	for (const action of ["status", "list", "delete", "stop"]) {
		assert.equal(checkRole({ action, config: { tools: ["delegate_task"] } }, settings), undefined, action);
	}
});

test("wrapper blocks a bad role write before it reaches the runner, and lets status through", async () => {
	const guarded = createDelegateWrapper(() => settings);
	let reached = 0;
	const run = async () => { reached++; return { content: [] }; };
	await assert.rejects(() => guarded({ action: "create", config: { tools: ["delegate_task"] } }, run), /role tools not allowed/);
	assert.equal(reached, 0);
	await guarded({ action: "status", id: "abc" }, run);
	await guarded({ action: "create", config: { name: "x", description: "d", tools: ["read"] } }, run);
	assert.equal(reached, 2);
});
