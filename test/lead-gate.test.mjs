import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BLOCKED_TOOLS, leadToolVerdict, registerLeadGate, resolveLeadGate } from "../src/lead/lead-gate.js";

test("blocks edit, write, bash and powershell by default", () => {
	const gate = resolveLeadGate({});
	for (const tool of DEFAULT_BLOCKED_TOOLS) assert.equal(leadToolVerdict(gate, tool).block, true, tool);
});

test("allows read-only tools and delegation", () => {
	const gate = resolveLeadGate({});
	for (const tool of ["read", "grep", "find", "ls", "delegate_task", "todo"]) {
		assert.equal(leadToolVerdict(gate, tool).block, false, tool);
	}
});

test("block reason points the lead at delegate_task", () => {
	const verdict = leadToolVerdict(resolveLeadGate({}), "edit");
	assert.match(verdict.reason, /delegate_task/);
});

test("piWorker.lead.blockedTools extends the default set", () => {
	const gate = resolveLeadGate({ piWorker: { lead: { blockedTools: ["notebook_edit"] } } });
	assert.equal(leadToolVerdict(gate, "notebook_edit").block, true);
	assert.equal(leadToolVerdict(gate, "edit").block, true);
});

test("piWorker.lead.readOnly=false turns the gate off", () => {
	const gate = resolveLeadGate({ piWorker: { lead: { readOnly: false } } });
	assert.equal(leadToolVerdict(gate, "bash").block, false);
});

test("malformed settings fall back to the safe default", () => {
	for (const bad of [undefined, null, 5, "x", { piWorker: 3 }, { piWorker: { lead: { blockedTools: "bash" } } }]) {
		assert.equal(leadToolVerdict(resolveLeadGate(bad), "bash").block, true, JSON.stringify(bad));
	}
});

test("tool_call handler vetoes through pi.getSettings, re-read on each call", () => {
	process.env.PI_LEAD_MODE = "1";
	let settings = {};
	let handler;
	registerLeadGate({ on: (name, fn) => { if (name === "tool_call") handler = fn; }, getSettings: () => settings });
	assert.equal(handler({ toolName: "write" }).block, true);
	assert.equal(handler({ toolName: "read" }), undefined);
	settings = { piWorker: { lead: { readOnly: false } } };
	assert.equal(handler({ toolName: "write" }), undefined);
});

test("the default denylist also covers apply_patch, multi_edit and notebook_edit", () => {
	const gate = resolveLeadGate({});
	for (const tool of ["apply_patch", "multi_edit", "notebook_edit"]) assert.equal(leadToolVerdict(gate, tool).block, true, tool);
});

test("non-strict mode lets unknown tools through", () => {
	assert.equal(leadToolVerdict(resolveLeadGate({}), "mcp__db__insert").block, false);
});

test("strict mode refuses an unknown tool, allows listed and readOnlyHint tools", () => {
	const gate = resolveLeadGate({ piWorker: { lead: { strict: true } } });
	assert.equal(leadToolVerdict(gate, "mcp__db__insert").block, true);
	assert.match(leadToolVerdict(gate, "mcp__db__insert").reason, /allowlist/);
	assert.equal(leadToolVerdict(gate, "mcp__db__query", { readOnlyHint: true }).block, false);
	assert.equal(leadToolVerdict(gate, "mcp__db__insert", { readOnlyHint: false }).block, true);
	for (const tool of ["read", "grep", "delegate_task", "worker_diff", "todo", "memory_search"]) {
		assert.equal(leadToolVerdict(gate, tool).block, false, tool);
	}
});

test("piWorker.lead.allowedTools extends the strict allowlist, but the denylist still wins", () => {
	const gate = resolveLeadGate({ piWorker: { lead: { strict: true, allowedTools: ["my_reader", "bash"] } } });
	assert.equal(leadToolVerdict(gate, "my_reader").block, false);
	assert.equal(leadToolVerdict(gate, "bash").block, true);
});

test("a readOnlyHint cannot unblock a denylisted tool", () => {
	assert.equal(leadToolVerdict(resolveLeadGate({}), "edit", { readOnlyHint: true }).block, true);
});

test("handler reads tool annotations from pi.getAllTools and survives it throwing", () => {
	process.env.PI_LEAD_MODE = "1";
	let handler;
	const settings = { piWorker: { lead: { strict: true } } };
	const base = { on: (name, fn) => { if (name === "tool_call") handler = fn; }, getSettings: () => settings };
	registerLeadGate({ ...base, getAllTools: () => [{ name: "q", annotations: { readOnlyHint: true } }] });
	assert.equal(handler({ toolName: "q" }), undefined);
	assert.equal(handler({ toolName: "other" }).block, true);
	registerLeadGate({ ...base, getAllTools: () => { throw new Error("not ready"); } });
	assert.equal(handler({ toolName: "other" }).block, true);
});

test("with lead mode off the gate changes nothing: a normal session can edit", () => {
	delete process.env.PI_LEAD_MODE;
	let handler;
	registerLeadGate({ on: (name, fn) => { if (name === "tool_call") handler = fn; }, getSettings: () => ({}), getAllTools: () => [] });
	for (const tool of ["edit", "write", "bash", "read"]) {
		assert.equal(handler({ toolName: tool }), undefined, tool);
	}
	process.env.PI_LEAD_MODE = "1";
	assert.equal(handler({ toolName: "edit" }).block, true);
	process.env.PI_LEAD_MODE = "0";
	assert.equal(handler({ toolName: "edit" }), undefined);
	delete process.env.PI_LEAD_MODE;
});
