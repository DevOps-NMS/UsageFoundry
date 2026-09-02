#!/usr/bin/env node
/**
 * Two proposals set to continue the same run's branch: where is that caught?
 *
 * `propose_run` refuses a proposal that continues *two* branches
 * (src/app/api/mcp/route.ts:1829) but says nothing about two proposals
 * continuing *one*. `planApprovalBatch` deliberately does not re-decide it
 * (src/lib/chat.ts:1060). `admitDependencies` does — against the live `runs`
 * table (src/lib/orchestrator.ts:3557) — and it throws, which
 * `approveProposal`'s catch turns into `markProposal(id, "failed")`
 * (src/lib/chat.ts:1283), a terminal status.
 *
 * So one click starts one of the two and permanently destroys the other, and
 * the sentence it destroys it with names run ids rather than proposal titles.
 * This drives the whole path against a throwaway git repo.
 *
 * Run: node proposals/ProposalBoundary/scripts/rival-continuation.cjs
 * Needs: `npm test` (or `npx tsc -p tsconfig.test.json`) first, and `git`.
 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const BUILD = path.join(REPO, ".test-build", "lib");

if (!fs.existsSync(path.join(BUILD, "chat.js"))) {
  console.error("No .test-build. Run `npm test` first.");
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-rival-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

const work = path.join(process.env.WORKSPACE_ROOT, "a-repo");
fs.mkdirSync(work, { recursive: true });
const git = (...args) =>
  execFileSync("git", ["-C", work, ...args], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(work, "README"), "hello\n");
git("add", "-A");
git("commit", "-qm", "first");

const config = require(path.join(BUILD, "config.js"));
assert.equal(config.DATA_DIR, process.env.DATA_DIR, "refusing to run against the real database");

const chat = require(path.join(BUILD, "chat.js"));
const { saveSettings } = require(path.join(BUILD, "settings.js"));

// Isolation on, which is what a continued branch needs at both ends.
saveSettings({
  chatDefaultGuards: {
    permissionMode: "plan",
    isolate: true,
    budget: { maxIterations: 1, maxDurationMinutes: null, maxRunCostUSD: 1 },
  },
  maxConcurrentRuns: 4,
});

const mountId = config.WORKSPACE_MOUNTS[0].id;
const thread = chat.createChat();

const make = (specId, title, dependsOn) =>
  chat.createProposal(thread.id, {
    templateId: null,
    title,
    task: `Do ${title}.`,
    promptOverride: null,
    mountId,
    folder: "a-repo",
    specId,
    dependsOn,
  });

// Exactly what `propose_run` accepts: each proposal continues one branch, and
// nothing looks across proposals.
const first = make("groundwork", "Lay the groundwork", []);
const second = make("polish", "Polish it", [
  { specId: "groundwork", edge: "on-success", continueBranch: true },
]);
const third = make("document", "Document it", [
  { specId: "groundwork", edge: "on-success", continueBranch: true },
]);

const batch = chat.approveRunBatch(thread.id, [first.id, second.id, third.id]);

console.log(`started: ${batch.started.length} of 3`);
for (const f of batch.failed) console.log(`  could not start “${f.title}”: ${f.reason}`);
console.log("\nproposal rows after the one click:");
for (const p of [first, second, third]) {
  const row = chat.getProposal(p.id);
  console.log(`  ${row.title.padEnd(22)} ${row.status}`);
}
console.log(`  still offered for decision: ${chat.pendingProposals(thread.id).length}`);

const rivalRefusal = batch.failed.find((f) => /continue run/.test(f.reason));
const burned =
  batch.started.length === 2 &&
  !!rivalRefusal &&
  chat.pendingProposals(thread.id).length === 0;

console.log(
  `\nVERDICT: the rival continuation was ${
    burned ? "caught only at approval, and the proposal is gone" : "not reproduced here"
  }.`,
);
if (rivalRefusal) {
  console.log(
    `         The operator is shown: "${rivalRefusal.reason}"\n` +
      "         — two run ids, neither of which was on any card.",
  );
}

fs.rmSync(root, { recursive: true, force: true });
process.exit(burned ? 0 : 1);
