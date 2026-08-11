import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { BudgetPolicy } from "./budget";

/**
 * Covers the folder-collision predicate, and only that.
 *
 * It earns a test where the rest of this codebase does not: it is pure, and
 * every way it can be wrong ends with two agents writing the same working tree.
 * The mounts have to be configured before the module is loaded, because
 * `WORKSPACE_MOUNTS` is fixed at import time.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-conflict-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(path.join(ws, "RepoOne", "sub"), { recursive: true });
fs.mkdirSync(path.join(ws, "Other"), { recursive: true });
fs.mkdirSync(path.join(ws, ".uf-worktrees", "repoone-1"), { recursive: true });
fs.mkdirSync(path.join(ws, "nested", "Deep"), { recursive: true });

// A second mount reaching the same tree. Compose aliases via bind mount, which
// realpath does not collapse; a symlink is the closest local stand-in, and the
// inode check that catches the bind mount catches this too.
const alias = path.join(tmp, "alias");
fs.symlinkSync(ws, alias);

// A mount *inside* another mount, plus a third mount aliasing that nested one.
// This is the case where an alias has to inherit a path prefix rather than
// starting from its own root.
const nestedAlias = path.join(tmp, "nested-alias");
fs.symlinkSync(path.join(ws, "nested"), nestedAlias);

process.env.WORKSPACE_ROOTS = `Main=${ws}|Alias=${alias}|Nested=${ws}/nested|NestedAlias=${nestedAlias}`;
process.env.DATA_DIR = path.join(tmp, "data");

// `require`, not `import`: imports are hoisted above the environment setup
// above, and the module reads WORKSPACE_ROOTS once at load.
const {
  buildArgs,
  conflictKey,
  overlaps,
  githubEnv,
  isTransientApiError,
  isUsageLimit,
  needsLiveSpendTelemetry,
  nextPrompt,
  permissionDenials,
  refusalResumeAt,
  selectPromotable,
  MAX_PAUSES_PER_RUN,
  MAX_TRANSIENT_RETRIES,
} = require("./orchestrator") as typeof import("./orchestrator");

const { normalizePolicy } = require("./budget") as typeof import("./budget");

const clash = (a: string, b: string) => overlaps(conflictKey(a), conflictKey(b));

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("folder collision", () => {
  it("treats a folder as its own occupant", () => {
    assert.equal(clash(`${ws}/RepoOne`, `${ws}/RepoOne`), true);
  });

  it("treats siblings as independent", () => {
    assert.equal(clash(`${ws}/RepoOne`, `${ws}/Other`), false);
  });

  it("catches a parent and a child in both directions", () => {
    // The picker offers the mount root, so this is a normal selection, not an
    // edge case.
    assert.equal(clash(ws, `${ws}/RepoOne`), true);
    assert.equal(clash(`${ws}/RepoOne/sub`, `${ws}/RepoOne`), true);
  });

  it("sees through two mounts onto one directory", () => {
    assert.equal(clash(`${ws}/RepoOne`, `${alias}/RepoOne`), true);
    assert.equal(clash(`${ws}/RepoOne`, `${alias}/Other`), false);
  });

  it("treats a case variant as the same folder", () => {
    // macOS is case-insensitive by default, so these are one directory.
    assert.equal(clash(`${ws}/RepoOne`, `${ws}/repoone`), true);
  });

  it("keeps isolated checkouts clear of the repo and of each other", () => {
    assert.equal(clash(`${ws}/RepoOne`, `${ws}/.uf-worktrees/repoone-1`), false);
    assert.equal(
      clash(`${ws}/.uf-worktrees/repoone-1`, `${ws}/.uf-worktrees/repoone-2`),
      false,
    );
  });

  it("still blocks checkouts against a run on the whole workspace", () => {
    assert.equal(clash(ws, `${ws}/.uf-worktrees/repoone-1`), true);
  });

  it("keeps a nested mount's prefix when a third mount aliases it", () => {
    // The alias inherits the parent's tree identity, so it has to inherit the
    // parent-relative prefix too. Dropping it makes `/nested-alias/Deep` and
    // `/ws/nested/Deep` — one directory — compare as different folders, and two
    // agents are admitted into the same working tree.
    assert.equal(clash(`${nestedAlias}/Deep`, `${ws}/nested/Deep`), true);
    assert.equal(clash(`${nestedAlias}/Deep`, `${ws}/RepoOne`), false);
    // And the parent mount still contains the aliased nested path.
    assert.equal(clash(ws, `${nestedAlias}/Deep`), true);
  });
});

/**
 * Covers which queued runs are allowed to start. Pure, and it earns a test on
 * the same grounds as the predicate above: one wrong status in the reservation
 * set is either two agents in one working tree, or a run queued behind
 * something that will never move.
 *
 * Array order is the contract — `activeRuns()` sorts by `created_at`, and these
 * fixtures stand in for that.
 */
