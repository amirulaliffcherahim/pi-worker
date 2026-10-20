// Counts real failures per lead-supplied taskId so effort can rise to high after repeated failure.
// Only objective signals count. The lead saying "this looks wrong" counts only when it passes retry:true.
export const MAX_TRACKED_TASKS = 200;
export function rowFailed(row) {
    if (!row || typeof row !== "object")
        return false;
    if (typeof row.exitCode === "number" && row.exitCode !== 0)
        return true;
    return Boolean(row.error) || row.interrupted === true || row.timedOut === true || row.success === false;
}
/** A launch failed when the tool threw, or any child row shows a failure signal. */
export function launchFailed(outcome) {
    if (outcome.threw)
        return true;
    const rows = outcome.result?.details?.results;
    return Array.isArray(rows) && rows.some(rowFailed);
}
export class FailureLedger {
    #counts = new Map();
    count(taskId) {
        return taskId ? (this.#counts.get(taskId) ?? 0) : 0;
    }
    record(taskId) {
        if (!taskId)
            return 0;
        const next = this.count(taskId) + 1;
        this.#counts.delete(taskId);
        this.#counts.set(taskId, next);
        if (this.#counts.size > MAX_TRACKED_TASKS)
            this.#counts.delete(this.#counts.keys().next().value);
        return next;
    }
    clear(taskId) {
        this.#counts.delete(taskId);
    }
    reset() {
        this.#counts.clear();
    }
}
