import { db, getJSON, setJSON } from "./db";
import { dayKey, scanDreaming, selectWritable, type SignatureRollup } from "./dreaming";
import {
  claimSignatures,
  recordNight,
  recordNotePath,
  writtenSignatures,
  type NightOutcome,
} from "./dreamingLedger";
import { resolveKnowledgeRoot } from "./knowledge";
import { TERMINAL_STATUSES, createRun, getRun, runEvents } from "./orchestrator";
import { nextOccurrence } from "./schedules";
import { mayWriteDataDir } from "./serverLock";
import { getSettings, type Settings } from "./settings";

/**
 * The half of Dreaming that spends money.
 *
 * A night reads the recurrence readout, asks which signatures have spanned
 * enough days and have not been written yet, claims them, and creates **one
 * run** whose folder is the operator's vault. It is a run rather than an assist
 * deliberately: a run lands in `runs.spent_usd`, which is where `installSpend`'s
 * rolling 24 hours looks, and it appears on `/runs` with a log, a cost and a
 * status. An assist would inherit the review's ten-minute clock
 * (`review.ts:78`), log itself as a review (`logLine.ts:561`) and spend
 * somewhere the install ceiling cannot see it (`installBudget.ts:79`).
 *
 * ## The clock, and what it is not allowed to do
 *
 * `schedules.ts` is this app's only other clock over work that spends, and
 * three of its rules are copied here because they were each learned the
 * expensive way: the timer stops rather than skips when the data-directory
 * claim is lost, since two processes firing one night is two agents writing
 * into one vault; a tick that is already running does not stack; and **a boot
 * never catches up.** The cursor jumps past every night that passed while this
 * process was down, because a server coming back at noon must not start an
 * unattended agent because of something that should have happened at 03:04.
 *
 * ## What bounds it
 *
 * `dreamingMaxCostUSD` is not nullable, on `scheduleRefusal`'s reasoning — a
 * clock removes the person who would have seen what the last one cost. The run
 * carries it as `maxRunCostUSD`, and `maxIterations` as the monotone terminus
 * `budget.ts` requires of every policy.
 */

/** How often the timer looks. The fire time itself is minute-resolution. */
const TICK_MS = 60_000;

/** Work cycles one night may take. A terminus, not a target. */
const MAX_CYCLES = 6;

/**
 * Wall clock one night may take.
 *
 * `budget.ts` is satisfied by `maxIterations` alone, so this is not there to
 * make the policy legal — it is there because six cycles has no upper bound in
 * time and the thing being bounded is how long an agent may hold the operator's
 * document store open. The first real night wrote twelve notes in eighteen
 * minutes; ninety leaves room for a slow one and still ends the same day.
 */
const MAX_MINUTES = 90;

/**
 * The kv key holding the last fire time already acted on, as epoch ms.
 *
 * **An instant, not a night, and that distinction is the whole of it.** It was
 * a `YYYY-MM-DD` day key, which is coarser than the thing it guards: the boot
 * reconciler set it to today so a restart could not replay a missed 03:04, and
 * that closed the *rest of the calendar day* along with it. On a machine
 * rebuilt most days — this one — the nightly pass would have fired
 * approximately never, with an empty Nights tab and nothing anywhere reporting
 * a fault. `schedules.ts` keys its cursor on an instant for exactly this
 * reason, and this now does the same.
 *
 * The key is a new one rather than the old name reused, because the *shape* of
 * the stored value changed: an install carrying the old day string would read
 * back as a `NaN` cursor and every comparison against it would be false, which
 * is the trap `orchestrator.ts:373` records for `globalThis` and holds just as
 * well for a settings row.
 */
const CURSOR_KEY = "dreaming.firedAt";

const timer = globalThis as unknown as {
  __ufDreamingTimer?: ReturnType<typeof setInterval> | null;
  __ufDreamingRunning?: boolean;
};

export interface NightResult {
  night: string;
  outcome: NightOutcome;
  reason: string | null;
  runId: string | null;
  selected: SignatureRollup[];
}

