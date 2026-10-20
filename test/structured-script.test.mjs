import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStructuredWorkflowScript } from "../src/workflows/structured-workflow-scripts.js";

const runsAll = (script) => script.split("\n").filter((line) => line.includes("runs.all"));

test("a per-step model reaches runs.all for single steps, parallel items and tasks items", () => {
	const chain = buildStructuredWorkflowScript("chain", [
		{ agent: "scout", task: "look", model: "m/a:low" },
		{ parallel: [{ agent: "worker", task: "a", model: "m/b:medium" }, { agent: "worker", task: "b" }] },
	]);
	const lines = runsAll(chain);
	assert.match(lines[0], /agent: "scout", model: "m\/a:low", task: "look"/);
	assert.match(lines[1], /agent: "worker", model: "m\/b:medium", task: "a"/);
	assert.doesNotMatch(lines[1].split("}, {")[1], /model:/);
	const tasks = buildStructuredWorkflowScript("tasks", [{ agent: "worker", task: "x", model: "m/c:low" }]);
	assert.match(runsAll(tasks)[0], /model: "m\/c:low"/);
});

test("writes is accepted but never reaches a child: it is only for the launch gate", () => {
	const script = buildStructuredWorkflowScript("chain", [{ agent: "worker", task: "t", writes: ["a.js"] }, { parallel: [{ agent: "worker", task: "u", writes: ["b.js"] }] }]);
	assert.doesNotMatch(script, /writes|a\.js|b\.js/);
	assert.doesNotMatch(buildStructuredWorkflowScript("tasks", [{ agent: "worker", task: "t", writes: ["c.js"] }]), /writes|c\.js/);
});

test("a model is escaped, so caller text can never become code", () => {
	const hostile = 'x"}]); evil(); ([{a:"';
	const script = buildStructuredWorkflowScript("tasks", [{ agent: "worker", task: "t", model: hostile }]);
	assert.ok(script.includes(JSON.stringify(hostile)), "the model appears only as a JSON string literal");
	let evilRan = false;
	const stub = "const runs = { all: async (items) => items.map((item) => ({ key: item.key, ok: true, output: '' })) };";
	const run = new Function("evil", `return (async () => { ${stub} ${script} })()`);
	return run(() => { evilRan = true; }).then(() => assert.equal(evilRan, false));
});

test("an empty or non-string model is refused", () => {
	assert.throws(() => buildStructuredWorkflowScript("tasks", [{ agent: "w", task: "t", model: "" }]), /model must be a non-empty string/);
	assert.throws(() => buildStructuredWorkflowScript("chain", [{ agent: "w", task: "t", model: 5 }]), /model must be a non-empty string/);
});

test("unknown fields are still refused, with the new field list", () => {
	assert.throws(() => buildStructuredWorkflowScript("tasks", [{ agent: "w", task: "t", thinking: "high" }]), /unsupported fields: thinking.*agent, task, model and writes/);
	assert.throws(() => buildStructuredWorkflowScript("chain", [{ agent: "w", task: "t", bogus: 1 }]), /unsupported fields: bogus/);
});

test("without a model nothing changes in the compiled call", () => {
	assert.doesNotMatch(runsAll(buildStructuredWorkflowScript("tasks", [{ agent: "w", task: "t" }]))[0], /model:/);
});