describe("promotion", () => {
  type Row = import("./orchestrator").RunRow;
  let seq = 0;
  // Only three fields are read. A complete row would be thirty nulls per case
  // and would need editing every time a column is added.
  const row = (status: Row["status"], dir: string): Row =>
    ({ id: `r${++seq}`, status, folder: dir, work_dir: dir }) as Row;

  it("starts a queued run in a folder only a parked run holds", () => {
    const parked = row("paused", `${ws}/RepoOne`);
    const waiting = row("queued", `${ws}/RepoOne`);
    assert.deepEqual(selectPromotable([parked, waiting], null), [waiting.id]);
  });

  it("holds it behind a running one", () => {
    const live = row("running", `${ws}/RepoOne`);
    const waiting = row("queued", `${ws}/RepoOne/sub`);
    assert.deepEqual(selectPromotable([live, waiting], null), []);
  });

  it("does not spend a concurrency slot on a parked run", () => {
    const parked = row("paused", `${ws}/Other`);
    const waiting = row("queued", `${ws}/RepoOne`);
    assert.deepEqual(selectPromotable([parked, waiting], 1), [waiting.id]);
  });

  it("does spend one on a running run", () => {
    const live = row("running", `${ws}/Other`);
    const waiting = row("queued", `${ws}/RepoOne`);
    assert.deepEqual(selectPromotable([live, waiting], 1), []);
  });

  it("does not let a younger run overtake one waiting on the workspace root", () => {
    // The root overlaps everything beneath it, so without the queued run's own
    // reservation it is jumped forever by the smaller runs behind it.
    const live = row("running", `${ws}/RepoOne`);
    const root = row("queued", ws);
    const small = row("queued", `${ws}/Other`);
    assert.deepEqual(selectPromotable([live, root, small], null), []);
  });

  it("starts isolated runs on one repo side by side", () => {
    const first = row("running", `${ws}/.uf-worktrees/repoone-1`);
    const second = row("queued", `${ws}/.uf-worktrees/repoone-2`);
    assert.deepEqual(selectPromotable([first, second], null), [second.id]);
  });
});

/**
 * Covers which prompt a cycle spawns with. Pure, and it earns a test because
 * every wrong branch is billed: the continuation prompt asks for DONE if the
 * work is finished, so sending it into a session that has just said DONE buys
 * an immediate second DONE, and sending the original task into a session that
 * is part-way through it repeats work already done.
 */
