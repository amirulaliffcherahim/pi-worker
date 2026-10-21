import { LEAD_MODE_ENV } from "./lead-mode.js";
// Lead mode is opt-in per session, and `/lead` is a real command so Pi lists it, completes it and
// dispatches it before a prompt is built. An input-hook interception would never appear in that list.
//
// `/lead <brief>` turns delegation on for the session and sends the rest of the line as the prompt.
// A bare `/lead` only flips the switch. `/lead off` turns it back off.
//
// While off, the delegation tools are removed from the active set, so their schemas and descriptions cost
// nothing per request, and registerLeadGate (lead-gate.js) vetoes them if another extension re-activates them.
// This file owns the switch alone; the read-only veto lives there.
export const DELEGATION_TOOLS = Object.freeze(["delegate_task", "subagents_enable", "subagent_supervisor"]);
export const LEAD_OFF = /^off$/i;

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
            ? "lead mode ON: the lead delegates and never edits. /lead off disables."
            : "lead mode OFF: delegation tools removed.", "info");
    };

    pi.registerCommand("lead", {
        description: "Lead mode: the lead reads and delegates, a worker executes. /lead <brief> starts it, /lead off disables it.",
        handler: async (args, ctx) => {
            const brief = (args ?? "").trim();
            if (LEAD_OFF.test(brief)) {
                applyToolSet(false);
                announce(ctx, false);
                return;
            }
            applyToolSet(true);
            announce(ctx, true);
            // A bare /lead only flips the switch; it should not spend a model turn.
            if (brief.length === 0)
                return;
            // Queue behind a running turn instead of throwing while the session streams.
            await ctx.sendUserMessage(brief, { deliverAs: "followUp" });
        },
    });

    // Start every session with delegation off, and keep it off until the user asks.
    pi.on("session_start", () => {
        applyToolSet(false);
    });

    // The subagent loader re-declares its tools on every turn (tool-activation.js). This handler is
    // registered after it, so the switch is the last word on the tool set for that request.
    pi.on("before_agent_start", () => {
        applyToolSet(enabled);
    });

    // Backstop: another extension may put the delegation tools back (tool-activation.js does, for the
    // loader). They stay refused while the switch is off, so the tool set is not the only guard.
    pi.on("tool_call", (event) => {
        if (enabled || !DELEGATION_TOOLS.includes(event.toolName))
            return undefined;
        return {
            block: true,
            reason: `pi-worker: ${event.toolName} is off. Run /lead to enable delegation for this session, or do the work directly.`,
        };
    });
}
