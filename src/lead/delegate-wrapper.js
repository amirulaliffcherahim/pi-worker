import { gateLaunch, isLaunch } from "./delegate-gate.js";
import { FailureLedger, launchFailed } from "./failure-ledger.js";
import { renderWorkerRules, resolveBriefTemplate } from "./lead-prompt.js";

// Report ceiling per worker. Upstream defaults to 200 KB, which could put ~50k tokens into lead context.
export const DEFAULT_REPORT_MAX = Object.freeze({ bytes: 8 * 1024, lines: 200 });
const RULES_SEPARATOR = "\n\n---\n";

/** Adds the worker contract after the brief cap was checked, so the rules never count against the brief. */
export function withWorkerRules(launch, settings) {
	const rules = renderWorkerRules(resolveBriefTemplate(settings));
	const addRules = (entry) => (entry && typeof entry.task === "string" ? { ...entry, task: entry.task + RULES_SEPARATOR + rules } : entry);
	const next = { ...launch };
	if (typeof next.task === "string")
		next.task = addRules(next).task;
	if (Array.isArray(next.tasks))
		next.tasks = next.tasks.map(addRules);
	if (Array.isArray(next.chain))
		next.chain = next.chain.map((step) => (Array.isArray(step?.parallel) ? { ...step, parallel: step.parallel.map(addRules) } : addRules(step)));
	return next;
}

export function resolveReportMax(settings, launch) {
	if (launch.maxOutput)
		return launch.maxOutput;
	const configured = settings?.piWorker?.report;
	const bytes = Number.isInteger(configured?.maxBytes) && configured.maxBytes > 0 ? configured.maxBytes : DEFAULT_REPORT_MAX.bytes;
	const lines = Number.isInteger(configured?.maxLines) && configured.maxLines > 0 ? configured.maxLines : DEFAULT_REPORT_MAX.lines;
	return { bytes, lines };
}

// taskId and retry are lead-facing fields; they are stripped before the launch reaches the runner.
export function stripLeadFields(params) {
	const { taskId, retry, ...rest } = params;
	return { launch: rest, taskId: typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined, retry: retry === true };
}

// Wraps the delegate_task executor with brief, model and thinking gates, the worker contract, the report cap
// and the failure ledger.
export function createDelegateWrapper(getSettings, ledger = new FailureLedger()) {
	return async function guarded(params, run) {
		const { launch, taskId, retry } = stripLeadFields(params);
		if (!isLaunch(launch))
			return run(launch);
		if (retry && taskId)
			ledger.record(taskId);
		const settings = getSettings();
		const gated = gateLaunch(launch, settings, ledger.count(taskId));
		if (gated.error)
			throw new Error(gated.error);
		let result;
		let threw = false;
		try {
			const launched = withWorkerRules(gated.params, settings);
			result = await run({ ...launched, maxOutput: resolveReportMax(settings, launched) });
		}
		catch (error) {
			threw = true;
			throw error;
		}
		finally {
			if (taskId && launchFailed({ result, threw }))
				ledger.record(taskId);
		}
		if (gated.notices.length > 0 && result?.content) {
			return { ...result, content: [...result.content, { type: "text", text: gated.notices.join(" ") }] };
		}
		return result;
	};
}
export { FailureLedger };
