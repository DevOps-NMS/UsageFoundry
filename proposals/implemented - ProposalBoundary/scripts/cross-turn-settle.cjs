#!/usr/bin/env node
/**
 * Does a cancelled turn's child settle the *next* turn's row?
 *
 * `finishTurn` (src/lib/chat.ts:2340) latches on `WHERE id=? AND
 * status='thinking'` and carries nothing that identifies which turn produced
 * the result. `endTurn` (src/lib/chat.ts:1695) settles the row to `failed` and
 * returns without waiting for the child it signalled, and `claimTurn`
 * (src/lib/chat.ts:1619) admits any status that is not `thinking` — so a second
 * message sent while the first child is still dying puts the row back to
 * `thinking`, and the first child's `land()` then walks straight through the
 * latch.
 *
 * This drives the real exported functions against a throwaway database and a
 * fake `claude` that ignores SIGINT for two seconds, which is what the CLI does
 * whenever it is mid-write. No network, no billing, nothing under `src/`.
 *
 * Run: node proposals/ProposalBoundary/scripts/cross-turn-settle.cjs
 * Needs: `npm test` (or `npx tsc -p tsconfig.test.json`) to have produced
 *        `.test-build/lib/chat.js` first.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const BUILD = path.join(REPO, ".test-build", "lib");

if (!fs.existsSync(path.join(BUILD, "chat.js"))) {
  console.error(
    "No .test-build. Run `npm test` (or `npx tsc -p tsconfig.test.json`) first.",
  );
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-cross-turn-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
fs.mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
fs.mkdirSync(process.env.CLAUDE_HOME, { recursive: true });

// A `claude` that survives SIGINT and SIGTERM for a while, then answers. The
// marker file is how each child says which one it was, since the two are
// otherwise identical processes.
const fake = path.join(root, "fake-claude");
fs.writeFileSync(
  fake,
  [
    "#!/bin/sh",
    "trap '' INT TERM",
    'n=$(cat "$0.count" 2>/dev/null || echo 0)',
    "n=$((n+1))",
    'printf %s "$n" > "$0.count"',
    'if [ "$n" = "1" ]; then sleep 2; else sleep 8; fi',
    'printf \'{"type":"result","subtype":"success","result":"reply-from-child-%s","session_id":"session-%s","total_cost_usd":0.25}\' "$n" "$n"',
  ].join("\n"),
  { mode: 0o755 },
);
process.env.CLAUDE_BIN = fake;

const config = require(path.join(BUILD, "config.js"));
assert.equal(config.DATA_DIR, process.env.DATA_DIR, "refusing to run against the real database");

const chat = require(path.join(BUILD, "chat.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const row = chat.createChat();

  const first = await chat.sendChatMessage(row.id, "message one");
  assert.equal(first.ok, true, `turn one did not start: ${first.reason ?? ""}`);
  assert.equal(chat.getChat(row.id).status, "thinking");

  // Long enough for the child to exist, far short of its two-second answer.
  await sleep(300);

  const stop = chat.cancelChatTurn(row.id);
  assert.equal(stop.ok, true);
  assert.equal(
    chat.getChat(row.id).status,
    "failed",
    "the cancel is supposed to settle the row immediately",
  );

  // `revokeCapability` is reachable only from `land` (src/lib/chat.ts:2144), so
  // the stopped turn's credential is still good while its child dies.
  const caps = globalThis.__ufChatCaps;
  console.log(
    `\n  live capability tokens the instant after Stop: ${caps ? caps.size : "n/a"}`,
  );

  // The operator retries, which is what the row being `failed` invites.
  const second = await chat.sendChatMessage(row.id, "message two");
  assert.equal(second.ok, true, `turn two did not start: ${second.reason ?? ""}`);
  assert.equal(chat.getChat(row.id).status, "thinking");

  // Child one answers here, two seconds in. Child two is eight seconds out.
  await sleep(3_000);

  const mid = chat.getChat(row.id);
  const texts = chat.listMessages(row.id).map((m) => m.text);

  const report = {
    statusAfterChildOneExits: mid.status,
    sessionId: mid.session_id,
    costUSD: mid.cost_usd,
    threadHasChildOnesReply: texts.some((t) => t.includes("reply-from-child-1")),
    threadHasChildTwosReply: texts.some((t) => t.includes("reply-from-child-2")),
    turnStartedAt: mid.turn_started_at,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log("\nthread:");
  for (const m of chat.listMessages(row.id)) console.log(`  ${m.role}: ${m.text}`);

  const settledByTheCancelledChild =
    report.statusAfterChildOneExits === "idle" && report.threadHasChildOnesReply;

  console.log(
    `\nVERDICT: turn two's row was ${
      settledByTheCancelledChild
        ? "settled by the CANCELLED turn's child"
        : "not settled by the cancelled turn's child"
    }.`,
  );

  // Whatever the verdict, say what happens to the live turn afterwards: the
  // sweeper only watches `thinking` rows, so a row settled early is a turn
  // nothing is left watching.
  if (settledByTheCancelledChild) {
    console.log(
      "         Turn two's child is still running with nothing tracking it; its\n" +
        "         own finishTurn will find status<>'thinking' and be discarded.",
    );

    // And the guard that is supposed to keep one billed child per conversation
    // is open, because it reads the row rather than the process.
    const third = await chat.sendChatMessage(row.id, "message three");
    console.log(
      `\n  A third message while turn two's child is still alive: ${
        third.ok ? "ACCEPTED — two billed children on one conversation" : `refused (${third.reason})`
      }`,
    );
  }

  return settledByTheCancelledChild ? 0 : 1;
}

main()
  .then((code) => {
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(3);
  });
