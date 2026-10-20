import { compareThinkingLevels } from "../shared/thinking-ceiling.js";
import { THINKING_LEVELS } from "../shared/model-info.js";
// Hard rules for every delegate_task launch. Code decides, the lead's judgement only picks inside the limits.
// Order of checks: brief size, model allowlist, thinking clamp. Management actions (status, stop...) are not launches.
// thinkingCeiling is deliberately not maxThinking: the inherited maxThinking hard-fails launches above it,
// which would block the escalation to high that this gate grants after repeated failures.
const SETTINGS_KEY = "piWorker";
export const DEFAULT_BRIEF_MAX_TOKENS = 3000;
export const DEFAULT_THINKING_CEILING = "medium";
export const ESCALATED_THINKING = "high";
export const ESCALATE_AFTER_FAILURES = 2;
export function estimateTokens(text) {
    // chars/4 over-counts code slightly, which errs toward a smaller brief.
    return Math.ceil(text.length / 4);
}
export function resolveDelegateSettings(settings) {
    const root = settings?.[SETTINGS_KEY];
    const brief = root?.brief;
    const maxTokens = Number.isInteger(brief?.maxTokens) && brief.maxTokens > 0 ? brief.maxTokens : DEFAULT_BRIEF_MAX_TOKENS;
    const ceilingRaw = root?.thinkingCeiling;
    const ceiling = THINKING_LEVELS.includes(ceilingRaw) ? ceilingRaw : DEFAULT_THINKING_CEILING;
    const enabledModels = Array.isArray(settings?.enabledModels) ? settings.enabledModels.filter((id) => typeof id === "string") : [];
    return { maxTokens, ceiling, enabledModels };
}
/** Every free-text brief in a launch: single task, parallel tasks, chain steps (including parallel groups). */
export function collectBriefs(params) {
    const briefs = [];
    if (typeof params.task === "string")
        briefs.push({ label: "task", text: params.task });
    if (Array.isArray(params.tasks)) {
        params.tasks.forEach((entry, index) => { if (typeof entry?.task === "string")
            briefs.push({ label: `tasks[${index}]`, text: entry.task }); });
    }
    if (Array.isArray(params.chain)) {
        params.chain.forEach((step, index) => {
            if (typeof step?.task === "string")
                briefs.push({ label: `chain[${index}]`, text: step.task });
            if (Array.isArray(step?.parallel)) {
                step.parallel.forEach((entry, inner) => { if (typeof entry?.task === "string")
                    briefs.push({ label: `chain[${index}].parallel[${inner}]`, text: entry.task }); });
            }
        });
    }
    return briefs;
}
export function isLaunch(params) {
    if (params.action !== undefined)
        return false;
    return typeof params.agent === "string" || Array.isArray(params.tasks) || Array.isArray(params.chain) || params.workflow !== undefined;
}
export function checkBriefs(params, maxTokens) {
    for (const { label, text } of collectBriefs(params)) {
        const tokens = estimateTokens(text);
        if (tokens > maxTokens) {
            return `pi-worker: brief '${label}' is about ${tokens} tokens, over the ${maxTokens} limit (piWorker.brief.maxTokens). Cut it to goal, exact files and line ranges, only the needed snippets, constraints, acceptance check. Do not paste whole files.`;
        }
    }
    return undefined;
}
/** `provider/id[:level]`. Only a trailing known level counts as a suffix. */
export function splitModel(value) {
    const cut = value.lastIndexOf(":");
    if (cut > 0 && THINKING_LEVELS.includes(value.slice(cut + 1)))
        return { id: value.slice(0, cut), level: value.slice(cut + 1) };
    return { id: value, level: undefined };
}
export function checkModel(id, enabledModels) {
    if (enabledModels.length === 0)
        return undefined;
    if (enabledModels.includes(id))
        return undefined;
    const bareMatches = enabledModels.filter((entry) => entry.split("/").slice(1).join("/") === id);
    if (bareMatches.length === 1)
        return undefined;
    return `pi-worker: model '${id}' is not in enabledModels. Pick one of: ${enabledModels.join(", ")}.`;
}
export function allowedThinking(ceiling, failures) {
    return failures >= ESCALATE_AFTER_FAILURES && compareThinkingLevels(ESCALATED_THINKING, ceiling) > 0 ? ESCALATED_THINKING : ceiling;
}
export function clampThinking(level, allowed) {
    if (level === undefined)
        return { level, clamped: false };
    return compareThinkingLevels(level, allowed) > 0 ? { level: allowed, clamped: true } : { level, clamped: false };
}
/**
 * Returns { error } to refuse the launch, or { params, notices } with the model suffix clamped.
 * `failures` is the count already recorded for this launch's taskId.
 */
export function gateLaunch(params, settings, failures) {
    if (!isLaunch(params))
        return { params, notices: [] };
    const rules = resolveDelegateSettings(settings);
    const briefError = checkBriefs(params, rules.maxTokens);
    if (briefError)
        return { error: briefError };
    if (typeof params.model !== "string" || params.model.trim() === "")
        return { params, notices: [] };
    const { id, level } = splitModel(params.model.trim());
    const modelError = checkModel(id, rules.enabledModels);
    if (modelError)
        return { error: modelError };
    const allowed = allowedThinking(rules.ceiling, failures);
    const { level: nextLevel, clamped } = clampThinking(level, allowed);
    const notices = clamped ? [`pi-worker: thinking '${level}' clamped to '${allowed}'.`] : [];
    return { params: nextLevel ? { ...params, model: `${id}:${nextLevel}` } : params, notices };
}
