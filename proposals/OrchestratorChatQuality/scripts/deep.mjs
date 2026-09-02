import fs from "node:fs";
const turns = JSON.parse(fs.readFileSync("/tmp/uf-721638d11c0b-1/turns.json","utf8"));
const props = turns.flatMap(t=>t.proposals.map(p=>({...p, _turn:t})));
const P = props.length;
const pc=(n,d=P)=>`${n}/${d} (${(100*n/d).toFixed(1)}%)`;

console.log("=== continueBranch vs template ===");
const cbProps = props.filter(p=>(p.dependsOn||[]).some(e=>e.continueBranch));
console.log(`proposals with a continueBranch edge: ${pc(cbProps.length)}`);
console.log(`  of those, naming a templateId: ${pc(cbProps.filter(p=>p.templateId).length, cbProps.length)}`);
console.log(`  of those, whose turn called list_templates first: ${pc(cbProps.filter(p=>{const t=p._turn;const i=t.mcp.indexOf("list_templates");return i>=0}).length, cbProps.length)}`);

console.log("\n=== dependsOn edge choice ===");
const edges = props.flatMap(p=>(p.dependsOn||[]).map(e=>({...e, _p:p})));
console.log(`edges: ${edges.length}`);
// Heuristic: which target titles/tasks are "run regardless" work — review, report, docs, audit, survey
const regardlessRe = /\b(review|report|audit|survey|document|docs|summar|inventor|catalogu|catalog|verify|check|test)\b/i;
const onSuccess = edges.filter(e=>e.edge==="on-success");
const onFinish = edges.filter(e=>e.edge==="on-finish");
console.log(`on-success where the DEPENDENT is review/report/audit-shaped: ${onSuccess.filter(e=>regardlessRe.test(e._p.title||"")).length}/${onSuccess.length}`);
console.log(`on-finish  where the DEPENDENT is review/report/audit-shaped: ${onFinish.filter(e=>regardlessRe.test(e._p.title||"")).length}/${onFinish.length}`);
console.log(`on-finish edges that ALSO carry continueBranch: ${onFinish.filter(e=>e.continueBranch).length}/${onFinish.length}`);
console.log(`on-success edges that ALSO carry continueBranch: ${onSuccess.filter(e=>e.continueBranch).length}/${onSuccess.length}`);
console.log("\n  sample on-finish + continueBranch dependents (title | dep):");
for (const e of onFinish.filter(e=>e.continueBranch).slice(0,12)) console.log(`    ${JSON.stringify(e._p.title)} <- ${e.id}`);
console.log("\n  sample on-success dependents that are review/report shaped:");
for (const e of onSuccess.filter(e=>regardlessRe.test(e._p.title||"")).slice(0,15)) console.log(`    ${JSON.stringify(e._p.title)} <- ${e.id} (${e.edge})`);

console.log("\n=== guard vocabulary inside task text ===");
const pats = {
  "budget/$": /\bbudget\b|\$\d/i,
  "work cycle/iteration": /work[- ]cycle|iteration/i,
  "permission mode": /permission mode|acceptEdits|bypassPermissions|acceptedits/i,
  "isolation/worktree/branch": /\bisolat|\bworktree\b|own checkout/i,
  "stop when/do not exceed": /do not exceed|stop when you|within (one|1|two|2|a single)/i,
};
for (const [k,re] of Object.entries(pats)) console.log(`  task matches ${k.padEnd(24)} ${pc(props.filter(p=>re.test(p.task||"")).length)}`);
console.log("\n  sample task excerpts using guard vocabulary:");
let shown=0;
for (const p of props) {
  const t=p.task||"";
  const m = t.match(/[^.\n]*(budget|work cycle|work-cycle|iteration|permission mode|acceptEdits|isolat|worktree)[^.\n]*[.\n]/i);
  if (m && shown<14) { console.log(`    [${(p.title||"").slice(0,50)}] …${m[0].trim().slice(0,190)}`); shown++; }
}

