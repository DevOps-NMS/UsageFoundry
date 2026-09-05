import fs from "node:fs";
const sessions = JSON.parse(fs.readFileSync("/tmp/uf-721638d11c0b-1/sessions.json","utf8")).filter(s=>s.isChat);

// dedupe: identical firstTs + identical call sequence + identical record count
const seen = new Map();
for (const s of sessions) {
  const k = `${s.firstTs}|${s.records}|${s.calls.join(",")}`;
  if (!seen.has(k)) seen.set(k, s);
}
const uniq = [...seen.values()];
console.log(`chat session files: ${sessions.length}; deduped conversations: ${uniq.length}`);

const allTurns = [];
let totalUserTurns = 0;
const nonMcpTools = {};

for (const s of uniq) {
  const recs = fs.readFileSync(s.path,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  let turn = null;
  const turns = [];
  for (const r of recs) {
    const m = r.message; if (!m) continue;
    const isUserText = r.type==="user" && (typeof m.content==="string" ? m.content.trim().length>0
      : Array.isArray(m.content) && m.content.some(c=>c.type==="text"));
    if (isUserText) {
      const text = typeof m.content==="string" ? m.content : m.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");
      turn = { session:s.file, path:s.path, ts:r.timestamp, userText:text, mcp:[], other:[], assistantText:[], proposals:[], questions:[] };
      turns.push(turn); totalUserTurns++;
      continue;
    }
    if (r.type==="assistant" && turn) {
      for (const c of (Array.isArray(m.content)?m.content:[])) {
        if (c.type==="text" && c.text.trim()) turn.assistantText.push(c.text);
        if (c.type!=="tool_use") continue;
        if (typeof c.name==="string" && c.name.startsWith("mcp__uf__")) {
          const nn = c.name.replace("mcp__uf__","");
          turn.mcp.push(nn);
          if (nn==="propose_run") turn.proposals.push(c.input||{});
          if (nn==="ask_operator") turn.questions.push(c.input||{});
          if (nn==="propose_workflow") (turn.workflows ||= []).push(c.input||{});
        } else {
          turn.other.push(c.name);
          nonMcpTools[c.name]=(nonMcpTools[c.name]||0)+1;
        }
      }
    }
  }
  allTurns.push(...turns);
}

const turns = allTurns;
console.log(`user turns: ${turns.length}`);
const withProp = turns.filter(t=>t.proposals.length>0 || (t.workflows||[]).length>0);
const withQ = turns.filter(t=>t.questions.length>0);
const withNeither = turns.filter(t=>t.proposals.length===0 && t.questions.length===0 && !(t.workflows||[]).length);
console.log(`turns ending with >=1 proposal:  ${withProp.length} (${(100*withProp.length/turns.length).toFixed(1)}%)`);
console.log(`turns with ask_operator:         ${withQ.length} (${(100*withQ.length/turns.length).toFixed(1)}%)`);
console.log(`turns with neither:              ${withNeither.length} (${(100*withNeither.length/turns.length).toFixed(1)}%)`);

const props = turns.flatMap(t=>t.proposals);
const pc = (n)=>`${n} (${(100*n/props.length).toFixed(1)}%)`;
console.log(`\npropose_run calls: ${props.length}`);
console.log(`  named a templateId:  ${pc(props.filter(p=>p.templateId).length)}`);
console.log(`  gave mountId:        ${pc(props.filter(p=>p.mountId!==undefined).length)}`);
console.log(`  gave folder:         ${pc(props.filter(p=>p.folder!==undefined).length)}`);
console.log(`  named an agentId:    ${pc(props.filter(p=>p.agentId).length)}`);
console.log(`  gave promptOverride: ${pc(props.filter(p=>p.promptOverride).length)}`);
console.log(`  gave an id:          ${pc(props.filter(p=>p.id).length)}`);
console.log(`  gave dependsOn:      ${pc(props.filter(p=>Array.isArray(p.dependsOn)&&p.dependsOn.length).length)}`);
const edges = props.flatMap(p=>Array.isArray(p.dependsOn)?p.dependsOn:[]);
const edgeT={}; for(const e of edges) edgeT[e.edge]=(edgeT[e.edge]||0)+1;
console.log(`  dependsOn edges:     ${edges.length} ${JSON.stringify(edgeT)}  continueBranch=${edges.filter(e=>e.continueBranch).length}`);

const q = (arr,f)=>arr[Math.min(arr.length-1,Math.floor(arr.length*f))];
const lens = props.map(p=>(p.task||"").length).sort((a,b)=>a-b);
console.log(`\n  task chars: min=${lens[0]} p10=${q(lens,.1)} p25=${q(lens,.25)} median=${q(lens,.5)} p75=${q(lens,.75)} p90=${q(lens,.9)} max=${lens[lens.length-1]}`);
const words = props.map(p=>(p.task||"").split(/\s+/).filter(Boolean).length).sort((a,b)=>a-b);
console.log(`  task words: min=${words[0]} p10=${q(words,.1)} median=${q(words,.5)} p90=${q(words,.9)} max=${words[words.length-1]}`);
console.log(`  tasks < 300 chars: ${pc(lens.filter(l=>l<300).length)}`);
console.log(`  tasks < 500 chars: ${pc(lens.filter(l=>l<500).length)}`);
console.log(`  tasks < 800 chars: ${pc(lens.filter(l=>l<800).length)}`);
const doneRe=/\bdone\b|\bsuccess\b|acceptance|verif|typecheck|npm test|passes|criteri/i;
console.log(`  task names a done/verify word:  ${pc(props.filter(p=>doneRe.test(p.task||"")).length)}`);
const fileRe=/\.(ts|tsx|js|jsx|md|json|css|py|sh|yml|yaml)\b/;
console.log(`  task names a concrete file:     ${pc(props.filter(p=>fileRe.test(p.task||"")).length)}`);
const lineRe=/:\d+/;
console.log(`  task names a file:line:         ${pc(props.filter(p=>lineRe.test(p.task||"")).length)}`);
const urlRe=/https?:\/\/|(^|\s)#\d+/;
console.log(`  task carries issue no. or URL:  ${pc(props.filter(p=>urlRe.test(p.task||"")).length)}`);
// guard language leaking into the task
const guardRe=/\bbudget\b|\bpermission mode\b|acceptEdits|bypassPermissions|work cycle|work-cycle|max iterations|maxIterations|isolation|worktree|\$\d/i;
console.log(`  task uses guard vocabulary:     ${pc(props.filter(p=>guardRe.test(p.task||"")).length)}`);

console.log(`\nask_operator calls: ${turns.flatMap(t=>t.questions).length}`);
for (const t of withQ) {
  console.log(`  --- ${t.session.slice(0,8)} ts=${t.ts}`);
  console.log(`      user asked: ${JSON.stringify(t.userText.slice(0,200))}`);
  for (const qq of t.questions) {
    const list = qq.questions||[];
    console.log(`      ${list.length} question(s); choices on ${list.filter(x=>x.choices).length}; allowText=false on ${list.filter(x=>x.allowText===false).length}`);
    for (const x of list) console.log(`        Q: ${JSON.stringify(x.question).slice(0,300)}\n           choices=${JSON.stringify(x.choices||null)}`);
  }
}

console.log(`\nnon-MCP tool calls across all chat turns:`, JSON.stringify(nonMcpTools));
const lookTools = new Set(["Read","Grep","Glob","Bash","WebFetch","Task","BashOutput","NotebookRead"]);
const looked = (t)=>t.other.some(n=>lookTools.has(n));
console.log(`turns using Read/Grep/Glob/Bash: ${turns.filter(looked).length}/${turns.length} (${(100*turns.filter(looked).length/turns.length).toFixed(1)}%)`);
console.log(`proposing turns that looked:     ${withProp.filter(looked).length}/${withProp.length} (${(100*withProp.filter(looked).length/withProp.length).toFixed(1)}%)`);
const before = (t,a,b)=>{const i=t.mcp.indexOf(a),j=t.mcp.indexOf(b); return i>=0&&(j<0||i<j);};
for (const tool of ["get_usage","list_folders","list_templates","list_runs","list_proposals","list_agents","list_workflows","get_run"]) {
  const n = withProp.filter(t=>before(t,tool,"propose_run")).length;
  console.log(`  proposing turns calling ${tool.padEnd(15)} before first propose_run: ${n}/${withProp.length} (${(100*n/withProp.length).toFixed(1)}%)`);
}

const finals = turns.map(t=>t.assistantText.length?t.assistantText[t.assistantText.length-1]:"").filter(x=>x);
const fl = finals.map(x=>x.length).sort((a,b)=>a-b);
console.log(`\nfinal assistant reply chars: median=${q(fl,.5)} p75=${q(fl,.75)} p90=${q(fl,.9)} max=${fl[fl.length-1]}`);
// does the final reply repeat the task text?
let repeats=0, checked=0;
for (const t of withProp) {
  const fin = t.assistantText.length?t.assistantText[t.assistantText.length-1]:""; if(!fin) continue;
  checked++;
  // count how many proposals' titles appear verbatim in the reply
  const titles = t.proposals.map(p=>p.title||"").filter(Boolean);
  const hits = titles.filter(x=>fin.includes(x)).length;
  if (titles.length && hits/titles.length > 0.5) repeats++;
}
console.log(`proposing turns whose final reply restates >50% of proposal titles verbatim: ${repeats}/${checked}`);

fs.writeFileSync("/tmp/uf-721638d11c0b-1/turns.json", JSON.stringify(turns,null,1));
