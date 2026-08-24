import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./config";
import { db } from "./db";
import { BYTES_PER_TOKEN } from "./fileCostNotice";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  resolvePrice,
} from "./pricing";
import { scanUsage } from "./transcripts";
import type { PruneTier } from "./apiTypes";
import { getSettings, type Settings } from "./settings";

/**
 * Context pruning — winnow, run at a work cycle's boundary.
 *
 * ## What this replaced, and what that cost
 *
 * Until this shipped, the only thing bounding a work cycle's context was
 * `--autocompact 200000` on every cycle's argv, which fired at 167,000 tokens
 * and had the strongest measurement in this repository behind it: a natural
 * experiment over 1,147 transcripts split at the commit that added the flag put
 * turns past the cap at **0.45× per turn and 0.50× per 1,000 output tokens**.
 * That flag is gone and this module is what stands in its place. The operator
 * decided the swap knowing the figure; `docs/verification.md` records what was
 * given up so that a later reading can tell a regression from a choice.
 *
 * The two do different things and only one of them is lossy. Compaction
 * replaced the conversation with a model-written summary — cheaper afterwards,
 * because what remains is small, but the detail is gone and the agent has to
 * re-derive it. A prune removes tool output and keeps the conversation, so it
 * shrinks less and forgets less.
 *
 * ## Why the boundary, and why a manufactured one is not free
 *
 * Cache reads bill at 0.1× and matching is exact and prefix-ordered, so editing
 * the transcript invalidates everything after the cut and forces a full-price
 * rewrite of it. With `D` removed and `S` left after the cut, the edit pays
 * `1.9·S − 2·D` once and earns `0.1·D` on every later turn, so it breaks even
 * after `19·(S/D) − 20` further turns (winnow's `docs/SPEC.md` §7, and the 2.0×
 * write multiplier there is measured on this install rather than taken from the
 * price list).
 *
 * At the boundary between cycle N and cycle N+1 the `2·D` term is **refunded**,
 * because `--resume` was going to rewrite the prefix anyway. That is the one
 * moment the edit is free, and it is why the boundary prune runs unconditionally
 * whenever the feature is on. Ending a cycle *early* to prune manufactures a
 * boundary that was not going to happen, which pays the invalidation in full —
 * so that path is gated on `paybackTurns` rather than run on sight.
 *
 * ## The number this reports is computed here, not read from the tool
 *
 * Measured against a real 2.0 MB transcript on this install: winnow's own report
 * said `Saved 0 tokens (0.0%)` for a prune that removed **28% of the
 * API-visible context**. Its token figure comes from the transcript's historical
 * `usage` frames, which record what was billed and cannot change when content is
 * edited, so it structurally cannot express a delta. `contextTokens` recomputes
 * from content instead, before and after, and that difference is the only figure
 * anything here reports.
 *
 * **Never report bytes freed.** The same measurement had winnow freeing 970 KB
 * of file while removing 290 KB of API-visible content — a 3.4× overstatement,
 * because the largest strategy (`tool-use-result-strip`) removes `toolUseResult`,
 * an envelope field the CLI writes and never sends. Bytes freed is the figure
 * every other pruner reports and it is the one this exists to avoid.
 */

/** Where the Dockerfile puts the checkout and its virtualenv. */
export const WINNOW_ROOT = "/opt/winnow";

/**
 * The interpreter, rather than a `winnow` launcher on `PATH`.
 *
 * `PATH` here is the server's, and `/home/node/pytools/bin` on it belongs to
 * `UF_PY_TOOLS` — an operator-managed directory a sibling agent can write. This
 * module is on the run loop's path on every cycle, so it resolves the absolute
 * interpreter inside the image layer and never a name.
 */
export const WINNOW_PYTHON = path.join(WINNOW_ROOT, "venv/bin/python");

/**
 * Winnow's own state directory, forced out of `$HOME`.
 *
 * Default is `~/.winnow`, which in this container is the writable layer — lost
 * on every rebuild — and `orchestrator_safe.data_dir()` refuses any path inside
 * `~/.claude` outright, because that is the operator's own machine through a
 * bind mount. `DATA_DIR` is neither.
 */
