import { gateLaunch, isLaunch } from "./delegate-gate.js";
import { FailureLedger, launchFailed } from "./failure-ledger.js";
// Wraps the delegate_task executor with brief, model and thinking gates plus the failure ledger.
// taskId and retry are lead-facing fields; they are stripped before the launch reaches the runner.
export function stripLeadFields(params) {
    const { taskId, retry, ...rest } = params;
    return { launch: rest, taskId: typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined, retry: retry === true };
}
export function createDelegateWrapper(getSettings, ledger = new FailureLedger()) {
    return async function guarded(params, run) {
        const { launch, taskId, retry } = stripLeadFields(params);
        if (!isLaunch(launch))
            return run(launch);
        if (retry && taskId)
            ledger.record(taskId);
        const gated = gateLaunch(launch, getSettings(), ledger.count(taskId));
        if (gated.error)
            throw new Error(gated.error);
        let result;
        let threw = false;
        try {
            result = await run(gated.params);
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
