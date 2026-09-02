#!/usr/bin/env node
/**
 * Is the guard set applied at approval the one the card was rendered with?
 *
 * An untemplated proposal's card carries the *values* — `defaultGuardsLabel()`
 * in src/app/api/chat/dto.ts:213 spells out the permission mode, the isolation
 * choice and the budget, because "an approval gate that does not show what is
 * being approved is a gate that gets clicked through". `approveProposal`
 * (src/lib/chat.ts:1254) then reads `chatGuards()` again at the click.
 *
 * Nothing carries the rendered set into the request: the route takes proposal
 * ids and nothing else (src/app/api/chat/[id]/proposals/route.ts:66). So a
 * `chatDefaultGuards` edit landing between the render and the click starts the
 * run under guards the card never showed. This drives both halves against a
 * throwaway database.
 *
 * Run: node proposals/ProposalBoundary/scripts/guard-drift.cjs
 * Needs: `npm test` (or `npx tsc -p tsconfig.test.json`) first.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const BUILD = path.join(REPO, ".test-build");

if (!fs.existsSync(path.join(BUILD, "lib", "chat.js"))) {
  console.error("No .test-build. Run `npm test` first.");
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-drift-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
fs.mkdirSync(path.join(process.env.WORKSPACE_ROOT, "a-repo"), { recursive: true });

const config = require(path.join(BUILD, "lib", "config.js"));
assert.equal(config.DATA_DIR, process.env.DATA_DIR, "refusing to run against the real database");

const chat = require(path.join(BUILD, "lib", "chat.js"));
const { db } = require(path.join(BUILD, "lib", "db.js"));
const { saveSettings } = require(path.join(BUILD, "lib", "settings.js"));
const dto = require(path.join(BUILD, "app", "api", "chat", "dto.js"));

const mountId = config.WORKSPACE_MOUNTS[0].id;

// What the operator has configured when the chat proposes.
saveSettings({
  chatDefaultGuards: {
    permissionMode: "plan",
    isolate: true,
    budget: { maxIterations: 3, maxDurationMinutes: null, maxRunCostUSD: 5 },
  },
});

const thread = chat.createChat();
const proposal = chat.createProposal(thread.id, {
  templateId: null,
  title: "Fix the flaky test",
  task: "Find out why the suite is flaky and fix it.",
  promptOverride: null,
  mountId,
  folder: "a-repo",
});

// The card, exactly as the page is served it.
const rendered = dto.chatDTO(chat.getChat(thread.id)).proposals.find((p) => p.id === proposal.id);
console.log(
  `card as rendered:   guardsSource=${rendered.guardsSource} guardsLabel="${rendered.guardsLabel}"`,
);

// The operator opens Settings — in this tab or another — and changes the
// untemplated guard set. The chat page polls every 10s when idle
// (POLL_IDLE_MS, src/app/chat/page.tsx:54); the card in front of them is
// whatever the last poll returned.
saveSettings({
  chatDefaultGuards: {
    permissionMode: "bypassPermissions",
    isolate: false,
    budget: { maxIterations: null, maxDurationMinutes: 600, maxRunCostUSD: null },
  },
});

// …and clicks Approve on the card above.
const outcome = chat.approveProposal(proposal.id);
assert.equal(outcome.ok, true, `the run did not start: ${outcome.reason ?? ""}`);

const run = db()
  .prepare("SELECT budget, isolation, max_iterations AS maxIterations FROM runs WHERE id=?")
  .get(outcome.runId);
const budget = JSON.parse(run.budget);

console.log(
  `run as started:     permissionMode=${budget.permissionMode} isolation=${run.isolation} ` +
    `maxIterations=${budget.maxIterations} maxRunCostUSD=${budget.maxRunCostUSD} ` +
    `maxDurationMinutes=${budget.maxDurationMinutes}`,
);

const drifted =
  budget.permissionMode !== "plan" || run.isolation === "none" || budget.maxRunCostUSD !== 5;

console.log(
  `\nVERDICT: the run ${drifted ? "DID NOT" : "did"} start under the guards the card stated.`,
);
if (drifted) {
  console.log(
    "         The card said plan / own checkout / 3 cycles / $5.00; the run is\n" +
      "         bypassPermissions, in the operator's own folder, uncapped in both\n" +
      "         cycles and money. Nothing in the thread or on the run records that\n" +
      "         the two disagree.",
  );
}

fs.rmSync(root, { recursive: true, force: true });
process.exit(drifted ? 0 : 1);
