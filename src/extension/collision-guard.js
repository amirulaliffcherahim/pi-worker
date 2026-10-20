// Both extensions can load together only because pi-worker renames its tool, commands, settings key,
// env vars and temp roots. Warn once so the operator knows two delegation layers are active.
const UPSTREAM_TOOL_NAME = "subagent";
export function warnIfUpstreamLoaded(pi, ctx) {
    let tools;
    try {
        tools = pi.getAllTools();
    }
    catch {
        return false;
    }
    const upstreamLoaded = tools.some((tool) => tool.name === UPSTREAM_TOOL_NAME);
    if (upstreamLoaded) {
        ctx.ui?.notify?.("pi-worker: pi-subagents is also loaded. Two delegation layers are active; disable pi-subagents so the lead delegates only through delegate_task.", "warning");
    }
    return upstreamLoaded;
}