describe("prompt for the next work cycle", () => {
  const base = {
    sessionId: "sess-1" as string | null,
    followUp: null as string | null,
    justRetriggered: false,
    task: "TASK",
    isolationPreamble: null as string | null,
    priorCycles: 0,
    worktreeBranch: null as string | null,
    continuation: "CONTINUE",
    donePushback: "PUSHBACK",
  };

  it("opens with the task when there is no session to resume", () => {
    assert.equal(nextPrompt({ ...base, sessionId: null }), "TASK");
  });

  it("prepends the isolation preamble only on that opening turn", () => {
    assert.equal(
      nextPrompt({ ...base, sessionId: null, isolationPreamble: "PRE" }),
      "PRE\n\nTASK",
    );
    // Mid-conversation the agent is already in its worktree and has been told.
    assert.equal(
      nextPrompt({ ...base, isolationPreamble: "PRE" }),
      "CONTINUE",
    );
  });

  it("continues an existing session rather than restating the task", () => {
    assert.equal(nextPrompt(base), "CONTINUE");
  });

  it("pushes back instead of continuing after a DONE", () => {
    // The continuation prompt asks for DONE when the work is complete, so
    // replying to a DONE with it is a billed cycle that only says DONE again.
    assert.equal(nextPrompt({ ...base, justRetriggered: true }), "PUSHBACK");
  });

  it("sends the operator's note as the whole turn", () => {
    assert.equal(nextPrompt({ ...base, followUp: "NOTE" }), "NOTE");
  });

  it("appends the note instead when the task has to start over", () => {
    // Without a session there is no conversation for a reply to land in, and a
    // note that only makes sense as one would read as the entire job.
    assert.equal(
      nextPrompt({ ...base, sessionId: null, followUp: "NOTE" }),
      "TASK\n\nNOTE",
    );
    assert.equal(
      nextPrompt({
        ...base,
        sessionId: null,
        isolationPreamble: "PRE",
        followUp: "NOTE",
      }),
      "PRE\n\nTASK\n\nNOTE",
    );
  });

  it("says so when the task is being reopened on top of earlier work", () => {
    // The one case the run page reports as a restart. There is no conversation
    // to carry what the previous attempt did, and a bare task tells the agent
    // to do the work it is standing on — so the prompt has to name the state on
    // disk itself.
    const restarted = nextPrompt({ ...base, sessionId: null, priorCycles: 3 });
    assert.match(restarted, /^A previous attempt at this task already ran 3 work cycles/);
    assert.match(restarted, /\n\nTASK$/);

    // An isolated run's earlier work is committed, and the branch is the only
    // place a fresh session can still read it.
    const isolated = nextPrompt({
      ...base,
      sessionId: null,
      isolationPreamble: "PRE",
      priorCycles: 1,
      worktreeBranch: "uf/thing",
    });
    assert.match(isolated, /^PRE\n\nA previous attempt at this task already ran 1 work cycle and committed its work to this branch \(uf\/thing\)/);
    assert.match(isolated, /\n\nTASK$/);
  });

  it("stays silent about earlier work when there is none, or a session holds it", () => {
    // A first cycle is not a restart …
    assert.equal(nextPrompt({ ...base, sessionId: null, priorCycles: 0 }), "TASK");
    // … and a run that can resume already has the whole conversation.
    assert.equal(
      nextPrompt({ ...base, priorCycles: 3, worktreeBranch: "uf/thing" }),
      "CONTINUE",
    );
  });
});

/**
 * Covers how a provider refusal is classified and when a refused run tries
 * again. Both are pure, and both are the difference between a run that waits
 * out a full window and one that either dies at the wall or re-spawns into it.
 */

describe("usage-limit classification", () => {
  it("matches the wording the CLI renders", () => {
    assert.equal(isUsageLimit("You've hit your session limit"), true);
    assert.equal(isUsageLimit("You've hit your weekly limit · resets 3:45pm"), true);
    assert.equal(isUsageLimit("You've reached your Opus limit."), true);
    // Matched loosely rather than enumerated: the label is per model as well as
    // per window, so a list written today goes stale the next time one ships.
    assert.equal(isUsageLimit("You've hit your Fable 5 limit."), true);
  });

  it("leaves money limits to end the run", () => {
    // A spend cap or a credit balance does not refill on a schedule, so waiting
    // for one holds a folder for hours to reach the same answer.
    assert.equal(isUsageLimit("You've hit your usage credit limit"), false);
    assert.equal(isUsageLimit("You've hit your monthly spend limit."), false);
    assert.equal(isUsageLimit("You're out of usage credits."), false);
    assert.equal(isUsageLimit("Your org is out of usage credits"), false);
  });

  it("matches the wording in the CLI's own error taxonomy", () => {
    assert.equal(isUsageLimit("usage limit reached"), true);
    // The pipe-epoch form every community wrapper keys on is absent from the
    // shipped binary, but costs nothing to keep matching if it ever returns.
    assert.equal(isUsageLimit("Claude AI usage limit reached|1786400000"), true);
  });

  it("leaves other refusals to fail as themselves", () => {
    // A real record from this machine. It must report truthfully, not wait five
    // hours for an allowance that was never the problem.
    assert.equal(isUsageLimit("Not logged in · Please run /login"), false);
    assert.equal(isUsageLimit(""), false);
  });

  it("does not treat a transient failure as an exhausted allowance", () => {
    // Waiting hours for one of these turns a retryable blip into a stalled run.
    assert.equal(isUsageLimit("429 Too Many Requests"), false);
    assert.equal(isUsageLimit("API is overloaded, please retry"), false);
    assert.equal(isUsageLimit("rate limited"), false);
  });
});

