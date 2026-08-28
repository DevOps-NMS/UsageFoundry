// Synthesise a realistic ~/.claude/projects tree so scanUsage() does real work.
// Without this, the per-run loop in pruneSavingsByRun looks free: an empty
// projects directory makes every scanUsage() a no-op.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// This deletes the tree it is about to write, so the guard is load-bearing:
// pointed at a real `~/.claude` it would destroy the operator's transcripts.
// Refuse anything under the home directory, and refuse a projects directory
// that already holds something — a scratch path is either absent or ours.
const HOME = process.env.CLAUDE_HOME && path.resolve(process.env.CLAUDE_HOME);
if (!HOME) {
  console.error("Refusing: set CLAUDE_HOME to a scratch directory first.");
  process.exit(1);
}
const home = path.resolve(os.homedir());
if (HOME === home || HOME.startsWith(`${home}${path.sep}`)) {
  console.error(`Refusing: ${HOME} is inside the home directory. Use a scratch path.`);
  process.exit(1);
}
const PROJECTS = path.join(HOME, "projects");
if (fs.existsSync(PROJECTS) && fs.readdirSync(PROJECTS).length > 0) {
  const marker = path.join(PROJECTS, ".uf-bench-fixture");
  if (!fs.existsSync(marker)) {
    console.error(`Refusing: ${PROJECTS} is not empty and this benchmark did not write it.`);
    process.exit(1);
  }
}
fs.rmSync(PROJECTS, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.writeFileSync(path.join(PROJECTS, ".uf-bench-fixture"), "written by bench/populate-transcripts.js\n");

let seed = 0x1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];

// Six months of an install that runs a fleet: a few projects, a lot of sessions.
const N_PROJECTS = 6;
const SESSIONS_PER_PROJECT = 40; // 240 transcript files
const NOW = Date.now();

const models = ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"];
let files = 0;
let bytes = 0;
const sessionIds = [];

for (let p = 0; p < N_PROJECTS; p++) {
  const dir = path.join(PROJECTS, `-workspace-project-${p}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let s = 0; s < SESSIONS_PER_PROJECT; s++) {
    const sessionId = `sess_${p}_${s}_${"a".repeat(20)}`;
    sessionIds.push(sessionId);
    const turns = int(80, 600);
    const lines = [];
    let t = NOW - int(0, 183 * 86400_000);
    for (let i = 0; i < turns; i++) {
      t += int(2000, 60_000);
      // Roughly two non-assistant lines per assistant line, as a real
      // transcript has (user turns, tool results, summaries).
      lines.push(JSON.stringify({ type: "user", uuid: `u${p}${s}${i}`, cwd: `/workspace/project-${p}`, sessionId, timestamp: new Date(t).toISOString(), message: { role: "user", content: "x".repeat(int(100, 900)) } }));
      lines.push(JSON.stringify({ type: "user", uuid: `r${p}${s}${i}`, sessionId, timestamp: new Date(t).toISOString(), toolUseResult: { stdout: "x".repeat(int(200, 2000)) } }));
      lines.push(JSON.stringify({
        type: "assistant",
        uuid: `a${p}${s}${i}`,
        requestId: `req_${p}_${s}_${i}`,
        sessionId,
        cwd: `/workspace/project-${p}`,
        isSidechain: rnd() < 0.2,
        timestamp: new Date(t + 1000).toISOString(),
        message: {
          id: `msg_${p}_${s}_${i}`,
          role: "assistant",
          model: pick(models),
          content: [{ type: "text", text: "x".repeat(int(200, 1500)) }],
          usage: {
            input_tokens: int(20, 4000),
            output_tokens: int(20, 3000),
            cache_read_input_tokens: int(0, 300000),
            cache_creation_input_tokens: int(0, 40000),
            service_tier: "standard",
          },
        },
      }));
    }
    const body = lines.join("\n") + "\n";
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);
    files++;
    bytes += body.length;
  }
}
fs.writeFileSync(path.join(HOME, "session-ids.json"), JSON.stringify(sessionIds));
console.log(`transcripts: ${files} files, ${(bytes / 1e6).toFixed(1)} MB under ${PROJECTS}`);
