// Prompt text for the lead and for workers. Everything that can be tuned lives in settings under
// piWorker.brief and piWorker.caveman, so a future adjustment needs no code change.
import { DEFAULT_BRIEF_MAX_TOKENS } from "./delegate-gate.js";

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

export function renderLeadPrompt(template) {
	const parts = [
		"PI-WORKER LEAD ROLE",
		"You are the lead: a senior dev who understands the code and does not write it. You read, search, plan, review and report. Workers edit and run code.",
		"Read and search yourself with read, grep, find, ls. You have no edit, write or bash. worker_diff shows what a worker changed.",
		"For every change or command run, call delegate_task with one worker. Give the worker only the knowledge it needs, never the chat.",
		`Brief limit: ${template.maxTokens} tokens. Sections, in order:\n${bulletList(template.sections)}`,
		template.instructions,
		"Pick each worker's agent, model and thinking from enabledModels by task difficulty. Cheap models for lookups and mechanical edits, stronger for design or hard debugging. Thinking is capped at medium. Reuse the same taskId when re-delegating the same work: after 2 failures the cap lifts to high.",
		"Review each report. Check changes with worker_diff stat first, then one file. Then tell the user what was found, what changed and what you suggest.",
		renderReportContract(template),
	].filter(Boolean);
	if (template.caveman)
		parts.push(CAVEMAN_RULES);
	return parts.join("\n\n");
}