/**
 * Covers which refusals are retried in place. It earns a test on the same
 * grounds as `isUsageLimit`, and the two failure modes point opposite ways: a
 * shape that stops being recognised ends a run — with a live session, a held
 * folder and an agent part-way through — for a fault that fixes itself, while
 * one recognised too broadly re-spawns three times into a wall that will refuse
 * every one of them.
 *
 * The five stream sentences are quoted from the shipped CLI, not invented.
 */
describe("transient API failure classification", () => {
  it("matches the CLI's own stream-truncation messages", () => {
    // The one from the issue, plus its four siblings in the same table.
    for (const text of [
      "API Error: Connection closed mid-response. The response above may be incomplete.",
      "API Error: Server error mid-response. The response above may be incomplete.",
      "API Error: Response stalled mid-stream. The response above may be incomplete.",
      "API Error: Response stalled while thinking, before producing a response. Try again.",
      "API Error: Connection closed while thinking, before producing a response. Try again.",
    ]) {
      assert.equal(isTransientApiError(text), true, text);
    }
  });

  it("matches the statuses and error types the provider documents as retryable", () => {
    assert.equal(isTransientApiError("API Error: 529 overloaded_error"), true);
    assert.equal(isTransientApiError("API Error: 500 Internal Server Error"), true);
    assert.equal(isTransientApiError("API Error: 503 Service Unavailable"), true);
    assert.equal(
      isTransientApiError('{"type":"error","error":{"type":"rate_limit_error"}}'),
      true,
    );
  });

  it("matches a connection that never reached a status", () => {
    assert.equal(isTransientApiError("Connection error."), true);
    assert.equal(isTransientApiError("Unable to connect to API"), true);
    assert.equal(isTransientApiError("read ECONNRESET"), true);
    assert.equal(isTransientApiError("TypeError: fetch failed"), true);
  });

  it("leaves permanent failures to end the run", () => {
    // Retrying any of these buys three more of the same answer.
    assert.equal(isTransientApiError("API Error: 401 Invalid API key · Please run /login"), false);
    assert.equal(isTransientApiError("Not logged in · Please run /login"), false);
    assert.equal(
      isTransientApiError("API Error: 400 duplicate tool_use ID in conversation history."),
      false,
    );
    assert.equal(isTransientApiError("Your credit balance is too low"), false);
    assert.equal(isTransientApiError(""), false);
  });

  it("does not read a bare number in ordinary text as a status", () => {
    // `apiError` can carry whatever the CLI summarised the cycle with.
    assert.equal(isTransientApiError("Wrote 500 lines to server.ts"), false);
    assert.equal(isTransientApiError("429 tests passed"), false);
  });

  it("is the second question asked, never the first", () => {
    // A wall can arrive as a 429, and backing off five seconds does not refill
    // an allowance — so the loop tests `isUsageLimit` first and this only ever
    // sees what that rejected. Both being true here is the reason for the order.
    const wall = "API Error: 429 You've hit your weekly limit";
    assert.equal(isUsageLimit(wall), true);
    assert.equal(isTransientApiError(wall), true);
  });

  it("retries a bounded number of times", () => {
    // The cap is what keeps a broken upstream from holding a folder forever;
    // `startRun` indexes a backoff entry per retry, so it must not be zero.
    assert.equal(MAX_TRANSIENT_RETRIES >= 1, true);
  });
});

