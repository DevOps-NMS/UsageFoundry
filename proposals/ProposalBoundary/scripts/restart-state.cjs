#!/usr/bin/env node
/**
 * What a restart leaves a chat in: proposals, questions, and the thread itself.
 *
 * `reconcileChatsOnBoot` (src/lib/chat.ts:2446) fails out every `thinking` row
 * and touches nothing else. This checks the three things an operator would come
 * back to — a pending proposal, an open question, and the conversation — and in
 * particular whether the thread records that a turn died, the way `endTurn`
 * (src/lib/chat.ts:1706) makes a point of doing for a cancel or a timeout.
 *
 * Run: node proposals/ProposalBoundary/scripts/restart-state.cjs
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-restart-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
fs.mkdirSync(path.join(process.env.WORKSPACE_ROOT, "a-repo"), { recursive: true });

const config = require(path.join(BUILD, "config.js"));
assert.equal(config.DATA_DIR, process.env.DATA_DIR, "refusing to run against the real database");

const chat = require(path.join(BUILD, "chat.js"));
const { db } = require(path.join(BUILD, "db.js"));

const mountId = config.WORKSPACE_MOUNTS[0].id;
const thread = chat.createChat();

// A turn that got as far as proposing and asking before the process died.
chat.appendMessage(thread.id, "user", "find me something worth doing");
chat.createProposal(thread.id, {
  templateId: null,
  title: "Fix the flaky test",
  task: "Find out why the suite is flaky and fix it.",
  promptOverride: null,
  mountId,
  folder: "a-repo",
});
chat.createQuestions(thread.id, [
  { question: "Which folder did you mean?", choices: ["a-repo", "b-repo"], allowText: true },
]);
db()
  .prepare("UPDATE chat_sessions SET status='thinking', turn_started_at=? WHERE id=?")
  .run(Date.now(), thread.id);

const before = chat.listMessages(thread.id).length;

// The process dies; the next one boots.
chat.reconcileChatsOnBoot();

const row = chat.getChat(thread.id);
const after = chat.listMessages(thread.id);

console.log(`chat status after boot:        ${row.status}`);
console.log(`chat.error after boot:         ${JSON.stringify(row.error)}`);
console.log(`turn_started_at after boot:    ${row.turn_started_at}`);
console.log(`pending proposals:             ${chat.pendingProposals(thread.id).length}`);
console.log(`pending questions:             ${chat.pendingQuestions(thread.id).length}`);
console.log(`messages before / after:       ${before} / ${after.length}`);
console.log("thread:");
for (const m of after) console.log(`  ${m.role}: ${m.text}`);

// The operator retries. `claimTurn` writes `error=NULL` in the same statement
// that takes the turn (src/lib/chat.ts:1618).
async function retry() {
  await chat.sendChatMessage(thread.id, "try again");
  const retried = chat.getChat(thread.id);
  console.log(`\nchat.error once the next message claims the turn: ${JSON.stringify(retried.error)}`);
}

const actionable =
  chat.pendingProposals(thread.id).length === 1 && row.status === "failed";
const silent = after.length === before && !after.some((m) => /restart/i.test(m.text));

console.log(
  `\nVERDICT: proposals and questions are ${actionable ? "still actionable" : "NOT actionable"};` +
    ` the thread ${silent ? "has NO record that the turn died" : "records the death"}.`,
);
if (silent) {
  console.log(
    "         The only record is chat_sessions.error, and the next message\n" +
      "         overwrites it — after which the conversation reads as a question\n" +
      "         the model simply never answered.",
  );
}

retry().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(actionable && silent ? 0 : 1);
});
