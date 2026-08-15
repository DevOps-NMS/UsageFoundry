import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  clipToolInput,
  describeEvent,
  MAX_TOOL_FIELD_CHARS,
  MAX_TOOL_INPUT_CHARS,
} from "./logLine";

// The pure decisions below reach no database, but importing them loads
// `config.ts`, which binds `DATA_DIR` at module load — and on a developer's
// machine the default is the real one. Named before the require below for the
// reason `orchestrator.test.ts` gives.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-ret-")));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above.
const {
  expiredTranscripts,
  planCheckoutReclaim,
  reclaimableCheckouts,
  retentionCutoff,
} = require("./retention") as typeof import("./retention");

/**
 * Covers the pure half of the retention design — what a store is allowed to
 * grow by, and what is allowed to be discarded from it.
 *
 * Every function here decides something that lands on disk and throws nothing,
 * which is `releasableRuns`' grounds for a test. This file holds the ones that
 * need no database and no filesystem; `retentionSweep.test.ts` beside it drives
 * the SQL, which is its own decision and its own file.
 */

describe("clipToolInput", () => {
  it("stores a small input exactly as it arrived", () => {
    const input = { command: "npm test", description: "run the suite" };
    const clipped = clipToolInput(input);

    assert.equal(clipped.input, input, "an input inside the cap is not copied");
    assert.equal(clipped.truncatedFrom, undefined);
  });

  it("cuts a whole-file Write and says how big it was", () => {
    // The event this exists for: `b.input` for a Write is the file, and the log
    // has only ever rendered one clipped line of it — so the whole of the
    // difference between what was stored and what was shown was storage.
    const content = "x".repeat(200_000);
    const raw = { file_path: "/workspace/repo/big.ts", content };
    const clipped = clipToolInput(raw);

    const stored = JSON.stringify(clipped.input);
    assert.ok(
      stored.length <= MAX_TOOL_INPUT_CHARS,
      `stored ${stored.length} chars, cap is ${MAX_TOOL_INPUT_CHARS}`,
    );
    assert.ok(
      (clipped.truncatedFrom ?? 0) > 200_000,
      "the original length is what makes a shortened input readable as one",
    );
  });

  it("keeps the field that names the call, whatever else it drops", () => {
    // `toolArgs` reads the headline fields in order and renders the first one
    // it finds. A cut that spent the budget on `content` first would leave the
    // log saying a tool ran and nothing about which command it was.
    const clipped = clipToolInput({
      content: "y".repeat(100_000),
      command: "git push origin HEAD",
    });

    const stored = clipped.input as Record<string, unknown>;
    assert.equal(stored.command, "git push origin HEAD");
    assert.equal(
      describeEvent({
        id: 1,
        runId: "r",
        ts: 0,
        kind: "tool",
        payload: { name: "Bash", input: stored, truncatedFrom: clipped.truncatedFrom },
      })?.text,
      "git push origin HEAD · input shortened for storage",
    );
  });

  it("cuts each string value rather than dropping the key", () => {
    const clipped = clipToolInput({
      old_string: "a".repeat(50_000),
      new_string: "b".repeat(50_000),
    });
    const stored = clipped.input as Record<string, string>;

    assert.equal(stored.old_string.length, MAX_TOOL_FIELD_CHARS + 1, "cut plus the ellipsis");
    assert.ok(stored.old_string.endsWith("…"));
    assert.ok(stored.new_string.startsWith("b"));
  });

  it("records the call rather than throwing on an input that will not serialise", () => {
    // Unreachable from the stream, which arrives through `JSON.parse` — but
    // this runs on every tool call of every cycle, and `emit` is on the path of
    // every status transition, so a throw here would take the run's whole log
    // with it and then the run. The true statement about such an input is that
    // the call happened and its arguments were not recorded.
    const cyclic: Record<string, unknown> = { command: "ls" };
    cyclic.self = cyclic;

    assert.deepEqual(clipToolInput(cyclic), { input: null });
  });
});

/**
 * Given these runs, these branch states and these slot states, which slot paths
 * are removable.
 *
 * `.uf-worktrees` is on the **workspace bind mount** — the operator's own source
 * directory — and nothing in this app ever removed a checkout except an operator
 * pressing Delete or Purge on a branch. The slot cap is 64 per repository and
 * the store is shared per mount, so fifteen repositories have a ceiling of 960
 * full checkouts with their dependency trees, and the first symptom of that is
 * the operator's own `git checkout` failing to write.
 *
 * Both ways of being wrong are silent and land on that disk. Reclaiming too
 * eagerly destroys an agent's uncommitted work in a directory nobody looks at;
 * reclaiming nothing is the state this replaces. Hence a fixture per clause.
 */
const DAY = 24 * 60 * 60 * 1000;
const AT = 1_786_470_000_000;
/** A week, matching the shipped `checkoutRetentionDays`. */
const CUTOFF = retentionCutoff(7, AT);

/** A checkout that every clause says may go, before the case changes one. */
function candidate(over: Partial<Parameters<typeof planCheckoutReclaim>[0]> = {}) {
  return {
    slotPath: "/workspace/.uf-worktrees/repo-1",
    runId: "11111111-2222-3333-4444-555555555555",
    status: "completed",
    finishedAt: AT - 30 * DAY,
    heldByActiveRun: false,
    clean: true,
    branchSettled: true,
    chained: false,
    ...over,
  };
}

