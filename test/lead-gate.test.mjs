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
	let settings = {};
	let handler;
	registerLeadGate({ on: (name, fn) => { if (name === "tool_call") handler = fn; }, getSettings: () => settings });
	assert.equal(handler({ toolName: "write" }).block, true);
	assert.equal(handler({ toolName: "read" }), undefined);
	settings = { piWorker: { lead: { readOnly: false } } };
	assert.equal(handler({ toolName: "write" }), undefined);
});