function cursor(): number | null {
  const raw = getJSON<unknown>(CURSOR_KEY, null);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function setCursor(at: number): void {
  setJSON(CURSOR_KEY, at);
}

/** Exported for the clock's test and for nothing else. */
export function clearDreamingCursor(): void {
  setJSON(CURSOR_KEY, null);
}

/**
 * The prompt a night hands its run.
 *
 * Pure and exported for its test, because every constraint this feature has
 * that is not enforced by code is enforced by this string, and a string nobody
 * asserts on is a string that drifts. Five things it must always say:
 *
 * 1. **Read the vault's own `CLAUDE.md` first.** This is the licence. The
 *    vault's `AGENTS.md` forbids notes from a session that has not, and the
 *    only reason this run is allowed to write at all is that it is pointed at
 *    the vault as its folder and told to read the conventions before writing.
 * 2. **Transcription is the claim; diagnosis is a hypothesis.** The error
 *    string is what the machine said and is checkable. Why it happened is a
 *    reconstruction, and the operator's own vault records the working position
 *    that an unverified stated cause must never enter a store as a fact.
 * 3. **Grow an existing note rather than writing a second one beside it.** The
 *    vault's conventions name that as the failure mode they exist to prevent.
 * 4. **A signature is a string, not a cause.** Four `bwrap` denials at four
 *    paths are one cause; `Exit code N` is many. The run is told to say so
 *    rather than to resolve it, because resolving it is a judgement with no
 *    verifier.
 * 5. **Report the paths back**, so the ledger can point at them and a person
 *    can find what to delete.
 */
export function buildDreamingPrompt(rollups: readonly SignatureRollup[], night: string): string {
  const items = rollups
    .map((r, i) => {
      const span = `${r.days.length} day${r.days.length === 1 ? "" : "s"}`;
      return [
        `### ${i + 1}. Seen on ${span} (${r.days.join(", ")}), ${r.instances} time(s)`,
        "",
        "```",
        r.sample.trim(),
        "```",
      ].join("\n");
    })
    .join("\n\n");

  return [
    `You are writing into this knowledge vault, which is your working directory.`,
    ``,
    `**Read \`CLAUDE.md\` in this directory before you write anything.** It carries`,
    `the writing conventions, and a note that violates them is worse than no note.`,
    `If you cannot find or read it, stop and write nothing.`,
    ``,
    `## What this is`,
    ``,
    `Below are failures observed in this install's own Claude Code transcripts on`,
    `the night of ${night}. Each one has occurred on two or more separate days, so`,
    `each is a standing property of the environment rather than an incident.`,
    `Failures seen on only one day are deliberately not shown to you.`,
    ``,
    `## What to write`,
    ``,
    `For each item, either grow an existing note that already covers it or create`,
    `one, following the conventions you just read — complete frontmatter, at least`,
    `three outgoing wikilinks with a \`## Related\` section explaining each, sources`,
    `for every claim, and \`confidence\` that does not exceed what those sources`,
    `license. **Search the vault first.** Writing a second note on a topic beside`,
    `an existing one is the failure mode the conventions exist to prevent; growing`,
    `the existing note in place is what to do instead.`,
    ``,
    // Both learned from the first night this ever ran: its notes passed the
    // vault's ERROR gate but tripped two warnings, and both are one line each.
    // Named explicitly rather than left to "follow the conventions", because
    // the conventions were followed and these still came out wrong.
    `Two the first run of this job got wrong, so they are spelled out: a note with`,
    `a \`sources:\` block in its frontmatter also needs a \`## Sources\` section in`,
    `the body, and any note you leave at \`status: seed\` needs a \`seeded_by:\``,
    `field naming the note it came from. Run the vault's own quality check before`,
    `you finish if it has one, and fix what it reports about the files you wrote.`,
    ``,
    `## What you may and may not claim`,
    ``,
    `- The error text is **transcription**: the machine said it, and it is`,
    `  checkable. Quote it verbatim.`,
    `- Why it happened is a **hypothesis**. Mark it as one. Never write an`,
    `  unverified cause as though it were established.`,
    `- These are normalised **strings**, not causes. Numbers, hashes and path`,
    `  interiors are collapsed, so one cause can appear as several items and one`,
    `  item can carry several causes. Say so where it matters rather than`,
    `  resolving it by guessing.`,
    `- Some of these are not failures at all — a person declining a tool call and`,
    `  a permission prompt both land here. If an item is one of those, say so and`,
    `  write nothing for it.`,
    ``,
    `## When you are done`,
    ``,
    `Regenerate the vault's index if its conventions ask you to. Then finish your`,
    `final message with one line per note you created or edited, exactly:`,
    ``,
    `NOTE <item number> <path relative to this directory>`,
    ``,
    `Write that line only for a file you actually wrote. If you wrote nothing for`,
    `an item, write no line for it.`,
    ``,
    `## The items`,
    ``,
    items,
  ].join("\n");
}

/**
 * Parse the `NOTE n path` lines a run reports.
 *
 * Tolerant on purpose: an agent that writes the line with a stray bullet, a
 * backtick or extra spacing has still told us what we asked for, and the cost
 * of being strict is a ledger row pointing at nothing. Anything that does not
 * resolve to a known item number is dropped rather than guessed at.
 */
export function parseNoteLines(text: string, count: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "");
    const m = /^NOTE\s+(\d+)\s+(.+)$/i.exec(line);
    if (!m) continue;
    const index = Number(m[1]);
    if (!Number.isInteger(index) || index < 1 || index > count) continue;
    const p = m[2].trim().replace(/^[`"']|[`"']$/g, "");
    if (p) out.set(index, p);
  }
  return out;
}

/**
 * Everything that must be true before a night may spend anything.
 *
 * Returned as a sentence rather than a code, because every one of these is
 * something the operator can act on and the pane shows it verbatim.
 */
export function dreamingRefusal(s: Settings): string | null {
  if (!s.dreamingEnabled) return "Dreaming is off.";
  if (!(s.dreamingMaxCostUSD > 0)) {
    return "Dreaming has no cost ceiling, and a clock removes the person who would have seen what the last run cost.";
  }
  const root = resolveKnowledgeRoot(s);
  if (!root.ok) return root.reason;
  return null;
}

/**
 * A Dreaming run that has not settled, if there is one.
 *
 * Exported for its test, on `tickSchedules`' precedent: the check is one SQL
 * predicate and every way of getting it wrong is silent — a status list that
 * drifts from `TERMINAL_STATUSES` would let two agents into the vault, and a
 * prefix that stopped matching would refuse every night for ever.
 *
 * Asks the `runs` table rather than the ledger, because the ledger records what
 * a night *decided* and this needs to know what is still happening. The
 * `origin_ref` prefix is the only thing that marks a run as this feature's —
 * `origin` is `schedule` or `form`, both of which every other run uses too.
 */
export function liveDreamingRun(): { runId: string; night: string } | null {
  const row = db()
    .prepare(
      `SELECT id, origin_ref AS ref FROM runs
        WHERE origin_ref LIKE 'dreaming:%'
          AND status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(...TERMINAL_STATUSES) as { id: string; ref: string } | undefined;
  if (!row) return null;
  return { runId: row.id, night: row.ref.slice("dreaming:".length) };
}

/**
 * Decide one night and, if anything qualifies, start the run that writes it.
 *
 * Exported for the manual press as well as the timer — the two differ only in
 * `origin`, which is exactly the distinction the column exists to record.
 */
export async function runDreamingNight(opts: {
  now?: number;
  origin: "schedule" | "form";
}): Promise<NightResult> {
  const now = opts.now ?? Date.now();
  const settings = getSettings();
  const night = dayKey(now, settings.dreamingTimeZone);

  const refusal = dreamingRefusal(settings);
  if (refusal) {
    const result: NightResult = {
      night,
      outcome: "refused",
      reason: refusal,
      runId: null,
      selected: [],
    };
    recordNight({ ...result, startedAt: now, selected: 0 });
    return result;
  }

  const root = resolveKnowledgeRoot(settings);
  if (!root.ok) {
    // Re-checked after the refusal above only because the type narrows here;
    // the refusal already covers the reachable case.
    const result: NightResult = {
      night,
      outcome: "refused",
      reason: root.reason,
      runId: null,
      selected: [],
    };
    recordNight({ ...result, startedAt: now, selected: 0 });
    return result;
  }

  // Nothing else stops two nights overlapping, and what they would overlap in
  // is the operator's live document store. `knowledge.ts:39`-`:44` refuses a
  // background writer for exactly this reason — "a background index that can
  // write into it is one that can lose somebody's paragraph while they are
  // typing it" — and two of our own agents editing one vault is that hazard
  // with the app on both ends of it. A long night is the ordinary way in: six
  // cycles against a vault has no wall-clock bound of its own until the cap
  // above, and the next night's timer does not ask what the last one is doing.
  const live = liveDreamingRun();
  if (live) {
    const result: NightResult = {
      night,
      outcome: "refused",
      reason: `The night of ${live.night} is still running. A second pass would put two agents in the vault at once.`,
      runId: live.runId,
      selected: [],
    };
    recordNight({ ...result, startedAt: now, selected: 0 });
    return result;
  }

  const readout = await scanDreaming({
    timeZone: settings.dreamingTimeZone,
    sinceDays: settings.transcriptRetentionDays,
    now,
  });
  const selected = selectWritable(
    readout.recurring,
    writtenSignatures(),
    settings.dreamingMinDays,
  ).slice(0, Math.max(1, settings.dreamingMaxPerNight));

  if (selected.length === 0) {
    // The success case for a write-on-recurrence policy, and the one the pane
    // must not draw as a failure: nothing recurred that was not already
    // written down.
    const result: NightResult = {
      night,
      outcome: "quiet",
      reason: null,
      runId: null,
      selected: [],
    };
    recordNight({ ...result, startedAt: now, selected: 0 });
    return result;
  }

  const prompt = buildDreamingPrompt(selected, night);

  let runId: string;
  try {
    const run = createRun({
      folder: root.root,
      mountId: settings.knowledgeBaseMountId,
      prompt,
      // Never isolated. An isolated run works in a copy and lands a branch, and
      // the vault is not a repository — there is nothing to land it into, and a
      // note written into a worktree that is later discarded is a note nobody
      // ever sees.
      isolate: false,
      // Nobody is watching a run a timer started. `acceptEdits` still prompts
      // for everything that is not a file edit, and a prompt with no operator
      // behind it stalls the run until the duration guard ends it — no note
      // written, on the one night the signature qualified for one.
      permissionMode: "bypassPermissions",
      budget: {
        maxRunCostUSD: settings.dreamingMaxCostUSD,
        maxRunCostFactor: null,
        maxIterations: MAX_CYCLES,
        maxWeeklyFraction: null,
        maxSessionFraction: null,
        maxRunTokens: null,
        maxDurationMinutes: MAX_MINUTES,
        enforcement: "between-cycles",
        continueAfterDone: false,
      },
      origin: opts.origin === "schedule" ? "schedule" : "form",
      originRef: `dreaming:${night}`,
    });
    runId = run.id;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const result: NightResult = {
      night,
      outcome: "refused",
      reason,
      runId: null,
      selected: [],
    };
    recordNight({ ...result, startedAt: now, selected: 0 });
    return result;
  }

  // Claimed *after* the run exists so the row can name it, and before the run
  // has written anything so a crash mid-way cannot hand the same signatures to
  // tomorrow. `claimSignatures` documents which way that trade runs.
  claimSignatures(night, runId, selected, now);

  const result: NightResult = {
    night,
    outcome: "selected",
    reason: null,
    runId,
    selected,
  };
  recordNight({ ...result, startedAt: now, selected: selected.length });
  return result;
}

/* ------------------------------------------------------------------ */
/*                              The clock                              */
/* ------------------------------------------------------------------ */

/** The instant tonight's pass is due, in the operator's zone. */
export function nextDreamingFire(s: Settings, after: number): number {
  return nextOccurrence({ kind: "daily", minutes: s.dreamingMinutes }, s.dreamingTimeZone, after);
}

/**
 * Close every night that passed while this process was down, and start nothing.
 *
 * `reconcileSchedulesOnBoot`'s rule, for its reason: a server coming back up
 * must not start an unattended agent because of something that should have
 * happened hours ago. The cursor jumps to the current night whatever it finds,
 * so the grace below can only ever cover a late tick and never a restart.
 */
export function reconcileDreamingOnBoot(now = Date.now()): void {
  // The boot instant, so every window that closed while this process was down
  // is behind the cursor and a window still ahead of it today is not. Set
  // unconditionally: a cursor left over from a previous boot is exactly the
  // stale value this is here to move past.
  setCursor(now);
}

/**
 * Whether tonight's window is open, and which one it is.
 *
 * Split out from the tick so the clock can be tested without a timer, a
 * database of runs, or a vault — every fault this function has ever had was
 * invisible to a press and would have taken a night to observe in production.
 *
 * A cursor that has never been set does **not** fire. A fresh install, or one
 * restored from a backup taken before this key existed, would otherwise start
 * an unattended agent because of a window it has no record of deciding. The
 * reading arms it instead, so the next window is honoured.
 */
export function dreamingDue(now = Date.now()): { due: boolean; dueAt: number } {
  const s = getSettings();
  // The most recent occurrence at or before `now`: `nextOccurrence` is strictly
  // forward, so today's is found by asking from a day earlier.
  const dueAt = nextDreamingFire(s, now - 24 * 3_600_000);
  const last = cursor();
  if (last === null) {
    setCursor(now);
    return { due: false, dueAt };
  }
  return { due: dueAt > last && now >= dueAt, dueAt };
}

/** Record a window as acted on, so it is not decided twice. */
export function markDreamingFired(dueAt: number): void {
  setCursor(dueAt);
}

/**
 * Start the clock, without letting the act of starting it spend anything.
 *
 * Called when the setting is saved as well as at boot, because `startDreaming`
 * used to run at boot alone: an operator who switched Dreaming on in Settings
 * got a switch that read as on and a timer that did not exist until the next
 * restart.
 *
 * Arming sets the cursor only when there is none. Turning the setting on is not
 * a press of Run — `review.ts:34`'s rule — so it must not fire a window that has
 * already passed today; and the settings page re-sends every field on every
 * save, so re-arming unconditionally would push the cursor past a window that
 * was about to fire, giving a nightly job that silently skips any day the
 * operator opened Settings.
 */
export function armDreaming(now = Date.now()): void {
  if (cursor() === null) setCursor(now);
  startDreaming();
}

/** Stop it, for the settings door to call when the switch goes off. */
export function disarmDreaming(): void {
  stopDreaming();
}

export function startDreaming(): void {
  if (timer.__ufDreamingTimer) return;
  if (!getSettings().dreamingEnabled) return;
  timer.__ufDreamingTimer = setInterval(() => void tickDreaming(), TICK_MS);
  timer.__ufDreamingTimer.unref?.();
}

function stopDreaming(): void {
  if (!timer.__ufDreamingTimer) return;
  clearInterval(timer.__ufDreamingTimer);
  timer.__ufDreamingTimer = null;
}

/**
 * Exported for its test and for nothing else.
 *
 * The data-directory claim is asked here rather than only at the boot that
 * started this timer, because ownership moves: a server that stalls past the
 * lock's staleness window loses the directory to a second process, and the two
 * would then both point an agent at one vault. The timer stops rather than
 * skipping — the nights belong to whoever owns the directory, and this process
 * will never own it again.
 */
export async function tickDreaming(): Promise<void> {
  if (!mayWriteDataDir()) {
    stopDreaming();
    return;
  }
  const settings = getSettings();
  if (!settings.dreamingEnabled) {
    stopDreaming();
    return;
  }
  if (timer.__ufDreamingRunning) return;

  const now = Date.now();
  const { due, dueAt } = dreamingDue(now);
  if (!due) return;

  timer.__ufDreamingRunning = true;
  try {
    // Moved before the work, not after: a night that throws must not be retried
    // every minute until midnight. The row `runDreamingNight` writes is what
    // says what happened.
    markDreamingFired(dueAt);
    await runDreamingNight({ now, origin: "schedule" });
  } catch (err) {
    // Loud rather than swallowed. This is the only surface an operator has, and
    // a night that has quietly stopped deciding looks exactly like a quiet one.
    console.error("[usagefoundry] dreaming night failed", err);
    recordNight({
      // The night the window belonged to, in the operator's zone — the same key
      // `runDreamingNight` would have written, so a failure lands on the row a
      // success would have.
      night: dayKey(now, settings.dreamingTimeZone),
      startedAt: now,
      outcome: "failed",
      reason: err instanceof Error ? err.message : String(err),
      runId: null,
      selected: 0,
    });
  } finally {
    timer.__ufDreamingRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/*                    Reading the run's answer back                    */
/* ------------------------------------------------------------------ */

/**
 * Attach the files a finished night's run says it wrote.
 *
 * Read-time rather than run-loop: this is the only consumer of the answer, the
 * pane is the only place it is shown, and putting a Dreaming-shaped branch into
 * the orchestrator's cycle handling would be a feature reaching into the loop
 * every other feature is careful not to touch. A night whose run is still going
 * has no answer yet; one that is finished has a final message that is not going
 * to change, so reading it when somebody looks is both correct and free.
 *
 * Only the *last* `assistant` event is read. That is `cycleOutputs`' rule and
 * for its reason: the main thread's final turn is the cycle's report, and an
 * earlier turn saying `NOTE 1 draft.md` is a plan rather than a result.
 *
 * Idempotent, and deliberately does not clear a path it already has: a run that
 * is reopened and says nothing the second time must not blank a row that
 * pointed at a real file.
 */
export function reconcileDreamingNotes(): number {
  // Keyed on the **run**, never on the night. Two passes in one calendar night
  // — a press at noon and the timer at 03:04, or two presses — share a
  // `dreaming_nights` row but not a prompt: each run was handed only its own
  // selection and numbered it from 1. Indexing a night's rows as one list maps
  // the second run's "NOTE 1" onto the first run's first signature, which
  // writes a path onto a row about a different failure. Nothing would report
  // it: both rows exist, both point at real files, and only the pairing is
  // wrong.
  const pending = db()
    .prepare(
      `SELECT DISTINCT run_id AS runId
         FROM dreaming_notes
        WHERE run_id IS NOT NULL AND note_path IS NULL`,
    )
    .all() as { runId: string }[];

  let attached = 0;
  for (const { runId } of pending) {
    const run = getRun(runId);
    if (!run || !TERMINAL_STATUSES.includes(run.status)) continue;

    let report = "";
    for (const e of runEvents(runId).events) {
      if (e.kind !== "assistant") continue;
      const text = e.payload.text;
      if (typeof text === "string" && text.trim()) report = text;
    }
    if (!report) continue;

    // The order `claimSignatures` inserted them, which is the order
    // `buildDreamingPrompt` numbered them — both walk the same array.
    const claimed = db()
      .prepare(
        "SELECT signature, note_path AS notePath FROM dreaming_notes WHERE run_id = ? ORDER BY rowid",
      )
      .all(runId) as { signature: string; notePath: string | null }[];

    for (const [index, notePath] of parseNoteLines(report, claimed.length)) {
      const target = claimed[index - 1];
      // Never overwrites a path it already has: a run reopened and re-reported
      // must not blank a row that points at a real file.
      if (!target || target.notePath) continue;
      recordNotePath(target.signature, notePath);
      attached++;
    }
  }
  return attached;
}
