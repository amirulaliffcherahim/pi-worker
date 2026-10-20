import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedThinking, checkModel, collectBriefs, DEFAULT_BRIEF_MAX_TOKENS, estimateTokens, gateLaunch, isLaunch, resolveDelegateSettings, splitModel } from "../src/lead/delegate-gate.js";
import { createDelegateWrapper, FailureLedger, stripLeadFields } from "../src/lead/delegate-wrapper.js";
import { launchFailed, rowFailed } from "../src/lead/failure-ledger.js";

const settings = { enabledModels: ["claude/claude-haiku-5-5", "claude/claude-sonnet-5-5", "deepseek/deepseek-flash"] };
const SONNET = "claude/claude-sonnet-5-5";

test("defaults: 3000-token brief, medium ceiling", () => {
	const rules = resolveDelegateSettings({});
	assert.equal(rules.maxTokens, DEFAULT_BRIEF_MAX_TOKENS);
	assert.equal(rules.ceiling, "medium");
});

test("settings override brief size and ceiling; junk falls back", () => {
	assert.equal(resolveDelegateSettings({ piWorker: { brief: { maxTokens: 1200 }, thinkingCeiling: "low" } }).maxTokens, 1200);
	assert.equal(resolveDelegateSettings({ piWorker: { brief: { maxTokens: -5 }, thinkingCeiling: "ultra" } }).maxTokens, 3000);
	assert.equal(resolveDelegateSettings({ piWorker: { thinkingCeiling: "ultra" } }).ceiling, "medium");
});

test("brief at the limit passes, one token over is refused with a trim hint", () => {
	const atLimit = "x".repeat(3000 * 4);
	assert.equal(gateLaunch({ agent: "worker", task: atLimit }, settings, 0).error, undefined);
	const over = gateLaunch({ agent: "worker", task: atLimit + "xxxx" }, settings, 0);
	assert.match(over.error, /over the 3000 limit/);
	assert.match(over.error, /Do not paste whole files/);
});

test("collects briefs from tasks, chain steps and chain parallel groups", () => {
	const labels = collectBriefs({
		tasks: [{ agent: "a", task: "t0" }],
		chain: [{ agent: "a", task: "c0" }, { parallel: [{ agent: "a", task: "p0" }] }],
	}).map((b) => b.label);
	assert.deepEqual(labels, ["tasks[0]", "chain[0]", "chain[1].parallel[0]"]);
});

test("an oversized brief hidden in a chain parallel group is still refused", () => {
	const big = "x".repeat(13_000);
	const gated = gateLaunch({ chain: [{ parallel: [{ agent: "a", task: big }] }] }, settings, 0);
	assert.match(gated.error, /chain\[0\]\.parallel\[0\]/);
});

test("management actions are not launches and skip every gate", () => {
	const params = { action: "status", agent: "x", task: "x".repeat(50_000), model: "nope/nope" };
	assert.equal(isLaunch(params), false);
	assert.equal(gateLaunch(params, settings, 0).error, undefined);
});

test("model must be in enabledModels; bare unique id accepted", () => {
	assert.match(checkModel("openai/gpt-9", settings.enabledModels), /not in enabledModels/);
	assert.equal(checkModel("claude/claude-haiku-5-5", settings.enabledModels), undefined);
	assert.equal(checkModel("claude-haiku-5-5", settings.enabledModels), undefined);
	assert.equal(checkModel("anything", []), undefined);
});

test("splitModel only treats a known trailing level as a suffix", () => {
	assert.deepEqual(splitModel("a/b:high"), { id: "a/b", level: "high" });
	assert.deepEqual(splitModel("a/b:weird"), { id: "a/b:weird", level: undefined });
	assert.deepEqual(splitModel("a/b"), { id: "a/b", level: undefined });
});

test("thinking above the ceiling is clamped to medium", () => {
	const gated = gateLaunch({ agent: "w", task: "t", model: SONNET + ":high" }, settings, 0);
	assert.equal(gated.params.model, SONNET + ":medium");
	assert.match(gated.notices[0], /clamped to 'medium'/);
	for (const level of ["xhigh", "max"]) {
		assert.equal(gateLaunch({ agent: "w", task: "t", model: SONNET + ":" + level }, settings, 0).params.model, SONNET + ":medium");
	}
});

test("thinking at or below the ceiling is untouched", () => {
	const gated = gateLaunch({ agent: "w", task: "t", model: SONNET + ":low" }, settings, 0);
	assert.equal(gated.params.model, SONNET + ":low");
	assert.deepEqual(gated.notices, []);
});

