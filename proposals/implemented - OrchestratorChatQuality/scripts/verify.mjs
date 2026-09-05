import fs from "node:fs";
const sessions = JSON.parse(fs.readFileSync("/tmp/uf-721638d11c0b-1/sessions.json","utf8")).filter(s=>s.isChat);
const seen=new Map(); for(const s of sessions){const k=`${s.firstTs}|${s.records}|${s.calls.join(",")}`; if(!seen.has(k))seen.set(k,s);}
const uniq=[...seen.values()];
const load=(p)=>fs.readFileSync(p,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);

console.log("=== ToolSearch: which uf tools get their schema fetched ===");
let queries=[], sessionsWithTS=0;
for (const s of uniq) {
  const recs=load(s.path); let any=false;
  for (const r of recs) if(r.type==="assistant") for (const c of (r.message?.content||[])) if(c.type==="tool_use"&&c.name==="ToolSearch"){queries.push(String(c.input?.query||"")); any=true;}
  if (any) sessionsWithTS++;
}
console.log(`  ToolSearch calls: ${queries.length} across ${sessionsWithTS}/${uniq.length} conversations`);
const tools=["list_folders","list_templates","list_runs","get_run","get_run_diff","get_usage","list_workflows","list_agents","list_proposals","save_template","ask_operator","propose_run","propose_workflow"];
for (const t of tools) {
  const n = queries.filter(q=>q.includes(`mcp__uf__${t}`)).length;
  console.log(`   ${t.padEnd(18)} named in ${String(n).padStart(3)}/${queries.length} ToolSearch queries`);
}
const selectish = queries.filter(q=>q.startsWith("select:")).length;
console.log(`  queries of form select:… ${selectish}/${queries.length}`);
console.log(`  queries naming ask_operator: ${queries.filter(q=>q.includes("ask_operator")).map(q=>q.slice(0,150))}`);

console.log("\n=== conversations where ask_operator's schema was fetched vs called ===");
let fetched=0, called=0, both=0;
for (const s of uniq) {
  const recs=load(s.path); let f=false,c=false;
  for (const r of recs) if(r.type==="assistant") for (const cc of (r.message?.content||[])) {
    if (cc.type==="tool_use"&&cc.name==="ToolSearch"&&String(cc.input?.query||"").includes("ask_operator")) f=true;
    if (cc.type==="tool_use"&&cc.name==="mcp__uf__ask_operator") c=true;
  }
  if(f)fetched++; if(c)called++; if(f&&c)both++;
}
console.log(`  fetched=${fetched} called=${called} both=${both} of ${uniq.length} conversations`);

console.log("\n=== session da349f53: the six task-less proposals and what followed ===");
const s = uniq.find(x=>x.file.startsWith("da349f53"));
if (s) {
  const recs=load(s.path);
  let n=0;
  for (const r of recs) {
    if (r.type!=="assistant"||!r.message) continue;
    for (const c of (r.message.content||[])) {
      if (c.type!=="tool_use"||c.name!=="mcp__uf__propose_run") continue;
      n++;
      const t=(c.input?.task||"");
      console.log(`  #${n} ${r.timestamp} out=${r.message.usage?.output_tokens} taskChars=${t.length} title=${JSON.stringify((c.input?.title||"").slice(0,60))}`);
    }
  }
}

console.log("\n=== list_folders truncation flag ===");
let lfCalls=0, lfTrunc=0, folderCounts=[];
for (const s of uniq) {
  const recs=load(s.path);
  const ids=new Set();
  for (const r of recs) if(r.type==="assistant") for(const c of (r.message?.content||[])) if(c.type==="tool_use"&&c.name==="mcp__uf__list_folders") ids.add(c.id);
  for (const r of recs) if(r.type==="user"&&Array.isArray(r.message?.content)) for(const cc of r.message.content) {
    if(cc.type!=="tool_result"||!ids.has(cc.tool_use_id)) continue;
    lfCalls++;
    const txt = typeof cc.content==="string"?cc.content:JSON.stringify(cc.content);
    if (/"truncated":\s*true/.test(txt)) lfTrunc++;
    const m = txt.match(/"folder"/g); if(m) folderCounts.push(m.length);
  }
}
folderCounts.sort((a,b)=>a-b);
console.log(`  list_folders results: ${lfCalls}; with truncated:true ${lfTrunc}`);

console.log("\n=== on-finish + continueBranch proposals, in full-ish ===");
for (const s of uniq) {
  const recs=load(s.path);
  for (const r of recs) if(r.type==="assistant") for(const c of (r.message?.content||[])) {
    if(c.type!=="tool_use"||c.name!=="mcp__uf__propose_run") continue;
    const bad=(c.input?.dependsOn||[]).filter(e=>e.edge==="on-finish"&&e.continueBranch);
    if(!bad.length) continue;
    console.log(`  ${s.file.slice(0,8)} ${r.timestamp}`);
    console.log(`    title: ${JSON.stringify(c.input.title)}`);
    console.log(`    dependsOn: ${JSON.stringify(c.input.dependsOn)}`);
    console.log(`    task head: ${JSON.stringify((c.input.task||"").replace(/\s+/g," ").slice(0,200))}`);
  }
}

console.log("\n=== the three ask_operator user messages, in full ===");
for (const s of uniq) {
  const recs=load(s.path);
  let lastUser="";
  for (const r of recs) {
    const m=r.message; if(!m) continue;
    if (r.type==="user") {
      const txt = typeof m.content==="string"?m.content:(Array.isArray(m.content)?m.content.filter(c=>c.type==="text").map(c=>c.text).join("\n"):"");
      if (txt.trim()) lastUser=txt;
    }
    if (r.type==="assistant") for(const c of (m.content||[])) if(c.type==="tool_use"&&c.name==="mcp__uf__ask_operator") {
      console.log(`  --- ${s.file.slice(0,8)} ${r.timestamp}`);
      console.log(`      OPERATOR SAID: ${JSON.stringify(lastUser.replace(/\s+/g," "))}`);
      console.log(`      questions asked: ${(c.input?.questions||[]).length}`);
    }
  }
}
