import { db } from "./db";
import {
  INSTALL_WINDOW_MS,
  evaluateInstallBudget,
  installBudgetIsOff,
  normalizeInstallBudget,
  type BudgetVerdict,
  type InstallBudgetPolicy,
  type InstallProgress,
} from "./budget";
import { telemetrySpendSince } from "./otlp";
import { getSettings } from "./settings";

/**
 * What this installation has spent, and whether it may start anything else.
 *
 * Its own module rather than a corner of `orchestrator.ts` because all five
 * doors read it and they live in four different files — `orchestrator.ts`
 * (`createRun` and the pre-cycle guard), `workflows.ts` (`startWorkflow`,
 * `startBlockTurn`), `chat.ts` (`sendChatMessage`) — and the last two already
 * import the first, so a home in any one of them would be an import cycle
 * waiting to happen. It reads the database and nothing else: the *decision* is
 * `evaluateInstallBudget`, which is pure and unit-tested beside the run and
 * instance guards.
 *
 * **No new cost source.** Every figure here is one this app already records:
 * `runs.spent_usd` and `runs.spent_usd_est`, `workflow_instance_blocks.cost_usd`,
 * `chat_sessions.cost_usd`, and — for cycles in flight — `telemetrySpendSince`,
 * through the same one door and with the same per-run, per-cycle bound the live
 * run guard and the instance guard already use. None of it reaches
 * `buildSnapshot()`, `runs.spent_usd` or any existing meter; this is its own
 * reading, with the same display-versus-guard split everything else here makes.
 */

/** Where the rolling window starts. */
function windowStart(now: number): number {
  return now - INSTALL_WINDOW_MS;
}

/**
 * The install's spend across the rolling window, measured and guarded.
 *
 * **A run contributes its whole spend if it was still going inside the window.**
 * `runs.spent_usd` is one figure for a whole run and this app records no
 * per-hour breakdown of it, so a run that started 30 hours ago and finished an
 * hour ago is counted in full. That over-counts, which is the safe direction for
 * a ceiling and the wrong one for a report — which is why this feeds a guard and
 * a card of its own and never a dashboard meter or a period rollup. The settings
 * copy says so.
 *
 * Blocks and chats are bounded the same way, on the only instants their rows
 * carry: a block's `finished_at` and a chat's `updated_at`. A row that has not
 * finished is inside the window by definition.
 */
export function installSpend(now = Date.now()): InstallProgress {
  const since = windowStart(now);

  const runs = db()
    .prepare(
      `SELECT id, status, spent_usd AS spent, spent_usd_est AS est,
              active_started_at AS cycleStartedAt
         FROM runs
        WHERE finished_at IS NULL OR finished_at >= ?`,
    )
    .all(since) as Array<{
    id: string;
    status: string;
    spent: number;
    est: number;
    cycleStartedAt: number | null;
  }>;

  let spentUSD = 0;
  let spentGuardUSD = 0;
  for (const run of runs) {
    spentUSD += run.spent;
    spentGuardUSD += run.spent + run.est;
    // `running` alone, for the reason `instanceSpend` bounds it that way and
    // `fmtCycleInFlight` refuses the column on any other status: nothing clears
    // `active_started_at` when the container dies mid-cycle, so a terminal row
    // can still name a cycle that ended hours ago.
    if (run.status === "running" && run.cycleStartedAt !== null) {
      spentGuardUSD += telemetrySpendSince(run.id, run.cycleStartedAt).costUSD;
    }
  }

  // An orchestrator block's deciding turn: measured money this app spent that no
  // run row records, exactly as `instanceSpend` counts it.
  const blocks = db()
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM workflow_instance_blocks" +
        " WHERE finished_at IS NULL OR finished_at >= ?",
    )
    .get(since) as { spent: number };

  // And the orchestrator chat, which passes through no `evaluateBudget` at all
  // and is bounded only by `chatTurnBudgetUSD` and the clock.
  const chats = db()
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM chat_sessions WHERE updated_at >= ?",
    )
    .get(since) as { spent: number };

  const other = blocks.spent + chats.spent;
  return { spentUSD: spentUSD + other, spentGuardUSD: spentGuardUSD + other };
}

/** The ceiling as configured, `null` meaning off. */
export function installBudget(): InstallBudgetPolicy {
  return normalizeInstallBudget({
    maxInstallCostUSD: getSettings().installDailyCostLimitUSD,
  });
}

/**
 * The verdict every door reads: may this install start something that spends?
 *
 * Returns `null` when the ceiling is off, so a caller's ordinary path is one
 * settings read and out — and so the doors can say "nothing to check" rather
 * than pretending to have checked.
 */
export function installBudgetVerdict(
  now = Date.now(),
): (BudgetVerdict & { allowed: false }) | null {
  const policy = installBudget();
  if (installBudgetIsOff(policy)) return null;
  const verdict = evaluateInstallBudget(policy, installSpend(now));
  return verdict.allowed ? null : verdict;
}

/** The same, as the sentence a door with an error channel shows. */
export function installBudgetRefusal(now = Date.now()): string | null {
  return installBudgetVerdict(now)?.reason ?? null;
}

/** What the dashboard draws: the reading, the ceiling and what it covers. */
export interface InstallSpendReport extends InstallProgress {
  /** null when no ceiling is configured — the meter is indeterminate, not 0%. */
  limitUSD: number | null;
  windowHours: number;
}

export function installSpendReport(now = Date.now()): InstallSpendReport {
  return {
    ...installSpend(now),
    limitUSD: installBudget().maxInstallCostUSD,
    windowHours: INSTALL_WINDOW_MS / 3_600_000,
  };
}
