import fs from "node:fs";
const turns = JSON.parse(fs.readFileSync("/tmp/uf-721638d11c0b-1/turns.json","utf8"));
const fin = (t)=> t.assistantText.length ? t.assistantText[t.assistantText.length-1] : "";
const withText = turns.filter(t=>fin(t).trim().length>0);
console.log(`turns with a final reply: ${withText.length}/${turns.length}`);

// Count question sentences in the final reply (excluding rhetorical headers)
const qsent = (s)=> (s.match(/[^\n?]{12,}\?/g)||[]).filter(x=>!/^\s*[-*#>]/.test(x));
const askedInProse = withText.filter(t=>qsent(fin(t)).length>0 && !t.questions.length);
console.log(`turns whose final reply contains >=1 question sentence but called no ask_operator: ${askedInProse.length}/${withText.length} (${(100*askedInProse.length/withText.length).toFixed(1)}%)`);
const proposedAndAsked = askedInProse.filter(t=>t.proposals.length>0);
console.log(`  of those, that ALSO proposed in the same turn: ${proposedAndAsked.length}`);
const askedOnly = askedInProse.filter(t=>!t.proposals.length);
console.log(`  of those, that proposed nothing (a pure prose question): ${askedOnly.length}`);
const counts = askedInProse.map(t=>qsent(fin(t)).length).sort((a,b)=>a-b);
const q=(a,f)=>a[Math.min(a.length-1,Math.floor(a.length*f))];
console.log(`  question sentences per such reply: median=${q(counts,.5)} p90=${q(counts,.9)} max=${counts.at(-1)}`);
console.log(`  replies with >=4 prose questions (the "form" the prompt forbids): ${counts.filter(n=>n>=4).length}`);

console.log("\n  sample prose questions (proposed-and-asked):");
let n=0;
for (const t of proposedAndAsked) {
  for (const s of qsent(fin(t))) {
    if (n>=16) break;
    console.log(`    [${t.session.slice(0,8)} ${t.proposals.length} proposals] ${JSON.stringify(s.trim().replace(/\s+/g," ").slice(0,190))}`);
    n++;
  }
  if(n>=16) break;
}
console.log("\n  sample prose questions (proposed nothing):");
n=0;
for (const t of askedOnly) {
  for (const s of qsent(fin(t))) {
    if (n>=10) break;
    console.log(`    [${t.session.slice(0,8)}] ${JSON.stringify(s.trim().replace(/\s+/g," ").slice(0,190))}`);
    n++;
  }
  if(n>=10) break;
}

// did the operator answer a prose question in a following turn?
const bySession=new Map();
for (const t of turns){const a=bySession.get(t.session)||[];a.push(t);bySession.set(t.session,a);}
let askedThenFollowed=0, askedThenDropped=0;
for (const [,ts] of bySession) {
  for (let i=0;i<ts.length;i++) {
    if (!(qsent(fin(ts[i])).length>0 && !ts[i].questions.length)) continue;
    if (i+1<ts.length) askedThenFollowed++; else askedThenDropped++;
  }
}
console.log(`\n  prose questions with a following operator turn: ${askedThenFollowed}`);
console.log(`  prose questions that were the last thing in the conversation: ${askedThenDropped}`);

console.log("\n=== which uf tool names does systemPrompt() mention? (checked against the source) ===");
const src = fs.readFileSync("/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1/src/lib/chat.ts","utf8");
const body = src.slice(src.indexOf("function systemPrompt()"), src.indexOf("function chatCwd()"));
for (const t of ["list_folders","list_templates","list_runs","get_run","get_run_diff","get_usage","list_workflows","list_agents","list_proposals","save_template","ask_operator","propose_run","propose_workflow"]) {
  console.log(`   ${t.padEnd(18)} ${body.includes(t) ? "NAMED in systemPrompt()" : "-- not named --"}`);
}
