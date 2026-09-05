import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./config";
import { db } from "./db";
import { BYTES_PER_TOKEN } from "./fileCostNotice";
// Client-safe presentation helper, no node builtins behind it — see format.ts.
import { fmtTokens } from "./format";
import { opsLog, recordOpsEvent } from "./ops";
import { childCredentials } from "./privsep";
import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  cacheReadMultiplierOf,
  resolvePrice,
} from "./pricing";
import { scanUsage, type UsageEntry } from "./transcripts";
import type {
  ContextCheckDTO,
  ContextCompositionDTO,
  ContextCompositionNodeDTO,
  ContextOccupancyDTO,
  ContextPrunerDTO,
  ContextSampleBasisDTO,
  PruneActivityDTO,
  PruneTier,
} from "./apiTypes";
import { PRUNE_ENGINE_LABEL } from "./pruneStatement";
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
 * **200,000 since 2026-08-25.** It was 167,000 — the number `--autocompact
 * 200000` fired at — and was raised to 300,000 and lowered again on the same
 * day. Matching the flag's number was the right discipline for the change that
 * removed it: that change swapped the *mechanism* bounding a long cycle, and
 * moving the trigger point in the same commit would have left nothing able to
 * tell which half a later reading was seeing. That comparison has been made and
 * is in `docs/verification.md`, so the number is now free to be chosen on its
 * own merits.
 *
 * It is above 167,000 because what this bounds turned out not to be the
 * quantity that number described. The ceiling reads the **whole prompt**, and
 * ~55,000 tokens of it are a fixed system prompt, tool list, `CLAUDE.md` and
 * appended notices that no prune can reach — measured on this install, where a
 * cycle's first request carried 57,819 tokens against 2,759 tokens of
 * conversation. At 167,000 that left ~112,000 tokens of prunable conversation,
 * and a run on this repository crossed the ceiling again within five minutes of
 * its own prune; what stopped the loop from repeating was
 * `PAYBACK_HORIZON_TURNS` refusing the second cut, not the ceiling doing its
 * job. 200,000 leaves ~145,000, which is roughly the width the old number was
 * believed to be giving.
 *
 * **It is not 300,000, and that is a judgement rather than a measurement.**
 * Every turn carries the whole prompt at the cache-read rate, so a cycle that
 * runs to 300,000 pays roughly 1.8× per turn what one stopping at 167,000 does,
 * against a saving that is only the manufactured boundaries it does not pay
 * for. On the runs this install saw at 300,000 the operator read that trade as
 * cost with no return, and the ceiling came back down. Nothing here prices the
 * two sides — `prune_receipts` and `netReceipt` are where that would show up,
 * and no reading off them has been recorded either way.
 *
 * **What it is not bounded by is the model's window.** The CLI resolves a
 * window near 1M for the model this fleet runs and refuses to auto-compact one
 * that large (`docs/agent/run-lifecycle.md`), and this install's own
 * transcripts carry a single request of **752,172 tokens** on
 * `claude-opus-5` — so 200,000 is nowhere near a limit that would turn a cycle
 * into an API error. A fleet running a 200,000-token model would need this
 * lower — the ceiling would stand at that model's entire window — and nothing
 * here checks it: there is no per-model window in this app, and inventing a
 * table of them for a case no run on this install has hit would be a second
 * thing to keep in step with the provider.
 *
 * A module constant rather than a setting, on `AUTOCOMPACT_WINDOW_TOKENS`'
 * argument, which this inherits along with its job: it trades context against
 * re-derivation, and an operator has no way to see the thing being traded.
 */
export const CYCLE_CONTEXT_CEILING_TOKENS = 200_000;

/**
 * How many further turns a cut is allowed to need, under `paybackTurns`.
 *
 * `boundaryAction` consults this and nothing else does. A run that has just
 * reached a cycle boundary may have any number of cycles left, and "has more
 * work to do" is not "has 60 turns left" — nothing here knows how many remain,
 * and a cut that needs more turns than the run has is a cost with no return at
 * all.
 *
 * 18 because it is the break-even for cutting **half** the suffix
 * (`19·2 − 20`), which is the case winnow's own SPEC calls out as clearly worth
 * doing. Anything needing longer than that is a bet on a run's remaining length
 * that this app cannot price, and the safe direction is to leave the context
 * alone: an unpruned cycle costs cache reads at 0.1×, where a cut that never
 * pays back has already spent the invalidation at ~2×.
 *
 * The ceiling asks the same question through a different formula and so needs
 * its own number: `CEILING_PAYBACK_HORIZON_TURNS`.
 */
export const PAYBACK_HORIZON_TURNS = 18;

/**
 * The same judgement at the ceiling, restated in the arithmetic used there.
 *
 * These are one policy — *cutting half is clearly worth doing, and past that
 * this app is betting on a run's remaining length it cannot price* — expressed
 * twice, because the two call sites price different quantities. `paybackTurns`
 * is `19·(S/D) − 20` over the **suffix**, and half of it costs 18 turns.
 * `ceilingPayback` is `20·(C − D)/D` over the **whole conversation**, and half
 * of *it* costs 20.
 *
 * Sharing the 18 across both therefore refused the very case it was chosen to
 * admit: an exactly-half cut priced at 20 against a limit of 18, off by the
 * difference between two formulas rather than by any decision anyone made.
 *
 * So neither constant may be used at the other's call site, and folding them
 * back together would reintroduce that. What they must keep in common is the
 * *case* — half — not the number it comes out as.
 */
export const CEILING_PAYBACK_HORIZON_TURNS = 20;

/**
 * How much a conversation must grow before the ceiling re-measures it.
 *
 * `checkContextCeilings` runs on the live ticker — every
 * `liveGuardIntervalSeconds`, 60 by default — and the measurement it takes
 * spawns the configured engine over the whole transcript (`ceilingCut`, so
 * `winnow plan` or a `treat` dry run). Without a growth gate a run parked above
 * the ceiling would spawn one subprocess a minute against a multi-megabyte
 * file, for hours.
 *
 * ## Why growth, and why this much of it
 *
 * A decline can only become an approval if `D` grows faster than the
 * conversation does, and clearing `CEILING_PAYBACK_HORIZON_TURNS` needs
 * `D/C ≥ 50%`. Under the fork engine the gap to that is wide: a run declining
 * at `D/C = 9%` would need about 164,000 further tokens to reach it even if
 * **every** one of them were strippable, so the answer is close to stable and a
 * threshold well under that is already generous.
 *
 * Under the in-place pruner it is not wide at all — `treat -rx aggressive`
 * measures at 49%–53% of the file on this install, which straddles the
 * threshold — and that is the case a latch would get wrong. `boundaryDeclines`
 * makes the same argument about the same arithmetic: `D` is whatever the newest
 * work happened to produce, and one cycle that greps a large tree or runs a long
 * build moves it. A permanent decline on one reading would miss exactly that.
 *
 * 25,000 tokens is roughly five to eight turns at the rate these runs
 * accumulate context — frequent enough to catch a run crossing a threshold it
 * is sitting on, and a sixtieth of the subprocesses.
 *
 * It also paces the operator-facing line, which is deliberate:
 * `ceilingDeclineMessage` is emitted once per measurement, so the log follows
 * the run's growth and never a clock. A run that stops growing stops saying
 * anything, because nothing about it has changed.
 */
export const CEILING_REMEASURE_GROWTH_TOKENS = 25_000;

/**
 * The tier `plan` is asked at, for the read-only observation beside each prune.
 *
 * Fixed rather than derived from `contextPruningStrictness`, because the two
 * vocabularies do not map: `gentle`/`standard`/`aggressive` name bundles of
 * inherited strategies and `C`/`CB`/`CBA` name SPEC §4 rule tiers, and there is
 * no correspondence to translate. CB is the tier every published figure in that
 * project is quoted at, so an observation taken here can be read against them.
 */
export const PLAN_TIER = "CB";

/** How long a prune may take before it is killed and the cycle carries on. */
const PRUNE_TIMEOUT_MS = 120_000;

/** What a prune did, in the only units worth reporting. */
export interface PruneOutcome {
  tier: PruneTier;
  /**
   * What the transcript's own turns came to before the prune, through
   * `contextTokens`. The conversation and nothing else: it is the one measure
   * that can express a before-and-after, and it holds none of the system
   * prompt, tool definitions or project instructions a request also carries.
   */
  tokensBefore: number;
  /** And after. */
  tokensAfter: number;
  /** `tokensBefore - tokensAfter`, never negative. */
  tokensRemoved: number;
  /**
   * What the API was carrying before the prune, through `apiContextTokens` —
   * the same reading the cycle ceiling acts on.
   *
   * Here so that the two lines an operator reads about one prune are in one
   * currency. The ceiling names the whole prompt and the three figures above
   * name the conversation inside it, and those are tens of thousands of tokens
   * apart **in either direction**, which is why neither can be derived from the
   * other by a constant. Measured on this install on 2026-08-25, a cycle the
   * ceiling ended at 183,214 tokens had a transcript `contextTokens` put at
   * 118,776: the system prompt, tool list, `CLAUDE.md` and the appended notices
   * are ~55,000 tokens the transcript never holds and no prune reaches, read
   * straight off that cycle's first request, which carried 57,819 tokens
   * against 2,759 of conversation. `apiContextTokens`' own note records the
   * opposite case from the same day — transcripts of 183,803 and 192,241
   * against API peaks of 114,485 and 123,524 — where the intake filter was
   * dropping more on the wire than the overhead was adding.
   *
   * Two numbers that far apart for one operation, one line under the other,
   * read as a bug in whichever of them the reader trusts less, which is what
   * they were reported as.
   */
  apiTokensBefore: number;
  /** Wall time the subprocess took, for the log line. */
  elapsedMs: number;
}

export type PruneResult =
  | { kind: "pruned"; outcome: PruneOutcome }
  | { kind: "nothing"; tokensBefore: number }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * Why a switched-on pruner cannot act, in the one wording both surfaces use.
 *
 * A module constant rather than a literal at the `pruneTranscript` branch that
 * used to hold it, because it is now read twice: once into the run log and once
 * onto `ContextPrunerDTO.detail`, which two screens render. A hedge worded
 * twice is a hedge that drifts, and the drift is invisible — the two copies
 * would still both typecheck and still both read as sentences.
 */
export const WINNOW_MISSING_REASON = `winnow is not installed at ${WINNOW_ROOT} — this image was built with WINNOW_REF empty`;

/**
 * How long a `winnowAvailable()` answer is reused.
 *
 * The probe used to run only on the run loop's path, a handful of times per
 * work cycle. It is now also on the dashboard's heartbeat and the run page's
 * three-second poll, so an uncached `statSync` would sit on a request path that
 * repeats for as long as a tab is open. The answer can only change by a rebuild
 * or an edit to a bind-mounted checkout, so a minute bounds even the second.
 */
const WINNOW_PROBE_TTL_MS = 60_000;

/**
 * A new key rather than a reuse, on `orchestrator.ts:373`'s trap: `??=` only
 * initialises when absent, so a value of a different shape left at an old key
 * by a pre-upgrade dev process survives the hot reload and every call on it
 * throws.
 */
const winnowProbe = ((globalThis as unknown as {
  __ufWinnowProbeV1?: { at: number; ok: boolean };
}).__ufWinnowProbeV1 ??= { at: 0, ok: false });

/**
 * Is the bundled tool actually here?
 *
 * Probed rather than assumed because the Dockerfile's `WINNOW_REF` may be empty
 * — an install that deliberately built without it — and because this runs on the
 * run loop's path, where an exception would end a cycle that was doing fine.
 *
 * Cached in place rather than behind a second, read-only twin: the guard that
 * decides whether to spawn and the readout that tells an operator whether it
 * can must never be able to disagree, and two functions over one fact is
 * exactly how they come to.
 */
export function winnowAvailable(): boolean {
  const now = Date.now();
  if (now - winnowProbe.at < WINNOW_PROBE_TTL_MS) return winnowProbe.ok;
  let ok: boolean;
  try {
    ok = fs.statSync(WINNOW_PYTHON).isFile();
  } catch {
    ok = false;
  }
  winnowProbe.at = now;
  winnowProbe.ok = ok;
  return ok;
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
 * ## What it still overcounts, measured, and why that is left alone
 *
 * This reads the transcript on disk, and winnow's **intake filter** never
 * touches the transcript — it rewrites the request on its way to the API. So a
 * result the filter had already replaced with a pointer is still here in full,
 * and a prune that removes it counts tokens the API never held and prices
 * re-reads that were never going to happen. Measured 2026-08-24 by running the
 * real `winnow treat -rx standard --execute` over this install's ten largest
 * transcripts and classifying each removed block against the filter's own
 * rules: **4.06% of removed tokens corpus-weighted**, 3.07% unweighted, range
 * 0.00%–9.92%, and an upper bound — the reconstruction ignores `keep_newest`,
 * so it calls a block phantom that the filter would have deferred rather than
 * dropped.
 *
 * Not corrected, because the correction is not available: telling those blocks
 * apart needs a `tool_use_id` on each ledger line and winnow writes none yet
 * (`intakeFilter.ts` puts every result on its fallback key today). The only
 * alternative is reimplementing `rule_for`/`LOCATOR_TOOLS`/`VERIFICATION_RE`/
 * `min_bytes`/`keep_newest` here and keeping them in step with a Python module
 * in another repository — a duplication that would still approximate, since
 * `keep_newest` turns on per-request state no transcript records. So the figure
 * carries a known 4% overstatement rather than a guessed correction, and the
 * dashboard never adds it to the filter's own: `docs/verification.md` and
 * `ContextControlAside` both say so on the page.
 *
 * Returns 0 for a file it cannot read, never throws: every caller is on the run
 * loop's path and none of them should end a cycle over a stat.
 */
export function contextTokens(transcriptPath: string): number {
  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return 0;
  }
  return contextTokensOf(text);
}

/**
 * The measurement above, over text the caller has already read.
 *
 * `readContext` reaches its fallbacks holding the whole file in a string, and
 * calling `contextTokens` from there read those same bytes off disk a second
 * time within the one call — 7.6 ms of the 31.9 ms that call costs on the
 * largest transcript this store holds. Measuring the string in hand also makes
 * the two halves of the answer describe one snapshot rather than two reads taken
 * milliseconds apart on a file being appended to.
 */
