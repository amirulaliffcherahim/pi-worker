import { LEAD_MODE_ENV } from "./lead-mode.js";
// Lead mode is opt-in per session.
//
// Typing `/lead ...` turns delegation on for the rest of the session and strips the token from the prompt:
// the rest of the line becomes the brief, unchanged. `/lead off` turns it back off.
//
// While off, the delegation tools are removed from the active set, so their schemas and descriptions cost
// nothing per request, and registerLeadGate (lead-gate.js) vetoes them if another extension re-activates them.
// This file owns the switch alone; the read-only veto lives there.
export const DELEGATION_TOOLS = Object.freeze(["delegate_task", "subagents_enable", "subagent_supervisor"]);
const LEAD_PREFIX = /^\s*\/lead(?:\s+|$)/i;
const LEAD_OFF = /^off$/i;

export function registerLeadCommand(pi) {
    // Session state, not settings: a new session starts as a normal single agent.
    let enabled = false;

    const availableTools = () => {
        try {
            return new Set(pi.getAllTools().map((tool) => tool.name));
        }
        catch {
            return new Set();
        }
    };

    const delegationAvailable = () => {
        const names = availableTools();
        return DELEGATION_TOOLS.some((name) => names.has(name));
    };

    // Only touch the tool set when it actually differs: every change costs a prompt-cache miss.
    const applyToolSet = (on) => {
        enabled = on;
        // lead-mode.js reads this; the lead prompt and the veto stay inert while it is off.
        process.env[LEAD_MODE_ENV] = on ? "1" : "0";
        const available = availableTools();
        const installable = DELEGATION_TOOLS.filter((name) => available.has(name));
        if (installable.length === 0)
            return;
        const active = pi.getActiveTools();
        const has = installable.some((name) => active.includes(name));
        if (has === on)
            return;
        const without = active.filter((name) => !DELEGATION_TOOLS.includes(name));
        pi.setActiveTools(on ? [...new Set([...without, ...installable])] : without);
    };

    const announce = (ctx, on) => {
        if (!delegationAvailable()) {
            ctx.ui?.notify?.("pi-worker: no delegation tools are registered, so /lead has nothing to enable.", "warning");
            return;
        }
        ctx.ui?.notify?.(on
            ? "lead mode ON: delegate_task is available. Type /lead off to disable."
            : "lead mode OFF: delegation tools removed.", on ? "info" : "info");
    };

    // Start every session with delegation off, and keep it off until the user asks.
    pi.on("session_start", () => {
        applyToolSet(false);
    });

    pi.on("input", async (event, ctx) => {
        if (event.source !== "interactive")
            return { action: "continue" };
        if (!LEAD_PREFIX.test(event.text)) {
            // Another hook may have re-declared the tools; re-assert the switch without changing it.
            if (enabled)
                applyToolSet(true);
            return { action: "continue" };
        }
        const rest = event.text.replace(LEAD_PREFIX, "").trim();
        if (LEAD_OFF.test(rest)) {
            applyToolSet(false);
            announce(ctx, false);
            return { action: "handled" };
        }
        applyToolSet(true);
        announce(ctx, true);
        // A bare /lead only flips the switch; it should not spend a model turn.
        if (rest.length === 0)
            return { action: "handled" };
        return { action: "transform", text: rest, images: event.images };
    });

    // The subagent loader re-declares its tools on every turn (tool-activation.js). This handler is
    // registered after it, so the switch is the last word on the tool set for that request.
    pi.on("before_agent_start", () => {
        applyToolSet(enabled);
    });
}
