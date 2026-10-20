import { compareThinkingLevels } from "../shared/thinking-ceiling.js";
import { THINKING_LEVELS } from "../shared/model-info.js";
import { checkUnitOverrides, pinNeeded, resolveUnitAgents } from "./agent-gate.js";

// Hard rules for every delegate_task launch. Code decides, the lead's judgement only picks inside the limits.
// Order of checks: role, workflow ban, brief size, model required and allowlisted, thinking clamp.
// Management actions (status, stop...) are not launches.
// thinkingCeiling is deliberately not maxThinking: the inherited maxThinking hard-fails launches above it,
// which would block the escalation to high that this gate grants after repeated failures.
const SETTINGS_KEY = "piWorker";
export const DEFAULT_BRIEF_MAX_TOKENS = 3000;
export const DEFAULT_THINKING_CEILING = "medium";
export const ESCALATED_THINKING = "high";
export const ESCALATE_AFTER_FAILURES = 2;
// xhigh and max are never reachable through delegation. Only the user applies them by hand, outside pi-worker.
export const HARD_MAX_THINKING = "high";
export const DEFAULT_ALLOWED_TOOLS = Object.freeze(["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"]);
const ROLE_ACTIONS = new Set(["create", "update"]);

export function estimateTokens(text) {
	// chars/4 over-counts code slightly, which errs toward a smaller brief.
	return Math.ceil(text.length / 4);
}

export function resolveDelegateSettings(settings) {
	const root = settings?.[SETTINGS_KEY];
	const brief = root?.brief;
	const maxTokens = Number.isInteger(brief?.maxTokens) && brief.maxTokens > 0 ? brief.maxTokens : DEFAULT_BRIEF_MAX_TOKENS;
	const ceilingRaw = root?.thinkingCeiling;
	const requested = THINKING_LEVELS.includes(ceilingRaw) ? ceilingRaw : DEFAULT_THINKING_CEILING;
	const ceiling = compareThinkingLevels(requested, HARD_MAX_THINKING) > 0 ? HARD_MAX_THINKING : requested;
	const enabledModels = Array.isArray(settings?.enabledModels) ? settings.enabledModels.filter((id) => typeof id === "string") : [];
	const allowedTools = Array.isArray(root?.allowedTools) ? root.allowedTools.map(String) : DEFAULT_ALLOWED_TOOLS;
	return { maxTokens, ceiling, enabledModels, allowedTools };
}