function contextTokensOf(text: string): number {
  let bytes = 0;
  // The whole walk stays inside a catch, not just the per-line parse: the
  // measurement above promises never to throw, its callers are all on the run
  // loop, and splitting the read out of that promise must not quietly narrow
  // it. `miss` reaches this directly, so the guarantee has to live here.
  try {
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
 * The context the **API actually saw**, read off the transcript's own `usage`.
 *
 * ## Why this is not `contextTokens`, and why both have to exist
 *
 * `contextTokens` sums the transcript's message envelopes and divides by
 * `BYTES_PER_TOKEN`. That is the right measure for the prune delta — historical
 * `usage` frames record what was billed and cannot change when content is
 * edited, so they structurally cannot express a before/after difference — and it
 * is the wrong measure for the ceiling, because the transcript is not what the
 * API receives.
 *
 * Two things separate them, and the gap is not small. `bytes / 4` is a crude
 * estimator that runs high on structured tool output; and winnow's intake filter
 * drops tool results *on the wire* while Claude Code keeps writing the full
 * bytes to disk, so every byte the filter removes is still counted by a
 * transcript-derived measure. Measured on this install on 2026-08-25, two runs
 * that `contextTokens` put at 183,803 and 192,241 tokens had API-visible peaks
 * of 114,485 and 123,524 — the ceiling was firing roughly 69,000 tokens early,
 * against a conversation that was never that large.
 *
 * ## What it returns
 *
 * The prompt the last completed request carried, plus that turn's output, which
 * together are what the *next* request will carry before it adds anything new.
 * `input + cache_creation + cache_read` is the whole prompt however it was
 * billed — a cached token is still a token the model reads.
 *
 * It lags by one turn by construction, because it reports a request that has
 * finished. That is the right direction to be wrong in for a ceiling: it never
 * ends a cycle for context the API has not actually been asked to carry.
 *
 * Falls back to `contextTokens` rather than to zero when no usage frame exists —
 * a fresh session, or one whose only assistant turns are `<synthetic>`. Zero
 * would read as "this run is empty" and silently disable the ceiling, which is
 * the one failure this must not have.
 */
export function apiContextTokens(transcriptPath: string): number {
  return readContext(transcriptPath, null, false).tokens;
}

/**
 * The same reading, plus where in the conversation it came from.
 *
 * A sibling of `apiContextTokens` rather than a widening of it, because the two
 * callers want different amounts of work out of one scan. The ceiling wants the
 * number and nothing else, and its scan stops at the first `usage` frame — a
 * handful of lines from the end of the file, which is what makes it affordable
 * once a minute per live run. The occupancy series also wants a turn count, and
 * a count means walking back **past** that frame, so it is asked for explicitly
 * and only by the caller that needs it.
 *
 * `sinceFrameId` is what keeps that walk cheap in the steady state: given the
 * frame the previous sample came from, the scan stops there, so it parses only
 * the turns that have happened since. A run's *first* sample has nothing to stop
 * at and pays for the whole window once.
 *
 * Never throws, `apiContextTokens`' rule and for its reason: every caller is on
 * the run loop's path.
 */
export function apiContextSample(
  transcriptPath: string,
  sinceFrameId: string | null,
): ContextReading {
  return readContext(transcriptPath, sinceFrameId, true);
}

/**
 * Which measure produced a reading. Never mixed in one arithmetic.
 *
 * The two stored values are the DTO's, so a consumer and this module cannot
 * drift apart on what a series is measured in; `unreadable` is this side only,
 * because nothing that failed to read is ever written down.
 */
export type ContextBasis = ContextSampleBasisDTO | "unreadable";

/** One reading of a live transcript's tail. */
export interface ContextReading {
  /** What `apiContextTokens` answers; 0 under `unreadable`. */
  tokens: number;
  basis: ContextBasis;
  /**
   * `message.id` of the frame the number came from, or null — under the
   * `transcript` basis there is no frame, and a frame is not obliged to carry
   * an id. Null is what pushes deduplication down onto the number itself.
   */
  frameId: string | null;
  /**
   * Main-thread assistant turns between `sinceFrameId` and this reading, or —
   * when nothing was passed to stop at — every one the scan could see.
   */
  turnsAdvanced: number;
  /** Whether `sinceFrameId` was located, so the advance is a measurement. */
  sinceFound: boolean;
  /** Whether the scan reached the start of the file rather than of a window. */
  wholeFile: boolean;
}

function readContext(
  transcriptPath: string,
  sinceFrameId: string | null,
  countTurns: boolean,
): ContextReading {
  // `text` is the whole file where the caller already holds it, which every
  // path that reaches a `transcript` basis does — the fallback below has just
  // read it, and a tail that came back `whole` *is* it. Re-reading those bytes
  // was a second multi-megabyte read inside the one call.
  const miss = (
    basis: ContextBasis,
    wholeFile: boolean,
    text?: string,
  ): ContextReading => ({
    tokens:
      basis === "unreadable"
        ? 0
        : text !== undefined
          ? contextTokensOf(text)
          : contextTokens(transcriptPath),
    basis,
    frameId: null,
    turnsAdvanced: 0,
    sinceFound: false,
    wholeFile,
  });

  let tail: { text: string; whole: boolean };
  try {
    tail = readTail(transcriptPath, TAIL_SCAN_BYTES);
  } catch {
    return miss("unreadable", false);
  }
  const fromTail = scanTail(tail.text, sinceFrameId, countTurns);
  if (fromTail) return { ...fromTail, basis: "api", wholeFile: tail.whole };
  if (!tail.whole) {
    // Nothing usable in the last megabyte, which is possible rather than
    // theoretical: the largest transcript on this install is 9.1 MB over 789
    // lines, so one tool result can be bigger than the window. Pay for the whole
    // file rather than report a conversation as empty.
    let whole: string;
    try {
      whole = fs.readFileSync(transcriptPath, "utf8");
      const fromWhole = scanTail(whole, sinceFrameId, countTurns);
      if (fromWhole) return { ...fromWhole, basis: "api", wholeFile: true };
    } catch {
      // The read *or* the scan: both were inside this catch before the text was
      // hoisted out of it, and a scan that threw answered `unreadable`.
      return miss("unreadable", false);
    }
    return miss("transcript", true, whole);
  }
  // `tail.whole` is true here, so `readTail` returned the file entire and it is
  // exactly what `contextTokens` would have gone back to disk for.
  return miss("transcript", tail.whole, tail.text);
}

/** What one backwards pass over a transcript's tail found. */
interface TailScan {
  tokens: number;
  frameId: string | null;
  turnsAdvanced: number;
  sinceFound: boolean;
}

/**
 * The prompt-plus-output of the last main-thread turn in `text`, and how many
 * turns have happened since `sinceFrameId`.
 *
 * One pass, backwards, because that is where the answer is and because a
 * transcript is appended to while this runs. The two exclusions are the same two
 * the ceiling has always made and neither may be relaxed: a sidechain is a
 * sub-agent's own conversation rather than this one's context, and a
 * `<synthetic>` frame is the CLI's record of an API-level refusal carrying an
 * all-zero `usage` block that would read as an empty run.
 *
 * Turns are counted as **distinct `message.id`s**, not as records: the CLI
 * writes an assistant turn that both spoke and called a tool as more than one
 * line sharing one id, and counting lines would report a tool-heavy run as
 * having had several times the turns it did.
 */
function scanTail(
  text: string,
  sinceFrameId: string | null,
  countTurns: boolean,
): TailScan | null {
  const lines = text.split("\n");
  let tokens: number | null = null;
  let frameId: string | null = null;
  let turnsAdvanced = 0;
  let lastId: string | null | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let record: {
      type?: unknown;
      isSidechain?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
    };
    try {
      record = JSON.parse(trimmed);
    } catch {
      // A torn trailing line is normal on a transcript being appended to.
      continue;
    }
    if (record?.type !== "assistant") continue;
    // A sub-agent's turns are not this conversation's context, and
    // `<synthetic>` frames carry an all-zero usage block that would read as an
    // empty run.
    if (record.isSidechain === true) continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    if (message.model === "<synthetic>") continue;

    const id = typeof message.id === "string" && message.id ? message.id : null;

    // Read the number *before* testing for the stopping frame, so a tick on
    // which nothing has happened still reports that frame's own tokens rather
    // than zero. That case is the ordinary one: the ticker is time-based and one
    // tool call routinely outlasts several ticks.
    if (tokens === null) {
      const usage = message.usage;
      if (usage && typeof usage === "object") {
        const num = (key: string): number => {
          const v = usage[key];
          return typeof v === "number" && Number.isFinite(v) ? v : 0;
        };
        const prompt =
          num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
        if (prompt > 0) {
          tokens = prompt + num("output_tokens");
          frameId = id;
          // The ceiling's caller asked for a number and nothing else, so this is
          // where its scan ends — a few lines from the end of the file.
          if (!countTurns) break;
        }
      }
    }

    if (countTurns) {
      // Everything newer than the previous sample's frame is what has happened
      // since; the frame itself was counted by the sample that named it.
      if (id !== null && id === sinceFrameId) {
        if (tokens === null) return null;
        return { tokens, frameId, turnsAdvanced, sinceFound: true };
      }
      if (id === null || id !== lastId) turnsAdvanced += 1;
      lastId = id;
    }
  }
  if (tokens === null) return null;
  return { tokens, frameId, turnsAdvanced, sinceFound: false };
}

/**
 * How much of a transcript's end is read looking for the last `usage` frame.
 *
 * A whole-file read used to be gated by a `statSync` in `checkContextCeilings`,
 * and that gate had to go — the prompt carries tens of thousands of tokens no
 * transcript holds, so a file under any byte threshold can be a cycle over the
 * ceiling. This is what replaces it, and it bounds the work rather than
 * guessing at it: the ceiling runs once a minute per live run, and the median
 * transcript here is 771 KB against a 9.1 MB largest, where a whole-file read
 * and split measured 23 ms.
 *
 * A megabyte because a line is a turn and a turn can be a tool result. The
 * largest file here averages 11.6 KB per line, so this covers roughly 90 turns
 * of the worst case measured; the fallback above covers the rest rather than
 * this being sized for it.
 */
const TAIL_SCAN_BYTES = 1_048_576;

/**
 * The last `bytes` of a file, or all of it when it is smaller.
 *
 * `whole` is what tells the caller whether a miss is final. A window that
 * starts mid-line leaves a torn first line, which the scan below drops the same
 * way it drops the torn *last* line of a transcript being appended to — and a
 * window that starts mid-character leaves a replacement char in that same line.
 */
function readTail(file: string, bytes: number): { text: string; whole: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= bytes) return { text: fs.readFileSync(fd, "utf8"), whole: true };
    const buffer = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, size - bytes);
    return { text: buffer.subarray(0, read).toString("utf8"), whole: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** The prompt-plus-output of the last main-thread turn in `text`, or null. */
function lastPromptTokens(text: string): number | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let record: {
      type?: unknown;
      isSidechain?: unknown;
      message?: { model?: unknown; usage?: Record<string, unknown> };
    };
    try {
      record = JSON.parse(trimmed);
    } catch {
      // A torn trailing line is normal on a transcript being appended to.
      continue;
    }
    if (record?.type !== "assistant") continue;
    // A sub-agent's turns are not this conversation's context, and
    // `<synthetic>` frames carry an all-zero usage block that would read as an
    // empty run.
    if (record.isSidechain === true) continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    if (message.model === "<synthetic>") continue;
    const usage = message.usage;
    if (!usage || typeof usage !== "object") continue;
    const num = (key: string): number => {
      const v = usage[key];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };
    const prompt =
      num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
    if (prompt <= 0) continue;
    return prompt + num("output_tokens");
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The occupancy series — what a live run's context was doing           */
/* ------------------------------------------------------------------ */

/**
 * How many samples one run may keep, oldest discarded first.
 *
 * These rows are written on the run loop's path for every live run and nothing
 * about a run bounds how many turns it takes, so an unbounded table here is a
 * defect rather than a follow-up. 2,000 is far past anything observed — the
 * series holds about one row per assistant turn once duplicates are dropped,
 * and no run on this install has come near that — so the cap is a backstop
 * against a pathological run rather than a shape the ordinary one meets.
 *
 * The **oldest** go, because the reason to look at this series is a run that is
 * either live now or was live recently, and its recent shape is what an operator
 * is reading. A run that hits the cap says so through `sampleCount`, which is
 * the stored total rather than the number returned.
 */
export const CONTEXT_SAMPLES_PER_RUN = 2_000;

/**
 * How many samples the run DTO carries, newest first.
 *
 * The run page polls that route every three seconds for as long as a tab is
 * open, and a run can be hours long, so the series is capped there as well as in
 * the table. A **tail** rather than a thinned series, deliberately: thinning
 * needs a rule about which points survive, and a series thinned by a rule the
 * consumer cannot see is a graph that lies about its own peaks — which is the
 * one thing a context meter must not do. The DTO carries the stored total beside
 * the array so a reader can see that it is holding the end of something longer.
 */
export const CONTEXT_SERIES_MAX_POINTS = 500;

/** The same rule for the prune marks that sit under the series. */
export const CONTEXT_PRUNE_MARKS_MAX = 200;

/** The last sample stored for a run, as SQLite holds it. */
interface StoredSample {
  frame_id: string | null;
  basis: string;
  tokens: number;
  turn_index: number;
  turns_exact: number;
}

/**
 * Take a reading of one live run's context and store it if it is new.
 *
 * Called from the live-guard tick, which already had this number in hand and
 * threw it away: the ceiling compares it and `continue`s on everything below,
 * which is every value a graph of occupancy is made of. So this is the same
 * measurement, taken once, written down — it adds no second transcript read and
 * no tokeniser, and it returns the reading so its caller can go on to make the
 * ceiling decision from it.
 *
 * **Deduplicated on the frame the number came from.** The ticker is time-based
 * and a single tool call routinely outlasts several ticks, so consecutive reads
 * return the identical `usage` frame; a row per tick would make the series
 * mostly flat duplicates and a graph of it would understate how fast context is
 * actually growing. When there is no frame to name — the byte-estimate fallback,
 * or a frame carrying no id — the identity falls back to (basis, tokens), which
 * is the same statement one measure down.
 *
 * Never throws. A sample is evidence, `recordPrune`'s rule: losing one must not
 * turn a live run into a failed one.
 */
export function sampleContext(
  runId: string,
  iteration: number,
  transcriptPath: string,
): ContextReading {
  let last: StoredSample | undefined;
  try {
    last = db()
      .prepare(
        `SELECT frame_id, basis, tokens, turn_index, turns_exact
           FROM context_samples WHERE run_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as StoredSample | undefined;
  } catch (err) {
    // Read first so the scan can stop at the previous sample's frame. Failing
    // here costs the turn count its exactness, never the reading.
    noteBookkeepingFailure("sampleContext.read", err);
  }

  const reading = apiContextSample(transcriptPath, last?.frame_id ?? null);
  // Before every return below, because every one of them is a tick that looked.
  // The two returns that follow write no row, and they are the ordinary case
  // rather than the exception — see `noteContextCheck`.
  noteContextCheck(runId, reading);

  // A transcript that could not be read is not a run whose context fell to
  // nothing, and neither is a conversation that has not opened yet. Both would
  // draw a cliff that never happened, which is worse than a gap.
  if (reading.basis === "unreadable" || reading.tokens <= 0) return reading;
  if (last && sameReading(last, reading)) return reading;

  const turns = nextTurnIndex(
    last ? { turnIndex: last.turn_index, exact: last.turns_exact !== 0 } : null,
    reading,
  );

  try {
    db()
      .prepare(
        `INSERT INTO context_samples
           (ts, run_id, iteration, tokens, basis, frame_id, turn_index, turns_exact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        runId,
        iteration,
        reading.tokens,
        reading.basis,
        reading.frameId,
        turns.turnIndex,
        turns.exact ? 1 : 0,
      );
    db()
      .prepare(
        `DELETE FROM context_samples
          WHERE run_id = ?
            AND id NOT IN (
              SELECT id FROM context_samples WHERE run_id = ? ORDER BY id DESC LIMIT ?
            )`,
      )
      .run(runId, runId, CONTEXT_SAMPLES_PER_RUN);
  } catch (err) {
    noteBookkeepingFailure("sampleContext", err);
  }
  return reading;
}

/** Whether a new reading is the one already on the row. */
function sameReading(last: StoredSample, reading: ContextReading): boolean {
  if (reading.frameId !== null) return last.frame_id === reading.frameId;
  return (
    last.frame_id === null && last.basis === reading.basis && last.tokens === reading.tokens
  );
}

/**
 * When each live run's transcript was last read, whatever came of it.
 *
 * ## Why this is not the newest sample's timestamp
 *
 * Measured on this install: a run whose main agent spawned one sub-agent at
 * 18:15:59 gained no sample for **22 minutes**, because every frame written in
 * that stretch was `isSidechain` and this measure excludes them exactly as the
 * ceiling does. The tick ran twenty-two times and read the transcript twenty-two
 * times; the figure it found was the same one every time, and it was *correct* —
 * the parent's context genuinely does not grow while a sub-agent works, since
 * nothing enters it until the tool result returns. The panel nonetheless said
 * "read 22m ago", which is what an operator reads as a dead poll, and the same
 * shape occurs on any tool call that outlasts a few ticks.
 *
 * So the two facts are stored separately: `context_samples` says when the number
 * last *moved*, and this says when it was last *looked at*.
 *
 * ## Why in memory and on `globalThis`
 *
 * It is a property of this process's ticker, not of the run — a server that has
 * just restarted has read nothing, however recently the run it inherited was
 * read by the server before it, and a stored row would let it claim otherwise
 * across exactly the restart an operator is most likely to be watching. A fresh
 * key rather than a reused one, per the note on `orchestrator.ts:373`: `??=`
 * only initialises when absent, so a key whose shape changed survives a dev hot
 * reload with the old value in it.
 *
 * Bounded by `forgetContextCheck` on the run's own teardown, beside the rest of
 * its per-run state.
 */
const contextChecks = ((globalThis as unknown as {
  __ufContextChecks?: Map<string, ContextCheckDTO>;
}).__ufContextChecks ??= new Map<string, ContextCheckDTO>());

/** Write down that a tick read this run, and what measure it came back in. */
function noteContextCheck(runId: string, reading: ContextReading): void {
  contextChecks.set(runId, { ts: Date.now(), basis: reading.basis });
}

/** The last read of one run, or null where this process has taken none. */
export function lastContextCheck(runId: string): ContextCheckDTO | null {
  return contextChecks.get(runId) ?? null;
}

/** Dropped with the run's other per-run state when its loop ends. */
export function forgetContextCheck(runId: string): void {
  contextChecks.delete(runId);
}

/**
 * Where a reading lands on the run's turn counter, and whether that is a fact.
 *
 * Pure, because every way of being wrong here typechecks and produces a number
 * that looks entirely ordinary — a turn axis that quietly stops advancing, or
 * one that double-counts a conversation after a resume, reads as the run having
 * behaved differently rather than as this arithmetic being wrong.
 *
 * Three cases and they are not the same case:
 *
 *  - The scan walked to the **start of the file** without meeting the frame it
 *    was told to stop at. There is nothing before what it counted, so this is
 *    the conversation's whole length rather than an advance on anything — which
 *    is also what a `--resume` into a new transcript looks like from here.
 *  - It met that frame, so the advance is measured and inherits whatever the
 *    previous index was.
 *  - It ran out of **window**. The tail scan is bounded at a megabyte, so the
 *    frame may be real and simply further back than the scan reached; the
 *    advance is then a floor, and a floor added to anything stays one.
 */
export function nextTurnIndex(
  last: { turnIndex: number; exact: boolean } | null,
  reading: Pick<ContextReading, "turnsAdvanced" | "sinceFound" | "wholeFile">,
): { turnIndex: number; exact: boolean } {
  if (!reading.sinceFound && reading.wholeFile) {
    return { turnIndex: reading.turnsAdvanced, exact: true };
  }
  if (last === null) return { turnIndex: reading.turnsAdvanced, exact: false };
  return {
    turnIndex: last.turnIndex + reading.turnsAdvanced,
    exact: last.exact && reading.sinceFound,
  };
}

/**
 * One run's occupancy series, with what a reader needs to draw it against.
 *
 * The ceiling travels with the samples because it is a module constant that has
 * already moved twice — 167,000, then 300,000, then 200,000 — so a consumer
 * computing a percentage against a hardcoded 200k would go on drawing the old
 * number after the next change, silently and correctly-looking.
 *
 * The prune marks travel with them for the same kind of reason: context falling
 * by tens of thousands of tokens between two samples is an unexplained cliff
 * unless the thing that caused it is on the same axis. They are read rather than
 * recomputed — the cut tables already hold them and are the record of what a cut
 * took out — and there are **two** of them. Reading `prune_receipts` alone drew
 * no mark at all on a run the fork engine cut, and reported zero prunes beside a
 * pruning section, in the same response and from the same handler, that reported
 * one: the failure `pricedCuts` documents having already been fixed for the
 * dashboard, arriving unchanged at the other reader.
 *
 * Undefined when this run has neither, so a caller can drop the section rather
 * than ship an empty series on a three-second poll.
 */
export function contextOccupancy(runId: string): ContextOccupancyDTO | undefined {
  try {
    const rows = db()
      .prepare(
        `SELECT ts, iteration, tokens, basis, turn_index, turns_exact
           FROM context_samples WHERE run_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(runId, CONTEXT_SERIES_MAX_POINTS) as Array<
      StoredSample & { ts: number; iteration: number }
    >;
    const receipts = db()
      .prepare(
        `SELECT ts, trigger, tokens_removed FROM prune_receipts
          WHERE run_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(runId, CONTEXT_PRUNE_MARKS_MAX) as Array<{
      ts: number;
      trigger: PruneTrigger;
      tokens_removed: number;
    }>;
    // The other cut table. A fork writes a new transcript instead of editing
    // one, so `recordPrune` never runs and there is no receipt to find; `written
    // = 1` is what separates a cut that happened from a refusal that did not,
    // and only a cut may draw a mark.
    const forks = db()
      .prepare(
        `SELECT ts, removed_bytes, net_bytes, suffix_bytes, trigger, context_tokens_after
           FROM fork_attempts
          WHERE run_id = ? AND written = 1 ORDER BY ts DESC LIMIT ?`,
      )
      .all(runId, CONTEXT_PRUNE_MARKS_MAX) as Array<{
      ts: number;
      removed_bytes: number;
      net_bytes: number;
      suffix_bytes: number;
      trigger: PruneTrigger | null;
      context_tokens_after: number | null;
    }>;
    const { series, total } = compositionSeries(runId);
    if (
      rows.length === 0 &&
      receipts.length === 0 &&
      forks.length === 0 &&
      series.length === 0
    ) {
      return undefined;
    }

    // Merged on `ts` rather than concatenated: an install that changed engines
    // has cuts of both kinds in one run's life, and a mark drawn out of order
    // points at the wrong fall in the series. Newest first for the cap, for the
    // reason the samples are read that way, and reversed with them for drawing.
    const marks = [
      ...receipts.map((r) => ({
        ts: r.ts,
        trigger: r.trigger,
        tokensRemoved: r.tokens_removed,
      })),
      ...forks.map((f) => {
        // Through `forkCutFromRow` rather than beside it. The bytes-to-tokens
        // change of basis, and what a row with no recorded trigger is read as,
        // are that function's rules; a second copy of them here would drift from
        // the priced figure the same page prints one section down, and a fork's
        // bytes reaching the wire as if they were a receipt's `tokens_removed`
        // would overstate every fork mark by a factor of 3.6.
        const cut = forkCutFromRow({
          ts: f.ts,
          runId,
          removedBytes: f.removed_bytes,
          netBytes: f.net_bytes,
          suffixBytes: f.suffix_bytes,
          // Only the pricing reads the model, and a mark is not priced.
          model: null,
          trigger: f.trigger,
          contextTokensAfter: f.context_tokens_after,
        });
        return { ts: cut.ts, trigger: cut.trigger, tokensRemoved: cut.tokensRemoved };
      }),
    ]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, CONTEXT_PRUNE_MARKS_MAX)
      .reverse();

    return {
      ceilingTokens: CYCLE_CONTEXT_CEILING_TOKENS,
      // Reversed rather than selected ascending: the cap has to take the newest
      // rows, which needs a descending scan, and a series is drawn oldest-first.
      samples: rows.reverse().map((r) => ({
        ts: r.ts,
        iteration: r.iteration,
        tokens: r.tokens,
        basis: r.basis === "transcript" ? "transcript" : "api",
        turnIndex: r.turn_index,
        turnsExact: r.turns_exact !== 0,
      })),
      sampleCount: countFor("context_samples", runId, rows.length, CONTEXT_SERIES_MAX_POINTS),
      prunes: marks,
      // Both tables, because the pruning section on the same page counts both:
      // one response saying a run pruned once and never pruned at all is the
      // whole of what this figure got wrong.
      pruneCount:
        countFor("prune_receipts", runId, receipts.length, CONTEXT_PRUNE_MARKS_MAX) +
        countFor("fork_attempts", runId, forks.length, CONTEXT_PRUNE_MARKS_MAX, "written = 1"),
      // Read here rather than left to the route, so the series and the tick that
      // produced it cannot be assembled from two different moments.
      lastCheck: lastContextCheck(runId),
      composition: series,
      compositionCount: total,
      // Resolved here rather than in the component, because only this side knows
      // which of the two blanks it is: `pruningEnabled` is the gate the reading
      // is taken behind, and a component that guessed would tell an operator to
      // wait for a reading nothing is going to take.
      compositionAbsence:
        series.length > 0 ? null : pruningEnabled() ? "pending" : "off",
    };
  } catch (err) {
    noteBookkeepingFailure("contextOccupancy", err);
    return undefined;
  }
}

/**
 * The stored total, asked for only when the page might be holding a tail.
 *
 * A short page proves the total by itself, and this route is polled every three
 * seconds per open run page — so the `COUNT(*)` is skipped on the case that is
 * almost always the one in front of it.
 *
 * `extra` narrows the count to the same rows the caller's own SELECT took, and
 * is a literal at the call site exactly as `table` is — both are interpolated,
 * and nothing on this path may ever take either from a request.
 */
function countFor(
  table: string,
  runId: string,
  returned: number,
  limit: number,
  extra?: string,
): number {
  if (returned < limit) return returned;
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?${extra ? ` AND ${extra}` : ""}`,
    )
    .get(runId) as { n: number };
  return row.n;
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

/**
 * What a cut would cost at the context ceiling, in turns, before one is taken.
 *
 * The decision this serves is the expensive one: whether to **manufacture** a
 * cycle boundary by ending a cycle early. That boundary is what forces a cold
 * rewrite of the whole conversation — measured at 178k–183k tokens, about $1.80
 * a time on this install — and it happens only because this app chose it, so
 * the counterfactual is a cycle that simply carries on and writes nothing.
 *
 * ```
 * cost     2.0 · C      one cold rewrite of the conversation left after the cut
 * earns    0.1 · D      per later turn, for not re-reading what came out
 * T*    =  20 · C / D
 * ```
 *
 * Checked against every fork this install has taken, using the conversation
 * each resume actually wrote and the turns its billed cost implies:
 *
 * | write   | D      | 20·C/D | billed |
 * |---------|--------|--------|--------|
 * | 180,259 |  4,678 |    771 |    771 |
 * | 178,675 |  8,878 |    402 |    403 |
 * | 183,187 | 17,594 |    208 |    209 |
 *
 * ## Why this is not `paybackTurns`
 *
 * That one implements winnow's SPEC formula, `19·(S/D) − 20`, over `S` — the
 * suffix standing after the cut line. It is right for what it prices and is
 * tested against winnow's own worked examples. It is the wrong quantity here:
 * a resume does not rewrite the suffix, it rewrites the conversation, and on
 * these three the suffix was 70–87k against ~180k written. Read through `S` the
 * same cuts priced at 74–275 turns where 209–771 was billed, which is how a
 * gate meant to catch exactly this let all three through.
 *
 * ## Where `D` comes from, and why not from here
 *
 * `removedTokens` is converted by the estimator that produced it — see
 * `ceilingCut`, and `treatRemovedTokens` for the case where a byte figure may
 * not be divided by `BYTES_PER_TOKEN` at all. This function used to take
 * `netBytes` and do that division itself, which quietly made it the arbiter of
 * a units question it has no way to answer: it cannot tell a count of prompt
 * bytes from a count of transcript bytes, and the second one over-reads the
 * first by about four times on this install.
 *
 * ## The imprecision that remains, and which way it leans
 *
 * `apiContextNow` is `sampleContext`'s API-visible figure and not
 * `contextTokens`, deliberately — the transcript runs ~37% high because the
 * intake filter drops tool results on the wire that Claude Code still writes to
 * disk (`apiContextTokens` documents 183,803 against a real 114,485). But it
 * also carries the ~21.9k static head — system prompt and tool definitions —
 * which a resume re-reads rather than rewrites, so `apiContextNow − D` sits
 * about 10% above what actually gets written. That pushes `T*` up and declines
 * more cuts, which is the direction to be wrong in on a gate whose failure mode
 * was being too permissive.
 *
 * Null when there is nothing to weigh: no measurement, or one that removes
 * nothing. **Null must decline here**, which is the opposite of
 * `predictedPayback`'s null — that one means "this run has not cut yet" and
 * resolves to prune on `boundaryAction`'s aggregate argument. This one means
 * "no measurement", and spending $1.80 on an unmeasured cut is the mistake
 * being corrected.
 */
export function ceilingPayback(
  apiContextNow: number,
  cut: { removedTokens: number } | null,
): number | null {
  if (!cut) return null;
  const removed = cut.removedTokens;
  if (removed <= 0) return null;
  const conversationAfter = Math.max(0, apiContextNow - removed);
  return Math.max(0, Math.round((20 * conversationAfter) / removed));
}

/**
 * One record of a past cut: when it was made, and the `S` and `D` it had.
 *
 * **Both fields are tokens.** They did not have to be while each engine's row
 * supplied both — `paybackTurns` reads `S/D` as a ratio, so a reading in bytes
 * divided by a reading in bytes was safe. That stopped being true when the fork
 * reading moved from `suffix_bytes` to `context_tokens_after`: one column counts
 * tokens and the other bytes, and a reading built from both is wrong by
 * `BYTES_PER_TOKEN` while typechecking perfectly. `predictedPayback` converts at
 * the read. Nothing may combine `s` from one reading with `d` from another.
 */
export interface PaybackReading {
  ts: number;
  /** `S`: the suffix as it stood **before** the cut. Never the after figure. */
  s: number;
  /** `D`: what came out, net of anything written in its place. */
  d: number;
}

/**
 * What a further cut on this run would cost, from whichever engine cut last.
 *
 * The two engines leave different records — `treat` writes a `prune_receipts`
 * row, `fork` writes a `fork_attempts` row — and the gates that consult this
 * (`boundaryAction`, and the ceiling watcher deciding whether to end a cycle
 * early) resolve `null` to *act*. So reading one table alone does not degrade
 * gracefully under the other engine: it leaves both gates permanently open on
 * exactly the engine this app is moving to, while looking like a run that had
 * simply never pruned.
 *
 * Newest wins. A refusal is still a reading — it removed nothing, but its plan
 * measured the cut that was on offer, which is what a prediction wants — and
 * under the default cold age a refusal is the common outcome, so dropping them
 * would empty the evidence for most runs.
 *
 * Pure, and separate from the two SELECTs behind it, on `boundaryAction`'s
 * reasoning: this is the arithmetic, and the arithmetic should be testable
 * without a database under it.
 */
export function freshestPayback(
  receipt: PaybackReading | null | undefined,
  fork: PaybackReading | null | undefined,
): number | null {
  const latest = [receipt, fork]
    .filter((r): r is PaybackReading => Boolean(r))
    .sort((a, b) => b.ts - a.ts)[0];
  return latest ? paybackTurns(latest.s, latest.d) : null;
}

/**
 * What is configured, and whether the tool behind it is actually here.
 *
 * `FilterSavingsDTO`'s `running`/`ledger` split, one mechanism over and for the
 * same reason. The pruner half of the context-control card shipped arithmetic
 * and no state, so an image built with `WINNOW_REF=` empty rendered a
 * byte-identical dashboard while every prune no-opped — the failure was
 * reported once per cycle into a per-run log nothing aggregates, and nowhere
 * else at all.
 *
 * Three readings and not a boolean, because the third is how an install lies
 * about itself: `unavailable` is pruning switched **on** with nothing behind
 * it, and it is the only one of the three drawn as a fault. Off is not a fault
 * — it is an operator's decision, and a warning standing permanently over one
 * trains the eye to skip warnings that matter.
 */
export function prunerState(s: Settings = getSettings()): ContextPrunerDTO {
  const available = winnowAvailable();
  return {
    state: !s.contextPruning ? "off" : available ? "ready" : "unavailable",
    engine: s.contextPruningEngine,
    detail: !s.contextPruning || available ? null : WINNOW_MISSING_REASON,
    minColdAgeSeconds:
      s.contextPruningEngine === "winnow" ? s.contextPruningForkMinColdAge : null,
  };
}

/**
 * Is the feature on, and is the tool here to do it?
 *
 * Defined over `prunerState` rather than beside it so the guard that decides
 * whether to spawn and the sentence that tells an operator what happened cannot
 * come apart — the readout would otherwise be a second derivation of the same
 * two facts, and a second derivation is a place for them to disagree.
 */
export function pruningEnabled(s: Settings = getSettings()): boolean {
  return prunerState(s).state === "ready";
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
    return { kind: "unavailable", reason: WINNOW_MISSING_REASON };
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
  // Before the edit, and it has to be: winnow removes whole records, so the
  // `usage` frame this reads is one of the things a prune can take away.
  const apiTokensBefore = apiContextTokens(transcriptPath);

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
      apiTokensBefore,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

/** The child, as its own function so `pruneTranscript` reads as the sequence it is. */

/**
 * Hand a transcript back to the agent's uid after winnow has been over it.
 *
 * The pruner is the app's own maintenance and runs as the server, which is
 * root — `describeSeparation()` states the arrangement at boot as "children run
 * as 1000:1000 … server as 0". Every winnow verb here that writes takes the
 * transcript with it, so the file the *next* work cycle has to resume from is
 * left `root:root 0600` and the agent, a different uid, cannot read it.
 *
 * MEASURED, 2026-09-05, on a real run against a real account. The same task with
 * `contextPruning` on failed at cycle 2 in 0 ms for $0.14 with
 * `No conversation found with session ID: …` on stderr; with it off the run
 * completed for $0.41. Changing nothing but the file's owner — `chown
 * root:root → node:node` on that exact session — turned the refusal into a
 * successful resume. The cost is not one cycle: the orchestrator reports
 * `error_during_execution` and fails the whole run, and because the failing
 * cycle bills $0 while the cycle before it reports success, nothing in the app
 * says what happened.
 *
 * `chownForChild` is the existing answer to precisely this shape and its own
 * docstring names the disease — "the server is root, so anything it writes …
 * lands root-owned and the agent … cannot touch it" — but lists only the
 * worktree store and the seeded config files. The transcript is the third place
 * and was missing from it.
 *
 * It does NOT throw, and that is the one deliberate difference from
 * `chownForChild`. This runs on the pruning path, whose rule is stated at
 * `observePlan`: an observation that could end a cycle is worth less than not
 * taking it. A failure here leaves exactly the behaviour that exists today, so
 * refusing loudly would trade a silent bug for a loud one on a path that must
 * not end a run.
 *
 * The chown is injected so the unit test can assert both directions without
 * being root and without a real transcript.
 */
export function restoreTranscriptOwnership(
  transcriptPath: string,
  deps: {
    credentials?: () => { uid?: number; gid?: number };
    chown?: (target: string, uid: number, gid: number) => void;
  } = {},
): { restored: boolean; reason: string | null } {
  const credentials = deps.credentials ?? childCredentials;
  const chown = deps.chown ?? fs.chownSync;
  const { uid, gid } = credentials();
  if (uid === undefined || gid === undefined) {
    // Not privilege-separated: the server and the agent are one uid and there
    // is nothing to hand over. Reported rather than silent so a caller can tell
    // "no separation" from "the chown failed".
    return { restored: false, reason: "not privilege separated" };
  }
  try {
    chown(transcriptPath, uid, gid);
    return { restored: true, reason: null };
  } catch (err) {
    return { restored: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

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
      // Before the caller moves on: winnow ran as the server, so the transcript
      // the next cycle resumes from may now be root-owned. Unconditional
      // because a refusal still may have written, and cheap enough to pay on a
      // path that already spawned a subprocess.
      restoreTranscriptOwnership(transcriptPath);
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

/* ------------------------------------------------------------------ */
/* What the new rule engine would have done — read-only, every cycle   */
/* ------------------------------------------------------------------ */

/**
 * `winnow plan --json`, for one transcript.
 *
 * ## Why this runs at all, given nothing acts on it
 *
 * The prune this app performs is `winnow treat -rx <tier>`, the **inherited**
 * pruner: about twenty strategies in `src/winnow/legacy/strategies/`, none of
 * which import `winnow.rules`. Winnow's newer work — `inspect`, `plan`, `fork`,
 * and the intake filter — runs a different classifier entirely, SPEC §4's six
 * rules at a tier. The two overlap in intent and agree almost nowhere in
 * detail: legacy `stale-reads` fires on any later edit, ignores read ranges and
 * hardcodes 500 bytes, where A1 requires an intervening-read test, honours
 * ranges and leaves a sha256 pointer.
 *
 * So "is the new engine better than the one we run" is an open question that no
 * amount of running the old one answers, and the blind-label measurement that
 * bears on it scored the *new* rules — not these. `plan` writes nothing and
 * refuses nothing, so it can be asked at every boundary for the price of one
 * subprocess, and its answer recorded beside what the pruner actually did. That
 * is the comparison, on production data, at no risk.
 *
 * ## Why its verdict does not reach the gate
 *
 * It is tempting to feed `arithmetic.break_even_turns` straight into the
 * boundary gate, since it describes the cut *about to happen* rather than the
 * last one `predictedPayback` reads. It describes a different cut. `T*` is
 * `19·(S/D) − 20` and `D` here is what the **new** rules would remove, which is
 * not what `treat` is about to remove. Gating one engine's action on the
 * other's arithmetic would be a category error that produced plausible numbers,
 * which is the worst kind. The gate keeps its own basis; this is recorded next
 * to it and nothing else.
 *
 * Tier CB regardless of the prescription in force, because the two vocabularies
 * do not map — `gentle`/`standard`/`aggressive` name strategy bundles and
 * `C`/`CB`/`CBA` name rule tiers — and CB is the tier every published figure in
 * that project is quoted at.
 *
 * Failure is silence. A missing winnow, a malformed body, a timeout or a
 * non-zero exit all return null: this is an observation, and an observation
 * that could end a cycle would be worth less than not taking it.
 */
export interface PlannedCut {
  tier: string;
  toolCalls: number;
  stripped: number;
  removedBytes: number;
  pointerOverhead: number;
  netBytes: number;
  suffixBytes: number;
  breakEvenTurns: number | null;
}

export function planCut(transcriptPath: string): Promise<PlannedCut | null> {
  return new Promise((resolve) => {
    if (!winnowAvailable()) {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: PlannedCut | null) => {
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
          "plan",
          transcriptPath,
          "--tier",
          PLAN_TIER,
          "--json",
        ],
        // Same credential argument as `spawnPrune`: this is the app's own
        // maintenance on the app's own data, and the transcripts are root-owned.
        { env: pruneEnv(), stdio: ["ignore", "pipe", "ignore"] },
      );

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        // Bounded like the stderr read in `spawnPrune`, and for a stronger
        // reason: `plan --json` carries a `pointers` array with one entry per
        // stripped result, so a large session's body is large by design.
        if (stdout.length < 4_000_000) stdout += chunk;
      });

      timer = setTimeout(() => child.kill("SIGKILL"), PRUNE_TIMEOUT_MS);
      timer.unref?.();

      child.on("error", () => finish(null));
      child.on("close", (code) => {
        // Exit 2 is "nothing met a rule at this tier" and still carries a full
        // body — a real answer, and one worth recording: it is the new engine
        // saying it would have left this conversation alone.
        if (code !== 0 && code !== 2) {
          finish(null);
          return;
        }
        finish(parsePlan(stdout));
      });
    } catch {
      finish(null);
    }
  });
}

/** The three objects of `plan --json` this app reads, or null if it cannot. */
export function parsePlan(body: string): PlannedCut | null {
  try {
    // Exit 2 — "no result met a rule at this tier" — prints the body and then
    // appends a sentence of prose to it, in the `--json` path as well as the
    // human one. `JSON.parse` of the whole thing throws, so every observation
    // of the new engine declining to cut anything was being dropped: exactly
    // the observations that would show it is more conservative than the
    // pruner, and the ones whose absence looks like the feature never running.
    const end = body.lastIndexOf("}");
    const raw = JSON.parse(end === -1 ? body : body.slice(0, end + 1)) as {
      selection?: { tier?: unknown };
      results?: { tool_calls?: unknown; stripped?: unknown };
      bytes?: { removed?: unknown; pointer_overhead?: unknown; net?: unknown };
      arithmetic?: { suffix_bytes?: unknown; break_even_turns?: unknown };
    };
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      tier: typeof raw.selection?.tier === "string" ? raw.selection.tier : PLAN_TIER,
      toolCalls: num(raw.results?.tool_calls),
      stripped: num(raw.results?.stripped),
      removedBytes: num(raw.bytes?.removed),
      pointerOverhead: num(raw.bytes?.pointer_overhead),
      netBytes: num(raw.bytes?.net),
      suffixBytes: num(raw.arithmetic?.suffix_bytes),
      // Absent when nothing fires — there is no cut, so no break-even. Null
      // rather than 0, which would read as "pays immediately".
      breakEvenTurns:
        typeof raw.arithmetic?.break_even_turns === "number"
          ? raw.arithmetic.break_even_turns
          : null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* What the window is made of — read-only, paced by growth             */
/* ------------------------------------------------------------------ */

/**
 * How many readings one run may keep, oldest first.
 *
 * Readings rather than rows, and the distinction is the whole of the cap:
 * one `winnow context` call writes a row per provenance, so a cap counted in
 * rows would truncate a reading down the middle and leave a stacked area whose
 * bands stop at different moments — a picture of a conversation that never
 * happened. Lower than `CONTEXT_SAMPLES_PER_RUN` by two orders because each
 * reading costs a subprocess and is paced by growth rather than by the tick:
 * at `COMPOSITION_REMEASURE_GROWTH_TOKENS` apart, 300 readings is 7.5 million
 * tokens of growth, which no run on this install has come near.
 */
export const CONTEXT_COMPOSITIONS_PER_RUN = 300;

/** The newest readings a DTO carries, on `CONTEXT_SERIES_MAX_POINTS`' rule. */
export const CONTEXT_COMPOSITION_MAX_READINGS = 120;

/**
 * How far a conversation must grow before its composition is read again.
 *
 * Larger than `CEILING_REMEASURE_GROWTH_TOKENS`, deliberately. That constant
 * paces a *decision* — whether to end a cycle early — and being late with it
 * costs money on every turn in between. This paces a *picture*, where being
 * late costs a point on a graph, and the subprocess is the same price either
 * way. At 40,000 a run climbing to the 200,000 ceiling draws five bands' worth
 * of shape, which is a shape; at the ceiling's own 25,000 it would draw eight
 * and spend 60% more subprocesses to do it.
 *
 * Growth is measured on the *sample*, not on winnow's window, because the
 * sample is the figure this app already has in hand on every tick — asking
 * winnow how much it has grown would mean spawning winnow to find out whether
 * to spawn winnow.
 */
export const COMPOSITION_REMEASURE_GROWTH_TOKENS = 40_000;

/**
 * Winnow's tree depth. 1 is provenance alone, which is what a band is.
 *
 * 3 is the whole tree: the provenance, then the tool or attachment class, then
 * the artefact — a file path with its repeat count, a Bash command head, an MCP
 * tool, one sub-agent's return. **The chart is unaffected.** It draws one band
 * per top-level provenance and nothing else, from the same rows it drew from at
 * depth 1; the two levels below exist for a detail view, which is a different
 * question asked of the same reading.
 *
 * What is stored, and the distinction is the whole of the bound:
 *
 * - The **series** is still one row per provenance per reading, which is what
 *   `CONTEXT_COMPOSITIONS_PER_RUN` counts readings for. A reading truncated down
 *   the middle is a picture of a conversation that never happened, and that
 *   argument survives only while a reading is a handful of rows.
 * - The **tree** is the newest reading's only, replaced whole on every reading,
 *   in `context_composition_children`. That is what bounds the store by *runs*
 *   rather than by readings × paths — the second is unbounded in the one
 *   dimension nothing here caps, since nothing limits how many distinct files a
 *   run may touch. The next reader will ask why the tree is not a series: it is
 *   because a detail view answers "what is in this window **now**", which the
 *   newest reading is, and not "what was in the third of forty", which no store
 *   this app can afford would answer.
 *
 * Within one reading, `COMPOSITION_CHILDREN_PER_NODE` bounds each node's own
 * children.
 */
const COMPOSITION_DEPTH = "3";

/**
 * How many children of one node survive into the store, largest first.
 *
 * A cap rather than a pool: the tail is **dropped**, never summed into an
 * "other" sibling, on `parseComposition`'s own rule — a set of children that
 * falls short of its parent is visible, where a manufactured bin is a band
 * indistinguishable from the residual, the one node whose whole job is to say
 * what nothing accounted for.
 *
 * Measured 2026-09-04 against the pinned winnow, on the four largest transcripts
 * on this install (7.2 MB to 12.9 MB of JSONL): a depth-3 body carries 72 to 110
 * sub-nodes in total and at most 29 under any one parent. So this does not fire
 * on anything here and is not tuning — it is the ceiling for the session that
 * reads a thousand distinct files, whose tree would otherwise be a thousand rows
 * for one run.
 */
const COMPOSITION_CHILDREN_PER_NODE = 64;

/**
 * One node below a provenance: the tool or attachment class, or the artefact.
 *
 * Winnow's own vocabulary throughout, on `parseComposition`'s rule — a label
 * this app did not anticipate is carried as itself rather than binned.
 */
export interface CompositionChild {
  /** Winnow's key, with the `×N` below lifted off it — see `splitRepeat`. */
  label: string;
  tokens: number;
  kind: string;
  /**
   * How many times winnow saw this artefact, or null where it attached no
   * count — which winnow does for every node above the artefact level and for
   * an artefact it saw once. Null is "winnow said nothing", not "once".
   */
  repeat: number | null;
  /** The level below this one, empty at the deepest `COMPOSITION_DEPTH` reaches. */
  children: CompositionChild[];
}

/** One provenance's share of one reading. Winnow's own label and kind. */
export interface CompositionSlice {
  label: string;
  tokens: number;
  kind: string;
  /**
   * This provenance's subtree. Parsed on every reading and stored for the newest
   * one only — see `COMPOSITION_DEPTH` and `recordComposition`.
   */
  children: CompositionChild[];
}

/** One `winnow context` reading: its exact window and what apportions it. */
export interface ContextComposition {
  /**
   * Winnow's own window total, in the same units as `apiContextTokens` and
   * **not** anchored the same way — see `recordComposition`.
   */
  window: number;
  slices: CompositionSlice[];
}

/**
 * `winnow context --json`, for one transcript.
 *
 * ## What it answers that nothing else here does
 *
 * Every other figure on this path is a *size*: how full the window is, how much
 * a cut would take out, what that cut would cost. None of them says what the
 * window is made of, so an operator watching a run climb to the ceiling could
 * see that it was climbing and had no way to tell whether it was climbing on
 * tool output a prune would take, on a prefix a prune cannot touch, or on
 * retained reasoning that is neither. Those three have different remedies and
 * the graph that showed the climb was silent on which one applied.
 *
 * `context` writes nothing anywhere — it is beside `inspect` in winnow's own
 * tree for exactly that reason — so it can be asked while the session is live,
 * for the price of one subprocess.
 *
 * ## Why it is nonetheless gated on the feature being on
 *
 * `observePlan`'s rule, and for its reason rather than by analogy: read-only is
 * not the same as permitted, and an operator who switched context pruning off
 * has asked that winnow is not spawned against their conversation. The reading
 * this app takes for free — `sampleContext` — stays ungated because it spawns
 * nothing. This does, so it does not.
 *
 * ## Why no `--window` is passed
 *
 * The flag exists so winnow can print a "% full", and the only denominator this
 * app has to offer is `CYCLE_CONTEXT_CEILING_TOKENS` — the size a *work cycle*
 * is ended early at, which is not the model's context window and is a third of
 * it on the 1M models. Passing it would have winnow label a percentage of this
 * app's own policy as a percentage of the context window. The shares are
 * computed here instead, against the window winnow did read.
 *
 * Failure is silence, `planCut`'s rule: a missing winnow, a malformed body, a
 * timeout or a non-zero exit all return null. This is an observation, and an
 * observation that could end a cycle would be worth less than not taking it.
 */
export function contextComposition(
  transcriptPath: string,
): Promise<ContextComposition | null> {
  return new Promise((resolve) => {
    if (!winnowAvailable()) {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: ContextComposition | null) => {
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
          "context",
          transcriptPath,
          "--depth",
          COMPOSITION_DEPTH,
          "--json",
        ],
        // Same credential argument as `spawnPrune` and `planCut`: this is the
        // app's own maintenance on the app's own data, and the transcripts are
        // root-owned.
        { env: pruneEnv(), stdio: ["ignore", "pipe", "ignore"] },
      );

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        // Bounded like `planCut`'s, and 4 MB is still right at depth 3, which
        // is what this used to be written against as a future. Measured
        // 2026-09-04 on the four largest transcripts on this install — 7.2 MB to
        // 12.9 MB of JSONL — a depth-3 `--json` body came back at 18 KB to 29 KB.
        // The body grows with the number of *distinct* artefacts and not with
        // the transcript, so the headroom here is two orders and the bound stays
        // what it is for: a winnow that goes wrong, not a session that gets big.
        if (stdout.length < 4_000_000) stdout += chunk;
      });

      timer = setTimeout(() => child.kill("SIGKILL"), PRUNE_TIMEOUT_MS);
      timer.unref?.();

      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (code !== 0) {
          finish(null);
          return;
        }
        finish(parseComposition(stdout));
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * The window and its top-level nodes out of `context --json`, or null.
 *
 * ## What null means here, and what it must not be confused with
 *
 * Null is *no reading*. A conversation winnow could not anchor — one with no
 * priced request yet — reports `window` as null in its own body, and that is
 * the same answer: nothing to draw. What is **not** null is a reading whose
 * slices are odd, a residual that is large, or a label this app has never seen.
 * Those are answers, and passing them through unaltered is the point: winnow
 * owns this vocabulary, the residual is deliberately not folded into its
 * neighbours, and a node binned as "other" here would hide the one figure whose
 * whole job is to say what nothing accounted for.
 *
 * ## Why the slices are not re-derived
 *
 * `share` is on the wire and is ignored: it is `tokens / window` to six places,
 * and recomputing it in the component keeps one number in one place. `tokens`
 * is what is stored, because a share stored against a window that later moves
 * is a figure with no denominator.
 *
 * A node whose token count is not a finite number is dropped rather than zeroed:
 * a band drawn at zero says winnow measured nothing there, and a band dropped
 * makes the slices fail to sum, which is visible. Zero is a measurement. The
 * children below follow the same rule, for the same reason.
 */
export function parseComposition(body: string): ContextComposition | null {
  try {
    const raw = JSON.parse(body) as {
      window?: { tokens?: unknown } | null;
      nodes?: unknown;
    };
    const window = raw.window?.tokens;
    // No anchoring request means no exact window, and every figure under it
    // would be an estimate apportioning nothing. Winnow says so with a null and
    // this says so with one.
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
      return null;
    }
    if (!Array.isArray(raw.nodes)) return null;

    const slices: CompositionSlice[] = [];
    for (const node of raw.nodes) {
      if (!node || typeof node !== "object") continue;
      const { label, tokens, kind } = node as Record<string, unknown>;
      if (typeof label !== "string" || label === "") continue;
      if (typeof tokens !== "number" || !Number.isFinite(tokens)) continue;
      slices.push({
        // No `splitRepeat` here. Winnow attaches a repeat count from the third
        // level down only, where the key is an artefact rather than a category,
        // so a provenance carrying one would be a label this app invented.
        label,
        tokens: Math.max(0, Math.round(tokens)),
        // Winnow states the kind on every node; an absent one is passed through
        // as the empty string rather than guessed at, because every value this
        // field can take is a claim about how the number was reached.
        kind: typeof kind === "string" ? kind : "",
        children: parseChildren((node as Record<string, unknown>).children),
      });
    }
    if (slices.length === 0) return null;
    return { window: Math.round(window), slices };
  } catch {
    return null;
  }
}

/**
 * Winnow's `×N` lifted off an artefact label.
 *
 * `context.py`'s `decorate()` composes it as the key, two spaces, `×` and the
 * count, from the third level down and only where the count is more than one.
 * Split here rather than stored composed, because the two are different facts: a
 * detail view grouping or sorting by path must not be sorting by *how many
 * times*, and one that forgot to strip it prints `×43` inside what it labels a
 * file path. Everything else about the key survives byte for byte.
 *
 * Anchored on the whole label, so it is a no-op on every label winnow did not
 * decorate — including `--by-path`'s own override, `path  ×3 (Read ×2, Edit)`,
 * which ends in a bracket. This app does not pass that flag; the anchor is why
 * the label would still survive whole if it ever did.
 *
 * A count that is not a plain integer above one leaves the label alone rather
 * than being coerced: winnow's own composition cannot produce one, so a match
 * that shape means the label was never decorated and the suffix is the artefact.
 */
function splitRepeat(label: string): { label: string; repeat: number | null } {
  const match = /^(.+)  ×(\d+)$/.exec(label);
  if (!match) return { label, repeat: null };
  const repeat = Number(match[2]);
  if (!Number.isSafeInteger(repeat) || repeat <= 1) return { label, repeat: null };
  return { label: match[1], repeat };
}

/**
 * One level of winnow's tree below a provenance, and every level under it.
 *
 * Recursive rather than two hardcoded passes, so the shape follows
 * `COMPOSITION_DEPTH` instead of restating it: raising the flag deepens the
 * parse and nothing here has to be told.
 *
 * Bounded per node at `COMPOSITION_CHILDREN_PER_NODE`. The sort fires only when
 * the cap does, which means winnow's own order — largest first — reaches the
 * store untouched in every case that occurs on this install, and the cap's
 * promise that the largest survive does not rest on another program's sort.
 */
function parseChildren(raw: unknown): CompositionChild[] {
  if (!Array.isArray(raw)) return [];
  const children: CompositionChild[] = [];
  for (const node of raw) {
    if (!node || typeof node !== "object") continue;
    const { label, tokens, kind, children: below } = node as Record<string, unknown>;
    if (typeof label !== "string" || label === "") continue;
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) continue;
    const split = splitRepeat(label);
    children.push({
      label: split.label,
      tokens: Math.max(0, Math.round(tokens)),
      kind: typeof kind === "string" ? kind : "",
      repeat: split.repeat,
      children: parseChildren(below),
    });
  }
  if (children.length <= COMPOSITION_CHILDREN_PER_NODE) return children;
  return [...children]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, COMPOSITION_CHILDREN_PER_NODE);
}

/**
 * Store one composition reading, or do nothing.
 *
 * ## Why winnow's window is stored and the sample's is not
 *
 * They are the same measure taken from different anchors. `apiContextSample`
 * reads the last **main-thread** `usage` frame — sidechains excluded, exactly
 * as the ceiling excludes them, because a sub-agent's turns are not this
 * conversation's context. Winnow anchors on the last priced request in the
 * file, and a sub-agent's frames are written to that same file. So for as long
 * as a sub-agent runs the two describe different conversations, and on this
 * install that has been 22 minutes at a stretch.
 *
 * Scaling the slices onto the sample's figure would make the two agree by
 * construction and would be a lie in the one case it mattered: the slices would
 * then apportion a total they were never measured against. So winnow's own
 * window rides on the row, the bands are drawn against it, and the component
 * says which reading it is. Nothing subtracts one from the other.
 *
 * Never throws — `recordPrune`'s rule. A reading is evidence, and losing one
 * must not turn a live run into a failed one.
 */
export function recordComposition(
  runId: string,
  iteration: number,
  reading: ContextComposition,
): void {
  try {
    const ts = Date.now();
    // One statement per row inside one transaction, so a reading is whole or
    // absent. A half-written reading is the stacked area's one unrecoverable
    // state: the bands would sum to less than the window and the gap would read
    // as unattributed context rather than as a missing row.
    db().transaction(() => {
      const next = db()
        .prepare(
          `SELECT COALESCE(MAX(reading), 0) + 1 AS n
             FROM context_compositions WHERE run_id = ?`,
        )
        .get(runId) as { n: number };
      const insert = db().prepare(
        `INSERT INTO context_compositions
           (ts, run_id, reading, iteration, window, label, tokens, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const slice of reading.slices) {
        insert.run(
          ts,
          runId,
          next.n,
          iteration,
          reading.window,
          slice.label,
          slice.tokens,
          slice.kind,
        );
      }
      // Capped on the reading rather than on the row, so the oldest whole
      // readings go and no reading is left with some of its bands.
      db()
        .prepare(
          `DELETE FROM context_compositions
            WHERE run_id = ?
              AND reading <= ? - ?`,
        )
        .run(runId, next.n, CONTEXT_COMPOSITIONS_PER_RUN);

      // The tree is replaced whole, and the delete is unconditional on the run
      // rather than keyed on a reading number: the store holds the newest
      // reading's tree and no other, which is what bounds it by runs instead of
      // by readings × paths. Inside the same transaction as the bands above, so
      // a run is never left showing one reading's stack over another's tree.
      db()
        .prepare(`DELETE FROM context_composition_children WHERE run_id = ?`)
        .run(runId);
      const insertChild = db().prepare(
        `INSERT INTO context_composition_children
           (ts, run_id, reading, provenance, parent, label, tokens, kind, repeat_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // Two levels, which is exactly what `COMPOSITION_DEPTH` asks winnow for.
      // Written flat rather than walked to the bottom because `parent` is a
      // label and not a path: a third level would need a key that says which
      // second-level node it hung under, and there is no third level to store.
      for (const slice of reading.slices) {
        for (const child of slice.children) {
          insertChild.run(
            ts,
            runId,
            next.n,
            slice.label,
            "",
            child.label,
            child.tokens,
            child.kind,
            child.repeat,
          );
          for (const artefact of child.children) {
            insertChild.run(
              ts,
              runId,
              next.n,
              slice.label,
              child.label,
              artefact.label,
              artefact.tokens,
              artefact.kind,
              artefact.repeat,
            );
          }
        }
      }
    })();
  } catch (err) {
    noteBookkeepingFailure("recordComposition", err);
  }
}

/**
 * This run's composition readings, oldest first, the newest carrying its tree.
 *
 * Grouped in one pass over a single descending scan rather than a query per
 * reading: the page polls this every three seconds alongside everything else on
 * the run, and `CONTEXT_COMPOSITION_MAX_READINGS` readings is a few hundred
 * rows either way.
 *
 * The tree is a second query and is attached to the newest reading only, because
 * that is the only reading it is stored for. Matched on the reading number
 * rather than assumed to belong to the last entry: a reading landing between the
 * two queries would leave the tree describing a stack this call did not return,
 * and attaching it anyway would draw one reading's artefacts under another's
 * provenances. Where they disagree, nothing is attached and the page has a stack
 * with no detail — which is the state every reading before this one is in.
 */
function compositionSeries(runId: string): {
  series: ContextCompositionDTO[];
  total: number;
} {
  const rows = db()
    .prepare(
      `SELECT ts, reading, iteration, window, label, tokens, kind
         FROM context_compositions
        WHERE run_id = ?
          AND reading > (
            SELECT COALESCE(MAX(reading), 0) - ? FROM context_compositions WHERE run_id = ?
          )
        ORDER BY reading ASC, id ASC`,
    )
    .all(runId, CONTEXT_COMPOSITION_MAX_READINGS, runId) as Array<{
    ts: number;
    reading: number;
    iteration: number;
    window: number;
    label: string;
    tokens: number;
    kind: string;
  }>;

  const series: ContextCompositionDTO[] = [];
  let current = -1;
  for (const row of rows) {
    if (row.reading !== current) {
      current = row.reading;
      series.push({
        ts: row.ts,
        iteration: row.iteration,
        window: row.window,
        slices: [],
      });
    }
    series[series.length - 1].slices.push({
      label: row.label,
      tokens: row.tokens,
      kind: row.kind,
      children: [],
    });
  }
  if (series.length > 0) attachChildren(runId, current, series[series.length - 1]);

  const stored = db()
    .prepare(
      `SELECT COUNT(DISTINCT reading) AS n FROM context_compositions WHERE run_id = ?`,
    )
    .get(runId) as { n: number } | undefined;
  return { series, total: stored?.n ?? series.length };
}

/**
 * Hang the stored tree on one reading's slices, in place.
 *
 * The rows are flat — `provenance`, then `parent`, which is the empty string on
 * a node hanging straight off a provenance — and they arrive parent-before-child
 * because that is the order `recordComposition` writes them in and `id` is the
 * order it wrote. So one pass suffices: a second-level node registers where its
 * own children go before any of them is read.
 *
 * A node whose parent is not in the map is dropped rather than raised to the top
 * level, on the parse's rule. The two are written in one transaction so it
 * cannot happen; if it ever does, a subtree short of one branch is visible where
 * an artefact reparented under the wrong provenance is not.
 */
function attachChildren(runId: string, reading: number, into: ContextCompositionDTO): void {
  const rows = db()
    .prepare(
      `SELECT provenance, parent, label, tokens, kind, repeat_count
         FROM context_composition_children
        WHERE run_id = ? AND reading = ?
        ORDER BY id ASC`,
    )
    .all(runId, reading) as Array<{
    provenance: string;
    parent: string;
    label: string;
    tokens: number;
    kind: string;
    repeat_count: number | null;
  }>;
  if (rows.length === 0) return;

  const byProvenance = new Map<string, ContextCompositionNodeDTO[]>();
  // Keyed on provenance *and* label, and joined on a byte no winnow label can
  // contain: two provenances can carry the same second-level key, and a key
  // built by concatenating with a printable separator would let one subtree's
  // artefacts land under another whose labels happen to straddle it.
  const byParent = new Map<string, ContextCompositionNodeDTO[]>();
  const parentKey = (provenance: string, label: string) =>
    `${provenance}\u0000${label}`;
  for (const row of rows) {
    const node: ContextCompositionNodeDTO = {
      label: row.label,
      tokens: row.tokens,
      kind: row.kind,
      repeat: row.repeat_count,
      children: [],
    };
    if (row.parent !== "") {
      byParent.get(parentKey(row.provenance, row.parent))?.push(node);
      continue;
    }
    let siblings = byProvenance.get(row.provenance);
    if (!siblings) {
      siblings = [];
      byProvenance.set(row.provenance, siblings);
    }
    siblings.push(node);
    byParent.set(parentKey(row.provenance, row.label), node.children);
  }

  for (const slice of into.slices) {
    slice.children = byProvenance.get(slice.label) ?? [];
  }
}

/* ------------------------------------------------------------------ */
/* What the engine in use would take out — read-only, at the ceiling   */
/* ------------------------------------------------------------------ */

/**
 * What the configured pruner says it would remove from this conversation.
 *
 * One shape for both engines so the ceiling gate cannot be handed the wrong
 * one, and `removedTokens` rather than bytes so that each estimator converts
 * in its own terms. That conversion is where the two genuinely differ and it
 * has no single right answer, so it belongs beside the measurement whose
 * reasoning justifies it rather than inside the arithmetic that consumes it —
 * `ceilingPayback` cannot tell transcript bytes from prompt bytes and must not
 * be the place that decides.
 */
export interface CeilingCut {
  /** Which engine measured it: the one that would do the cutting. */
  engine: Settings["contextPruningEngine"];
  /** In the same currency as `apiContextNow`. See each estimator. */
  removedTokens: number;
}

/**
 * The two figures a `treat` dry run prints, in bytes.
 *
 * Separated from the conversion so the parse can be tested against winnow's
 * real output without a transcript, which is the half that breaks when the
 * tool's wording moves.
 */
export interface TreatEstimate {
  /** The transcript as it stands, as winnow measured it in this same run. */
  totalBytes: number;
  /** What the prescription would take out of it. */
  freedBytes: number;
}

/**
 * Bytes out of one of winnow's `fmt_bytes` renderings, or null.
 *
 * `legacy/cli.py:100` prints `123B`, `12.3KB` or `1.23MB`, and the KB and MB
 * are binary — matching them with 1000 would be wrong by 2.4% at MB, which is
 * the size every figure this reads comes back at.
 *
 * `fmt_tokens` beside it renders `K` and `M` with no `B`, so a line carrying
 * both a token count and a byte count has exactly one match for this and the
 * three shapes of winnow's `Saved` line collapse to one rule.
 */
function winnowBytes(line: string): number | null {
  const m = /(\d+(?:\.\d+)?)(MB|KB|B)(?![A-Za-z])/.exec(line);
  if (!m) return null;
  const scale = m[2] === "MB" ? 1024 * 1024 : m[2] === "KB" ? 1024 : 1;
  const value = Number(m[1]) * scale;
  return Number.isFinite(value) ? value : null;
}

/**
 * The size and the saving out of `treat`'s dry-run summary.
 *
 * A text parse, because the inherited CLI has no `--json` on this subcommand —
 * `plan` and `fork` are the new tree's commands and carry one, `treat` is not.
 * Both figures come from the **same** run so the share below is taken against
 * the file winnow actually measured, rather than against a `stat` that a live
 * cycle may have appended to in between.
 *
 * Null when either line is missing or unreadable, which the caller reports
 * rather than swallows: this is the one failure mode that looks exactly like a
 * conversation with nothing worth removing, and the whole reason this function
 * exists is that a wrong number here reads as a working feature.
 */
export function parseTreatEstimate(body: string): TreatEstimate | null {
  const before = /^\s*Before\b.*$/m.exec(body);
  const saved = /^\s*Saved\b.*$/m.exec(body);
  if (!before || !saved) return null;
  const totalBytes = winnowBytes(before[0]);
  const freedBytes = winnowBytes(saved[0]);
  if (totalBytes === null || freedBytes === null) return null;
  if (totalBytes <= 0 || freedBytes < 0) return null;
  return { totalBytes, freedBytes };
}

/**
 * What `treat` would remove, as a share of the conversation the API carries.
 *
 * **Not `freedBytes / BYTES_PER_TOKEN`, and that is the whole of this
 * function.** That constant converts *text* to tokens; a transcript is not the
 * prompt. Measured on this install, session `02584a86` stood at 3.83 MB on
 * disk against an API context of 258.3k tokens — 14.8 bytes a token, four
 * times the constant — because the file holds JSON envelopes, thinking blocks
 * with signatures, and tool results the intake filter had already taken off
 * the wire. Read at 3.6 the same dry run's 1.79 MB came to 521k tokens
 * "removed" from a 258k-token conversation, so `apiContextNow − D` floored at
 * zero and every cut priced at 0 turns. A gate cannot be built on a quantity
 * that can exceed the thing it is subtracted from.
 *
 * A share can't. `treat` reports a change in the size of the file, so the
 * honest reading of it is proportional: the cut takes out this fraction of the
 * transcript, so assume it takes out that fraction of the prompt. The units
 * cancel, and `D ≤ apiContextNow` holds by construction.
 *
 * ## Why `planCut`'s figure is *not* converted this way
 *
 * The two engines' bytes are not the same measurement despite both being a
 * delta on the same file. `plan` at tier CB strips results its rules select —
 * `keep_last: 6`, `min_bytes: 2048`, an intervening-read test — so its bytes
 * are recent, large results still standing in the prompt, and the overlap with
 * what the intake filter had already dropped is bounded and measured at 4.06%
 * (`intakeFilter.ts`). `treat -rx aggressive` strips **every** tool result in
 * the file, most of which are old, already filtered, or both. So the absolute
 * reading is defensible for one and not the other, and this is where the two
 * part company rather than an inconsistency to be tidied away.
 *
 * ## What is still wrong with it, and in which direction
 *
 * The share is taken against the whole prompt, and ~55k tokens of that is a
 * system prompt, tool list and `CLAUDE.md` no prune can reach (`PruneOutcome`
 * records the measurement). Applying a 49% share to all of it therefore claims
 * about a quarter more than a prune could deliver, which lowers `T*` and makes
 * this **permissive** — the direction that has already been wrong once here.
 * Correcting it needs a per-run head size this app does not have; what would
 * settle it is a resume measured against its predecessor, which is what
 * `resumeControl` is built to collect. Until then this is on
 * `docs/verification.md`'s not-verified list rather than presented as a
 * measurement.
 */
export function treatRemovedTokens(
  estimate: TreatEstimate,
  apiContextNow: number,
): number {
  return Math.round(apiContextNow * (estimate.freedBytes / estimate.totalBytes));
}

/**
 * `winnow treat -rx <tier>`, dry, for one transcript.
 *
 * The same argv `spawnPrune` uses **without `--execute`**, which is what makes
 * it a measurement: the inherited CLI's default is a dry run and the flag is
 * the opt-in. It must stay that way — this is the one place in the app that
 * names `treat` and does not want it to write, and it runs against a session a
 * Claude process is holding open. `orchestrator_safe.refusal_for` will not
 * save us there: it refuses a mutating argv only when it can see a live Claude
 * *above itself* in the process tree, and in this container the walk stops at
 * `next-server`, so the agent this measures is invisible to it.
 *
 * Failure is null and is reported, on `parseTreatEstimate`'s reasoning.
 */
export function estimateTreatCut(
  transcriptPath: string,
  tier: PruneTier,
): Promise<TreatEstimate | null> {
  return new Promise((resolve) => {
    if (!winnowAvailable()) {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: TreatEstimate | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      const child = spawn(
        WINNOW_PYTHON,
        ["-m", "winnow", "safe", "run", "--", "treat", transcriptPath, "-rx", tier],
        // `spawnPrune`'s credential argument, unchanged: the app's own
        // maintenance on root-owned transcripts.
        { env: pruneEnv(), stdio: ["ignore", "pipe", "ignore"] },
      );

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        // A summary and a strategy table, so this is bounded far tighter than
        // `planCut`'s four megabytes — that one carries a pointer per stripped
        // result and this carries a line per strategy.
        if (stdout.length < 200_000) stdout += chunk;
      });

      timer = setTimeout(() => child.kill("SIGKILL"), PRUNE_TIMEOUT_MS);
      timer.unref?.();

      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (code !== 0) {
          finish(null);
          return;
        }
        const parsed = parseTreatEstimate(stdout);
        if (parsed === null) {
          // Reported rather than returned quietly. A wording change in winnow
          // would otherwise silence the ceiling on every install at once,
          // while looking exactly like conversations with nothing in them.
          noteBookkeepingFailure(
            "parseTreatEstimate",
            new Error("no readable Before/Saved figures in `treat`'s dry run"),
          );
        }
        finish(parsed);
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * What a cut would take out, measured by the engine that would take it.
 *
 * The ceiling used to ask `planCut` whatever the setting said, and `plan` is
 * the **new** rule engine: SPEC §4's six rules at tier CB, which is what
 * `contextPruningEngine: "winnow"` runs and is not what `"legacy"` runs.
 * Measured on the two transcripts this install declined on 2026-08-28, tier CB
 * would have stripped 9 of 183 and 13 of 172 tool results — 2.2% and 7.1% of
 * the file — where `treat -rx aggressive`, the pruner actually configured,
 * strips every one of them and frees 49% and 53%. So the gate refused every
 * crossing on a figure five to twenty times smaller than the cut it was
 * refusing, and `prune_receipts` has stood empty since 2026-08-26 while the
 * decline line repeated every few minutes.
 *
 * `planCut`'s own docblock names this failure — "gating one engine's action on
 * the other's arithmetic would be a category error that produced plausible
 * numbers, which is the worst kind" — about `break_even_turns`. Reading its
 * `netBytes` instead was the same error wearing a different field name, so the
 * pairing is made structural here: one function resolves the engine, and there
 * is no way to reach a measurement without going through it.
 *
 * The tier each engine is asked at differs on purpose. `plan` is fixed at
 * `PLAN_TIER` because `gentle`/`standard`/`aggressive` and `C`/`CB`/`CBA` name
 * different things and there is no translation; `treat` is asked at
 * `contextPruningStrictness`, because that is literally the argv the prune
 * would run with.
 */
export async function ceilingCut(
  transcriptPath: string,
  apiContextNow: number,
  s: Settings = getSettings(),
): Promise<CeilingCut | null> {
  if (s.contextPruningEngine === "winnow") {
    const plan = await planCut(transcriptPath);
    if (plan === null) return null;
    return { engine: "winnow", removedTokens: plan.netBytes / BYTES_PER_TOKEN };
  }
  const estimate = await estimateTreatCut(transcriptPath, s.contextPruningStrictness);
  if (estimate === null) return null;
  return {
    engine: "legacy",
    removedTokens: treatRemovedTokens(estimate, apiContextNow),
  };
}

/** How many distinct faults get a durable row before the rest are stdout only. */
const MAX_REPORTED_FAULTS = 32;

const reportedFailures = new Set<string>();

/**
 * A bookkeeping read or write that failed, reported rather than swallowed.
 *
 * Every catch that calls this is right to be non-fatal: a receipt that will not
 * write must not fail the run it describes, and a panel query that throws must
 * not take the page down with it. All of them were also **silent**, and that is
 * a different property that nothing chose. `fork_attempts` shipped without the
 * `suffix_bytes` column that both its INSERT and its SELECT name; the write
 * threw at every fork and the read threw at every page load, and the whole of it
 * was indistinguishable from a fork engine that had had nothing to say. An
 * operator cannot tell "no forks happened" from "forks cannot be recorded", and
 * that is the one distinction this table exists to make.
 *
 * `ops.ts` was written for the same shape of bug on the sweep timer, and says
 * so: the catch is right, the silence is not.
 *
 * The first occurrence of each distinct fault gets a durable `ops_events` row
 * and every repeat goes to stdout alone. These sit in the cycle loop and on a
 * polled route, so a schema fault recurs at every boundary and every refresh,
 * and `ops_events` keeps 500 rows — one repeating fault would evict everything
 * else the operator might have needed to read beside it.
 */
function noteBookkeepingFailure(site: string, err: unknown): void {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const key = `${site}:${message}`;
  const fields = { site, message };
  // Bounded, because the key carries a message and a message can carry a value
  // that varies per call. Past the cap a genuinely new fault loses its durable
  // row and keeps its stdout line, which is the right way round.
  if (reportedFailures.has(key) || reportedFailures.size >= MAX_REPORTED_FAULTS) {
    opsLog("error", "context_pruning.record_failed", fields);
    return;
  }
  reportedFailures.add(key);
  recordOpsEvent("error", "context_pruning.record_failed", fields);
}

/**
 * Record what the new engine would have done at this boundary.
 *
 * Best-effort and never thrown from, on `recordPrune`'s reasoning.
 */
export function recordPlanObservation(
  runId: string,
  sessionId: string | null,
  plan: PlannedCut,
  pruned: boolean,
): void {
  try {
    db()
      .prepare(
        `INSERT INTO plan_observations
           (ts, run_id, session_id, tier, tool_calls, stripped, removed_bytes,
            pointer_overhead, net_bytes, suffix_bytes, break_even_turns, pruned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        runId,
        sessionId,
        plan.tier,
        plan.toolCalls,
        plan.stripped,
        plan.removedBytes,
        plan.pointerOverhead,
        plan.netBytes,
        plan.suffixBytes,
        plan.breakEvenTurns,
        pruned ? 1 : 0,
      );
  } catch (err) {
    noteBookkeepingFailure("recordPlanObservation", err);
  }
}

/* ------------------------------------------------------------------ */
/* The fork engine — a new transcript, a new session id                */
/* ------------------------------------------------------------------ */

/**
 * The break-even budget this app asks winnow for, and why it is `null`.
 *
 * winnow 1.9.0 refuses a fork whose `T* = 19·(S/D) − 20` is above a budget of
 * further turns, defaulting to 60. That gate is right for what it was measured
 * on — an operator forking a session they are about to go on using, where the
 * invalidation is real and comes out of that session's remaining turns. Over
 * 396 of this install's transcripts, forking on every rule hit came to −$10.85
 * and the gate turned it into +$56.06.
 *
 * It is the wrong question **here**, and inheriting it would be a silent
 * regression. This app forks only where a resume is already committed, and the
 * argument in this module's header is that `--resume` rewrites the prefix
 * regardless — so the cut rides a write already paid for and the `1.9·S` term is
 * not the fork's. A gate priced on that term refuses cuts that are free: the
 * `WRITTEN` fixture in `contextPruning.test.ts` is a real fork of this install
 * carrying `break_even_turns: 82.8`, written before the gate existed and refused
 * by its default afterwards.
 *
 * **Both moments, and the second one is the counter-intuitive half.** A natural
 * boundary was going to resume anyway. A manufactured one — the early-end path,
 * where the ceiling watcher interrupts a cycle *in order* to prune — pays for
 * the rewrite by ending the cycle, and that is spent at the moment of the
 * interrupt whether or not anything is then cut. So by the time the fork runs,
 * the invalidation is sunk in both cases and the arithmetic is the same. Gating
 * the fork would only mean paying for a manufactured boundary and then declining
 * to use it.
 *
 * The gate that does belong on the early-end path is the one already there, and
 * it is `CEILING_PAYBACK_HORIZON_TURNS` deciding whether to interrupt at all
 * (`orchestrator.ts`, the ceiling watcher). That is the decision with a real
 * cost behind it.
 *
 * `null` is sent as `--max-break-even none` — winnow's spelling for "the
 * question does not arise", which is deliberately not `0`. It is passed
 * explicitly on every argv rather than left to the default, so that a later
 * winnow release changing its own mind cannot move this app without a diff.
 *
 * **What would overturn it.** `resumeControl` is the experiment already built
 * for this: it reads clean boundaries — resumes with no prune before them — and
 * reports the share that came back warm. A warm clean resume means the prefix
 * *was* still cached, the boundary refund is not real, and the honest value here
 * becomes `PAYBACK_HORIZON_TURNS` — along with every figure in this file that
 * prices a boundary invalidation at zero. Until that control has
 * `MIN_CONTROL_RESUMES` behind it, the value that changes nothing is the honest
 * one.
 */
export const BOUNDARY_BREAK_EVEN_BUDGET: number | null = null;

/**
 * `winnow fork --write --json`, for one transcript.
 *
 * The other engine. `treat` edits the transcript in place and the run keeps its
 * session id; `fork` opens the original read-only and writes a **new**
 * transcript under a new UUIDv5, which the run then has to switch onto. The
 * original is never modified and never removed — it is the recovery path, and
 * `winnow recover <session> <pointer-id>` prints any stripped result back out
 * of it.
 *
 * ## What a caller has to handle that `spawnPrune` does not
 *
 * **Exit 3 is a refusal, not a failure**, and at a cycle boundary the expected
 * one is `cold-age`: winnow will not cut a conversation whose last request is
 * younger than `--min-cold-age` because the prefix may still be cached and the
 * cut is then not free. The body carries `refusals[]` with a `guard` name, so a
 * caller can tell "the guard stood" from "the tool broke" and say so. Since
 * winnow 1.9.0 there is a second guard a boundary can meet, `break-even`, and
 * `BOUNDARY_BREAK_EVEN_BUDGET` is why this app does not arm it.
 *
 * **Exit 2 is nothing to do** — no result met a rule at this tier — and its
 * body is success-shaped with `written: false`.
 *
 * **A successful fork is not yet a usable one.** Nothing here has proved the
 * new transcript resumes; winnow's own 100-fork guardrail is unrun. The caller
 * adopts the id, and rolls back to the original if the next cycle cannot resume
 * it. That containment is also the measurement: `fork_attempts.resumed` is the
 * guardrail being collected a fork at a time, in production.
 */
export interface ForkResult {
  written: boolean;
  newSessionId: string | null;
  out: string | null;
  /** The guard that stood, when nothing was written. `cold-age` is the usual one. */
  refusedBy: string | null;
  reason: string | null;
  removedBytes: number;
  netBytes: number;
  suffixBytes: number;
  breakEvenTurns: number | null;
  coldAgeSeconds: number | null;
}

export function forkTranscript(
  transcriptPath: string,
  minColdAgeSeconds: number | null,
  maxBreakEven: number | null = BOUNDARY_BREAK_EVEN_BUDGET,
): Promise<ForkResult | null> {
  return new Promise((resolve) => {
    if (!winnowAvailable()) {
      resolve(null);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: ForkResult | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // `fork --write` is the verb that rewrites the transcript outright, so
      // this is the path where the ownership actually moves. Both the original
      // and whatever the fork left behind are handed back to the child.
      restoreTranscriptOwnership(transcriptPath);
      resolve(result);
    };

    const argv = [
      "-m",
      "winnow",
      "safe",
      "run",
      "--",
      "fork",
      transcriptPath,
      "--tier",
      PLAN_TIER,
      "--write",
      "--json",
    ];
    // Passed whenever the caller has a figure, which since the default moved to
    // 0 is always unless an operator blanked it. Absent, winnow applies its own
    // 3,600 — and at a cycle boundary the transcript's last request is ~0s old
    // by construction, so that is not a stricter setting but an engine that
    // cannot fire. See `contextPruningForkMinColdAge`.
    if (minColdAgeSeconds !== null) {
      argv.push("--min-cold-age", String(Math.floor(minColdAgeSeconds)));
    }
    // Always passed, unlike --min-cold-age above: this app has a position on the
    // break-even question at a boundary and the argv should carry it, so that a
    // winnow release moving its own default cannot move this app silently.
    // See BOUNDARY_BREAK_EVEN_BUDGET.
    argv.push(
      "--max-break-even",
      maxBreakEven === null ? "none" : String(Math.floor(maxBreakEven)),
    );

    try {
      const child = spawn(WINNOW_PYTHON, argv, {
        env: pruneEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 4_000_000) stdout += chunk;
      });
      // Read as large as stdout, and that is not symmetry for its own sake.
      // `cmd_fork` prints its JSON body to **stdout** on exit 0 and 2 and to
      // **stderr** on exit 3 — and exit 3 is the refusal, the one outcome this
      // caller most needs to read structurally. A 4 KB cap here would truncate
      // the body of every cold-age refusal into unparseable JSON, and every
      // refusal would then be filed as "winnow broke".
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 4_000_000) stderr += chunk;
      });

      timer = setTimeout(() => child.kill("SIGKILL"), PRUNE_TIMEOUT_MS);
      timer.unref?.();

      child.on("error", () => finish(null));
      child.on("close", (code) => {
        // stdout first, then stderr, for the split above. A safe-mode refusal
        // puts a plain sentence on stderr rather than a body, which parses to
        // null and falls through to the reason branch — correctly, because a
        // mode refusal is not one of winnow's own guards standing.
        const parsed = parseFork(stdout) ?? parseFork(stderr);
        if (parsed) {
          finish(parsed);
          return;
        }
        // No body to read. Exit 1 is a usage error and anything else is the
        // tool breaking; either way this is not a refusal and must not be
        // filed as one.
        finish({
          written: false,
          newSessionId: null,
          out: null,
          refusedBy: null,
          reason: stderr.trim() || `winnow fork exited with code ${code ?? -1}`,
          removedBytes: 0,
          netBytes: 0,
          suffixBytes: 0,
          breakEvenTurns: null,
          coldAgeSeconds: null,
        });
      });
    } catch (err) {
      finish({
        written: false,
        newSessionId: null,
        out: null,
        refusedBy: null,
        reason: err instanceof Error ? err.message : String(err),
        removedBytes: 0,
        netBytes: 0,
        suffixBytes: 0,
        breakEvenTurns: null,
        coldAgeSeconds: null,
      });
    }
  });
}

