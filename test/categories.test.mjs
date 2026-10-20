import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForAgent, DEFAULT_CATEGORIES, HARD_MAX_THINKING, resolveCategories, validEffort } from "../src/lead/categories.js";
import { gateLaunch } from "../src/lead/delegate-gate.js";
import { mapUnits } from "../src/lead/unit-models.js";
import { renderSlicingRules, resolveSlicing } from "../src/lead/lead-prompt.js";

const SONNET = "claude/claude-sonnet-5-5";
const HAIKU = "claude/claude-haiku-5-5";
const OPUS = "claude/claude-opus-5-5";
const agents = [
	{ name: "worker", tools: ["read", "edit"] },
	{ name: "scout", tools: ["read", "grep"] },
	{ name: "oracle", tools: ["read", "bash"] },
	{ name: "reviewer", tools: ["read"] },
];
const resolveAgent = (name, list) => ({ agent: list.find((a) => a.name === name) });
const env = { agents, resolveAgent, sessionThinking: "low" };
const base = { enabledModels: [SONNET, HAIKU, OPUS] };

test("default efforts: scout low, worker medium, oracle high", () => {
	const by = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.agent, c.effort]));
	assert.equal(by.scout, "low");
	assert.equal(by.worker, "medium");
	assert.equal(by.oracle, "high");
});

test("effort in settings is capped at high; junk is dropped", () => {
	assert.equal(validEffort("xhigh"), HARD_MAX_THINKING);
	assert.equal(validEffort("max"), "high");
	assert.equal(validEffort("low"), "low");
	assert.equal(validEffort("loud"), undefined);
	assert.equal(validEffort(5), undefined);
	const cats = resolveCategories({ piWorker: { categories: [{ agent: "worker", effort: "max", model: " " + SONNET + " " }] } });
	assert.equal(cats[0].effort, "high");
	assert.equal(cats[0].model, SONNET);
});

test("categoryForAgent finds the first category for an agent", () => {
	assert.equal(categoryForAgent(DEFAULT_CATEGORIES, "oracle").title, "Decide");
	assert.equal(categoryForAgent(DEFAULT_CATEGORIES, "ghost"), undefined);
});

test("the lead can omit model: the category model and effort apply", () => {
	const settings = { ...base, piWorker: { categories: [{ agent: "worker", model: SONNET, effort: "low" }] } };
	const gated = gateLaunch({ agent: "worker", task: "t" }, settings, 0, env);
	assert.equal(gated.error, undefined);
	assert.equal(gated.params.model, SONNET + ":low");
});

test("model precedence: unit, then launch, then category, then piWorker.defaultModel", () => {
	const settings = { ...base, piWorker: { defaultModel: OPUS, categories: [{ agent: "worker", model: HAIKU }, { agent: "scout" }] } };
	const unitModel = gateLaunch({ model: SONNET, tasks: [{ agent: "worker", task: "t", model: OPUS }] }, settings, 0, env);
	assert.ok(unitModel.params.tasks[0].model.startsWith(OPUS));
	const launchModel = gateLaunch({ model: SONNET, tasks: [{ agent: "worker", task: "t" }] }, settings, 0, env);
	assert.ok(launchModel.params.tasks[0].model.startsWith(SONNET));
	const categoryModel = gateLaunch({ tasks: [{ agent: "worker", task: "t" }] }, settings, 0, env);
	assert.ok(categoryModel.params.tasks[0].model.startsWith(HAIKU));
	const fallback = gateLaunch({ tasks: [{ agent: "scout", task: "t" }] }, settings, 0, env);
	assert.ok(fallback.params.tasks[0].model.startsWith(OPUS));
});

test("each unit gets its own model and effort in one launch", () => {
	const settings = { ...base, piWorker: { categories: [{ agent: "scout", model: HAIKU, effort: "low" }, { agent: "oracle", model: OPUS, effort: "high" }, { agent: "worker", model: SONNET }] } };
	const gated = gateLaunch({ chain: [{ agent: "scout", task: "a" }, { agent: "oracle", task: "b" }, { parallel: [{ agent: "worker", task: "c1 src/a.js" }, { agent: "worker", task: "c2 src/b.js" }] }] }, settings, 0, env);
	assert.equal(gated.error, undefined);
	assert.equal(gated.params.chain[0].model, HAIKU + ":low");
	assert.equal(gated.params.chain[1].model, OPUS + ":high");
	assert.equal(gated.params.chain[2].parallel[0].model, SONNET + ":medium");
	assert.equal(gated.params.chain[2].parallel[1].model, SONNET + ":medium");
});

test("an operator category effort of high is trusted, the lead's own request is still clamped to medium", () => {
	const settings = { ...base, piWorker: { categories: [{ agent: "oracle", model: OPUS, effort: "high" }] } };
	assert.equal(gateLaunch({ agent: "oracle", task: "t" }, settings, 0, env).params.model, OPUS + ":high");
	const lead = gateLaunch({ agent: "oracle", task: "t", model: OPUS + ":high" }, settings, 0, env);
	assert.equal(lead.params.model, OPUS + ":medium");
	assert.match(lead.notices.join(" "), /clamped/);
});

test("xhigh and max never launch, whatever the config or the lead says", () => {
	const loose = { ...base, piWorker: { thinkingCeiling: "max", categories: [{ agent: "oracle", model: OPUS, effort: "max" }] } };
	assert.equal(gateLaunch({ agent: "oracle", task: "t" }, loose, 0, env).params.model, OPUS + ":high");
	for (const level of ["xhigh", "max"]) {
		assert.equal(gateLaunch({ agent: "oracle", task: "t", model: OPUS + ":" + level }, loose, 9, env).params.model, OPUS + ":high");
	}
});

test("a category that only sets a model keeps the built-in effort for that agent", () => {
	const cats = resolveCategories({ piWorker: { categories: [{ agent: "oracle", model: OPUS }, { agent: "custom", model: HAIKU }] } });
	assert.equal(cats[0].effort, "high");
	assert.equal(cats[1].effort, undefined);
});

test("no model anywhere: refused, naming the unit, the fix and the choices", () => {
	const settings = { enabledModels: [SONNET], piWorker: { categories: [{ agent: "reviewer" }] } };
	const none = gateLaunch({ tasks: [{ agent: "scout", task: "ok", model: SONNET }, { agent: "reviewer", task: "t" }] }, settings, 0, env);
	assert.match(none.error, /tasks\[1\].*\(reviewer\) has no model/);
	assert.match(none.error, /piWorker\.defaultModel/);
	assert.match(none.error, /claude-sonnet-5-5/);
});

test("mapUnits applies to single, tasks, chain and chain parallel, and leaves other steps alone", () => {
	const touch = (unit, label) => ({ seen: label });
	assert.equal(mapUnits({ agent: "a", task: "t" }, touch).seen, "task");
	assert.deepEqual(mapUnits({ tasks: [{ agent: "a" }, { agent: "b" }] }, touch).tasks.map((t) => t.seen), ["tasks[0]", "tasks[1]"]);
	const chain = mapUnits({ chain: [{ agent: "a" }, { parallel: [{ agent: "b" }] }, { other: 1 }] }, touch).chain;
	assert.equal(chain[0].seen, "chain[0]");
	assert.equal(chain[1].parallel[0].seen, "chain[1].parallel[0]");
	assert.equal(chain[2].seen, undefined);
});

test("the lead prompt shows each category effort and the omit-model rule", () => {
	const text = renderSlicingRules(resolveSlicing({}), undefined);
	assert.match(text, /Decide -> oracle \(high\)/);
	assert.match(text, /Recon -> scout \(low\)/);
});