export const WINNOW_DATA_DIR = path.join(DATA_DIR, "winnow");

/**
 * The prescriptions offered, and why `gentle` is not among them.
 *
 * Winnow ships three. Measured here, `gentle` freed **0 bytes** on a real 2.0 MB
 * transcript, and that is structural rather than a property of the sample: its
 * one strategy that fires on an ordinary session is `metadata-strip`, which
 * orchestrator-safe mode excludes **by name** because it deletes the `usage`,
 * `costUSD` and `duration` fields every window, every budget guard and
 * `runs.spent_usd` in this app are computed from. The exclusion is correct and
 * is not negotiable, so `gentle` cannot do anything here under any configuration
 * this app would accept.
 *
 * Offering it anyway would be a control that reads as on and provably does
 * nothing, which is the failure `readGuardMaxTokens`' ceiling is documented
 * against. Two positions, and the reason for the missing third is here rather
 * than in the settings copy because it is a fact about the tool.
 */
export const PRUNE_TIERS: readonly PruneTier[] = ["standard", "aggressive"];

export function isPruneTier(value: unknown): value is PruneTier {
  return typeof value === "string" && (PRUNE_TIERS as readonly string[]).includes(value);
}

export type { PruneTier };

/**
 * The context size at which a cycle is ended early so it can be pruned.
 *
 * 167,000 because that is exactly where `--autocompact 200000` fired, and
 * matching it is the discipline rather than a coincidence: this change swaps the
 * *mechanism* that bounds a long cycle, and moving the trigger point in the same
 * change would leave nothing able to tell which half a later reading is seeing.
 * 30 of 42 observed compaction boundaries landed within ±3,000 of it, which is
 * more evidence than any number picked here would have.
 *
 * A module constant rather than a setting, on `AUTOCOMPACT_WINDOW_TOKENS`'
 * argument, which this inherits along with its job: it trades context against
 * re-derivation, and an operator has no way to see the thing being traded.
 */
export const CYCLE_CONTEXT_CEILING_TOKENS = 167_000;

/**
 * How many further turns a manufactured boundary is allowed to need.
 *
 * Only the early-end path consults this. A cycle that has just crossed the
 * ceiling is by definition a long one, but "long" is not "has 60 turns left" —
 * nothing here knows how many remain, and a cut that needs more turns than the
 * run has is a cost with no return at all.
 *
 * 18 because it is the break-even for cutting **half** the suffix
 * (`19·2 − 20`), which is the case winnow's own SPEC calls out as clearly worth
 * doing. Anything needing longer than that is a bet on a run's remaining length
 * that this app cannot price, and the safe direction is to leave the context
 * alone: an unpruned cycle costs cache reads at 0.1×, where a cut that never
 * pays back has already spent the invalidation at ~2×.
 */
export const PAYBACK_HORIZON_TURNS = 18;

/** How long a prune may take before it is killed and the cycle carries on. */
const PRUNE_TIMEOUT_MS = 120_000;

/** What a prune did, in the only units worth reporting. */
export interface PruneOutcome {
  tier: PruneTier;
  /** API-visible tokens the transcript carried before the prune. */
  tokensBefore: number;
  /** And after. */
  tokensAfter: number;
  /** `tokensBefore - tokensAfter`, never negative. */
  tokensRemoved: number;
  /** Wall time the subprocess took, for the log line. */
  elapsedMs: number;
}

export type PruneResult =
  | { kind: "pruned"; outcome: PruneOutcome }
  | { kind: "nothing"; tokensBefore: number }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * Is the bundled tool actually here?
 *
 * Probed rather than assumed because the Dockerfile's `WINNOW_REF` may be empty
 * — an install that deliberately built without it — and because this runs on the
 * run loop's path, where an exception would end a cycle that was doing fine.
 */
export function winnowAvailable(): boolean {
  try {
    return fs.statSync(WINNOW_PYTHON).isFile();
  } catch {
    return false;
  }
}

