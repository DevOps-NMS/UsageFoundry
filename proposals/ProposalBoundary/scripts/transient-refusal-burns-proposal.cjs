#!/usr/bin/env node
/**
 * Does a *temporary* refusal destroy the proposal permanently?
 *
 * `approveProposal` (src/lib/chat.ts:1278) catches everything `createRun`
 * throws and calls `markProposal(id, "failed", …)`, which is terminal —
 * `planProposal` refuses any proposal whose status is not `pending`
 * (src/lib/chat.ts:833) and the route only offers `pendingProposals(id)`. Its
 * own comment justifies that by enumerating the *permanent* refusals ("a folder
 * outside every mount and a folder that does not exist").
 *
 * But `createRun` also throws for two conditions that clear on their own:
 * `installBudgetRefusal()` (src/lib/orchestrator.ts:3645), a rolling-24h
 * ceiling, and `requireDataDir()` (:3631), which is whichever process holds the
 * lock right now. This drives the first of those against a throwaway database.
 *
 * Run: node proposals/ProposalBoundary/scripts/transient-refusal-burns-proposal.cjs
 * Needs: `npm test` (or `npx tsc -p tsconfig.test.json`) first.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const BUILD = path.join(REPO, ".test-build", "lib");

if (!fs.existsSync(path.join(BUILD, "chat.js"))) {
  console.error("No .test-build. Run `npm test` first.");
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-burn-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
// This container exports the real mounts; the throwaway one has to win.
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
fs.mkdirSync(path.join(process.env.WORKSPACE_ROOT, "a-repo"), { recursive: true });

const config = require(path.join(BUILD, "config.js"));
assert.equal(config.DATA_DIR, process.env.DATA_DIR, "refusing to run against the real database");

const chat = require(path.join(BUILD, "chat.js"));
const { db } = require(path.join(BUILD, "db.js"));
const { saveSettings } = require(path.join(BUILD, "settings.js"));
const { installBudgetRefusal } = require(path.join(BUILD, "installBudget.js"));

const mountId = config.WORKSPACE_MOUNTS[0].id;

// The operator's install ceiling, and enough spend inside the rolling window to
// have reached it. A chat turn's own spend row is the cheapest way to put money
// in the window without inventing a run.
saveSettings({ installDailyCostLimitUSD: 1 });
const spender = chat.createChat();
db()
  .prepare("INSERT INTO chat_turn_spend (chat_id, ts, cost_usd) VALUES (?, ?, ?)")
  .run(spender.id, Date.now(), 5);

const ceiling = installBudgetRefusal();
assert.ok(ceiling, "the ceiling should be tripped for this script to mean anything");
console.log(`ceiling tripped: ${ceiling}\n`);

const thread = chat.createChat();
const proposal = chat.createProposal(thread.id, {
  templateId: null,
  title: "Fix the flaky test",
  task: "Find out why the suite is flaky and fix it.",
  promptOverride: null,
  mountId,
  folder: "a-repo",
});
assert.equal(chat.getProposal(proposal.id).status, "pending");

const outcome = chat.approveProposal(proposal.id);
const afterClick = chat.getProposal(proposal.id);

console.log(`approve while the ceiling is tripped -> ok=${outcome.ok}`);
console.log(`  reason: ${outcome.reason}`);
console.log(`  proposal status: ${afterClick.status}`);
console.log(`  still offered for decision: ${chat.pendingProposals(thread.id).length > 0}`);

// The window rolls, or the operator raises the ceiling. Nothing about the
// proposal was wrong.
saveSettings({ installDailyCostLimitUSD: null });
assert.equal(installBudgetRefusal(), null, "the ceiling should now be off");

const retry = chat.approveProposal(proposal.id);
console.log(`\nceiling off; approve the same proposal again -> ok=${retry.ok}`);
console.log(`  reason: ${retry.reason}`);
console.log(
  `  still offered for decision: ${chat.pendingProposals(thread.id).length > 0}`,
);

const burned = afterClick.status === "failed" && !retry.ok;
console.log(
  `\nVERDICT: a proposal refused by a condition that clears on its own is ${
    burned ? "PERMANENTLY LOST" : "still approvable"
  }.`,
);

fs.rmSync(root, { recursive: true, force: true });
process.exit(burned ? 0 : 1);
