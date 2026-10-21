import { test } from "node:test";
import assert from "node:assert/strict";
import { DELEGATION_TOOLS, registerLeadCommand } from "../src/lead/lead-command.js";

/** Stub API: records handlers, owns the active tool set. */
function load(registered = ["read", ...DELEGATION_TOOLS]) {
	const handlers = new Map();
	const toolState = { active: [...registered] };
	const notices = [];
	const pi = {
		on: (name, fn) => {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		getAllTools: () => registered.map((name) => ({ name })),
		getActiveTools: () => [...toolState.active],
		setActiveTools: (names) => {
			toolState.active = [...names];
		},
	};
	registerLeadCommand(pi);
	const run = (name, ...args) => {
		assert.ok(handlers.has(name), `registered a ${name} handler`);
		return handlers.get(name).at(-1)(...args);
	};
	const ctx = { ui: { notify: (message) => notices.push(message) } };
	const input = (text, source = "interactive") => run("input", { type: "input", text, source }, ctx);
	return { run, input, notices, toolState };
}

test("a new session starts with lead mode off and no delegation tools", () => {
	process.env.PI_LEAD_MODE = "1";
	const { run, toolState } = load();
	run("session_start", { type: "session_start", reason: "startup" }, {});
	assert.equal(process.env.PI_LEAD_MODE, "0");
	assert.deepEqual(toolState.active, ["read"]);
});

test("/lead turns delegation on and strips the token from the prompt", async () => {
	const { input, toolState, notices } = load();
	const result = await input("/lead refactor the parser");
	assert.equal(result.action, "transform");
	assert.equal(result.text, "refactor the parser");
	assert.equal(process.env.PI_LEAD_MODE, "1");
	for (const name of DELEGATION_TOOLS) assert.ok(toolState.active.includes(name), name);
	assert.ok(notices.some((n) => /lead mode ON/.test(n)));
});

test("a bare /lead flips the switch without spending a model turn", async () => {
	const { input, toolState } = load();
	assert.deepEqual(await input("/lead"), { action: "handled" });
	assert.equal(process.env.PI_LEAD_MODE, "1");
	assert.ok(toolState.active.includes("delegate_task"));
});

test("/lead off turns it back off and removes the tools", async () => {
	const { input, toolState, notices } = load();
	await input("/lead on");
	await input("/lead off");
	assert.equal(process.env.PI_LEAD_MODE, "0");
	assert.deepEqual(toolState.active, ["read"]);
	assert.ok(notices.some((n) => /lead mode OFF/.test(n)));
});

test("ordinary prompts pass through and do not change the switch", async () => {
	process.env.PI_LEAD_MODE = "0";
	const { input } = load();
	assert.deepEqual(await input("add a mul function"), { action: "continue" });
	assert.equal(process.env.PI_LEAD_MODE, "0");
});

test("non-interactive input is left alone", async () => {
	const { input } = load();
	assert.deepEqual(await input("/lead refactor", "command"), { action: "continue" });
});

test("the switch re-asserts after the subagent loader re-declares its tools", () => {
	const { run, toolState } = load();
	run("session_start", {}, {});
	// What tool-activation.js does on every turn while the loader is selected.
	toolState.active = ["read", "subagents_enable", "delegate_task"];
	run("before_agent_start", { systemPromptOptions: { sections: {} } }, {});
	assert.deepEqual(toolState.active, ["read"]);
});

test("lead mode stays on across turns once enabled", async () => {
	const { run, input, toolState } = load();
	await input("/lead on");
	run("before_agent_start", { systemPromptOptions: { sections: {} } }, {});
	assert.ok(toolState.active.includes("delegate_task"));
});

test("a session without delegation tools still records the switch and warns", async () => {
	const { input, notices } = load(["read"]);
	const result = await input("/lead refactor");
	assert.equal(result.action, "transform");
	assert.equal(process.env.PI_LEAD_MODE, "1");
	assert.ok(notices.some((n) => /no delegation tools/.test(n)));
});

test("the delegation tools are refused while the switch is off, allowed after /lead", async () => {
	const { run, input } = load();
	const call = (toolName) => run("tool_call", { toolName, input: {} }, {});
	for (const name of DELEGATION_TOOLS) {
		const blocked = call(name);
		assert.equal(blocked?.block, true, name);
		assert.match(blocked.reason, /\/lead/);
	}
	assert.equal(call("read"), undefined);
	await input("/lead on");
	for (const name of DELEGATION_TOOLS) assert.equal(call(name), undefined, name);
	await input("/lead off");
	assert.equal(call("delegate_task")?.block, true);
});