/**
 * The API-visible size of a transcript, in tokens.
 *
 * Only `message` is counted, and that is the whole point of the function. A
 * transcript record carries the message the CLI sent alongside envelope fields
 * it did not — `toolUseResult` most of all, which is where winnow finds most of
 * the bytes it removes. Counting the file would credit a prune with removing
 * content that was never in anybody's context.
 *
 * Estimated through `BYTES_PER_TOKEN` rather than counted exactly, for the
 * reason `fileCostNotice.ts` states: a tokeniser here would be a second
 * dependency and a per-cycle cost, and the figure is used to compare two
 * readings of the *same* transcript taken seconds apart. A constant that is
 * slightly wrong cancels almost entirely in the difference.
 *
 * Returns 0 for a file it cannot read, never throws: every caller is on the run
 * loop's path and none of them should end a cycle over a stat.
 */
export function contextTokens(transcriptPath: string): number {
  let bytes = 0;
  try {
    const text = fs.readFileSync(transcriptPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        // A torn trailing line is normal on a transcript being appended to.
        continue;
      }
      const message = (record as { message?: unknown } | null)?.message;
      if (message === undefined || message === null) continue;
      bytes += JSON.stringify(message).length;
    }
  } catch {
    return 0;
  }
  return Math.round(bytes / BYTES_PER_TOKEN);
}

/**
 * Further turns before an edit that removed `removedTokens` pays for itself.
 *
 * `19·(S/D) − 20`, where **`S` is the suffix as it stood before the cut** — the
 * whole of what sits after the cut point, including the part about to be removed
 * — and `D` is what came out. Checked against the two worked examples winnow's
 * README gives: cutting half pays back in 18 turns (`S/D = 2`) and cutting a
 * tenth needs 170 (`S/D = 10`).
 *
 * **The parameter is the before figure, not the after figure**, and passing the
 * wrong one is the mistake this docblock exists to prevent — it is off by
 * exactly `D`, which is small when the cut is small and enormous when it is
 * large, so it flatters precisely the cuts that do not pay. A caller holding a
 * receipt wants `tokens_before`.
 *
 * Pure and tested because it is the whole of the early-end decision and every
 * way of getting it wrong typechecks.
 *
 * Null when the question does not arise: nothing was removed, so there is no
 * edit to pay for. Zero rather than a negative number when the cut is large
 * enough to have paid already — "it pays immediately" is the meaning, and a
 * caller comparing against a horizon should not have to know the formula can go
 * below zero.
 */
export function paybackTurns(suffixBeforeCut: number, removedTokens: number): number | null {
  if (removedTokens <= 0) return null;
  const turns = 19 * (suffixBeforeCut / removedTokens) - 20;
  return Math.max(0, Math.round(turns));
}

/** Is the feature on, and is the tool here to do it? */
export function pruningEnabled(s: Settings = getSettings()): boolean {
  return s.contextPruning && winnowAvailable();
}

/**
 * The environment winnow's own safe mode asks for, plus the two this app
 * overrides and why.
 *
 * `winnow safe env` is the source for the rest — it is the tool's own statement
 * of what it needs to be survivable under a harness, and copying the list here
 * would mean maintaining a second one that drifts. It is applied by
 * `winnow safe run` in-process; what this adds is the pair that command does not
 * set for us.
 */
function pruneEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The gate and the `metadata-strip` exclusion both key off this. Without it
    // `winnow safe run` refuses outright rather than pruning without the
    // exclusion, which is the correct direction and also not what we want.
    WINNOW_ORCHESTRATOR: "1",
    // Out of `$HOME`. See WINNOW_DATA_DIR.
    WINNOW_DATA_DIR,
  };
}