/**
 * What an operator is told when the quiet-period guard refuses a fork.
 *
 * Pure, and exported, for one reason: the number that decides this outcome is
 * `minColdAge`, and the first version of this line did not print it. It printed
 * the age — "the last request is 0s old" — which reads as a statement about the
 * conversation and invites the reading that the conversation was too hot. The
 * conversation is *always* too hot by that reading: a fork happens in the gap
 * between two work cycles, so the age is a fraction of a second every time and
 * carries no information at all. Four consecutive refusals over two days were
 * diagnosed as a bad default in this app when the install had `30` stored
 * against it the whole time, which the log could have said and didn't.
 *
 * So the contract under test is: the effective threshold appears, and the line
 * says that any threshold above 0 refuses every fork rather than delaying one.
 */
export function coldAgeRefusalMessage(
  coldAgeSeconds: number | null,
  minColdAge: number | null,
): string {
  const age =
    coldAgeSeconds === null
      ? "younger than the threshold"
      : `${Math.round(coldAgeSeconds)}s old`;
  const threshold =
    minColdAge === null
      ? "no quiet period is set here, so winnow applied its own hour"
      : `the quiet period is set to ${minColdAge}s`;
  return (
    `Left this run's conversation alone: winnow's quiet-period guard refused ` +
    `the fork. The last request is ${age} and ${threshold}. A fork can only ` +
    `happen between two work cycles, where the conversation is always seconds ` +
    `old — so any quiet period above 0 means nothing is ever forked. Set ` +
    `contextPruningForkMinColdAge to 0 to cut here, or turn context pruning ` +
    `off if that is what you meant.`
  );
}

