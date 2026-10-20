import { compareThinkingLevels } from "../shared/thinking-ceiling.js";
import { THINKING_LEVELS } from "../shared/model-info.js";

// One table drives both the lead prompt and the launch gate: which worker does a category, and which model and effort it
// gets by default. Operator-set `effort` is trusted up to HARD_MAX_THINKING; the lead can never raise it.
const SETTINGS_KEY = "piWorker";
// xhigh and max are never reachable through delegation. Only the user applies them by hand, outside pi-worker.
export const HARD_MAX_THINKING = "high";

export const DEFAULT_CATEGORIES = Object.freeze([
	{ key: "recon", title: "Recon", agent: "scout", effort: "low", hint: "Find files, entry points, data flow. Read-only, cheap model." },
	{ key: "build", title: "Build", agent: "worker", effort: "medium", hint: "Edit code, add tests, run them. The only slice that writes." },
	{ key: "review", title: "Review", agent: "reviewer", effort: "medium", hint: "Check a finished diff for bugs and scope creep. Read-only." },
	{ key: "decide", title: "Decide", agent: "oracle", effort: "high", hint: "Check a plan against the code before any build slice. Read-only." },
	{ key: "research", title: "Research", agent: "researcher", effort: "low", hint: "Web lookups and docs. Never touches the repo." },
	{ key: "audit", title: "Audit", agent: "evidence-auditor", effort: "medium", hint: "Verify that research claims match their sources." },
	{ key: "misc", title: "Small jobs", agent: "delegate", effort: "low", hint: "Docs, config and renames only. Source or test logic goes to Build." },
]);

export function validEffort(value) {
	if (typeof value !== "string" || !THINKING_LEVELS.includes(value))
		return undefined;
	return compareThinkingLevels(value, HARD_MAX_THINKING) > 0 ? HARD_MAX_THINKING : value;
}

function cleanCategory(entry, index) {
	const model = typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : undefined;
	// An entry that omits effort keeps the built-in effort for that agent, so overriding only the model does not lose it.
	const inherited = DEFAULT_CATEGORIES.find((category) => category.agent === entry.agent.trim())?.effort;
	const effort = validEffort(entry.effort) ?? inherited;
	return {
		key: typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : `category${index}`,
		title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : entry.agent.trim(),
		agent: entry.agent.trim(),
		hint: typeof entry.hint === "string" ? entry.hint.trim() : "",
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
	};
}

export function resolveCategories(settings) {
	const value = settings?.[SETTINGS_KEY]?.categories;
	if (!Array.isArray(value))
		return DEFAULT_CATEGORIES;
	const cleaned = value
		.filter((entry) => entry && typeof entry === "object" && entry.enabled !== false && typeof entry.agent === "string" && entry.agent.trim())
		.map(cleanCategory);
	return cleaned.length > 0 ? cleaned : DEFAULT_CATEGORIES;
}

/** First category that names this agent, or undefined. */
export function categoryForAgent(categories, agentName) {
	return categories.find((category) => category.agent === agentName);
}
