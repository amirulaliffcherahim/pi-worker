// The lead never changes code. Enforced at the tool_call boundary, not in the prompt:
// a prompt rule can be talked around, a veto cannot. Workers run in children where this extension
// returns early, so these blocks only ever apply to the lead session.
export const DEFAULT_BLOCKED_TOOLS = Object.freeze(["edit", "write", "bash", "powershell"]);
const SETTINGS_KEY = "piWorker";
export function resolveLeadGate(settings) {
    const lead = settings?.[SETTINGS_KEY]?.lead;
    const enabled = lead?.readOnly !== false;
    const extra = Array.isArray(lead?.blockedTools) ? lead.blockedTools.filter((name) => typeof name === "string" && name.length > 0) : [];
    return { enabled, blocked: new Set([...DEFAULT_BLOCKED_TOOLS, ...extra]) };
}
export function leadToolVerdict(gate, toolName) {
    if (!gate.enabled || !gate.blocked.has(toolName))
        return { block: false };
    return {
        block: true,
        reason: `pi-worker: the lead never edits or runs code. Put "${toolName}" work in a brief and call delegate_task; a worker executes it and reports back.`,
    };
}
export function registerLeadGate(pi) {
    pi.on("tool_call", (event) => {
        const gate = resolveLeadGate(pi.getSettings());
        const verdict = leadToolVerdict(gate, event.toolName);
        return verdict.block ? verdict : undefined;
    });
}
