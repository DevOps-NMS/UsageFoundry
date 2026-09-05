// F2's evidence: the message that dropped the required `task` on six of ten
// proposals, and the retry that recovered by reusing one override verbatim.
//
// Reproduces the table in 02-findings.md#f2. Run after scan.mjs and analyse.mjs.
import fs from "node:fs";
import crypto from "node:crypto";

const SCRATCH = "/tmp/uf-721638d11c0b-1";
const sessions = JSON.parse(fs.readFileSync(`${SCRATCH}/sessions.json`, "utf8")).filter((x) => x.isChat);
const s = sessions.find((x) => x.file.startsWith("da349f53"));
if (!s) {
  console.log("da349f53 not in this corpus — the conversation this finding rests on is absent.");
  process.exit(0);
}
const recs = fs.readFileSync(s.path, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

console.log("=== every propose_run in da349f53, with the field it carried ===");
let i = 0;
for (const r of recs) {
  if (r.type !== "assistant") continue;
  for (const c of (r.message?.content || [])) {
    if (c.type !== "tool_use" || c.name !== "mcp__uf__propose_run") continue;
    i++;
    const task = c.input?.task || "";
    const po = c.input?.promptOverride || "";
    const hash = po ? crypto.createHash("sha1").update(po).digest("hex").slice(0, 8) : "-";
    console.log(
      `#${String(i).padStart(2)} out=${String(r.message.usage?.output_tokens).padStart(5)}` +
      ` task=${String(task.length).padStart(5)} override=${String(po.length).padStart(5)}` +
      ` overrideSHA1=${hash} ${(c.input?.title || "").slice(0, 44)}`,
    );
  }
}

console.log("\n=== corpus-wide: how the two fields co-occur ===");
const turns = JSON.parse(fs.readFileSync(`${SCRATCH}/turns.json`, "utf8"));
const props = turns.flatMap((t) => t.proposals);
const n = (f) => props.filter(f).length;
console.log(`  task + override: ${n((p) => (p.task || "").length && (p.promptOverride || "").length)}`);
console.log(`  task only:       ${n((p) => (p.task || "").length && !(p.promptOverride || "").length)}`);
console.log(`  override only:   ${n((p) => !(p.task || "").length && (p.promptOverride || "").length)}   <- every one is the message above`);
console.log(`  total:           ${props.length}`);
const lens = props.filter((p) => (p.promptOverride || "").length).map((p) => p.promptOverride.length).sort((a, b) => a - b);
console.log(`  override present on ${lens.length} proposals; chars min=${lens[0]} median=${lens[Math.floor(lens.length / 2)]} max=${lens.at(-1)}`);
