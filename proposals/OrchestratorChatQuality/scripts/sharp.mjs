import fs from "node:fs";
const sessions = JSON.parse(fs.readFileSync("/tmp/uf-721638d11c0b-1/sessions.json","utf8")).filter(s=>s.isChat);
const seen=new Map(); for(const s of sessions){const k=`${s.firstTs}|${s.records}|${s.calls.join(",")}`; if(!seen.has(k))seen.set(k,s);}
const uniq=[...seen.values()];

console.log("=== stop_reason / max_tokens across chat assistant messages ===");
const stops={}; let outTok=[]; let maxOut=0, maxOutWhere="";
const truncated=[];
for (const s of uniq) {
  const recs = fs.readFileSync(s.path,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  for (const r of recs) {
    if (r.type!=="assistant"||!r.message) continue;
    const sr = r.message.stop_reason ?? "null";
    stops[sr]=(stops[sr]||0)+1;
    const u = r.message.usage;
    if (u?.output_tokens) { outTok.push(u.output_tokens); if (u.output_tokens>maxOut){maxOut=u.output_tokens;maxOutWhere=`${s.file.slice(0,8)} ${r.timestamp}`;} }
    if (sr==="max_tokens") truncated.push({file:s.file, ts:r.timestamp, out:u?.output_tokens,
      names:(r.message.content||[]).filter(c=>c.type==="tool_use").map(c=>c.name)});
  }
}
console.log("  stop_reason tally:", JSON.stringify(stops));
outTok.sort((a,b)=>a-b);
const q=(a,f)=>a[Math.min(a.length-1,Math.floor(a.length*f))];
console.log(`  assistant output_tokens: median=${q(outTok,.5)} p90=${q(outTok,.9)} p99=${q(outTok,.99)} max=${maxOut} @ ${maxOutWhere}`);
console.log(`  messages ending at max_tokens: ${truncated.length}`);
for (const t of truncated.slice(0,12)) console.log(`    ${t.file.slice(0,8)} ${t.ts} out=${t.out} tools=${t.names.join(",")}`);

console.log("\n=== the empty-task propose_run calls, raw ===");
for (const s of uniq) {
  const recs = fs.readFileSync(s.path,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  for (const r of recs) {
    if (r.type!=="assistant"||!r.message) continue;
    for (const c of (r.message.content||[])) {
      if (c.type==="tool_use" && c.name==="mcp__uf__propose_run" && !(c.input?.task||"").length) {
        console.log(`  ${s.file.slice(0,8)} ${r.timestamp} stop=${r.message.stop_reason} out=${r.message.usage?.output_tokens}`);
        console.log(`    input keys: ${Object.keys(c.input||{}).join(",")}`);
        console.log(`    title=${JSON.stringify(c.input?.title)}`);
        // find the tool_result for this call
        const res = recs.find(x=>x.type==="user" && Array.isArray(x.message?.content) && x.message.content.some(cc=>cc.tool_use_id===c.id));
        const rc = res?.message.content.find(cc=>cc.tool_use_id===c.id);
        const txt = typeof rc?.content==="string"?rc.content:JSON.stringify(rc?.content);
        console.log(`    result is_error=${rc?.is_error} -> ${String(txt).replace(/\s+/g," ").slice(0,300)}`);
      }
    }
  }
}

console.log("\n=== every propose_run tool_result that is an error ===");
const errTally={}; let errN=0, okN=0;
for (const s of uniq) {
  const recs = fs.readFileSync(s.path,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const byId=new Map();
  for (const r of recs) if(r.type==="assistant") for (const c of (r.message?.content||[])) if(c.type==="tool_use"&&c.name?.startsWith("mcp__uf__")) byId.set(c.id,c);
  for (const r of recs) {
    if (r.type!=="user"||!Array.isArray(r.message?.content)) continue;
    for (const cc of r.message.content) {
      if (cc.type!=="tool_result"||!byId.has(cc.tool_use_id)) continue;
      const call = byId.get(cc.tool_use_id);
      const txt = typeof cc.content==="string"?cc.content:JSON.stringify(cc.content);
      const isErr = cc.is_error || /"ok":false|error|refus|invalid|unknown|not found|cannot|must be/i.test(String(txt).slice(0,400));
      if (isErr) { errN++; const key=`${call.name.replace("mcp__uf__","")}: ${String(txt).replace(/\s+/g," ").slice(0,150)}`; errTally[key]=(errTally[key]||0)+1; }
      else okN++;
    }
  }
}
console.log(`  uf tool results: ${okN} clean, ${errN} error-ish`);
for (const [k,v] of Object.entries(errTally).sort((a,b)=>b[1]-a[1]).slice(0,25)) console.log(`   ${String(v).padStart(3)}x  ${k}`);

console.log("\n=== ToolSearch queries in chat turns ===");
const tq={};
for (const s of uniq) {
  const recs = fs.readFileSync(s.path,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  for (const r of recs) if(r.type==="assistant") for (const c of (r.message?.content||[])) if(c.type==="tool_use"&&c.name==="ToolSearch") { const k=String(c.input?.query||""); tq[k]=(tq[k]||0)+1; }
}
for (const [k,v] of Object.entries(tq).sort((a,b)=>b[1]-a[1]).slice(0,20)) console.log(`   ${String(v).padStart(3)}x  ${k}`);

console.log("\n=== Write call targets ===");
for (const s of uniq) {
  const recs = fs.readFileSync(s.path,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  for (const r of recs) if(r.type==="assistant") for (const c of (r.message?.content||[])) if(c.type==="tool_use"&&c.name==="Write") console.log(`   ${s.file.slice(0,8)} ${r.timestamp} -> ${c.input?.file_path}`);
}
