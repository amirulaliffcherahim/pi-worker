import { test } from "node:test";
import assert from "node:assert/strict";
import { DELEGATION_TOOLS, registerLeadCommand } from "../src/lead/lead-command.js";

/** Stub API: records handlers and the registered command, owns the active tool set. */
function load(registered = ["read", ...DELEGATION_TOOLS]) {
	const handlers = new Map();
	const toolState = { active: [...registered] };
	const notices = [];
	const sent = [];
	let command;
	const pi = {
		on: (name, fn) => {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerCommand: (name, options) => {
			command = { name, ...options };
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
	const ctx = {
		ui: { notify: (message) => notices.push(message) },
		sendUserMessage: async (content, options) => sent.push({ content, options }),
	};
	assert.ok(command, "registered the /lead command");
	const lead = (args) => command.handler(args, ctx);
	const call = (toolName) => run("tool_call", { toolName, input: {} }, {});
	return { run, lead, call, command, notices, sent, toolState };
}

test("the /lead command is registered with a description, so Pi lists it", () => {
	const { command } = load();
	assert.equal(command.name, "lead");
	assert.match(command.description, /delegate/);
	assert.equal(typeof command.handler, "function");
});

test("a new session starts with lead mode off and no delegation tools", () => {
	process.env.PI_LEAD_MODE = "1";
	const { run, toolState } = load();
	run("session_start", { type: "session_start", reason: "startup" }, {});
	assert.equal(process.env.PI_LEAD_MODE, "0");
	assert.deepEqual(toolState.active, ["read"]);
});

test("/lead <brief> enables delegation and sends the rest of the line as the prompt", async () => {
	const { lead, toolState, notices, sent } = load();
	await lead("refactor the parser");
	assert.equal(process.env.PI_LEAD_MODE, "1");
	for (const name of DELEGATION_TOOLS) assert.ok(toolState.active.includes(name), name);
	assert.deepEqual(sent.map((m) => m.content), ["refactor the parser"]);
	assert.equal(sent[0].options.deliverAs, "followUp");
	assert.ok(notices.some((n) => /lead mode ON/.test(n)));
});

test("a bare /lead flips the switch without spending a model turn", async () => {
	const { lead, toolState, sent } = load();
	await lead("");
	assert.equal(process.env.PI_LEAD_MODE, "1");
	assert.ok(toolState.active.includes("delegate_task"));
	assert.equal(sent.length, 0);
});

test("/lead off turns it back off and removes the tools", async () => {
	const { lead, toolState, notices, sent } = load();
	await lead("on");
	await lead("off");
	assert.equal(process.env.PI_LEAD_MODE, "0");
	assert.deepEqual(toolState.active, ["read"]);
	assert.equal(sent.length, 1);
	assert.ok(notices.some((n) => /lead mode OFF/.test(n)));
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
	const { run, lead, toolState } = load();
	await lead("");
	run("before_agent_start", { systemPromptOptions: { sections: {} } }, {});
	assert.ok(toolState.active.includes("delegate_task"));
});

test("a session without delegation tools still records the switch and warns", async () => {
	const { lead, notices, sent } = load(["read"]);
	await lead("refactor");
	assert.equal(process.env.PI_LEAD_MODE, "1");
	assert.equal(sent.length, 1);
	assert.ok(notices.some((n) => /no delegation tools/.test(n)));
});

test("the delegation tools are refused while the switch is off, allowed after /lead", async () => {
	const { lead, call } = load();
	for (const name of DELEGATION_TOOLS) {
		const blocked = call(name);
		assert.equal(blocked?.block, true, name);
		assert.match(blocked.reason, /\/lead/);
	}
	assert.equal(call("read"), undefined);
	await lead("on");
	for (const name of DELEGATION_TOOLS) assert.equal(call(name), undefined, name);
	await lead("off");
	assert.equal(call("delegate_task")?.block, true);
});
