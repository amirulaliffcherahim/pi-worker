import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { createSubagentParamsSchema } from "../src/extension/schemas.js";
import { resolveDisabledFeatureSurface } from "../src/shared/disabled-features.js";
import { forceWorkerFeatureLimits } from "../src/lead/feature-limits.js";

// The model sees exactly this schema, and Pi validates calls against it before any gate runs.
// A field the gate understands but the schema rejects cannot be used, so check both agree.
const schema = createSubagentParamsSchema(resolveDisabledFeatureSurface(forceWorkerFeatureLimits({})));
const accepts = (params) => Value.Check(schema, params);

test("schema accepts per-task writes and model in tasks[]", () => {
	assert.equal(accepts({ tasks: [{ agent: "worker", task: "t", writes: ["a.js"], model: "x/y" }, { agent: "worker", task: "t", writes: ["b.js"] }] }), true);
});

test("schema accepts writes and model in chain steps and chain parallel groups", () => {
	assert.equal(accepts({ chain: [{ agent: "scout", task: "t" }, { agent: "worker", task: "t", writes: ["a.js"], model: "x/y" }] }), true);
	assert.equal(accepts({ chain: [{ parallel: [{ agent: "worker", task: "t", writes: ["a.js"] }, { agent: "worker", task: "t", writes: ["b.js"], model: "x/y" }] }] }), true);
});

test("schema accepts a single launch with writes and taskId", () => {
	assert.equal(accepts({ agent: "worker", task: "t", writes: ["a.js"], taskId: "T1", model: "x/y" }), true);
});

test("schema still rejects fields the gate does not know, and a non-array writes", () => {
	assert.equal(accepts({ tasks: [{ agent: "worker", task: "t", bogus: 1 }] }), false);
	assert.equal(accepts({ tasks: [{ agent: "worker", task: "t", writes: "a.js" }] }), false);
});

test("schema has no retry field and no workflow field", () => {
	assert.equal("retry" in schema.properties, false);
	assert.equal("workflow" in schema.properties, false);
});