/**
 * Run the prune, and report it in tokens.
 *
 * `winnow safe run -- treat …` rather than `treat` directly, and that is the
 * load-bearing part of the argv. `safe run` calls the inherited CLI **in this
 * process** precisely so that `apply_strategy_exclusions()` has already removed
 * `metadata-strip` from every prescription; spawning `treat` on its own would
 * import a fresh, unexcluded copy and the first thing it would delete is the
 * `usage` frames this app bills every run from. The gate it also applies is a
 * second reason and not the first: at a cycle boundary no Claude process holds
 * the session, so `treat --execute` is permitted there.
 *
 * Never a shell. Argv array, `security.md`'s rule, and the transcript path
 * reaches the child as one element however it is spelled.
 */
export async function pruneTranscript(
  transcriptPath: string,
  tier: PruneTier,
): Promise<PruneResult> {
  if (!winnowAvailable()) {
    return {
      kind: "unavailable",
      reason: `winnow is not installed at ${WINNOW_ROOT} — this image was built with WINNOW_REF empty`,
    };
  }

  // Created here rather than at boot: this is the only thing that writes it, and
  // winnow stats it on startup and raises `PermissionError` rather than creating
  // it. 0700 because it is the server's alone — nothing an agent runs reads it.
  try {
    fs.mkdirSync(WINNOW_DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      kind: "failed",
      reason: `could not create ${WINNOW_DATA_DIR}: ${(err as Error).message}`,
    };
  }

  const tokensBefore = contextTokens(transcriptPath);
  if (tokensBefore === 0) {
    return { kind: "failed", reason: `could not read ${path.basename(transcriptPath)}` };
  }

  const startedAt = Date.now();
  const run = await spawnPrune(transcriptPath, tier);
  if (!run.ok) return { kind: "failed", reason: run.reason };

  // Deleted rather than kept, and this is not tidiness. `save_messages` is
  // called with `create_backup=True` at all three of winnow's call sites with no
  // flag in front of it, so every prune drops a copy of the *pre-prune*
  // transcript beside the original — inside `~/.claude`, which is a bind mount
  // of the operator's own disk. A 2 MB transcript pruned once per cycle would
  // leave 2 MB behind per cycle, on their machine, with nothing in this app
  // sweeping it: `retention.ts` expires transcripts by asking the database what
  // is live, and these files are not rows.
  removeBackups(transcriptPath, startedAt);

  const tokensAfter = contextTokens(transcriptPath);
  const tokensRemoved = Math.max(0, tokensBefore - tokensAfter);
  if (tokensRemoved === 0) return { kind: "nothing", tokensBefore };

  return {
    kind: "pruned",
    outcome: {
      tier,
      tokensBefore,
      tokensAfter,
      tokensRemoved,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

/** The child, as its own function so `pruneTranscript` reads as the sequence it is. */
function spawnPrune(
  transcriptPath: string,
  tier: PruneTier,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      const child = spawn(
        WINNOW_PYTHON,
        [
          "-m",
          "winnow",
          "safe",
          "run",
          "--",
          "treat",
          transcriptPath,
          "-rx",
          tier,
          "--execute",
        ],
        {
          env: pruneEnv(),
          // **No `childCredentials()`, and this is the one spawn in this app
          // that deliberately does not drop to the agent uid.**
          //
          // Every other child here is an agent, running work a model decided on,
          // and dropping privilege is the whole point. This one is the app's own
          // maintenance on the app's own data, and the uid split makes the drop
          // impossible rather than merely unnecessary: measured on this install,
          // the transcripts are `0600 root` and `DATA_DIR` is `0700 root`, so a
          // child at `UF_AGENT_UID` can neither read the file it is meant to
          // prune nor write the state directory winnow keeps. It fails with
          // `PermissionError` on `WINNOW_DATA_DIR` before it reaches the
          // transcript.
          //
          // What is actually being trusted is narrow and worth naming: a pinned
          // commit, built at image build time into a root-owned directory no
          // agent can write, invoked with an argv array this module composes
          // whose only variable parts are a transcript path this app resolved
          // and a tier from a closed list the settings route refuses anything
          // outside of. No agent input reaches this command line.
          stdio: ["ignore", "ignore", "pipe"],
        },
      );

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // Bounded: this is a refusal reason at most, and winnow bounds its own
        // lines to 500 characters. An unbounded read here would put a tool's
        // whole traceback into a run event.
        if (stderr.length < 4_000) stderr += chunk;
      });

      timer = setTimeout(() => child.kill("SIGKILL"), PRUNE_TIMEOUT_MS);
      timer.unref?.();

      child.on("error", (err) => finish({ ok: false, reason: err.message }));
      child.on("close", (code) =>
        finish(
          code === 0
            ? { ok: true }
            : {
                ok: false,
                reason: stderr.trim() || `winnow exited with code ${code ?? -1}`,
              },
        ),
      );
    } catch (err) {
      finish({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Remove the `.bak` winnow just wrote beside the transcript.
 *
 * Matched on winnow's own naming — `<stem>.<YYYYmmdd_HHMMSS>.jsonl.bak` — and
 * filtered by mtime against the moment this prune started, so a backup left by
 * something else, or by an operator running the tool by hand, is not swept up by
 * this app. Best-effort and silent: a backup that could not be removed is disk,
 * where a throw here would be a cycle lost after the prune had already
 * succeeded.
 */
function removeBackups(transcriptPath: string, since: number): void {
  try {
    const dir = path.dirname(transcriptPath);
    const stem = path.basename(transcriptPath, ".jsonl");
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(`${stem}.`) || !entry.endsWith(".jsonl.bak")) continue;
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).mtimeMs >= since - 1_000) fs.unlinkSync(full);
      } catch {
        // Next sweep, or never. Not worth a line in the run's log.
      }
    }
  } catch {
    // The directory is the CLI's, not ours. Unreadable is not this app's problem.
  }
}