describe("refusal wake-up time", () => {
  const now = 1_700_000_000_000;
  const min = 5 * 60_000;
  const hour = 3_600_000;

  it("waits for the window when one is still open, plus the settling margin", () => {
    const at = refusalResumeAt({ boundary: now + 2 * hour, pauseCount: 0, now });
    assert.equal(at > now + 2 * hour, true);
    assert.equal(at <= now + 2 * hour + 2 * 60_000, true);
  });

  it("backs off when the boundary it can see has already passed", () => {
    // The derived boundary is floored to the hour, so it can be up to an hour
    // early. Trusting it here would re-spawn straight back into the wall.
    const first = refusalResumeAt({ boundary: now - hour, pauseCount: 0, now });
    const second = refusalResumeAt({ boundary: now - hour, pauseCount: 1, now });
    const third = refusalResumeAt({ boundary: now - hour, pauseCount: 2, now });
    assert.equal(first > now + min, true);
    assert.equal(second > first, true);
    assert.equal(third > second, true);
    // Three waits have to cover the floor-to-hour error, or the feature never
    // reaches the reset it is waiting for.
    assert.equal(third - now >= hour, true);
  });

  it("backs off identically when it can see no window at all", () => {
    assert.equal(
      refusalResumeAt({ boundary: null, pauseCount: 0, now }),
      refusalResumeAt({ boundary: now - hour, pauseCount: 0, now }),
    );
  });

  it("never re-spawns immediately, whatever the arithmetic says", () => {
    // A boundary one second out would otherwise mean a spawn per second.
    assert.equal(
      refusalResumeAt({ boundary: now + 1_000, pauseCount: 0, now }) >= now + min,
      true,
    );
  });

  it("never holds a folder for longer than a window plus slack", () => {
    const at = refusalResumeAt({ boundary: now + 40 * hour, pauseCount: 0, now });
    assert.equal(at <= now + 6 * hour, true);
  });

  it("stops backing off once the cap is reached", () => {
    // Past the cap the run fails instead of parking, so the backoff table only
    // ever needs entries up to it.
    assert.equal(MAX_PAUSES_PER_RUN >= 1, true);
    const atCap = refusalResumeAt({
      boundary: null,
      pauseCount: MAX_PAUSES_PER_RUN,
      now,
    });
    assert.equal(Number.isFinite(atCap), true);
    assert.equal(atCap <= now + 6 * hour, true);
  });
});

/**
 * The credential block handed to a work cycle.
 *
 * It earns a test on the same grounds as the rest of this file: it is pure, and
 * every way it can be wrong is silent. Git ignores a `GIT_CONFIG_*` block whose
 * count and pairs disagree — no warning, no non-zero exit — so a mistake here
 * looks exactly like the unauthenticated container it exists to fix, and only
 * shows up as an agent that could not push, inside a tool call nothing here
 * reads. The empty case matters just as much: injecting a helper that answers
 * with an empty password turns "no credentials configured" into a rejected
 * login against whatever the agent was doing.
 */
