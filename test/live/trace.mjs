// Summarises one live pi-worker run from its session directory. Prints metadata only, never prompts or outputs.
// Usage: node test/live/trace.mjs <session-dir>
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node test/live/trace.mjs <session-dir>");

const leadFile = fs.readdirSync(dir).find((name) => name.endsWith(".jsonl"));
const lines = fs.readFileSync(path.join(dir, leadFile), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const calls = [];
const toolNames = new Map();
let failed = 0;
for (const entry of lines) {
	const message = entry.message ?? entry;
	if (message.role === "assistant" && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			toolNames.set(block.name, (toolNames.get(block.name) ?? 0) + 1);
			if (block.name !== "delegate_task") continue;
			const a = block.arguments ?? {};
			const shape = a.chain ? "chain" : a.tasks ? "tasks" : a.agent ? "single" : (a.action ?? "other");
			const units = a.tasks ?? a.chain ?? [a];
			const flat = units.flatMap((u) => u.parallel ?? [u]);
			calls.push({
				id: block.id,
				shape,
				agents: flat.map((u) => u.agent).join(","),
				writes: flat.map((u) => (u.writes ? u.writes.join("+") : "-")).join(" | "),
				model: a.model ?? (flat.map((u) => u.model).filter(Boolean).join(",") || "-"),
			});
		}
	}
	if (message.role === "toolResult" && message.isError) {
		failed++;
		const text = (message.content?.[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 150);
		const match = calls.find((call) => call.id === message.toolCallId);
		if (match) match.error = text;
		else calls.push({ shape: message.toolName, error: text });
	}
}

console.log(`failed tool calls: ${failed}`);
console.log(`tool use: ${[...toolNames].map(([n, c]) => `${n}x${c}`).join(" ")}`);
for (const call of calls) {
	console.log(`- ${call.shape.padEnd(7)} agents=${(call.agents ?? "-").padEnd(28)} writes=${call.writes ?? "-"}${call.error ? `\n    ERR ${call.error}` : ""}`);
}

const artifacts = path.join(dir, "subagent-artifacts");
let cost = 0;
if (fs.existsSync(artifacts)) {
	for (const name of fs.readdirSync(artifacts).filter((n) => n.endsWith("_meta.json"))) {
		const meta = JSON.parse(fs.readFileSync(path.join(artifacts, name), "utf8"));
		cost += meta.usage?.cost ?? 0;
		console.log(`  worker ${String(meta.agent).padEnd(10)} ${String(meta.model).padEnd(34)} exit=${meta.exitCode} $${(meta.usage?.cost ?? 0).toFixed(4)}`);
	}
}
console.log(`worker cost: $${cost.toFixed(4)}`);