/**
 * What an operator is told when a run sits above the context ceiling and is
 * left alone.
 *
 * Emitted on **every** measurement, not only the first. The first version of
 * this decision logged once per run and then went quiet, which meant a run
 * climbing from 200k to 300k said nothing for an hour while the gate re-decided
 * behind it. That silence is indistinguishable from a broken feature, and it is
 * the same shape as every other fault found in this area: a cold-age guard that
 * refused forty times without saying what threshold, a control group that never
 * filled, a dashboard reading one of two tables. None of them threw; all of them
 * read as "nothing is happening".
 *
 * Emitting per measurement rather than per tick is what makes that affordable.
 * The measurement is paced by `CEILING_REMEASURE_GROWTH_TOKENS`, so the line
 * follows the conversation's growth and never a clock — a run that stops growing
 * stops repeating itself, because nothing about it has changed.
 *
 * `repeat` shortens the line rather than suppressing it. The first one has to
 * explain the decision; the ones after it only have to carry the numbers, which
 * are the part that moves and the part worth watching — a share that keeps
 * falling is a run drifting further from ever being worth cutting, and that is
 * the evidence for raising the ceiling or leaving pruning off.
 */
export function ceilingDeclineMessage(o: {
  /** The API-visible conversation now, from `sampleContext`. */
  contextTokens: number;
  /** What a cut would take out, or 0 when nothing could be priced. */
  removedTokens: number;
  /** `ceilingPayback`'s answer; null when there was no measurement to make. */
  turnsNeeded: number | null;
  /** Which engine measured it, or null where nothing could be measured. */
  engine: CeilingCut["engine"] | null;
  /** False for the first line of a run, true for every one after it. */
  repeat: boolean;
}): string {
  const share =
    o.contextTokens > 0 ? (o.removedTokens / o.contextTokens) * 100 : 0;
  // Named, because the question this line failed to answer for a whole day was
  // "which engine's figure is this". It was `plan`'s — the fork engine's rules
  // — on an install running the in-place pruner, and nothing on screen said so.
  // Through `PRUNE_ENGINE_LABEL` rather than a second vocabulary, so the engine
  // reads the same here as on the settings page and the dashboard.
  const engine = o.engine
    ? `the pruner in use (${PRUNE_ENGINE_LABEL[o.engine].toLowerCase()})`
    : null;

  // Three findings, not two. "The pruner ran and found nothing" and "nothing
  // measured it" are the same blank on screen and opposite facts underneath:
  // the first is a clean conversation and the second is a winnow that would not
  // run, a wording change in its output, or a transcript that could not be
  // read. Collapsing them is the failure this whole area keeps having — an
  // operator cannot tell a working feature from a broken one.
  const finding =
    engine === null
      ? `nothing here could be measured, so no cut has been priced`
      : o.turnsNeeded === null || o.removedTokens <= 0
        ? `${engine} found nothing here worth removing`
        : `${engine} would remove ${fmtTokens(o.removedTokens)} tokens ` +
          `(${share.toFixed(1)}% of it) and need ${o.turnsNeeded} further turns ` +
          `to pay for the rewrite that ending this cycle would cause, against a ` +
          `limit of ${CEILING_PAYBACK_HORIZON_TURNS}`;

  if (o.repeat) {
    return (
      `Still leaving this run's conversation alone at ` +
      `${fmtTokens(o.contextTokens)} tokens: ${finding}.`
    );
  }
  return (
    `This run's context has passed ` +
    `${fmtTokens(CYCLE_CONTEXT_CEILING_TOKENS)} tokens, but ${finding}. ` +
    `Letting the cycle run on, which costs cache reads at 0.1× and invalidates ` +
    `nothing. Checked again every ` +
    `${fmtTokens(CEILING_REMEASURE_GROWTH_TOKENS)} tokens of growth.`
  );
}

