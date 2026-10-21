import { isLeadMode } from "./lead-mode.js";
// The lead never changes code. Enforced at the tool_call boundary, not in the prompt:
// a prompt rule can be talked around, a veto cannot. Workers run in children where this extension
// returns early, so these blocks only ever apply to the lead session.
//
// A denylist alone misses every mutating tool another extension adds later, so a call is allowed when ANY of:
//   1. the tool is on the lead allowlist (reads, delegation, bookkeeping)
//   2. the tool declares annotations.readOnlyHint === true
// and it is refused when it is on the denylist, or when it is neither of the above and `strict` is on.
export const DEFAULT_BLOCKED_TOOLS = Object.freeze(["edit", "write", "bash", "powershell", "apply_patch", "multi_edit", "notebook_edit"]);
export const DEFAULT_ALLOWED_TOOLS = Object.freeze([
	"read", "grep", "find", "ls", "worker_diff",
	"delegate_task", "subagent_supervisor", "contact_supervisor", "structured_output", "bg_wait",
	"todo", "ask_user_question", "ask_advisor", "record_advisor_outcome", "ask_compliance",
	"memory_read", "memory_search", "memory_status", "memory_write", "memory_forget", "memory_restore", "scratchpad",
	"google_search", "web_search", "fetch_content", "get_search_content", "source_check", "convert_to_markdown",
]);
const SETTINGS_KEY = "piWorker";

function stringList(value) {
	return Array.isArray(value) ? value.filter((name) => typeof name === "string" && name.length > 0) : [];
}

export function resolveLeadGate(settings) {
	const lead = settings?.[SETTINGS_KEY]?.lead;
	return {
		enabled: lead?.readOnly !== false,
		strict: lead?.strict === true,
		blocked: new Set([...DEFAULT_BLOCKED_TOOLS, ...stringList(lead?.blockedTools)]),
		allowed: new Set([...DEFAULT_ALLOWED_TOOLS, ...stringList(lead?.allowedTools)]),
	};
}

/** `annotations` is the tool's own metadata from pi.getAllTools(), when known. */
export function leadToolVerdict(gate, toolName, annotations) {
	if (!gate.enabled)
		return { block: false };
	if (gate.blocked.has(toolName))
		return { block: true, reason: blockedReason(toolName) };
	if (gate.allowed.has(toolName) || annotations?.readOnlyHint === true)
		return { block: false };
	if (gate.strict)
		return { block: true, reason: `pi-worker: tool "${toolName}" is not on the lead allowlist (piWorker.lead.allowedTools). Delegate it, or add it to the allowlist if it is read-only.` };
	return { block: false };
}

function blockedReason(toolName) {
	return `pi-worker: the lead never edits or runs code. Put "${toolName}" work in a brief and call delegate_task; a worker executes it and reports back.`;
}

function annotationsFor(pi, toolName) {
	try {
		return pi.getAllTools().find((tool) => tool.name === toolName)?.annotations;
	}
	catch {
		return undefined;
	}
}

export function registerLeadGate(pi) {
	pi.on("tool_call", (event) => {
		// Only when the user asked for lead mode; otherwise the session is a normal single agent.
		if (!isLeadMode())
			return undefined;
		const gate = resolveLeadGate(pi.getSettings());
		const verdict = leadToolVerdict(gate, event.toolName, annotationsFor(pi, event.toolName));
		return verdict.block ? verdict : undefined;
	});
}