describe("github credentials for a work cycle", () => {
  const token = "ghp_example";
  const env = githubEnv(token);

  it("hands nothing to the child when no token is configured", () => {
    assert.deepEqual(githubEnv(""), {});
  });

  it("sets both names the gh CLI and its ecosystem read", () => {
    assert.equal(env.GH_TOKEN, token);
    assert.equal(env.GITHUB_TOKEN, token);
  });

  it("numbers the git config block so git does not discard all of it", () => {
    const count = Number(env.GIT_CONFIG_COUNT);
    assert.equal(Number.isInteger(count) && count > 0, true);
    for (let i = 0; i < count; i += 1) {
      assert.equal(typeof env[`GIT_CONFIG_KEY_${i}`], "string");
      assert.equal(typeof env[`GIT_CONFIG_VALUE_${i}`], "string");
    }
    // A pair past the count is a pair git never reads.
    assert.equal(env[`GIT_CONFIG_KEY_${count}`], undefined);
  });

  it("resets the credential helper list before adding its own", () => {
    // A repository cloned on the host can name a helper this image does not
    // have; git consults them in order, so ours has to be the only one.
    const keys: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i += 1) {
      keys.push(env[`GIT_CONFIG_KEY_${i}`]);
      values.push(env[`GIT_CONFIG_VALUE_${i}`]);
    }
    const first = keys.indexOf("credential.https://github.com.helper");
    assert.notEqual(first, -1);
    assert.equal(values[first], "");
    assert.equal(values[first + 1]?.startsWith("!"), true);
    assert.equal(keys[first + 1], "credential.https://github.com.helper");
  });

  it("rewrites an ssh remote, which is the case that cannot be authenticated", () => {
    const rewrites = Object.entries(env)
      .filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
      .filter(([, v]) => v === "url.https://github.com/.insteadOf")
      .map(([k]) => env[k.replace("KEY", "VALUE")]);
    assert.deepEqual(rewrites.sort(), ["git@github.com:", "ssh://git@github.com/"]);
  });

  it("keeps the token out of the git config it writes", () => {
    // `git config --list` is something an agent prints; the helper reads the
    // environment at call time so the value there is `$GH_TOKEN`, not the token.
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("GIT_CONFIG_")) assert.equal(value.includes(token), false);
    }
  });
});

/**
 * Covers the argv an isolated run is spawned with, and the refusals it reports.
 *
 * Both earn a test on the same grounds as everything else here — pure, silent,
 * expensive — and both were written *after* the failure they describe. Four
 * runs finished `completed`, on their own branches, having been told to commit
 * as they went, with every `git add` and `git commit` refused by the permission
 * mode and the whole change left uncommitted in a worktree. Nothing failed;
 * `landState` simply read four branches with no commits on them. The argv is
 * what makes the preamble's instruction possible to obey, and the denial line
 * is what makes it visible when it is not.
 */
describe("buildArgs", () => {
  const base = {
    prompt: "do the thing",
    model: null,
    permissionMode: "acceptEdits" as const,
    resumeSessionId: null,
  };

  it("grants an isolated run the two git commands it is told to use", () => {
    const args = buildArgs({ ...base, isolated: true });
    const at = args.indexOf("--allowedTools");
    assert.notEqual(at, -1, "an isolated run must be able to commit");
    assert.deepEqual(args.slice(at + 1, at + 3), [
      "Bash(git add:*)",
      "Bash(git commit:*)",
    ]);
  });

  it("grants nothing to a run working in the operator's own checkout", () => {
    // It is never told to commit, and auto-approving commits into the tree
    // somebody is working in is a decision nobody asked for.
    assert.equal(buildArgs({ ...base, isolated: false }).includes("--allowedTools"), false);
  });

  /**
   * The other direction, and the more expensive one. `next-server` is the
   * process title of both this server and any dev server an agent starts to
   * check its work, so a name-matched kill aimed at one reaches the other: one
   * `pkill -f "next-server|next dev"` restarted the container and took fourteen
   * runs with it. The argv is the whole mechanism — there is no ownership
   * boundary between an agent and the process supervising it — so it is pinned
   * for every mode, including the one whose entire purpose is skipping checks.
   */
  for (const permissionMode of ["acceptEdits", "bypassPermissions"] as const) {
    for (const isolated of [true, false]) {
      it(`withholds name-matched kills from a ${permissionMode} run (isolated: ${isolated})`, () => {
        const args = buildArgs({ ...base, permissionMode, isolated });
        const at = args.indexOf("--disallowedTools");
        assert.notEqual(at, -1, "no run may select processes to kill by name");
        assert.deepEqual(args.slice(at + 1, at + 3), [
          "Bash(pkill:*)",
          "Bash(killall:*)",
        ]);
        // Denying the command without saying why buys one turn, not a fix:
        // `kill $(pgrep -f next-server)` is not `pkill` and is just as fatal.
        const said = args[args.indexOf("--append-system-prompt") + 1] ?? "";
        assert.match(said, /pgrep/);
        assert.match(said, /next-server/);
      });
    }
  }

  it("still passes the mode, the model and the session to resume", () => {
    const args = buildArgs({
      ...base,
      model: "claude-opus-5",
      resumeSessionId: "sess-1",
      isolated: true,
    });
    assert.deepEqual(args.slice(0, 2), ["-p", "do the thing"]);
    assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(args[args.indexOf("--resume") + 1], "sess-1");
  });
});