/** The fields of `fork --json` this app reads, or null if the body is unusable. */
export function parseFork(body: string): ForkResult | null {
  try {
    const raw = JSON.parse(body) as Record<string, unknown>;
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    const obj = (v: unknown): Record<string, unknown> =>
      v && typeof v === "object" ? (v as Record<string, unknown>) : {};

    const plan = obj(raw.plan);
    const bytes = obj(plan.bytes);
    const arithmetic = obj(plan.arithmetic);
    const coldAge = obj(raw.cold_age);
    const refusals = Array.isArray(raw.refusals) ? raw.refusals : [];
    const first = obj(refusals[0]);

    // `written` is set only after the file is on disk, so it is the one field
    // that separates a fork from a plan. A `new_session_id` without it is the
    // name a fork *would* have had.
    const written = raw.written === true;
    return {
      written,
      newSessionId:
        written && typeof raw.new_session_id === "string" ? raw.new_session_id : null,
      out: written && typeof raw.out === "string" ? raw.out : null,
      refusedBy: typeof first.guard === "string" ? first.guard : null,
      reason: typeof first.reason === "string" ? first.reason : null,
      removedBytes: num(bytes.removed),
      netBytes: num(bytes.net),
      suffixBytes: num(arithmetic.suffix_bytes),
      breakEvenTurns:
        typeof arithmetic.break_even_turns === "number"
          ? arithmetic.break_even_turns
          : null,
      coldAgeSeconds:
        typeof coldAge.seconds === "number" ? coldAge.seconds : null,
    };
  } catch {
    return null;
  }
}

