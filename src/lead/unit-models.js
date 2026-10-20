import { compareThinkingLevels } from "../shared/thinking-ceiling.js";
import { categoryForAgent } from "./categories.js";

// Resolves the model and thinking level for every child a launch starts, one unit at a time.
// Model: the unit's own, else the launch's, else its category default, else piWorker.defaultModel.
// Thinking: the lead's suffix is clamped to the ceiling. An operator-set category effort is trusted (it is config,
// capped at HARD_MAX_THINKING), so oracle can default to high while the lead itself stays capped at medium.

/** Returns a copy of `params` with `fn(unit, label)` applied to every child. A single launch is its own unit. */
export function mapUnits(params, fn) {
	const next = { ...params };
	if (typeof params.agent === "string" && !Array.isArray(params.tasks) && !Array.isArray(params.chain))
		return { ...next, ...fn(params, "task") };
	if (Array.isArray(params.tasks))
		next.tasks = params.tasks.map((unit, index) => ({ ...unit, ...fn(unit, `tasks[${index}]`) }));
	if (Array.isArray(params.chain)) {
		next.chain = params.chain.map((step, index) => {
			if (Array.isArray(step?.parallel)) {
				return { ...step, parallel: step.parallel.map((unit, inner) => ({ ...unit, ...fn(unit, `chain[${index}].parallel[${inner}]`) })) };
			}
			return typeof step?.agent === "string" ? { ...step, ...fn(step, `chain[${index}]`) } : step;
		});
	}
	return next;
}

function missingModelError(label, agent, enabledModels) {
	const choices = enabledModels.join(", ") || "(enabledModels is empty)";
	return `pi-worker: '${label}' (${agent}) has no model. Pass model, or set piWorker.defaultModel or a model on its category. Pick one of: ${choices}.`;
}

/**
 * `ctx` = { rules, categories, allowed, defaultModel, lookup(agentName) -> agent config | undefined, pinFor(agent, level) -> level | undefined,
 *           splitModel, checkModel }.
 * Returns { error } or { params, notices }.
 */
export function resolveUnitModels(params, ctx) {
	const notices = [];
	let error;
	const resolved = mapUnits(params, (unit, label) => {
		if (error)
			return {};
		const agentName = unit.agent.trim();
		const category = categoryForAgent(ctx.categories, agentName);
		const raw = [unit.model, params.model, category?.model, ctx.defaultModel].find((value) => typeof value === "string" && value.trim());
		if (!raw) {
			error = missingModelError(label, agentName, ctx.rules.enabledModels);
			return {};
		}
		const { id, level } = ctx.splitModel(raw.trim());
		const modelError = ctx.checkModel(id, ctx.rules.enabledModels);
		if (modelError) {
			error = `${label}: ${modelError}`;
			return {};
		}
		const fromCategory = level === undefined && category?.effort !== undefined;
		const wanted = level ?? category?.effort;
		let finalLevel = wanted;
		if (wanted !== undefined && !fromCategory && compareThinkingLevels(wanted, ctx.allowed) > 0) {
			finalLevel = ctx.allowed;
			notices.push(`pi-worker: ${label} thinking '${wanted}' clamped to '${ctx.allowed}'.`);
		}
		if (finalLevel === undefined) {
			const pin = ctx.pinFor(ctx.lookup(agentName), undefined);
			if (pin) {
				finalLevel = pin;
				notices.push(`pi-worker: ${label} agent or session default exceeds '${ctx.allowed}'; pinned to '${pin}'.`);
			}
		}
		return { model: finalLevel ? `${id}:${finalLevel}` : id };
	});
	if (error)
		return { error };
	if (!(typeof params.agent === "string" && !Array.isArray(params.tasks) && !Array.isArray(params.chain)))
		delete resolved.model;
	return { params: resolved, notices };
}