describe("needsLiveSpendTelemetry", () => {
  // Every wrong answer here is silent. False when it should be true leaves the
  // spend guard reading a number frozen for the whole cycle, so a run asked to
  // stop mid-cycle at $5 keeps working — the exact overshoot live enforcement
  // was chosen to avoid, and nothing in the log says the guard was inert.
  const policy = (over: Partial<BudgetPolicy>): BudgetPolicy => ({
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    maxRunCostUSD: null,
    maxRunTokens: null,
    maxIterations: 5,
    maxDurationMinutes: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
    ...over,
  });

  it("is needed by a live run with a spending limit", () => {
    for (const enforcement of ["live", "live-resume"] as const) {
      assert.equal(
        needsLiveSpendTelemetry(policy({ enforcement, maxRunCostUSD: 5 })),
        true,
      );
      assert.equal(
        needsLiveSpendTelemetry(policy({ enforcement, maxRunTokens: 1_000 })),
        true,
      );
    }
  });

  it("is not needed between cycles, where the result event is in time", () => {
    // The whole point of the default mode: every cycle reports its own cost
    // before the next guard check, so there is nothing for telemetry to add.
    assert.equal(
      needsLiveSpendTelemetry(
        policy({ enforcement: "between-cycles", maxRunCostUSD: 5, maxRunTokens: 1_000 }),
      ),
      false,
    );
  });

  it("is not needed by a live run guarding only on windows or the clock", () => {
    // Those move on every tick already — the fractions off a fresh snapshot,
    // the duration off the wall clock — so forcing an export would collect
    // records nothing reads.
    assert.equal(
      needsLiveSpendTelemetry(
        policy({
          enforcement: "live",
          maxSessionFraction: 0.5,
          maxWeeklyFraction: 0.8,
          maxDurationMinutes: 30,
        }),
      ),
      false,
    );
  });

  it("treats a zeroed limit as no limit, the way normalizePolicy does", () => {
    // `normalizePolicy` maps 0 to null, so a policy that reaches the loop can
    // only carry null or a real limit; going by truthiness here would then
    // disagree with the guard about whether one exists.
    assert.equal(
      needsLiveSpendTelemetry(
        normalizePolicy({
          enforcement: "live",
          maxRunCostUSD: 0,
          maxIterations: 5,
        }),
      ),
      false,
    );
    assert.equal(
      needsLiveSpendTelemetry(
        normalizePolicy({
          enforcement: "live",
          maxRunCostUSD: 5,
          maxIterations: 5,
        }),
      ),
      true,
    );
  });
});

describe("permissionDenials", () => {
  it("names the command, because every denial's tool_name is Bash", () => {
    // The shape is copied from a real `result` event: tool_name is the tool,
    // and what was actually refused is in tool_input.command.
    assert.deepEqual(
      permissionDenials([
        {
          tool_name: "Bash",
          tool_use_id: "toolu_01",
          tool_input: { command: "git push", description: "Run git push" },
        },
      ]),
      ["Bash (git push)"],
    );
  });

  it("groups a refusal the agent retried, which is how they arrive", () => {
    const denials = permissionDenials([
      { tool_name: "Bash", tool_input: { command: "git commit -am 'x'" } },
      { tool_name: "Bash", tool_input: { command: "git commit -am 'x'" } },
      { tool_name: "WebFetch" },
    ]);
    assert.deepEqual(denials, ["Bash (git commit -am 'x') ×2", "WebFetch"]);
  });

  it("is empty for a build that stops sending the field", () => {
    // Read defensively on purpose: this shape was captured from one CLI build,
    // and a cycle must not fail to finish because its result event changed.
    for (const raw of [undefined, null, "nope", [], [{}], [{ tool_name: "" }]]) {
      assert.deepEqual(permissionDenials(raw), []);
    }
  });
});