test("high unlocks only at 2 failures", () => {
	assert.equal(allowedThinking("medium", 0), "medium");
	assert.equal(allowedThinking("medium", 1), "medium");
	assert.equal(allowedThinking("medium", 2), "high");
	assert.equal(allowedThinking("xhigh", 5), "xhigh");
	assert.equal(gateLaunch({ agent: "w", task: "t", model: SONNET + ":high" }, settings, 2).params.model, SONNET + ":high");
	assert.equal(gateLaunch({ agent: "w", task: "t", model: SONNET + ":xhigh" }, settings, 2).params.model, SONNET + ":high");
});

test("rowFailed reads objective signals only", () => {
	assert.equal(rowFailed({ exitCode: 0 }), false);
	assert.equal(rowFailed({ exitCode: 1 }), true);
	assert.equal(rowFailed({ error: "boom" }), true);
	assert.equal(rowFailed({ timedOut: true }), true);
	assert.equal(rowFailed({ interrupted: true }), true);
	assert.equal(rowFailed({ success: false }), true);
	assert.equal(rowFailed({}), false);
	assert.equal(launchFailed({ threw: true }), true);
	assert.equal(launchFailed({ result: { details: { results: [{ exitCode: 0 }, { exitCode: 2 }] } } }), true);
	assert.equal(launchFailed({ result: { details: { results: [{ exitCode: 0 }] } } }), false);
});

test("stripLeadFields removes taskId and retry before launch", () => {
	const { launch, taskId, retry } = stripLeadFields({ agent: "w", task: "t", taskId: " t1 ", retry: true });
	assert.deepEqual(launch, { agent: "w", task: "t" });
	assert.equal(taskId, "t1");
	assert.equal(retry, true);
});

function harness(rowsPerCall) {
	const launched = [];
	let call = 0;
	const guarded = createDelegateWrapper(() => settings, new FailureLedger());
	const send = (extra = {}) =>
		guarded({ agent: "worker", task: "do it", taskId: "T1", model: SONNET + ":high", ...extra }, async (launch) => {
			launched.push(launch);
			const rows = rowsPerCall[Math.min(call++, rowsPerCall.length - 1)];
			return { content: [{ type: "text", text: "done" }], details: { results: rows } };
		});
	return { send, launched };
}

test("two real failures for one taskId raise the third launch to high", async () => {
	const { send, launched } = harness([[{ exitCode: 1 }], [{ error: "boom" }], [{ exitCode: 0 }]]);
	await send();
	await send();
	await send();
	assert.deepEqual(launched.map((l) => l.model), [SONNET + ":medium", SONNET + ":medium", SONNET + ":high"]);
	assert.ok(launched.every((l) => !("taskId" in l) && !("retry" in l)));
});

test("a thrown launch counts as a failure", async () => {
	const guarded = createDelegateWrapper(() => settings);
	const input = { agent: "w", task: "t", taskId: "T", model: SONNET + ":high" };
	const fail = () => guarded(input, async () => { throw new Error("crash"); });
	await assert.rejects(fail, /crash/);
	await assert.rejects(fail, /crash/);
	const seen = [];
	await guarded(input, async (launch) => { seen.push(launch.model); return { content: [], details: { results: [] } }; });
	assert.equal(seen[0], SONNET + ":high");
});

test("success never counts, and different taskIds do not share failures", async () => {
	const { send, launched } = harness([[{ exitCode: 0 }]]);
	await send();
	await send();
	await send();
	assert.ok(launched.every((l) => l.model.endsWith(":medium")));
	const other = harness([[{ exitCode: 1 }], [{ exitCode: 1 }]]);
	await other.send({ taskId: "A" });
	await other.send({ taskId: "A" });
	await other.send({ taskId: "B" });
	assert.equal(other.launched[2].model.endsWith(":medium"), true);
});

test("retry:true counts a wrong-but-clean result", async () => {
	const { send, launched } = harness([[{ exitCode: 0 }]]);
	await send();
	await send({ retry: true });
	await send({ retry: true });
	assert.equal(launched[2].model.endsWith(":high"), true);
});

test("without a taskId nothing escalates", async () => {
	const { send, launched } = harness([[{ exitCode: 1 }]]);
	for (let i = 0; i < 4; i++) await send({ taskId: undefined });
	assert.ok(launched.every((l) => l.model.endsWith(":medium")));
});

test("refused launch throws and never reaches the runner", async () => {
	const { send, launched } = harness([[{ exitCode: 0 }]]);
	await assert.rejects(() => send({ model: "openai/gpt-9:low" }), /not in enabledModels/);
	await assert.rejects(() => send({ task: "x".repeat(20_000) }), /over the 3000 limit/);
	assert.equal(launched.length, 0);
});

test("estimateTokens is chars/4 rounded up", () => {
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("abcde"), 2);
});
