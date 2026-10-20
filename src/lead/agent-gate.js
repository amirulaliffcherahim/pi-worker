import { compareThinkingLevels } from "../shared/thinking-ceiling.js";
import { THINKING_LEVELS } from "../shared/model-info.js";

// Checks run against the agent a launch will really use, not only against what the lead typed.
// An agent file can be written by a worker (workers have write), so the lead's own role gate is not enough.

/** Every child a launch starts: single task, parallel tasks, chain steps and chain parallel groups. */
export function collectUnits(params) {
	const units = [];
	if (typeof params.agent === "string")
		units.push({ label: "task", unit: params });
	if (Array.isArray(params.tasks))
		params.tasks.forEach((entry, index) => units.push({ label: `tasks[${index}]`, unit: entry }));
	if (Array.isArray(params.chain)) {
		params.chain.forEach((step, index) => {
			if (typeof step?.agent === "string")
				units.push({ label: `chain[${index}]`, unit: step });
			if (Array.isArray(step?.parallel))
				step.parallel.forEach((entry, inner) => units.push({ label: `chain[${index}].parallel[${inner}]`, unit: entry }));
		});
	}
	return units;
}

/** Model and thinking are set once at the top level. A per-child value would dodge the allowlist and the clamp. */
export function checkUnitOverrides(params) {
	for (const { label, unit } of collectUnits(params)) {
		if (unit === params)
			continue;
		for (const key of ["model", "thinking"]) {
			if (unit?.[key] !== undefined)
				return `pi-worker: '${label}' sets its own ${key}. Set model once at the top level of the launch.`;
		}
	}
	return undefined;
}

function toolsOf(agent) {
	return Array.isArray(agent.tools) ? agent.tools : undefined;
}

/** Refusal text for one agent, or undefined when it is safe to run as a worker. */
export function checkAgentConfig(agent, allowedTools) {
	if (agent.runner !== undefined)
		return `agent '${agent.name}' uses an external runner. Workers run natively so brief, model and thinking limits apply.`;
	if (agent.allowNestedSubagents === true)
		return `agent '${agent.name}' may delegate further. Workers never fan out.`;
	const tools = toolsOf(agent);
	if (!tools || tools.length === 0)
		return `agent '${agent.name}' declares no tools list. Add tools: with names from ${allowedTools.join(", ")}.`;
	const forbidden = tools.filter((tool) => !allowedTools.includes(tool));
	if (forbidden.length > 0)
		return `agent '${agent.name}' has tools outside piWorker.allowedTools: ${forbidden.join(", ")}.`;
	return undefined;
}

export function agentThinking(agent) {
	return typeof agent?.thinking === "string" && THINKING_LEVELS.includes(agent.thinking) ? agent.thinking : undefined;
}

/**
 * `agents` is the discovered list, `resolve(name, agents)` returns { agent } or {}.
 * Returns { error } or { configs } (one entry per unit that resolved to a real agent).
 * Unknown names are left to the runner, which replies with the valid choices.
 */
export function resolveUnitAgents(params, agents, resolve, allowedTools) {
	const configs = [];
	for (const { label, unit } of collectUnits(params)) {
		const found = resolve(unit.agent.trim(), agents);
		if (!found.agent)
			continue;
		const problem = checkAgentConfig(found.agent, allowedTools);
		if (problem)
			return { error: `pi-worker: ${label}: ${problem}` };
		configs.push(found.agent);
	}
	return { configs };
}

/**
 * Effective level of a child: the model suffix wins, then the agent file, then the session default.
 * Returns the level the launch must be pinned to, or undefined when no pin is needed.
 */
export function pinNeeded({ suffixLevel, configs, sessionDefault, allowed }) {
	if (suffixLevel !== undefined)
		return undefined;
	const exceeds = (level) => level !== undefined && compareThinkingLevels(level, allowed) > 0;
	const sessionLevel = THINKING_LEVELS.includes(sessionDefault) ? sessionDefault : undefined;
	const effective = configs.length > 0 ? configs.map((agent) => agentThinking(agent) ?? sessionLevel) : [sessionLevel];
	return effective.some(exceeds) ? allowed : undefined;
}