console.log("\n=== final reply: brevity and repetition ===");
const withProp = turns.filter(t=>t.proposals.length>0);
let restated=0, mentionsWindow=0, mentionsGuard=0, mentionsSameClick=0, cbTurns=0, cbSaidSameClick=0;
const q=(a,f)=>a[Math.min(a.length-1,Math.floor(a.length*f))];
const bodyLens=[];
for (const t of withProp) {
  const fin = t.assistantText.length ? t.assistantText[t.assistantText.length-1] : "";
  bodyLens.push(fin.length);
  // proportion of proposals whose task first sentence is echoed
  const echoes = t.proposals.filter(p=>{
    const first=(p.task||"").split(/(?<=\.)\s/)[0]||""; return first.length>40 && fin.includes(first.slice(0,60));
  }).length;
  if (t.proposals.length && echoes/t.proposals.length>0.3) restated++;
  if (/5-hour|five-hour|weekly window|window is|% of (the )?(5|five)|burn rate|usage window/i.test(fin)) mentionsWindow++;
  if (/default guard set|guard set|template/i.test(fin)) mentionsGuard++;
  const hasDeps = t.proposals.some(p=>(p.dependsOn||[]).length);
  if (hasDeps) { cbTurns++; if (/same click|same batch|approve (them |all )?together|approve all|in one click/i.test(fin)) cbSaidSameClick++; }
}
bodyLens.sort((a,b)=>a-b);
console.log(`  final reply chars over proposing turns: median=${q(bodyLens,.5)} p90=${q(bodyLens,.9)} max=${bodyLens[bodyLens.length-1]}`);
console.log(`  reply echoes >30% of proposals' opening task sentence: ${restated}/${withProp.length}`);
console.log(`  reply mentions the usage window:      ${mentionsWindow}/${withProp.length}`);
console.log(`  reply mentions template/guard set:    ${mentionsGuard}/${withProp.length}`);
console.log(`  turns with dependsOn that say "same click": ${cbSaidSameClick}/${cbTurns}`);

console.log("\n=== get_usage: called vs used ===");
const usageTurns = withProp.filter(t=>t.mcp.includes("get_usage"));
const usedIt = usageTurns.filter(t=>{const fin=t.assistantText.at(-1)||"";return /5-hour|five-hour|weekly|window|burn|%/i.test(fin);});
console.log(`  proposing turns calling get_usage: ${usageTurns.length}; whose reply mentions a window/percentage: ${usedIt.length}`);

console.log("\n=== turns with neither a proposal nor a question ===");
const neither = turns.filter(t=>!t.proposals.length && !t.questions.length && !(t.workflows||[]).length);
console.log(`  ${neither.length} turns`);
for (const t of neither.slice(0,26)) {
  const fin=(t.assistantText.at(-1)||"").replace(/\s+/g," ");
  console.log(`   - user: ${JSON.stringify(t.userText.replace(/\s+/g," ").slice(0,120))}`);
  console.log(`     mcp=[${t.mcp.join(",")}] other=${t.other.length} replyChars=${fin.length}`);
}

console.log("\n=== Write / Agent / ToolSearch use ===");
for (const t of turns) {
  if (t.other.includes("Write")) console.log(`  Write in session ${t.session.slice(0,8)} ts=${t.ts} user=${JSON.stringify(t.userText.slice(0,90))}`);
}
const tsTurns = turns.filter(t=>t.other.includes("ToolSearch"));
console.log(`  turns using ToolSearch: ${tsTurns.length}/${turns.length}; total calls=${turns.reduce((n,t)=>n+t.other.filter(x=>x==="ToolSearch").length,0)}`);
const bashCounts = turns.map(t=>t.other.filter(x=>x==="Bash").length).sort((a,b)=>a-b);
console.log(`  Bash calls per turn: median=${q(bashCounts,.5)} p90=${q(bashCounts,.9)} max=${bashCounts.at(-1)}`);

console.log("\n=== proposals per turn ===");
const per = withProp.map(t=>t.proposals.length).sort((a,b)=>a-b);
console.log(`  median=${q(per,.5)} p90=${q(per,.9)} max=${per.at(-1)}; turns proposing >=8: ${per.filter(n=>n>=8).length}`);

console.log("\n=== title quality ===");
const tl = props.map(p=>(p.title||"").length).sort((a,b)=>a-b);
console.log(`  title chars: median=${q(tl,.5)} p90=${q(tl,.9)} max=${tl.at(-1)}`);

console.log("\n=== six shortest tasks (the 'two-line brief' cases) ===");
for (const p of [...props].sort((a,b)=>(a.task||"").length-(b.task||"").length).slice(0,6)) {
  console.log(`  [${(p.task||"").length} chars] ${JSON.stringify(p.title)} :: ${JSON.stringify((p.task||"").slice(0,260))}`);
}
