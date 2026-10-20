import { test } from "node:test";
import assert from "node:assert/strict";
import { CAVEMAN_RULES, DEFAULT_BRIEF_SECTIONS, renderLeadPrompt, renderReportContract, renderWorkerRules, resolveBriefTemplate } from "../src/lead/lead-prompt.js";
import { createDelegateWrapper, DEFAULT_REPORT_MAX, resolveReportMax, withWorkerRules } from "../src/lead/delegate-wrapper.js";
import { estimateTokens } from "../src/lead/delegate-gate.js";

const models = { enabledModels: ["claude/claude-sonnet-5-5"] };

test("default template: 3000 tokens, five brief sections, caveman on", () => {
	const template = resolveBriefTemplate({});
	assert.equal(template.maxTokens, 3000);
	assert.deepEqual(template.sections.map((s) => s.key), DEFAULT_BRIEF_SECTIONS.map((s) => s.key));
	assert.equal(template.caveman, true);
});

test("sections are editable: reorder, rename, disable", () => {
	const template = resolveBriefTemplate({
		piWorker: {
			brief: {
				maxTokens: 1500,
				sections: [
					{ key: "files", title: "Where" },
					{ key: "goal", title: "Aim", hint: "short" },
					{ key: "snippets", title: "Code", enabled: false },
				],
			},
		},
	});
	assert.equal(template.maxTokens, 1500);
	assert.deepEqual(template.sections.map((s) => s.title), ["Where", "Aim"]);
	assert.match(renderLeadPrompt(template), /Brief limit: 1500 tokens/);
	assert.match(renderLeadPrompt(template), /- Aim: short/);
});

test("report format is editable", () => {
	const template = resolveBriefTemplate({ piWorker: { brief: { reportFormat: [{ title: "Done" }, { title: "Next" }] } } });
	assert.match(renderReportContract(template), /- Done\n- Next/);
});

test("custom instructions reach the lead prompt", () => {
	const template = resolveBriefTemplate({ piWorker: { brief: { instructions: "Always name the test file." } } });
	assert.match(renderLeadPrompt(template), /Always name the test file\./);
});

test("malformed sections fall back to defaults", () => {
	for (const bad of ["x", 5, [], [{ title: "" }], [null], [{ enabled: false, title: "a" }]]) {
		const template = resolveBriefTemplate({ piWorker: { brief: { sections: bad } } });
		assert.equal(template.sections.length, DEFAULT_BRIEF_SECTIONS.length, JSON.stringify(bad));
	}
});

test("caveman is on by default and can be switched off for lead and worker", () => {
	assert.match(renderLeadPrompt(resolveBriefTemplate({})), /Talk terse/);
	assert.match(renderWorkerRules(resolveBriefTemplate({})), /Talk terse/);
	const off = resolveBriefTemplate({ piWorker: { caveman: false } });
	assert.doesNotMatch(renderLeadPrompt(off), /Talk terse/);
	assert.doesNotMatch(renderWorkerRules(off), /Talk terse/);
});

test("caveman rules keep code, paths and negations exact", () => {
	assert.match(CAVEMAN_RULES, /verbatim/);
	assert.match(CAVEMAN_RULES, /never drop not, never, no, only, except/i);
});

test("lead prompt states the role and stays small", () => {
	const prompt = renderLeadPrompt(resolveBriefTemplate({}));
	assert.match(prompt, /does not write it/);
	assert.match(prompt, /delegate_task/);
	assert.match(prompt, /worker_diff/);
	assert.match(prompt, /after 2 real failures the cap lifts to high/);
	assert.ok(estimateTokens(prompt) < 1100, `lead prompt is ${estimateTokens(prompt)} tokens`);
});

test("worker rules are appended to every task shape, brief text first", () => {
	const settings = {};
	const single = withWorkerRules({ agent: "w", task: "BRIEF" }, settings);
	assert.ok(single.task.startsWith("BRIEF\n\n---\n"));
	assert.match(single.task, /Report back using exactly these headings/);
	const multi = withWorkerRules({ tasks: [{ agent: "a", task: "A" }, { agent: "b", task: "B" }] }, settings);
	assert.ok(multi.tasks.every((t) => t.task.includes("Report back")));
	const chain = withWorkerRules({ chain: [{ agent: "a", task: "S1" }, { parallel: [{ agent: "b", task: "P1" }] }] }, settings);
	assert.match(chain.chain[0].task, /Report back/);
	assert.match(chain.chain[1].parallel[0].task, /Report back/);
});

test("withWorkerRules leaves launches without a task alone and never mutates input", () => {
	const input = { agent: "w", task: "T" };
	withWorkerRules(input, {});
	assert.equal(input.task, "T");
	assert.deepEqual(withWorkerRules({ agent: "w" }, {}), { agent: "w" });
});

test("rules do not count against the brief cap", async () => {
	const guarded = createDelegateWrapper(() => ({ ...models, piWorker: { brief: { maxTokens: 50 } } }));
	const atCap = "x".repeat(50 * 4);
	let seen;
	await guarded({ agent: "w", task: atCap, model: "claude/claude-sonnet-5-5" }, async (launch) => { seen = launch; return { content: [], details: { results: [] } }; });
	assert.ok(estimateTokens(seen.task) > 50);
	await assert.rejects(() => guarded({ agent: "w", task: atCap + "xxxx", model: "claude/claude-sonnet-5-5" }, async () => ({})), /over the 50 limit/);
});

test("report cap defaults to 8 KB / 200 lines, is configurable, and respects an explicit maxOutput", () => {
	assert.deepEqual(resolveReportMax({}, {}), DEFAULT_REPORT_MAX);
	assert.deepEqual(resolveReportMax({ piWorker: { report: { maxBytes: 2000, maxLines: 40 } } }, {}), { bytes: 2000, lines: 40 });
	assert.deepEqual(resolveReportMax({ piWorker: { report: { maxBytes: -1 } } }, {}), DEFAULT_REPORT_MAX);
	assert.deepEqual(resolveReportMax({}, { maxOutput: { bytes: 99 } }), { bytes: 99 });
});

test("runner receives the report cap and no lead-only fields", async () => {
	const guarded = createDelegateWrapper(() => models);
	let seen;
	await guarded({ agent: "w", task: "t", taskId: "T", retry: false, model: "claude/claude-sonnet-5-5" }, async (launch) => { seen = launch; return { content: [], details: { results: [] } }; });
	assert.deepEqual(seen.maxOutput, DEFAULT_REPORT_MAX);
	assert.ok(!("taskId" in seen) && !("retry" in seen));
});

test("management actions pass through untouched", async () => {
	const guarded = createDelegateWrapper(() => models);
	let seen;
	await guarded({ action: "status", id: "abc" }, async (launch) => { seen = launch; return { content: [] }; });
	assert.deepEqual(seen, { action: "status", id: "abc" });
});

test("lead prompt tells the lead not to try bash and not to read skill files", () => {
	const prompt = renderLeadPrompt(resolveBriefTemplate({}));
	assert.match(prompt, /do not try them, a call is refused/);
	assert.match(prompt, /do not need to read any skill file/);
	assert.match(prompt, /Keep todo use light/);
	assert.match(prompt, /leave model out and each worker gets its category default/);
});