/** Every free-text brief in a launch: single task, parallel tasks, chain steps (including parallel groups). */
export function collectBriefs(params) {
	const briefs = [];
	if (typeof params.task === "string")
		briefs.push({ label: "task", text: params.task });
	if (Array.isArray(params.tasks)) {
		params.tasks.forEach((entry, index) => {
			if (typeof entry?.task === "string")
				briefs.push({ label: `tasks[${index}]`, text: entry.task });
		});
	}
	if (Array.isArray(params.chain)) {
		params.chain.forEach((step, index) => {
			if (typeof step?.task === "string")
				briefs.push({ label: `chain[${index}]`, text: step.task });
			if (Array.isArray(step?.parallel)) {
				step.parallel.forEach((entry, inner) => {
					if (typeof entry?.task === "string")
						briefs.push({ label: `chain[${index}].parallel[${inner}]`, text: entry.task });
				});
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

function parseRoleConfig(value) {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		}
		catch {
			return undefined;
		}
	}
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function toolList(value) {
	if (Array.isArray(value))
		return value.map(String);
	return typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

/**
 * Roles the lead writes for itself. Tools stay inside piWorker.allowedTools (which also keeps delegate_task out,
 * so workers cannot fan out), and model and thinking obey the same limits as a launch.
 * Returns an error string, or undefined when the role is fine or the action is not a role write.
 */
export function checkRole(params, settings) {
	if (!ROLE_ACTIONS.has(params.action))
		return undefined;
	const cfg = parseRoleConfig(params.config);
	if (!cfg)
		return undefined;
	const rules = resolveDelegateSettings(settings);
	const forbidden = toolList(cfg.tools).filter((tool) => !rules.allowedTools.includes(tool));
	if (forbidden.length > 0) {
		return `pi-worker: role tools not allowed: ${forbidden.join(", ")}. Allowed: ${rules.allowedTools.join(", ")}. Roles cannot delegate further.`;
	}
	if (typeof cfg.thinking === "string" && THINKING_LEVELS.includes(cfg.thinking) && compareThinkingLevels(cfg.thinking, rules.ceiling) > 0) {
		return `pi-worker: role thinking '${cfg.thinking}' is above the ${rules.ceiling} ceiling. Set it at or below ${rules.ceiling}; the ceiling lifts per task after 2 failures.`;
	}
	if (typeof cfg.model === "string" && cfg.model.trim()) {
		const { id, level } = splitModel(cfg.model.trim());
		const modelError = checkModel(id, rules.enabledModels);
		if (modelError)
			return modelError;
		if (level && compareThinkingLevels(level, rules.ceiling) > 0)
			return `pi-worker: role model level '${level}' is above the ${rules.ceiling} ceiling.`;
	}
	return undefined;
}

/**
 * Returns { error } to refuse the call, or { params, notices } with the model suffix clamped.
 * `failures` is the count already recorded for this launch's taskId.
 * `env` supplies what only the runtime knows: `agents` (discovered list), `resolveAgent(name, agents)`
 * and `sessionThinking` (the level a child gets when neither the model nor its agent file sets one).
 */
export function gateLaunch(params, settings, failures, env = {}) {
	const roleError = checkRole(params, settings);
	if (roleError)
		return { error: roleError };
	if (!isLaunch(params))
		return { params, notices: [] };
	// Script bodies hold their own task text and models, so no gate below could see them.
	if (params.workflow !== undefined) {
		return { error: "pi-worker: workflow scripts are disabled. Use agent+task, tasks:[...] for parallel, or chain:[...] for ordered steps, so every brief is size-checked." };
	}
	const rules = resolveDelegateSettings(settings);
	const briefError = checkBriefs(params, rules.maxTokens);
	if (briefError)
		return { error: briefError };
	// A missing model would let the agent file pick model and thinking, skipping the clamp. Always name one.
	if (typeof params.model !== "string" || params.model.trim() === "") {
		const choices = rules.enabledModels.join(", ") || "(enabledModels is empty)";
		return { error: `pi-worker: every launch needs a model. Pick one of: ${choices}, optionally with :off, :minimal, :low or :medium.` };
	}
	const { id, level } = splitModel(params.model.trim());
	const modelError = checkModel(id, rules.enabledModels);
	if (modelError)
		return { error: modelError };
	const overrideError = checkUnitOverrides(params);
	if (overrideError)
		return { error: overrideError };
	let configs = [];
	if (env.agents && env.resolveAgent) {
		const resolved = resolveUnitAgents(params, env.agents, env.resolveAgent, rules.allowedTools);
		if (resolved.error)
			return { error: resolved.error };
		configs = resolved.configs;
	}
	const allowed = allowedThinking(rules.ceiling, failures);
	const { level: nextLevel, clamped } = clampThinking(level, allowed);
	// With no suffix the agent file (or the session) decides the level, so pin the ceiling when either exceeds it.
	const pin = pinNeeded({ suffixLevel: level, configs, sessionDefault: env.sessionThinking, allowed });
	const finalLevel = nextLevel ?? pin;
	const notices = [];
	if (clamped)
		notices.push(`pi-worker: thinking '${level}' clamped to '${allowed}'.`);
	if (pin)
		notices.push(`pi-worker: agent or session default exceeds '${allowed}'; pinned to '${pin}'.`);
	// A worker gets the brief only. Fork and profile contexts would copy the lead chat into it.
	// async:false so the launch returns a real result; async runs return at launch, before any failure is visible.
	const fresh = { ...params, context: "fresh", async: false };
	return { params: finalLevel ? { ...fresh, model: `${id}:${finalLevel}` } : fresh, notices, allowedThinking: allowed };
}
