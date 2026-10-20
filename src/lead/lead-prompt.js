// Prompt text for the lead and for workers. Everything that can be tuned lives in settings under
// piWorker.brief and piWorker.caveman, so a future adjustment needs no code change.
import { DEFAULT_BRIEF_MAX_TOKENS, DEFAULT_MAX_PARALLEL } from "./delegate-gate.js";

const SETTINGS_KEY = "piWorker";

export const DEFAULT_BRIEF_SECTIONS = Object.freeze([
	{ key: "goal", title: "Goal", hint: "One sentence: the outcome wanted." },
	{ key: "files", title: "Files", hint: "Exact paths with line ranges to touch or read. No whole-file dumps." },
	{ key: "snippets", title: "Snippets", hint: "Only code the worker cannot find in the listed ranges. Keep it short." },
	{ key: "constraints", title: "Constraints", hint: "Hard rules: style, no new dependencies, what must not change." },
	{ key: "acceptance", title: "Acceptance", hint: "The exact command or check that proves it is done." },
]);

export const DEFAULT_REPORT_FIELDS = Object.freeze([
	{ key: "status", title: "Status", hint: "success, partial or failed." },
	{ key: "changes", title: "Changes", hint: "file:line and one line each. No diffs." },
	{ key: "validation", title: "Validation", hint: "Command run and its result, quoted shortest decisive line." },
	{ key: "blockers", title: "Blockers", hint: "What stopped you, or none." },
	{ key: "suggestions", title: "Suggestions", hint: "Risks and follow-ups, max three." },
]);

export const CAVEMAN_RULES = [
	"Talk terse. Answer first. Drop greetings, hedging, recaps and closers. Short words, fragments allowed.",
	"Never drop not, never, no, only, except. Numbers, units and names stay exact.",
	"Code, diffs, commands, file paths, types and error traces stay 100% verbatim. Caveman applies to prose only.",
	"Anything written into a file, commit or doc is plain prose, not caveman.",
].join(" ");

function validSections(value, fallback) {
	if (!Array.isArray(value))
		return fallback;
	const cleaned = value
		.filter((entry) => entry && typeof entry === "object" && entry.enabled !== false && typeof entry.title === "string" && entry.title.trim())
		.map((entry, index) => ({
			key: typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : `section${index}`,
			title: entry.title.trim(),
			hint: typeof entry.hint === "string" ? entry.hint.trim() : "",
		}));
	return cleaned.length > 0 ? cleaned : fallback;
}

export function resolveBriefTemplate(settings) {
	const root = settings?.[SETTINGS_KEY] ?? {};
	const brief = root.brief ?? {};
	const maxTokens = Number.isInteger(brief.maxTokens) && brief.maxTokens > 0 ? brief.maxTokens : DEFAULT_BRIEF_MAX_TOKENS;
	return {
		maxTokens,
		sections: validSections(brief.sections, DEFAULT_BRIEF_SECTIONS),
		reportFields: validSections(brief.reportFormat, DEFAULT_REPORT_FIELDS),
		instructions: typeof brief.instructions === "string" ? brief.instructions.trim() : "",
		caveman: root.caveman !== false,
	};
}

function bulletList(items) {
	return items.map((item) => (item.hint ? `- ${item.title}: ${item.hint}` : `- ${item.title}`)).join("\n");
}

export function renderReportContract(template) {
	return `Report back using exactly these headings, nothing else:\n${bulletList(template.reportFields)}`;
}

/** Appended to every worker's task by the launch wrapper, so a worker always knows its output contract. */
export function renderWorkerRules(template) {
	const parts = [
		"You are a worker. The brief below is all the context you get. Do not ask for more history; read only the files it names.",
		renderReportContract(template),
	];
	if (template.caveman)
		parts.push(CAVEMAN_RULES);
	return parts.join("\n\n");
}

export { DEFAULT_MAX_PARALLEL };
export const DEFAULT_CATEGORIES = Object.freeze([
	{ key: "recon", title: "Recon", agent: "scout", hint: "Find files, entry points, data flow. Read-only, cheap model." },
	{ key: "build", title: "Build", agent: "worker", hint: "Edit code, add tests, run them. The only slice that writes." },
	{ key: "review", title: "Review", agent: "reviewer", hint: "Check a finished diff for bugs and scope creep. Read-only." },
	{ key: "decide", title: "Decide", agent: "oracle", hint: "Check a plan against the code before any build slice. Read-only." },
	{ key: "research", title: "Research", agent: "researcher", hint: "Web lookups and docs. Never touches the repo." },
	{ key: "audit", title: "Audit", agent: "evidence-auditor", hint: "Verify that research claims match their sources." },
	{ key: "misc", title: "Small jobs", agent: "delegate", hint: "One-off chores that fit no other category." },
]);