/**
 * Record one fork attempt, refusal included.
 *
 * Refusals are rows too, and the reason is not bookkeeping. The expected
 * outcome at a boundary is `cold-age`, and an operator who switched the engine
 * on and saw nothing happen needs the table to say "it refused 40 times because
 * the conversation was 5 seconds old" rather than to be empty.
 *
 * Returns the row id so a later resume can be written back against it, or null
 * if the insert failed — best-effort here as everywhere in this file.
 */
export function recordForkAttempt(
  runId: string,
  sourceSessionId: string | null,
  result: ForkResult,
  minColdAgeSeconds: number | null,
  trigger: PruneTrigger,
  contextTokensAfter: number | null,
): number | null {
  try {
    const info = db()
      .prepare(
        `INSERT INTO fork_attempts
           (ts, run_id, source_session_id, new_session_id, written, refused_by,
            reason, removed_bytes, net_bytes, suffix_bytes, break_even_turns,
            cold_age_seconds, min_cold_age, trigger, context_tokens_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        runId,
        sourceSessionId,
        result.newSessionId,
        result.written ? 1 : 0,
        result.refusedBy,
        result.reason,
        result.removedBytes,
        result.netBytes,
        result.suffixBytes,
        result.breakEvenTurns,
        result.coldAgeSeconds,
        minColdAgeSeconds,
        trigger,
        contextTokensAfter,
      );
    return Number(info.lastInsertRowid);
  } catch (err) {
    noteBookkeepingFailure("recordForkAttempt", err);
    return null;
  }
}

/**
 * The fork a run adopted but has no verdict for yet, if the run is sitting on it.
 *
 * `pendingFork` lives in memory and dies with the run's loop, so a run that
 * forked and was then parked — by a rate limit, a guard, or a restart — came
 * back with no way home and no row to settle. It would resume the fork on trust,
 * and if the fork would not resume the run failed outright instead of rolling
 * back onto the conversation it had.
 *
 * Recovered from the table rather than kept in memory across the gap, because
 * the table is the thing that survives a restart. Matched on the session the run
 * is actually holding, so a fork the run has already moved off is not revived.
 */
export function pendingForkFor(
  runId: string,
  sessionId: string | null,
): { fallbackSessionId: string | null; forkSessionId: string; rowId: number } | null {
  if (!sessionId) return null;
  try {
    const row = db()
      .prepare(
        `SELECT id, source_session_id, new_session_id FROM fork_attempts
          WHERE run_id = ? AND new_session_id = ? AND written = 1 AND resumed IS NULL
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(runId, sessionId) as
      | { id: number; source_session_id: string | null; new_session_id: string }
      | undefined;
    if (!row) return null;
    return {
      fallbackSessionId: row.source_session_id,
      forkSessionId: row.new_session_id,
      rowId: row.id,
    };
  } catch (err) {
    noteBookkeepingFailure("pendingForkFor", err);
    return null;
  }
}

/**
 * Write back whether the fork this row records actually resumed.
 *
 * This column **is** milestone 2's first criterion — "given a forked session,
 * when `claude --resume <new-id>` runs, then it exits 0; 100 forks, 0 failures"
 * — collected one production cycle at a time instead of in a dedicated run. A 0
 * here is the kill condition that guardrail names, and it is worth more than
 * the same 0 from a harness because the resume was a real one the run needed.
 */
export function markForkResumed(rowId: number, resumed: boolean): void {
  try {
    db()
      .prepare("UPDATE fork_attempts SET resumed = ? WHERE id = ?")
      .run(resumed ? 1 : 0, rowId);
  } catch (err) {
    noteBookkeepingFailure("markForkResumed", err);
  }
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
  } catch (err) {
    // A receipt is evidence, not the thing itself — so this does not throw.
    noteBookkeepingFailure("recordPrune", err);
  }
}

/**
 * How a cycle boundary ended.
 *
 * Six and not two, because the difference between them is the whole reason the
 * table exists: an operator reading "nothing pruned" cannot act on it, and each
 * of these calls for a different action — none, a rebuild, a wait, or nothing
 * at all because the arithmetic said so.
 */
export type PruneDecisionOutcome =
  | "cut"
  | "nothing"
  | "declined"
  | "refused"
  | "unavailable"
  | "failed";

export interface PruneDecisionRow {
  ts: number;
  runId: string;
  trigger: PruneTrigger;
  engine: "legacy" | "winnow";
  outcome: PruneDecisionOutcome;
  detail: string | null;
  predictedTurns: number | null;
}

const PRUNE_DECISION_OUTCOMES = new Set<string>([
  "cut",
  "nothing",
  "declined",
  "refused",
  "unavailable",
  "failed",
]);

/**
 * Write down how a boundary ended, beside the log line that says the same thing.
 *
 * Best-effort on `recordPrune`'s reasoning, and the stakes here are lower still
 * — the decision has already been taken and acted on, and what is lost is a
 * clause in a sentence.
 *
 * Called at each terminus rather than once at the end, so the row and the line
 * in the operator's pane are written from the same branch and cannot come to
 * disagree about what happened.
 */