describe("reclaimableCheckouts", () => {
  it("reclaims a settled run's checkout once its branch has nowhere to go", () => {
    assert.deepEqual(planCheckoutReclaim(candidate(), AT, CUTOFF), {
      action: "remove",
    });
  });

  it("never removes one an active run holds", () => {
    // The acceptance criterion, and it is asked two ways because the two can
    // disagree: a run released from `waiting` days later takes whatever slot is
    // free, so the newest row recorded in a slot need not be the run in it.
    for (const status of ["running", "queued", "paused"]) {
      assert.equal(
        planCheckoutReclaim(candidate({ status }), AT, CUTOFF).action,
        "keep",
        `a ${status} run's checkout was offered for removal`,
      );
    }
    assert.equal(
      planCheckoutReclaim(candidate({ heldByActiveRun: true }), AT, CUTOFF).action,
      "keep",
    );
  });

  it("never removes one with uncommitted work, or one it could not read", () => {
    // `slotIsDirty`'s rule, which this sweep must not weaken: unreadable counts
    // as dirty, because refusing to reclaim is the recoverable mistake.
    const verdict = planCheckoutReclaim(candidate({ clean: false }), AT, CUTOFF);
    assert.equal(verdict.action, "keep");
    assert.match(
      verdict.action === "keep" ? verdict.reason : "",
      /uncommitted/,
    );
  });

  it("never removes one whose branch still carries commits", () => {
    assert.equal(
      planCheckoutReclaim(candidate({ branchSettled: false }), AT, CUTOFF).action,
      "keep",
    );
  });

  it("leaves the slot a run is set to carry the branch on from", () => {
    assert.equal(
      planCheckoutReclaim(candidate({ chained: true }), AT, CUTOFF).action,
      "keep",
    );
  });

  it("waits out the horizon, and a run with no finish time for ever", () => {
    assert.equal(
      planCheckoutReclaim(candidate({ finishedAt: AT - 2 * DAY }), AT, CUTOFF)
        .action,
      "keep",
      "a checkout two days old is inside a seven-day horizon",
    );
    assert.equal(
      planCheckoutReclaim(candidate({ finishedAt: null }), AT, CUTOFF).action,
      "keep",
      "no finish time is no age, and no age is no horizon to be past",
    );
  });

  it("removes nothing at all when the horizon is blank", () => {
    assert.deepEqual(reclaimableCheckouts([candidate()], AT, null), []);
  });

  it("answers with the paths, in the order it was given them", () => {
    const removable = reclaimableCheckouts(
      [
        candidate({ slotPath: "/ws/.uf-worktrees/a-1" }),
        candidate({ slotPath: "/ws/.uf-worktrees/a-2", clean: false }),
        candidate({ slotPath: "/ws/.uf-worktrees/b-1" }),
        candidate({ slotPath: "/ws/.uf-worktrees/b-2", status: "running" }),
      ],
      AT,
      CUTOFF,
    );
    assert.deepEqual(removable, ["/ws/.uf-worktrees/a-1", "/ws/.uf-worktrees/b-1"]);
  });
});

/**
 * Given a horizon and a set of file mtimes, exactly which transcripts go.
 *
 * `~/.claude/projects` is the third store and the one on the operator's own
 * home directory — beside `.credentials.json`, which is why a full disk there
 * presents as an authentication failure rather than as a disk failure. Nothing
 * in this app, its Dockerfile or its compose file ever pruned it: 233 MB in
 * four days, measured well under the concurrency this is judged at.
 *
 * The clause that earns the test is not the age one. It is that a session
 * something may still resume into is never a candidate however old its file is
 * — a live run's, or any chat thread's, since an operator can type into one at
 * any time and there is no terminal state to key on. Getting that wrong is
 * silent: the file is gone, and the failure arrives later as a work cycle that
 * could not resume a session nobody can now find.
 */
describe("expiredTranscripts", () => {
  const file = (over: Partial<Parameters<typeof expiredTranscripts>[0][number]>) => ({
    path: `/home/node/.claude/projects/-workspace/${over.sessionId ?? "s"}.jsonl`,
    sessionId: "s",
    mtimeMs: AT - 60 * DAY,
    bytes: 1_000,
    ...over,
  });

  const paths = (files: Parameters<typeof expiredTranscripts>[0], keep: string[] = []) =>
    expiredTranscripts(files, {
      now: AT,
      cutoff: retentionCutoff(30, AT),
      keepSessions: new Set(keep),
    }).map((f) => f.sessionId);

  it("takes what is past the horizon and leaves what is inside it", () => {
    assert.deepEqual(
      paths([
        file({ sessionId: "old", mtimeMs: AT - 60 * DAY }),
        file({ sessionId: "recent", mtimeMs: AT - 2 * DAY }),
        file({ sessionId: "edge", mtimeMs: AT - 29 * DAY }),
      ]),
      ["old"],
    );
  });

  it("never takes a session something may still resume into", () => {
    // The one clause that cannot be derived from a file's age. A run's
    // transcript is written as it works, so a live run's file is recent — but a
    // *parked* run's is not, and it is exactly the one that will be resumed.
    assert.deepEqual(
      paths(
        [
          file({ sessionId: "parked-run", mtimeMs: AT - 90 * DAY }),
          file({ sessionId: "old-chat", mtimeMs: AT - 90 * DAY }),
          file({ sessionId: "nobody", mtimeMs: AT - 90 * DAY }),
        ],
        ["parked-run", "old-chat"],
      ),
      ["nobody"],
    );
  });

  it("takes nothing when the horizon is blank", () => {
    assert.deepEqual(
      expiredTranscripts([file({ sessionId: "ancient", mtimeMs: 0 })], {
        now: AT,
        cutoff: null,
        keepSessions: new Set(),
      }),
      [],
    );
  });
});