/**
 * Which moment a prune happened at.
 *
 * Not decoration: it is what decides whether the receipt carries an
 * invalidation cost. A `boundary` prune rides a rewrite `--resume` was going to
 * do regardless, so it pays nothing; an `early-end` manufactured the boundary
 * and pays for it in full.
 */
export type PruneTrigger = "boundary" | "early-end";

/**
 * Write the receipt.
 *
 * Best-effort and never thrown from: the prune has already happened by the time
 * this is called, and a failed insert must not turn a cycle that succeeded into
 * one that ended with an error. What is lost is a row in a KPI, which is the
 * cheaper of the two — winnow's own `receipts.py` takes the same position and
 * says so in the same words.
 */
export function recordPrune(
  runId: string,
  trigger: PruneTrigger,
  outcome: PruneOutcome,
  model: string | null,
): void {
  try {
    db()
      .prepare(
        `INSERT INTO prune_receipts
           (ts, run_id, trigger, tier, tokens_before, tokens_after, tokens_removed, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        runId,
        trigger,
        outcome.tier,
        outcome.tokensBefore,
        outcome.tokensAfter,
        outcome.tokensRemoved,
        model,
      );
  } catch {
    // See above. A receipt is evidence, not the thing itself.
  }
}

/* ------------------------------------------------------------------ */
/* What a prune was worth — netted, never gross                        */
/* ------------------------------------------------------------------ */

/**
 * One prune, as stored.
 *
 * `turnsAfter` is not on the row: it is counted at read time from the usage
 * entries this app already scans, because it goes on growing for as long as the
 * run does. A figure written at prune time would be zero for every receipt.
 */
export interface PruneReceiptRow {
  ts: number;
  runId: string;
  trigger: PruneTrigger;
  tier: PruneTier;
  tokensBefore: number;
  tokensAfter: number;
  tokensRemoved: number;
  model: string | null;
}

/** What a prune actually came to, once both sides are counted. */
export interface PruneNet {
  /** Turns that have carried the smaller conversation. The saving is over these. */
  turnsAfter: number;
  /**
   * False when the model this ran on has no price here, in which case the three
   * figures below are 0 and mean **unknown** rather than nothing.
   *
   * Carried rather than folded into a 0, because `metering.md`'s rule is that an
   * unknown renders as indeterminate and never as a zero — a prune that saved a
   * dollar on an unpriced model must not read as a prune that saved nothing.
   * The aggregate keeps the count so a reader can be told what the money covers.
   */
  priced: boolean;
  /** What not re-reading the removed tokens saved, at the cache-read rate. */
  cacheSavedUSD: number;
  /** What the edit cost, which is nothing at a boundary. */
  invalidationUSD: number;
  /** The only figure worth leading with. */
  netUSD: number;
}

/**
 * Price one receipt.
 *
 * ## Why a boundary prune pays no invalidation
 *
 * Editing a cached prefix normally forces a full-price rewrite of everything
 * after the cut. A boundary prune does not, and this is not an approximation:
 * the next cycle opens with `--resume`, which rewrites that prefix whether or
 * not anything was removed from it. The rewrite is the resume's cost, already
 * committed before the prune ran, so charging it here would be charging twice
 * for one write. An early end is the opposite case — it *created* the resume —
 * so it pays for the context the resume then writes.
 *
 * ## Why the saving is measured and not projected
 *
 * `turnsAfter` is turns that have already happened, so `cacheSavedUSD` is a
 * count of re-reads that demonstrably did not occur, not a forecast of ones that
 * might not. It grows while a run is live and stops when the run does, which is
 * the correct shape: this is a measurement whose value is not final until the
 * thing being measured has ended.
 *
 * The rate is the one-hour write class rather than the five-minute one, because
 * that is what was **measured** on this install — every main-thread turn across
 * 26,194 wrote at the one-hour class. Using the list-price 1.25× is the specific
 * error winnow's own `docs/COZEMPIC.md` §3.1 keeps on the record: it understates
 * invalidation by about 40%, which flatters exactly the marginal cuts.
 */
export function netReceipt(row: PruneReceiptRow, turnsAfter: number): PruneNet {
  // Priced at the rate for the run's own model, and `at` is the receipt's own
  // timestamp rather than now — `byAgent.counterfactualUSD`'s rule: a rate
  // looked up at read time prices last week's prune at this week's list.
  const price = resolvePrice(row.model ?? undefined, { at: row.ts });
  if (!price) {
    return {
      turnsAfter,
      priced: false,
      cacheSavedUSD: 0,
      invalidationUSD: 0,
      netUSD: 0,
    };
  }
  const perToken = price.input / 1_000_000;

  const cacheSavedUSD =
    row.tokensRemoved * turnsAfter * perToken * CACHE_READ_MULTIPLIER;
  const invalidationUSD =
    row.trigger === "early-end"
      ? row.tokensAfter * perToken * CACHE_WRITE_1H_MULTIPLIER
      : 0;

  return {
    turnsAfter,
    priced: true,
    cacheSavedUSD,
    invalidationUSD,
    netUSD: cacheSavedUSD - invalidationUSD,
  };
}

/** Several receipts, added up. */
export interface PruneSavings {
  prunes: number;
  /**
   * How many of them the money below actually covers.
   *
   * Below `prunes` when a run used a model with no price here. The gap is the
   * thing to render — the alternative is a total that silently omits some of its
   * own subject.
   */
  pricedPrunes: number;
  tokensRemoved: number;
  turnsAfter: number;
  cacheSavedUSD: number;
  invalidationUSD: number;
  netUSD: number;
}

export const NO_PRUNE_SAVINGS: PruneSavings = {
  prunes: 0,
  pricedPrunes: 0,
  tokensRemoved: 0,
  turnsAfter: 0,
  cacheSavedUSD: 0,
  invalidationUSD: 0,
  netUSD: 0,
};

/**
 * Add up a set of already-priced receipts.
 *
 * Pure and separate from the reading so that the arithmetic is testable without
 * a database and a transcript scan behind it.
 */
export function sumPruneSavings(
  priced: readonly { row: PruneReceiptRow; net: PruneNet }[],
): PruneSavings {
  return priced.reduce<PruneSavings>(
    (acc, { row, net }) => ({
      prunes: acc.prunes + 1,
      pricedPrunes: acc.pricedPrunes + (net.priced ? 1 : 0),
      tokensRemoved: acc.tokensRemoved + row.tokensRemoved,
      // Summed rather than maxed: two prunes on one run each saved their own
      // tokens over their own turns, and the second one's turns are a subset of
      // the first's. It is a total of turn-savings, not a count of distinct
      // turns, which is why the field sits beside the money rather than being
      // reported as "the run took this many turns".
      turnsAfter: acc.turnsAfter + net.turnsAfter,
      cacheSavedUSD: acc.cacheSavedUSD + net.cacheSavedUSD,
      invalidationUSD: acc.invalidationUSD + net.invalidationUSD,
      netUSD: acc.netUSD + net.netUSD,
    }),
    NO_PRUNE_SAVINGS,
  );
}

/** Read receipts in a window, or for one run. */
export function readReceipts(
  filter: { from: number; to: number } | { runId: string },
): PruneReceiptRow[] {
  const sql =
    "runId" in filter
      ? `SELECT ts, run_id, trigger, tier, tokens_before, tokens_after, tokens_removed, model
           FROM prune_receipts WHERE run_id = ? ORDER BY ts`
      : `SELECT ts, run_id, trigger, tier, tokens_before, tokens_after, tokens_removed, model
           FROM prune_receipts WHERE ts >= ? AND ts <= ? ORDER BY ts`;
  const args = "runId" in filter ? [filter.runId] : [filter.from, filter.to];
  try {
    const rows = db().prepare(sql).all(...args) as {
      ts: number;
      run_id: string;
      trigger: string;
      tier: string;
      tokens_before: number;
      tokens_after: number;
      tokens_removed: number;
      model: string | null;
    }[];
    return rows.map((r) => ({
      ts: r.ts,
      runId: r.run_id,
      trigger: r.trigger === "early-end" ? "early-end" : "boundary",
      tier: isPruneTier(r.tier) ? r.tier : "standard",
      tokensBefore: r.tokens_before,
      tokensAfter: r.tokens_after,
      tokensRemoved: r.tokens_removed,
      model: r.model,
    }));
  } catch {
    return [];
  }
}

/**
 * What pruning has been worth, over a window or over one run.
 *
 * Async because the turn count comes from the transcript scan rather than from
 * the database — a turn is not a row here, and inventing a counter that
 * incremented alongside `runs.iterations` would be counting cycles rather than
 * the API calls the saving is actually per.
 *
 * **The session a receipt is attributed to is the run's current one.** A run
 * that adopted a new session id mid-flight (see `adoptSession`) has its earlier
 * receipts counted against turns of the later session, which under-counts rather
 * than over-counts: the earlier session's turns are simply not found. Stated
 * because a saving that reads low is the kind of wrong nobody investigates.
 */
export async function pruneSavings(
  filter: { from: number; to: number } | { runId: string },
): Promise<PruneSavings> {
  const receipts = readReceipts(filter);
  if (receipts.length === 0) return NO_PRUNE_SAVINGS;

  // One lookup per distinct run rather than per receipt: a long run can hold
  // several.
  const sessions = new Map<string, string | null>();
  for (const r of receipts) {
    if (!sessions.has(r.runId)) {
      const row = db()
        .prepare("SELECT session_id FROM runs WHERE id = ?")
        .get(r.runId) as { session_id: string | null } | undefined;
      sessions.set(r.runId, row?.session_id ?? null);
    }
  }

  const { entries } = await scanUsage();
  // Main thread only. A sub-agent's context is its own and is discarded when it
  // answers, so pruning the main transcript changes nothing a sidechain turn
  // carries — counting them would credit the prune with savings on turns it
  // never touched. Same split `transcripts.ts` makes everywhere else.
  const mainThread = entries.filter((e) => !e.isSidechain);

  const priced = receipts.map((row) => {
    const sessionId = sessions.get(row.runId) ?? null;
    const turnsAfter = sessionId
      ? mainThread.filter((e) => e.sessionId === sessionId && e.ts > row.ts).length
      : 0;
    return { row, net: netReceipt(row, turnsAfter) };
  });

  return sumPruneSavings(priced);
}