export function recordPruneDecision(
  runId: string,
  trigger: PruneTrigger,
  engine: "legacy" | "winnow",
  outcome: PruneDecisionOutcome,
  detail: string | null = null,
  predictedTurns: number | null = null,
): void {
  try {
    db()
      .prepare(
        `INSERT INTO prune_decisions
           (ts, run_id, trigger, engine, outcome, detail, predicted_turns)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), runId, trigger, engine, outcome, detail, predictedTurns);
  } catch (err) {
    noteBookkeepingFailure("recordPruneDecision", err);
  }
}

/** Raw decision rows, span- or run-bounded. */
export function readPruneDecisions(
  filter: { from: number; to: number } | { runId: string },
): PruneDecisionRow[] {
  const where = "runId" in filter ? "run_id = ?" : "ts >= ? AND ts <= ?";
  const args: (string | number)[] =
    "runId" in filter ? [filter.runId] : [filter.from, filter.to];
  try {
    const rows = db()
      .prepare(
        `SELECT ts, run_id, trigger, engine, outcome, detail, predicted_turns
           FROM prune_decisions WHERE ${where} ORDER BY ts`,
      )
      .all(...args) as {
      ts: number;
      run_id: string;
      trigger: string;
      engine: string;
      outcome: string;
      detail: string | null;
      predicted_turns: number | null;
    }[];
    return rows.flatMap((r) =>
      // Dropped rather than coerced, unlike `readReceipts`' tier. A tier that
      // cannot be read still describes a cut that happened, so a default is
      // honest there; an outcome that cannot be read is the entire content of
      // this row, and defaulting it would invent a boundary decision.
      PRUNE_DECISION_OUTCOMES.has(r.outcome)
        ? [
            {
              ts: r.ts,
              runId: r.run_id,
              trigger: r.trigger === "early-end" ? "early-end" : "boundary",
              engine: r.engine === "winnow" ? "winnow" : "legacy",
              outcome: r.outcome as PruneDecisionOutcome,
              detail: r.detail,
              predictedTurns: r.predicted_turns,
            } satisfies PruneDecisionRow,
          ]
        : [],
    );
  } catch (err) {
    noteBookkeepingFailure("readPruneDecisions", err);
    return [];
  }
}

/**
 * Count the outcomes.
 *
 * Pure and separate from the read on `sumPruneSavings`' grounds: the counting is
 * what has to be testable without a database behind it, because a breakdown that
 * does not sum to `boundaries` is a sentence quietly dropping a clause — and a
 * shorter sentence still reads as a complete one.
 */
export function sumPruneActivity(
  rows: readonly PruneDecisionRow[],
): PruneActivityDTO {
  const out: PruneActivityDTO = {
    boundaries: rows.length,
    cut: 0,
    nothing: 0,
    declined: 0,
    refused: 0,
    unavailable: 0,
    failed: 0,
    lastDetail: null,
  };
  for (const r of rows) {
    out[r.outcome] += 1;
    // Newest wins, and rows arrive in `ts` order. A cut carries no detail worth
    // repeating — the money beside it already says what happened.
    if (r.outcome !== "cut" && r.detail) out.lastDetail = r.detail;
  }
  return out;
}

/**
 * One span or one run's boundary outcomes, or undefined when it reached none.
 *
 * Undefined rather than a zeroed record, on `contextOccupancy`'s convention: the
 * page drops the section rather than printing a row of zeroes, and with every
 * boundary now writing a row, absent genuinely means nothing happened.
 */
export function pruneActivity(
  filter: { from: number; to: number } | { runId: string },
): PruneActivityDTO | undefined {
  const rows = readPruneDecisions(filter);
  return rows.length === 0 ? undefined : sumPruneActivity(rows);
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
export interface PruneReceiptRow extends NettableCut {
  tier: PruneTier;
}

/**
 * A cut, in the terms the netting arithmetic actually uses.
 *
 * Separated from `PruneReceiptRow` because the fork engine produces cuts that
 * are not prune receipts and must be priced by the same rules. A fork has no
 * `tier` in this vocabulary — it runs SPEC section 4 rule tiers, `C`/`CB`/`CBA`,
 * where a prescription is `gentle`/`standard`/`aggressive` — and inventing a
 * value to satisfy a field `netReceipt` never reads would put a wrong answer in
 * a column for the sake of a type.
 *
 * Everything here is load-bearing. `trigger` decides whether the invalidation is
 * charged, `tokensBefore` is the suffix the counterfactual read would have
 * covered, `tokensAfter` is what a resume writes, `model` and `ts` price it at
 * the rate that applied then.
 */
export interface NettableCut {
  ts: number;
  runId: string;
  trigger: PruneTrigger;
  tokensBefore: number;
  tokensAfter: number;
  tokensRemoved: number;
  model: string | null;
}

/**
 * The cache write the resume after a prune actually performed.
 *
 * Read off the first real turn following the prune. "Real" excludes the
 * all-zero record the CLI writes at a restart — it carries a `usage` block with
 * every field at zero and a null `service_tier`, and taking it as the first turn
 * reports the invalidation as $0.00.
 *
 * `cacheRead` arrived with the boundary accounting below and is the reason the
 * shape changed. It is the field that separates a resume which *rewrote* its
 * prefix from one which *re-read* it, and without it on the row the two are
 * indistinguishable — which is precisely the ambiguity the boundary zero was
 * resting on.
 */
export interface ResumeWrite {
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
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
  /**
   * What the edit cost — **$0 only when that has been observed**, never merely
   * assumed.
   *
   * Read alongside `invalidationKnown`. When that is false this is 0 and means
   * *not yet measured*, the same contract `priced` already carries for the model
   * table. The distinction is the whole point of the field: a boundary prune's
   * cost used to be hard-zeroed on an argument, which made a loss unrepresentable
   * rather than absent.
   */
  invalidationUSD: number;
  /**
   * Whether `invalidationUSD` is a measurement.
   *
   * True when a turn has followed the prune and its billed usage settled the
   * question, or when the receipt is an early end (whose write the prune plainly
   * caused). False for a boundary prune whose resume has not been observed yet —
   * and for one on an install that has never produced a clean control resume to
   * compare against, because the counterfactual is not derivable from the pruned
   * run alone. See `classifyResume`.
   */
  invalidationKnown: boolean;
  /** The only figure worth leading with. */
  netUSD: number;
}

/**
 * Share of a resume's billed prefix that came back as a cache *read* rather than
 * a write, above which that resume is called warm.
 *
 * A cold resume re-writes its whole conversation and reads only the static head
 * — the system prompt and the tool definitions, which on this install measure
 * about 15,900 tokens and are the same on every turn. A warm one reads the
 * conversation too. The gap between the two is wide, so the threshold does not
 * have to be delicate: measured over 1,316 transcripts in `~/.claude/projects`,
 * full-context rewrites read a near-constant 15.9k against conversations of
 * 50k–750k, which puts every observed cold resume under 0.30 and leaves nothing
 * sitting near the line.
 */
export const WARM_RESUME_READ_SHARE = 0.5;

/** Whether a resume re-read its prefix or paid to write it again. */
export type ResumeKind = "warm" | "cold";

/**
 * Declines in a row before one boundary is pruned anyway, to retake the reading.
 *
 * Four is a judgement, not a measurement, chosen from what it costs to be wrong
 * each way. Too high and a run that could be pruning again carries a
 * conversation it does not need; too low and the gate barely gates. One refresh
 * cut every four boundaries caps the cost of a stale decline at a quarter of the
 * prunes the ungated path would have taken, while keeping the prediction the
 * gate acts on no more than four cycles old.
 */
export const BOUNDARY_RECHECK_AFTER = 4;

/** What to do at a cycle boundary. */
export type BoundaryAction =
  | /** The payback test had no objection, or none it is still entitled to. */ "prune"
  | /** Over the horizon, but on a reading too old to keep trusting. */ "refresh"
  | /** Over the horizon, on a reading recent enough to act on. */ "decline";

/**
 * Whether to prune at this cycle boundary.
 *
 * Pure and separate from the spawning, on `sumPruneSavings`' reasoning: this is
 * the arithmetic, and it should be testable without a database, a transcript
 * scan and a subprocess behind it.
 *
 * `predicted` is `predictedPayback` — turns this run's *last* cut still needs to
 * break even, or null when it has not cut yet. Null is not a small number: it
 * means unmeasured, and it resolves to **prune**, because the repo's own corpus
 * has always-prune netting +$214.46 over 175 sessions. Refusing too readily
 * costs more in aggregate than allowing too readily, so every unknown here goes
 * the permissive way.
 *
 * `declinesSoFar` is what makes this a gate rather than a switch. A decline
 * writes no receipt, so the next boundary re-reads the same prediction and would
 * decline again for ever on one measurement. See `BOUNDARY_RECHECK_AFTER`.
 */
export function boundaryAction(
  predicted: number | null,
  declinesSoFar: number,
): BoundaryAction {
  if (predicted === null || predicted <= PAYBACK_HORIZON_TURNS) return "prune";
  return declinesSoFar >= BOUNDARY_RECHECK_AFTER ? "refresh" : "decline";
}

/**
 * Did this resume re-read the conversation, or rewrite it?
 *
 * This is the observation the boundary zero always needed and never had. The
 * argument for charging a boundary prune nothing is that `--resume` rewrites the
 * cached prefix regardless, so the write was committed before the prune ran. If
 * that is true the resume is **cold** and the zero is right. If a plain resume
 * comes back **warm**, the prefix was still cached, the prune broke it, and the
 * zero is hiding a real cost.
 *
 * Note what this can and cannot settle on its own. Run on the turn after a
 * *pruned* resume it is nearly always cold, because the edit itself broke the
 * cache — that reading is evidence of nothing. It is decisive only on a resume
 * with **no prune before it**, which is why `resumeControl` exists and why the
 * boundary gate below is worth having twice over: every prune it declines leaves
 * a clean resume behind, and clean resumes are the control group.
 */
export function classifyResume(write: ResumeWrite): ResumeKind {
  const billed = write.cacheRead + write.cacheWrite5m + write.cacheWrite1h;
  if (billed <= 0) return "cold";
  return write.cacheRead / billed >= WARM_RESUME_READ_SHARE ? "warm" : "cold";
}

/**
 * What resumes that had **no prune before them** did on this install.
 *
 * The control group, and the only thing that can settle what a boundary prune
 * costs. Everything else in this file measures the treated population.
 */
export interface ResumeControl {
  /** Clean boundaries whose next billed turn has been observed. */
  cleanResumes: number;
  /** Of those, the share that came back warm. 0 when `cleanResumes` is 0. */
  warmShare: number;
}

/**
 * Clean resumes needed before the control is allowed to decide anything.
 *
 * Small on purpose. This is not an attempt at significance — it is a floor under
 * "one observation is not a rate", and the effect it is reading is close to
 * binary: on the 1,316-transcript corpus a cold resume reads about 15.9k against
 * conversations of 50k–750k, so a handful of clean boundaries separates the two
 * hypotheses cleanly. Raising it costs nothing but delay; the honest failure
 * here is deciding on one probe, not deciding on five.
 */
export const MIN_CONTROL_RESUMES = 5;

/** No control yet — every boundary invalidation stays indeterminate. */
export const NO_RESUME_CONTROL: ResumeControl = {
  cleanResumes: 0,
  warmShare: 0,
};

/**
 * Note that a cycle boundary happened, and whether anything was cut at it.
 *
 * Best-effort and never thrown from, on `recordPrune`'s reasoning: the cycle has
 * already turned by the time this is called, and a failed insert must not end a
 * run that worked. What is lost is one point of a control group.
 */
export function recordResumeProbe(
  runId: string,
  sessionId: string | null,
  pruned: boolean,
  tokensBefore: number,
): void {
  try {
    db()
      .prepare(
        `INSERT INTO resume_probes (ts, run_id, session_id, pruned, tokens_before)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), runId, sessionId, pruned ? 1 : 0, tokensBefore);
  } catch (err) {
    noteBookkeepingFailure("recordResumeProbe", err);
  }
}

/**
 * Read the control group out of the probes and the transcripts behind them.
 *
 * Takes the already-scanned main-thread entries rather than scanning again:
 * `priceReceipts` has them in hand and the dashboard draws three nested spans
 * off one read.
 *
 * A probe with no billed turn after it yet is skipped rather than counted cold.
 * The boundary that has not resumed is the ordinary state of the newest row in
 * the table, and letting it vote would drag `warmShare` toward zero — which is
 * the direction that quietly restores the assumption this exists to replace.
 */
export function resumeControl(
  probes: readonly CleanProbe[],
  mainThread: readonly UsageEntry[],
): ResumeControl {
  // Grouped once, then one probe reads one session's turns. `firstBilledTurn`
  // skips every entry whose session is not the one asked about, so this is the
  // same loop over the only entries that could ever have answered it — and the
  // one below was O(probes x every turn on the machine): 4,835 probes against
  // 82,913 turns is 400M comparisons for a single run's page row.
  const bySession = indexBySession(mainThread);
  let observed = 0;
  let warm = 0;
  for (const probe of probes) {
    if (!probe.sessionId) continue;
    const firstBilled = firstBilledTurn(bySession, probe.sessionId, probe.ts);
    if (!firstBilled) continue;
    observed += 1;
    if (classifyResume(firstBilled) === "warm") warm += 1;
  }
  return {
    cleanResumes: observed,
    warmShare: observed === 0 ? 0 : warm / observed,
  };
}

/**
 * Main-thread turns grouped by the session that produced them, in array order.
 *
 * Every reader below asks the same question — this session's turns, after this
 * instant — and each was answering it by walking the whole corpus. Sessions
 * partition the turns, so a group holds every candidate and nothing else, and
 * relative order inside a group is the order the array had.
 */
function indexBySession(
  mainThread: readonly UsageEntry[],
): Map<string, UsageEntry[]> {
  const bySession = new Map<string, UsageEntry[]>();
  for (const e of mainThread) {
    const bucket = bySession.get(e.sessionId);
    if (bucket) bucket.push(e);
    else bySession.set(e.sessionId, [e]);
  }
  return bySession;
}

/** One boundary at which no prune ran. */
export interface CleanProbe {
  ts: number;
  sessionId: string | null;
}

/**
 * The first turn after `after` in this session that billed anything.
 *
 * "Billed anything" rather than simply "first": a restart writes a record whose
 * usage block is present and entirely zero, and taking that one reports the
 * invalidation as $0.00 — which is how this was wrong before it was measured.
 *
 * For the control, which has a probe timestamp and no pre-filtered turn list.
 * `priceReceipts` does the same read off the `following` array it has already
 * built, and the two must not come to disagree about which turn a resume is —
 * the zero-usage skip is the part that would drift.
 */
function firstBilledTurn(
  bySession: ReadonlyMap<string, UsageEntry[]>,
  sessionId: string,
  after: number,
): ResumeWrite | null {
  let best: UsageEntry | null = null;
  for (const e of bySession.get(sessionId) ?? []) {
    if (e.ts <= after) continue;
    const billed =
      e.tokens.cacheRead + e.tokens.cacheWrite5m + e.tokens.cacheWrite1h;
    if (billed <= 0) continue;
    if (!best || e.ts < best.ts) best = e;
  }
  return best
    ? {
        cacheRead: best.tokens.cacheRead,
        cacheWrite5m: best.tokens.cacheWrite5m,
        cacheWrite1h: best.tokens.cacheWrite1h,
      }
    : null;
}

/** The clean boundaries in a window, newest last. */
export function readCleanProbes(span: {
  from: number;
  to: number;
}): CleanProbe[] {
  try {
    const rows = db()
      .prepare(
        `SELECT ts, session_id FROM resume_probes
         WHERE pruned = 0 AND ts >= ? AND ts <= ? ORDER BY ts`,
      )
      .all(span.from, span.to) as { ts: number; session_id: string | null }[];
    return rows.map((r) => ({ ts: r.ts, sessionId: r.session_id }));
  } catch (err) {
    noteBookkeepingFailure("readCleanProbes", err);
    return [];
  }
}

/**
 * Price one receipt.
 *
 * ## What a boundary prune pays, and why that stopped being a constant
 *
 * Editing a cached prefix normally forces a full-price rewrite of everything
 * after the cut. The standing argument was that a boundary prune does not, and
 * that this is not an approximation: the next cycle opens with `--resume`, which
 * rewrites that prefix whether or not anything was removed from it. The rewrite
 * is the resume's cost, already committed before the prune ran, so charging it
 * here would be charging twice for one write. An early end is the opposite case
 * — it *created* the resume — so it pays for the context the resume then writes.
 *
 * **That argument is still the most likely one to be right, and it was never
 * measured.** It was implemented as `row.trigger !== "early-end" ? 0 : …`, which
 * made a boundary prune's net a product of non-negative terms with a floor of
 * exactly $0.00 — so the page built to show whether pruning earns its keep could
 * not express the answer "no". A claim that cannot fail is not evidence, however
 * plausible it is, and this feature's whole pitch is that everyone else reports
 * bytes removed and calls it a saving.
 *
 * So the zero stayed and the certainty went. `invalidationUSD` is now $0 for a
 * boundary prune only where that has been **observed**, and carries
 * `invalidationKnown: false` otherwise — the same indeterminate-not-zero
 * contract `priced` already holds for the model table, and for the same reason.
 *
 * The observation is `classifyResume`. A cold resume rewrote its prefix and the
 * zero is correct. A warm one re-read it, meaning the prefix outlived the cycle
 * boundary and a prune that broke it destroyed something worth 0.1×. The catch
 * is that reading this off the *pruned* run proves nothing — the edit breaks the
 * cache itself, so the resume after a prune is cold either way. Only a resume
 * with no prune before it can settle it, which is what `control` carries and
 * what the boundary gate in `orchestrator.ts` quietly manufactures every time it
 * declines a cut.
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
export function netReceipt(
  row: NettableCut,
  turnsAfter: number,
  resumeWrite: ResumeWrite | null = null,
  control: ResumeControl | null = null,
): PruneNet {
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
      invalidationKnown: false,
      netUSD: 0,
    };
  }
  const perToken = price.input / 1_000_000;

  const cacheSavedUSD =
    row.tokensRemoved * turnsAfter * perToken * cacheReadMultiplierOf(price);

  // **Measured where it can be, modelled only until then.**
  //
  // The write an early end causes is not a counterfactual — it is the very next
  // turn's `cache_creation_input_tokens`, sitting in the transcript. Reading it
  // is strictly better than estimating it, and the estimate was measurably
  // wrong: over the first four prunes on this install it charged against 405,049
  // tokens where the resumes actually wrote 485,828, understating the cost by
  // 16.6% and so overstating the net by about 15%. The gap is everything in the
  // context that is not in the transcript's `message` fields — the system
  // prompt, the tool definitions, `CLAUDE.md`, the three appended notices — and
  // it is one-sided, so it cannot be dismissed as estimator noise the way the
  // removal figure's ±3% can. That one is a *difference* between two readings of
  // the same file, where the offset cancels; this is an absolute.
  //
  // Priced per class rather than at one multiplier, because the row carries
  // both and an install writing at the five-minute class would otherwise be
  // charged 2× for a 1.25× write.
  const observedWriteUSD = resumeWrite
    ? (resumeWrite.cacheWrite5m * CACHE_WRITE_5M_MULTIPLIER +
        resumeWrite.cacheWrite1h * CACHE_WRITE_1H_MULTIPLIER) *
      perToken
    : null;

  const { invalidationUSD, invalidationKnown } =
    row.trigger === "early-end"
      ? {
          // Unchanged, and deliberately so. This boundary was not going to
          // happen, so the write it causes is genuinely new cost. Measured off
          // the resume where a turn has followed; estimated from `tokensAfter`
          // until then, which is the low end — a live run's cost here only ever
          // revises upward when the next turn lands.
          invalidationUSD:
            observedWriteUSD ??
            row.tokensAfter * perToken * CACHE_WRITE_1H_MULTIPLIER,
          invalidationKnown: true,
        }
      : boundaryInvalidation(
          row,
          resumeWrite,
          observedWriteUSD,
          perToken * cacheReadMultiplierOf(price),
          control,
        );

  return {
    turnsAfter,
    priced: true,
    cacheSavedUSD,
    invalidationUSD,
    invalidationKnown,
    netUSD: cacheSavedUSD - invalidationUSD,
  };
}

/**
 * What a boundary prune's edit cost, or an admission that nobody knows yet.
 *
 * Split out because the branching is the argument, and inlining it put five
 * outcomes behind one ternary where only two were visible.
 *
 * The four cases, in the order they resolve:
 *
 * 1. **No turn has followed.** Nothing has been billed since the edit, so there
 *    is nothing to read. Unknown, not zero — the receipt of a prune that ran a
 *    second ago should not read as one that has been settled.
 * 2. **The resume came back warm.** The prefix survived the edit, so the edit
 *    invalidated nothing. $0, and this time observed.
 * 3. **The resume came back cold, and clean resumes on this install are cold
 *    too.** The rewrite was happening regardless. $0, and the standing argument
 *    is now carrying a measurement instead of an assumption.
 * 4. **The resume came back cold, and clean resumes are warm.** The prefix does
 *    normally outlive a cycle boundary here, so the edit is what forced this
 *    write. Charged the difference between what the resume paid and what the
 *    unpruned one would have — a read of the *pre*-prune conversation at the
 *    run's own cache read rate, which is 0.1× on every model but the 5.1 pair.
 *
 * With no control, case 3 and case 4 are indistinguishable and the answer is
 * unknown. That is the honest floor: the counterfactual is not recoverable from
 * a pruned run, because the edit breaks the cache whether or not the boundary
 * would have.
 */
