import fs from "node:fs";
import path from "node:path";

const ROOT = "/home/node/.claude/projects";
const dirs = fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory());
const CHAT_ONLY = new Set(["list_proposals","save_template","ask_operator","propose_run","propose_workflow"]);
const sessions = [];

for (const d of dirs) {
  const dir = path.join(ROOT, d);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const p = path.join(dir, f);
    let txt;
    try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (!txt.includes("mcp__uf__")) continue;
    const recs = [];
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      try { recs.push(JSON.parse(line)); } catch {}
    }
    const calls = [];
    let userMsgs = 0, assistantMsgs = 0, cwd = null, sessionId = null, model = null;
    let firstTs = null, lastTs = null;
    for (const r of recs) {
      if (r.cwd && !cwd) cwd = r.cwd;
      if (r.sessionId && !sessionId) sessionId = r.sessionId;
      if (r.timestamp) { if (!firstTs) firstTs = r.timestamp; lastTs = r.timestamp; }
      const m = r.message;
      if (!m) continue;
      if (r.type === "user" && typeof m.content === "string") userMsgs++;
      if (r.type === "user" && Array.isArray(m.content) && m.content.some((c)=>c.type==="text")) userMsgs++;
      if (r.type === "assistant") {
        assistantMsgs++;
        if (m.model) model = m.model;
        for (const c of (Array.isArray(m.content) ? m.content : [])) {
          if (c.type === "tool_use" && typeof c.name === "string" && c.name.startsWith("mcp__uf__")) {
            calls.push(c.name.slice("mcp__uf__".length));
          }
        }
      }
    }
    if (!calls.length) continue;
    const isChat = calls.some((c) => CHAT_ONLY.has(c));
    const isBlock = calls.includes("emit_runs");
    sessions.push({ project: d, file: f, path: p, cwd, sessionId, model, isChat, isBlock,
      records: recs.length, userMsgs, assistantMsgs, calls, firstTs, lastTs,
      bytes: fs.statSync(p).size });
  }
}

sessions.sort((a,b)=> (a.firstTs||"").localeCompare(b.firstTs||""));
const chats = sessions.filter(s=>s.isChat);
const blocks = sessions.filter(s=>s.isBlock && !s.isChat);
const other = sessions.filter(s=>!s.isChat && !s.isBlock);
console.log(`sessions with mcp__uf__ tool_use: ${sessions.length}`);
console.log(`  chat-tool sessions: ${chats.length}`);
console.log(`  block (emit_runs) sessions: ${blocks.length}`);
console.log(`  read-only-uf sessions: ${other.length}`);
const tally = {};
for (const s of sessions) for (const c of s.calls) tally[c]=(tally[c]||0)+1;
console.log("call tally (all):", JSON.stringify(tally, null, 0));
const ctally = {};
for (const s of chats) for (const c of s.calls) ctally[c]=(ctally[c]||0)+1;
console.log("call tally (chat sessions):", JSON.stringify(ctally, null, 0));
console.log("\n--- chat sessions ---");
for (const s of chats) console.log([s.firstTs, s.project.slice(0,44), s.file.slice(0,8), `cwd=${s.cwd}`, `mdl=${(s.model||"").slice(0,20)}`, `rec=${s.records}`, `u=${s.userMsgs}`, `a=${s.assistantMsgs}`, s.calls.join(",")].join(" | "));
console.log("\n--- block sessions ---");
for (const s of blocks) console.log([s.firstTs, s.project.slice(0,44), s.file.slice(0,8), `cwd=${s.cwd}`, `rec=${s.records}`, s.calls.join(",")].join(" | "));
console.log("\n--- other uf sessions (first 40) ---");
for (const s of other.slice(0,40)) console.log([s.firstTs, s.project.slice(0,44), s.file.slice(0,8), `cwd=${s.cwd}`, `rec=${s.records}`, s.calls.join(",")].join(" | "));
fs.writeFileSync("/tmp/uf-721638d11c0b-1/sessions.json", JSON.stringify(sessions, null, 1));
