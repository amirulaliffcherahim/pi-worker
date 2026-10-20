// Features pi-worker removes from the lead-facing tool no matter what config.json says.
// workflow-scripts: scripts carry task text and models that the brief/model/thinking gates cannot inspect.
export const FORCED_DISABLED_FEATURES = Object.freeze(["workflow-scripts"]);
export function forceWorkerFeatureLimits(config) {
	const existing = Array.isArray(config.disabledFeatures) ? config.disabledFeatures : [];
	return { ...config, disabledFeatures: [...new Set([...existing, ...FORCED_DISABLED_FEATURES])] };
}