function boundaryInvalidation(
  row: NettableCut,
  resumeWrite: ResumeWrite | null,
  observedWriteUSD: number | null,
  cacheReadPerToken: number,
  control: ResumeControl | null,
): { invalidationUSD: number; invalidationKnown: boolean } {
  if (!resumeWrite || observedWriteUSD === null) {
    return { invalidationUSD: 0, invalidationKnown: false };
  }
  if (classifyResume(resumeWrite) === "warm") {
    return { invalidationUSD: 0, invalidationKnown: true };
  }
  if (!control || control.cleanResumes < MIN_CONTROL_RESUMES) {
    return { invalidationUSD: 0, invalidationKnown: false };
  }
  if (control.warmShare < WARM_RESUME_READ_SHARE) {
    return { invalidationUSD: 0, invalidationKnown: true };
  }
  // The counterfactual: the same resume without the edit, re-reading the
  // conversation as it stood *before* the cut. Floored at zero rather than
  // allowed to go negative — a resume that wrote less than the read it replaced
  // is a saving the `cacheSavedUSD` side already counts, and crediting it twice
  // here is the double-count this whole function exists to avoid.
  const avoidedReadUSD = row.tokensBefore * cacheReadPerToken;
  return {
    invalidationUSD: Math.max(0, observedWriteUSD - avoidedReadUSD),
    invalidationKnown: true,
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
  /**
   * Priced prunes whose invalidation has **not** been settled.
   *
   * Rendered rather than folded away. These contribute $0 to `invalidationUSD`
   * and therefore their full gross to `netUSD`, so a total with a high count
   * here is an upper bound on the saving and not a measurement of it. Saying so
   * is the difference between this and the version that could not report a loss.
   */
  unsettledPrunes: number;
  tokensRemoved: number;
  turnsAfter: number;
  cacheSavedUSD: number;
  invalidationUSD: number;
  netUSD: number;
}

export const NO_PRUNE_SAVINGS: PruneSavings = {
  prunes: 0,
  pricedPrunes: 0,
  unsettledPrunes: 0,
  tokensRemoved: 0,
  turnsAfter: 0,
  cacheSavedUSD: 0,
  invalidationUSD: 0,
  netUSD: 0,
};

/** One receipt beside what it turned out to be worth. */
export interface PricedReceipt {
  row: NettableCut;
  net: PruneNet;
}

/**
 * Add up a set of already-priced receipts.
 *
 * Pure and separate from the reading so that the arithmetic is testable without
 * a database and a transcript scan behind it.
 */
export function sumPruneSavings(priced: readonly PricedReceipt[]): PruneSavings {
  return priced.reduce<PruneSavings>(
    (acc, { row, net }) => ({
      prunes: acc.prunes + 1,
      pricedPrunes: acc.pricedPrunes + (net.priced ? 1 : 0),
      // Only among the priced. An unpriced receipt is already reported as
      // uncovered by `pricedPrunes`, and counting it here as well would say the
      // same omission twice in two different words.
      unsettledPrunes:
        acc.unsettledPrunes + (net.priced && !net.invalidationKnown ? 1 : 0),
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

/** Read receipts in a window, for one run, or for a page of runs. */
export function readReceipts(
  filter:
    | { from: number; to: number }
    | { runId: string }
    | { runIds: readonly string[] },
): PruneReceiptRow[] {
  // `IN ()` is a syntax error in SQLite rather than an empty result, and a page
  // of runs none of which ever pruned is the ordinary case on a stock install.
  if ("runIds" in filter && filter.runIds.length === 0) return [];
  const where =
    "runId" in filter
      ? "run_id = ?"
      : "runIds" in filter
        ? `run_id IN (${filter.runIds.map(() => "?").join(",")})`
        : "ts >= ? AND ts <= ?";
  const sql = `SELECT ts, run_id, trigger, tier, tokens_before, tokens_after, tokens_removed, model
           FROM prune_receipts WHERE ${where} ORDER BY ts`;
  const args: (string | number)[] =
    "runId" in filter
      ? [filter.runId]
      : "runIds" in filter
        ? [...filter.runIds]
        : [filter.from, filter.to];
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
  } catch (err) {
    noteBookkeepingFailure("readReceipts", err);
    return [];
  }
}

/**
 * Price a set of receipts against the transcripts behind them.
 *
 * Split out of `pruneSavings` so that several spans can be summed off **one**
 * read. The dashboard draws three that nest — a total, the week inside it, the
 * five hours inside that — and asking for each separately would scan the same
 * transcripts and re-count the same tail of turns once per span, on a ten-second
 * heartbeat.
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
 *
 * The same under-count with a harder edge is a receipt whose transcript has been
 * swept: no turns are found, so its saving reads zero while an early end's
 * invalidation still counts, and its net goes *negative*. That is why the span
 * a caller asks about is its own decision rather than "everything in the table"
 * — see the dashboard route, which bounds it at the transcript horizon.
 */
export async function priceReceipts(
  receipts: readonly PruneReceiptRow[],
): Promise<PricedReceipt[]> {
  if (receipts.length === 0) return [];

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

  // The control, from the earliest receipt in hand to now.
  //
  // Bounded below rather than reading the whole table, because what a plain
  // resume does is a property of an install's configuration and a period before
  // this one may have been running a different one. Open above, because a clean
  // boundary that happened *after* the last prune is still evidence about the
  // same install, and the gate in `orchestrator.ts` produces its controls by
  // declining prunes — so the newest rows are exactly the ones that make an
  // indeterminate receipt determinable.
  const from = receipts.reduce((min, r) => Math.min(min, r.ts), receipts[0].ts);
  const control = resumeControl(
    readCleanProbes({ from, to: Date.now() }),
    mainThread,
  );
  // Per receipt, and it was walking every turn on the machine each time. The
  // sort below is unchanged and still what fixes the order this relies on.
  const bySession = indexBySession(mainThread);

  return receipts.map((row) => {
    const sessionId = sessions.get(row.runId) ?? null;
    const following = sessionId
      ? (bySession.get(sessionId) ?? [])
          .filter((e) => e.ts > row.ts)
          .sort((a, b) => a.ts - b.ts)
      : [];

    // Read for **every** trigger now, not only for an early end. The reading was
    // always available for a boundary prune and was deliberately discarded,
    // which is what made its $0 unfalsifiable rather than merely likely.
    //
    // Taken off `following`, which is already this session's turns after this
    // receipt in time order, rather than re-scanning the whole main thread per
    // receipt. The **first turn that billed anything** rather than simply the
    // first: a restart writes a record whose usage block is present and entirely
    // zero, and taking that one reports the invalidation as nothing at all.
    const firstBilled = following.find(
      (e) =>
        e.tokens.cacheRead > 0 ||
        e.tokens.cacheWrite5m > 0 ||
        e.tokens.cacheWrite1h > 0,
    );
    const resumeWrite: ResumeWrite | null = firstBilled
      ? {
          cacheRead: firstBilled.tokens.cacheRead,
          cacheWrite5m: firstBilled.tokens.cacheWrite5m,
          cacheWrite1h: firstBilled.tokens.cacheWrite1h,
        }
      : null;

    return {
      row,
      net: netReceipt(row, following.length, resumeWrite, control),
    };
  });
}

/**
 * The fork engine's cuts, priced by exactly the rules the pruner's are.
 *
 * ## Why these are not prune receipts
 *
 * A fork writes a new transcript rather than editing one, so `pruneTranscript`
 * never runs and `recordPrune` is never called. Without this, switching
 * `contextPruningEngine` to `"winnow"` makes the savings panel go silent — the
 * work still happens and the money still moves, and the one page built to say
 * whether context control earns its keep reports nothing at all. That is worse
 * than a wrong number, because a zero reads as "it did nothing".
 *
 * ## The unit change, and why it is a division and not a fudge
 *
 * `fork_attempts` stores **bytes**, because `winnow plan`/`fork` report bytes:
 * SPEC section 6 measures `len()` of the content string. `prune_receipts`
 * stores tokens, because `contextTokens` already divided by
 * `BYTES_PER_TOKEN`. The two have to meet, and they meet on the token side
 * because that is where the price table is. Dividing by the same constant
 * `contextTokens` uses puts a fork on precisely the basis a prune is already
 * on — not on a better one. Both carry that estimate; neither pretends not to.
 *
 * ## The invalidation is the same open question, arriving unchanged
 *
 * A fork is priced by **where it was taken**, exactly as a prune receipt is.
 * At a natural boundary it is a `boundary` cut and goes through
 * `boundaryInvalidation` with the whole indeterminate-until-a-control
 * treatment, because there the counterfactual is genuinely open: the resume
 * might have rewritten this prefix anyway. At an early end it is an `early-end`
 * cut and is charged its rewrite, because that boundary exists only because
 * this app made it in order to cut.
 *
 * That distinction used to be missing — every fork was read as a boundary — and
 * it was not a rounding error. On the three forks that first ran here, the
 * resumes wrote 178k–183k tokens at the one-hour class, about $1.80 each, and
 * all of it was reported as $0 against $0.86 of savings. The identical
 * operation under the legacy engine was charged in full, so the engine switch
 * silently moved the same event onto the free side of the ledger.
 */
export async function forkSavings(
  filter: { from: number; to: number } | { runId: string },
): Promise<PruneSavings> {
  return sumPruneSavings(await priceForks(readForkCuts(filter)));
}

/**
 * One `fork_attempts` row as a cut the netting can price.
 *
 * Pure and exported so the conversions in it can be tested without a database:
 * the byte-to-token change of basis, what happens to a row written before
 * `suffix_bytes` existed, and how a row with no recorded trigger is read.
 */
export function forkCutFromRow(row: {
  ts: number;
  runId: string;
  removedBytes: number;
  netBytes: number;
  suffixBytes: number;
  model: string | null;
  trigger: PruneTrigger | null;
  contextTokensAfter: number | null;
}): NettableCut {
  // The **net** of the cut, not the gross. `removedBytes` is what came out;
  // `netBytes` is that less the pointers winnow put back in, and the pointers
  // are really there — a saving counted on the gross would be claiming bytes
  // the fork still carries.
  const removed = Math.max(0, Math.round(row.netBytes / BYTES_PER_TOKEN));
  // `suffixBytes` is winnow's own S: the conversation standing after the cut
  // line. `tokensBefore` is that suffix as it stood *before* the cut, so the
  // removed tokens go back on — which is what the counterfactual read in
  // `boundaryInvalidation` has to cover, and the only reason the column exists.
  //
  // A row written before that column existed reads 0 and falls back to the
  // removed tokens alone. That understates the suffix, which overstates the
  // invalidation and understates the net — the conservative direction, and the
  // one to be wrong in on a figure that decides whether to keep a feature on.
  const suffix = Math.max(0, Math.round(row.suffixBytes / BYTES_PER_TOKEN));
  // `suffix_bytes` is already the **pre-cut** suffix. `winnow plan` computes it
  // as the bytes standing from the cut line to the end of the source
  // transcript, which is the file before anything was removed — so the removed
  // tokens are inside it, and adding them back counted them twice.
  const before = suffix > 0 ? suffix : removed;
  return {
    ts: row.ts,
    runId: row.runId,
    // A row with no trigger predates the column. Read as `early-end`, which is
    // the **conservative** direction on a figure that decides whether to keep a
    // feature switched on: it charges the rewrite rather than assuming it away.
    // It also happens to be true of every fork written before the column
    // existed, because the context ceiling reaches a run before a natural
    // boundary does — this install has 50 early-end receipts against 2 boundary
    // ones, and every fork it has ever written came from the early-end path.
    trigger: row.trigger ?? "early-end",
    tokensBefore: before,
    // The forked conversation as measured, not as inferred. `before - removed`
    // is the *suffix* after the cut, which is not what a resume writes — it
    // writes the whole conversation, and on the first three forks here that was
    // 180k against a suffix of 70–87k. Estimating the rewrite from the suffix
    // put the cost at $0.62–0.69 where $1.79–1.83 was billed. The fallback is
    // kept for rows written before the column, and is wrong in the direction
    // that understates cost — which is why it is a fallback and not the rule.
    tokensAfter:
      row.contextTokensAfter !== null && row.contextTokensAfter > 0
        ? row.contextTokensAfter
        : Math.max(0, before - removed),
    tokensRemoved: removed,
    model: row.model,
  };
}

/** One written fork, in the terms the netting uses. */
function readForkCuts(
  filter: { from: number; to: number } | { runId: string },
): { cut: NettableCut; sessionId: string | null }[] {
  const where = "runId" in filter ? "run_id = ?" : "ts >= ? AND ts <= ?";
  const args: (string | number)[] =
    "runId" in filter ? [filter.runId] : [filter.from, filter.to];
  try {
    const rows = db()
      .prepare(
        `SELECT ts, run_id, new_session_id, removed_bytes, net_bytes, suffix_bytes,
                trigger, context_tokens_after
           FROM fork_attempts
          WHERE written = 1 AND ${where}
          ORDER BY ts`,
      )
      .all(...args) as {
      ts: number;
      run_id: string;
      new_session_id: string | null;
      removed_bytes: number;
      net_bytes: number;
      suffix_bytes: number;
      trigger: PruneTrigger | null;
      context_tokens_after: number | null;
    }[];

    // One lookup per run, as `priceReceipts` does, and for the model rather
    // than the session: a fork's session is on its own row precisely because
    // the run's current one may have moved on since.
    const models = new Map<string, string | null>();
    return rows.map((r) => {
      if (!models.has(r.run_id)) {
        const row = db()
          .prepare("SELECT model FROM runs WHERE id = ?")
          .get(r.run_id) as { model: string | null } | undefined;
        models.set(r.run_id, row?.model ?? null);
      }
      return {
        sessionId: r.new_session_id,
        cut: forkCutFromRow({
          ts: r.ts,
          runId: r.run_id,
          removedBytes: r.removed_bytes,
          netBytes: r.net_bytes,
          suffixBytes: r.suffix_bytes,
          model: models.get(r.run_id) ?? null,
          trigger: r.trigger,
          contextTokensAfter: r.context_tokens_after,
        }),
      };
    });
  } catch (err) {
    noteBookkeepingFailure("readForkCuts", err);
    return [];
  }
}

/**
 * Price a set of forks against the transcripts they produced.
 *
 * The turn count comes from the **fork's own** session id rather than the run's
 * current one. That is the fix for the mis-attribution `priceReceipts`
 * documents and cannot avoid: a run that forks twice has two sessions, and
 * counting both cuts' turns against whichever id the run ended on would credit
 * the first fork with the second's tail.
 */
async function priceForks(
  forks: readonly { cut: NettableCut; sessionId: string | null }[],
): Promise<PricedReceipt[]> {
  if (forks.length === 0) return [];
  const { entries } = await scanUsage();
  const mainThread = entries.filter((e) => !e.isSidechain);

  const from = forks.reduce((min, f) => Math.min(min, f.cut.ts), forks[0].cut.ts);
  const control = resumeControl(
    readCleanProbes({ from, to: Date.now() }),
    mainThread,
  );
  // Both reads below are per fork and both were walking every turn on the
  // machine to find one session's. Same grouping `resumeControl` makes, for the
  // same reason; only `following.length` is read, so nothing here depends on an
  // order the grouping preserves anyway.
  const bySession = indexBySession(mainThread);

  return forks.map(({ cut, sessionId }) => {
    const following = sessionId
      ? (bySession.get(sessionId) ?? []).filter((e) => e.ts > cut.ts)
      : [];
    const resumeWrite = sessionId
      ? firstBilledTurn(bySession, sessionId, cut.ts)
      : null;
    return { row: cut, net: netReceipt(cut, following.length, resumeWrite, control) };
  });
}

/** Two engines' figures, added. */
export function addSavings(a: PruneSavings, b: PruneSavings): PruneSavings {
  return {
    prunes: a.prunes + b.prunes,
    pricedPrunes: a.pricedPrunes + b.pricedPrunes,
    unsettledPrunes: a.unsettledPrunes + b.unsettledPrunes,
    tokensRemoved: a.tokensRemoved + b.tokensRemoved,
    turnsAfter: a.turnsAfter + b.turnsAfter,
    cacheSavedUSD: a.cacheSavedUSD + b.cacheSavedUSD,
    invalidationUSD: a.invalidationUSD + b.invalidationUSD,
    netUSD: a.netUSD + b.netUSD,
  };
}

/**
 * Both engines' cuts, priced and not yet added up.
 *
 * `pruneSavings` below is this plus `sumPruneSavings`, and the split exists for
 * the one caller that has to slice before it sums: the dashboard prices once
 * over the widest span it draws and then totals three subsets of that list, so
 * a function returning a total is no use to it.
 *
 * It is exported because of what that caller did instead. It reached for
 * `priceReceipts(readReceipts(...))` — the legacy table alone — and so the
 * whole dashboard was blind to the fork engine: a cut showed up on its own
 * run's page, which goes through `pruneSavings`, and nowhere on the card that
 * says what context control has been worth. Two views of one event, disagreeing
 * because one of them reached past the function that knows there are two
 * tables. There is no longer a reason to reach past it.
 */
export async function pricedCuts(
  filter: { from: number; to: number } | { runId: string },
): Promise<PricedReceipt[]> {
  // Both engines. An install that switched from one to the other has cuts of
  // both kinds in any window wide enough to matter, and a figure covering only
  // the engine currently configured would drop the other's work out of the
  // total the moment the setting changed — which reads as pruning having
  // suddenly stopped earning anything.
  const [pruned, forked] = await Promise.all([
    priceReceipts(readReceipts(filter)),
    priceForks(readForkCuts(filter)),
  ]);
  return [...pruned, ...forked];
}

/** What pruning has been worth, over a window or over one run. */
export async function pruneSavings(
  filter: { from: number; to: number } | { runId: string },
): Promise<PruneSavings> {
  return sumPruneSavings(await pricedCuts(filter));
}

/**
 * Priced receipts summed per run.
 *
 * Pure and separate from the read on `sumPruneSavings`'s grounds, and it earns
 * that separately: a receipt filed against the wrong run puts one run's money on
 * another's row, which is wrong in a way nothing downstream can detect.
 *
 * A run with no receipts is **absent** rather than present at zero, so a caller
 * can tell "pruning saved nothing here" from "pruning did not run".
 */
export function groupPruneSavingsByRun(
  priced: readonly PricedReceipt[],
): Map<string, PruneSavings> {
  const byRun = new Map<string, PricedReceipt[]>();
  for (const p of priced) {
    const bucket = byRun.get(p.row.runId);
    if (bucket) bucket.push(p);
    else byRun.set(p.row.runId, [p]);
  }
  return new Map([...byRun].map(([runId, rs]) => [runId, sumPruneSavings(rs)]));
}

/**
 * What pruning has been worth to each of a page of runs.
 *
 * One read and **one** pricing pass for the whole page rather than
 * `pruneSavings({ runId })` per row: pricing counts the turns after each receipt
 * out of a transcript scan, and a hundred separate calls would scan the same
 * transcripts a hundred times on a four-second poll. `priceReceipts` returns
 * before the scan when nothing came back, so a page whose runs never pruned
 * costs one indexed query.
 */
export async function pruneSavingsByRun(
  runIds: readonly string[],
): Promise<Map<string, PruneSavings>> {
  const byRun = groupPruneSavingsByRun(
    await priceReceipts(readReceipts({ runIds })),
  );
  // The runs list reads this per row, so a forked run showing nothing in the
  // Pruning column while its own page showed a figure would be the two views
  // disagreeing about the same run.
  for (const runId of runIds) {
    const forked = await forkSavings({ runId });
    if (forked.prunes === 0) continue;
    byRun.set(runId, addSavings(byRun.get(runId) ?? NO_PRUNE_SAVINGS, forked));
  }
  return byRun;
}