function validCategories(value) {
	if (!Array.isArray(value))
		return DEFAULT_CATEGORIES;
	const cleaned = value
		.filter((entry) => entry && typeof entry === "object" && entry.enabled !== false && typeof entry.agent === "string" && entry.agent.trim())
		.map((entry, index) => ({
			key: typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : `category${index}`,
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : entry.agent.trim(),
			agent: entry.agent.trim(),
			hint: typeof entry.hint === "string" ? entry.hint.trim() : "",
		}));
	return cleaned.length > 0 ? cleaned : DEFAULT_CATEGORIES;
}

export function resolveSlicing(settings) {
	const root = settings?.[SETTINGS_KEY] ?? {};
	const parallel = root.maxParallel;
	return {
		categories: validCategories(root.categories),
		maxParallel: Number.isInteger(parallel) && parallel > 0 ? parallel : DEFAULT_MAX_PARALLEL,
	};
}

const ROSTER_DESCRIPTION_CHARS = 90;

/** One line per agent the gate would accept, so the lead is never offered a worker it cannot launch. */
export function renderRoster(roster) {
	if (!Array.isArray(roster) || roster.length === 0)
		return "";
	const lines = roster.map((agent) => {
		const writes = (agent.tools ?? []).some((tool) => tool === "edit" || tool === "write");
		const description = String(agent.description ?? "").replace(/\s+/g, " ").trim().slice(0, ROSTER_DESCRIPTION_CHARS);
		return `- ${agent.name} [${writes ? "writes" : "read-only"}]: ${description}`;
	});
	return `Workers available now:\n${lines.join("\n")}`;
}

export function renderSlicingRules(slicing, roster) {
	const available = new Set((roster ?? []).map((agent) => agent.name));
	const usable = roster && roster.length > 0 ? slicing.categories.filter((category) => available.has(category.agent)) : slicing.categories;
	const table = usable.map((category) => `- ${category.title} -> ${category.agent}: ${category.hint}`).join("\n");
	return [
		"When the user gives a goal, slice it before delegating:",
		"1. Read enough to split the goal into slices. One slice has one category, one worker and its own brief.",
		`Categories:\n${table}`,
		`2. Independent slices go in one delegate_task call with tasks:[...], at most ${slicing.maxParallel}. Slices that need an earlier result go in chain:[...]. Give each slice its own taskId.`,
		"3. Only one Build slice may touch a file at a time. Two Build slices run in parallel only if their file lists do not overlap. Otherwise chain them.",
		"4. Typical order: Recon, then Decide when the plan is risky, then Build, then Review. Skip steps a small goal does not need. A one-line fix is one Build slice, not five.",
		"5. Each slice's brief carries only what that slice needs. Do not copy the whole goal into every brief.",
		"6. When all slices report, merge the results and tell the user what was found, what changed and what you suggest.",
	].join("\n");
}

export function renderLeadPrompt(template, options = {}) {
	const roster = options.roster;
	const slicing = options.slicing ?? resolveSlicing({});
	const parts = [
		"PI-WORKER LEAD ROLE",
		"You are the lead: a senior dev who understands the code and does not write it. You read, search, plan, review and report. Workers edit and run code.",
		"Read and search yourself with read, grep, find, ls. You have no edit, write or bash. worker_diff shows what a worker changed.",
		"For every change or command run, call delegate_task. Give each worker only the knowledge it needs, never the chat.",
		renderRoster(roster),
		renderSlicingRules(slicing, roster),
		`Brief limit: ${template.maxTokens} tokens. Sections, in order:\n${bulletList(template.sections)}`,
		template.instructions,
		"Pick each worker's model from enabledModels by difficulty, and always pass a model. Cheap models for lookups and mechanical edits, stronger for design or hard debugging. Thinking is capped at medium. Reuse a slice's taskId when re-delegating it: after 2 real failures the cap lifts to high. xhigh and max are not available to you.",
		"Review each report. Check changes with worker_diff stat first, then one file. Then tell the user what was found, what changed and what you suggest.",
		renderReportContract(template),
	].filter(Boolean);
	if (template.caveman)
		parts.push(CAVEMAN_RULES);
	return parts.join("\n\n");
}
