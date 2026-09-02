import fs from "node:fs";
const sessions = JSON.parse(fs.readFileSync("/tmp/uf-721638d11c0b-1/sessions.json","utf8")).filter(s=>s.isChat);
const seen=new Map(); for(const s of sessions){const k=`${s.firstTs}|${s.records}|${s.calls.join(",")}`; if(!seen.has(k))seen.set(k,s);}
const uniq=[...seen.values()].sort((a,b)=>(a.firstTs||"").localeCompare(b.firstTs||""));
const load=(p)=>fs.readFileSync(p,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);

console.log("=== is ToolSearch deferral recent? conversations with/without, by date ===");
const rows=[];
for (const s of uniq) {
  const recs=load(s.path);
  let ts=0;
  for (const r of recs) if(r.type==="assistant") for(const c of (r.message?.content||[])) if(c.type==="tool_use"&&c.name==="ToolSearch") ts++;
  rows.push({d:(s.firstTs||"").slice(0,10), ts});
}
const byDay={};
for (const r of rows){ byDay[r.d] ||= {n:0, withTS:0}; byDay[r.d].n++; if(r.ts) byDay[r.d].withTS++; }
for (const [d,v] of Object.entries(byDay)) console.log(`  ${d}  conversations=${String(v.n).padStart(2)}  using ToolSearch=${v.withTS}`);
console.log(`  earliest conversation ${uniq[0].firstTs}; latest ${uniq.at(-1).firstTs}`);

console.log("\n=== the six task-less calls: did they carry a promptOverride, and how long? ===");
const s = uniq.find(x=>x.file.startsWith("da349f53"));
for (const r of load(s.path)) {
  if(r.type!=="assistant") continue;
  for (const c of (r.message?.content||[])) {
    if(c.type!=="tool_use"||c.name!=="mcp__uf__propose_run") continue;
    if((c.input?.task||"").length) continue;
    console.log(`  ${JSON.stringify((c.input.title||"").slice(0,48))} taskChars=0 promptOverrideChars=${(c.input.promptOverride||"").length} templateId=${c.input.templateId?"yes":"no"}`);
    console.log(`     promptOverride head: ${JSON.stringify((c.input.promptOverride||"").replace(/\s+/g," ").slice(0,180))}`);
  }
}

console.log("\n=== list_proposals on SECOND-AND-LATER proposing turns of a conversation ===");
const turns = JSON.parse(fs.readFileSync("/tmp/uf-721638d11c0b-1/turns.json","utf8"));
const bySession = new Map();
for (const t of turns) { const a = bySession.get(t.session) || []; a.push(t); bySession.set(t.session, a); }
let firstProp=0, firstPropLP=0, laterProp=0, laterPropLP=0;
for (const [,ts] of bySession) {
  let seenProp=false;
  for (const t of ts) {
    if (!t.proposals.length) continue;
    const i=t.mcp.indexOf("list_proposals"), j=t.mcp.indexOf("propose_run");
    const lp = i>=0 && (j<0 || i<j);
    if (!seenProp) { firstProp++; if(lp) firstPropLP++; seenProp=true; }
    else { laterProp++; if(lp) laterPropLP++; }
  }
}
console.log(`  first proposing turn in a conversation: ${firstPropLP}/${firstProp} called list_proposals first`);
console.log(`  later proposing turns:                  ${laterPropLP}/${laterProp} called list_proposals first`);

console.log("\n=== budget advice written into task text: does it quote a number? ===");
const props = turns.flatMap(t=>t.proposals);
const budgetTasks = props.filter(p=>/\bbudget\b/i.test(p.task||""));
console.log(`  tasks naming 'budget': ${budgetTasks.length}`);
const withNumber = budgetTasks.filter(p=>/\$\s?\d/.test(p.task||""));
console.log(`  of those, quoting a dollar figure: ${withNumber.length}`);
let n=0;
for (const p of budgetTasks) {
  const m=(p.task||"").match(/[^.\n]*budget[^.\n]*/i);
  if (m && n<10) { console.log(`    ${JSON.stringify(m[0].trim().slice(0,170))}`); n++; }
}

console.log("\n=== 'work cycle' / iteration advice in task text ===");
n=0;
for (const p of props) {
  const m=(p.task||"").match(/[^.\n]*(work cycle|work-cycle|iteration)[^.\n]*/i);
  if (m && n<10) { console.log(`    ${JSON.stringify(m[0].trim().slice(0,170))}`); n++; }
}

console.log("\n=== per-conversation shape ===");
const convTurns = [...bySession.values()].map(a=>a.length).sort((a,b)=>a-b);
const q=(a,f)=>a[Math.min(a.length-1,Math.floor(a.length*f))];
console.log(`  turns per conversation: median=${q(convTurns,.5)} p90=${q(convTurns,.9)} max=${convTurns.at(-1)}; single-turn conversations=${convTurns.filter(x=>x===1).length}/${convTurns.length}`);

console.log("\n=== one full example turn (a good one), for quoting ===");
const ex = turns.find(t=>t.proposals.length>=3 && t.proposals.some(p=>(p.dependsOn||[]).length) && t.other.length>4);
if (ex) {
  console.log(`  session=${ex.session.slice(0,8)} ts=${ex.ts}`);
  console.log(`  operator: ${JSON.stringify(ex.userText.replace(/\s+/g," ").slice(0,300))}`);
  console.log(`  mcp calls in order: ${ex.mcp.join(" -> ")}`);
  console.log(`  other tools: ${ex.other.join(",")}`);
  console.log(`  proposals: ${ex.proposals.map(p=>`${JSON.stringify(p.title)} [${(p.task||"").length}ch, tmpl=${p.templateId?"y":"n"}, deps=${JSON.stringify(p.dependsOn||[])}]`).join("\n              ")}`);
  console.log(`  final reply (${(ex.assistantText.at(-1)||"").length} chars):\n${(ex.assistantText.at(-1)||"").slice(0,1600)}`);
}
