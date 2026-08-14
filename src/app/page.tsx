"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { LiveTelemetry } from "@/components/LiveTelemetry";
import { Meter } from "@/components/Meter";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty, Stat, StatSub } from "@/components/ui/Card";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Table, Td, Th, Tr } from "@/components/ui/Table";
import { PERIOD_OPTIONS, UsagePeriods } from "@/components/UsagePeriods";
import type {
  PeriodGranularityDTO,
  PlanUsageDTO,
  UsageResponse,
  WindowStateDTO,
} from "@/lib/apiTypes";
import {
  agentOriginBadge,
  type BadgeTone,
  fmtDateTime,
  fmtDuration,
  fmtPct,
  fmtRelative,
  fmtTokens,
  fmtUSD,
  pollFailureMessage,
  shortPath,
} from "@/lib/format";

/**
 * Describe the ceiling a window's percentage is measured against.
 *
 * `w.limit` is the *effective* ceiling: `limitConfig()` has already subtracted
 * reserved headroom. Calling that "your configured estimate" named the wrong
 * number — at a 15% reserve a typed $650 is measured against $552.50, so the
 * bar climbs ~18% faster than the figure in Settings implies and the gap widens
 * with usage. The arithmetic was never wrong; the label was, and a meter that
 * disagrees with the value you set reads as a broken calculation. So say both
 * numbers whenever a reserve is in force.
 */
function ceilingDetail(
  w: WindowStateDTO,
  configured: number | null,
  reserve: number,
  plan: PlanUsageDTO | null,
  now: number,
): string {
  const reduced = reserve > 0 && configured !== null;

  // The provider's own percentage has no ceiling behind it to describe, so
  // this says where it came from and how old it is instead. Both matter: it
  // covers surfaces the dollar figure above it cannot see, and it is cached
  // for up to five minutes, so a reader reconciling it against a window that
  // just moved needs to know they are looking at a reading, not a live tap.
  if (w.fractionMetric === "plan") {
    const age = plan ? ` Read ${fmtRelative(plan.fetchedAt, now)}.` : "";
    return (
      "Reported by Anthropic for this account, covering every Claude surface " +
      `that shares the allowance — not only the turns counted above.${age}`
    );
  }

  if (w.fractionMetric === "cost") {
    return reduced
      ? `Ceiling: ${fmtUSD(w.limit ?? 0)} equivalent API cost — your ${fmtUSD(configured)} estimate less ${fmtPct(reserve)} reserved headroom.`
      : `Ceiling: ${fmtUSD(w.limit ?? 0)} equivalent API cost — your configured estimate.`;
  }
  if (w.fractionMetric === "tokens") {
    const head = reduced
      ? `Ceiling: ${fmtTokens(w.limit ?? 0)} raw tokens — your ${fmtTokens(configured)} estimate less ${fmtPct(reserve)} reserved headroom.`
      : `Ceiling: ${fmtTokens(w.limit ?? 0)} raw tokens.`;
    return `${head} A cost ceiling is steadier for this workload — see Settings.`;
  }
  return "Set a ceiling in Settings to see a percentage.";
}

/** Fixed order, so the picker and the map it indexes cannot disagree. */
const DIMENSIONS = ["model", "project", "effort", "agent", "skill"] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** One name per slice, read by the picker and by the table's own column head. */
const DIMENSION_LABEL: Record<Dimension, string> = {
  model: "Model",
  project: "Project",
  effort: "Effort",
  agent: "Sub-agent",
  skill: "Skill",
};

const DIMENSION_OPTIONS = DIMENSIONS.map((value) => ({
  value,
  label: DIMENSION_LABEL[value],
}));

/**
 * One row of the breakdown table, whichever slice is showing.
 *
 * `mark` is optional because only one dimension has anything to mark: an agent
 * bucket can say where its definition lives, and a model or a skill cannot.
 * Named rather than inferred because `satisfies` keeps each key's own narrower
 * shape, so a `mark` on one dimension is invisible at the call site that renders
 * all five.
 */
interface BreakdownRow {
  label: string;
  cost: number;
  mark?: { text: string; tone: BadgeTone } | null;
}

interface Breakdown {
  rows: BreakdownRow[];
  hint?: string;
}

/**
 * A Finder-style list view: a bordered, rounded box that owns its own scroll
 * region, with the column heads stuck to the top of it — rather than a
 * full-width web table running to the card's edges and scrolling the page.
 *
 * The height cap is what gives the sticky head something to stick inside, which
 * is also why `TableWrap` cannot be used here: a scroll container with no
 * height constraint never scrolls vertically, so a head stuck to its top never
 * moves. `overflow-auto` because these tables still overflow sideways on a
 * narrow window, which is the job `TableWrap` was doing.
 *
 * Repeated in `UsagePeriods` and `LiveTelemetry` rather than shared: those two
 * are unit-tested against the plain CommonJS `tsconfig.test.json` emits, where
 * a path alias does not resolve, so a shared module would have to be reachable
 * relatively from both — a fourth file holding two class strings.
 */
const LIST_VIEW = "max-h-80 overflow-auto rounded-sm border border-line";

/**
 * `bg-surface` because the rows scroll under it, and the inset shadow because a
 * `border-b` on a sticky cell is not reliably painted under `border-collapse` —
 * the two are the same hairline in the same place wherever both do render.
 */
const STICKY_HEAD =
  "sticky top-0 z-10 bg-surface shadow-[inset_0_-1px_0_var(--border)]";

/** Poll cadence: the second one applies while a run is still working. */
const POLL_IDLE_MS = 10_000;
const POLL_WORKING_MS = 5_000;

/** Both tables cut their tail. What is cut is counted rather than dropped. */
const MAX_BREAKDOWN_ROWS = 12;
const MAX_BLOCK_ROWS = 15;

/**
 * The figure at the right of a grouped row.
 *
 * Tabular for the reason every figure on this page is: the whole card re-renders
 * every ten seconds, and a proportional digit set moves the right edge of the
 * column each time a 1 becomes an 8.
 */
function ListValue({ children }: { children: ReactNode }) {
  return (
    <span className="text-sm font-medium tabular-nums text-ink">{children}</span>
  );
}

/** Middot between metadata items, hidden from assistive tech as pure ornament. */
function Sep() {
  return (
    <span aria-hidden="true" className="text-ink-faint">
      ·
    </span>
  );
}

/**
 * The title renders before any data does, and never moves afterwards.
 *
 * The loading, error and loaded states all mount this identically, so the one
 * layout shift a dashboard cannot avoid — first paint — happens below the fold
 * of the header rather than under it.
 */
function PageHeader({ children }: { children: ReactNode }) {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">
        Claude Code usage
      </h1>
      <p className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs tabular-nums text-ink-muted">
        {children}
      </p>
    </>
  );
}

/**
 * Shaped like the cards it stands in for, so the page settles rather than
 * jumps when the first response lands.
 *
 * Deliberately static: a shimmer or a spinner would be the only looping motion
 * on the page, and the sentence above it already says what is happening.
 */
function DashboardSkeleton() {
  return (
    <div aria-busy="true">
      {/* One lead card holding both windows, then a grouped list — the shape
          the loaded page has, so the first response settles into it. */}
      <Card emphasis="primary" className="mb-4">
        <div className="h-3 w-40 rounded-sm bg-inset" />
        <div className="mt-4 h-7 w-32 rounded-sm bg-inset" />
        <div className="mt-2 h-3 w-48 rounded-sm bg-inset" />
        <div className="mt-5 h-3 w-full rounded-full bg-inset" />
        <div className="mt-3 h-3 w-3/4 rounded-sm bg-inset" />
        <div className="mt-5 border-t border-line pt-4">
          <div className="h-3 w-28 rounded-sm bg-inset" />
          <div className="mt-4 h-6 w-24 rounded-sm bg-inset" />
          <div className="mt-2 h-3 w-40 rounded-sm bg-inset" />
          <div className="mt-5 h-2 w-full rounded-full bg-inset" />
        </div>
      </Card>
      <Card emphasis="quiet">
        <div className="mb-3 h-3 w-32 rounded-sm bg-inset" />
        <div className="divide-y divide-line rounded-lg border border-line bg-grouped">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between px-3.5 py-3">
              <div className="h-3 w-40 rounded-sm bg-inset" />
              <div className="h-3 w-16 rounded-sm bg-inset" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/**
 * A machine with nothing to measure yet.
 *
 * The meters would all read $0.00 against a hatched bar, which is accurate and
 * useless: it is bit-for-bit what a wrongly-pointed `CLAUDE_HOME` looks like.
 * So say which of the two it is, and what to do about either.
 */
function FirstRun({
  transcriptDir,
  fileCount,
}: {
  transcriptDir: string;
  fileCount: number;
}) {
  return (
    <Card emphasis="primary">
      <CardTitle>Nothing to measure yet</CardTitle>
      <p className="max-w-[64ch] text-sm text-ink-muted">
        {fileCount > 0 ? (
          <>
            <span className="tabular-nums">{fileCount.toLocaleString()}</span>{" "}
            session {fileCount === 1 ? "file" : "files"} were read from{" "}
            <span className="mono">{transcriptDir}</span>, and none of them
            contains a billable turn yet.
          </>
        ) : (
          <>
            No Claude Code session files under{" "}
            <span className="mono">{transcriptDir}</span>.
          </>
        )}
      </p>
      <ul className="mt-3 max-w-[64ch] list-disc space-y-1.5 pl-5 text-sm text-ink-muted marker:text-ink-faint">
        <li>
          Use Claude Code once in any project. This page reads the transcripts
          it writes as it goes — no setup, no export.
        </li>
        <li>
          If you have already used it, <span className="mono">CLAUDE_HOME</span>{" "}
          is pointing somewhere else. It is fixed at boot, so changing it means
          restarting the container.
        </li>
        <li>
          <Link href="/settings">Set a ceiling</Link> now and the meters will
          have something to measure against when the first turn lands.
        </li>
      </ul>
    </Card>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [dimension, setDimension] = useState<Dimension>("model");
  const [granularity, setGranularity] = useState<PeriodGranularityDTO>("week");

  /**
   * A run in flight is the one time this page has something new to say every
   * few seconds — its telemetry lands per API request, while `runs.spent_usd`
   * waits for the end of the whole work cycle. Only 2x faster, and only while
   * that is true: `buildSnapshot` re-aggregates the full history on every
   * request and the agent is competing for the same CPU.
   */
  const working = (data?.telemetry?.workingRunCount ?? 0) > 0;

  useEffect(() => {
    let alive = true;
    // The calendar buckets are cut server-side, and cutting them in the
    // container's UTC would file a late-evening turn under tomorrow. Read here
    // rather than at render: this component is server-rendered too, and the
    // server's zone in the first paint would not match the browser's in the
    // second. `resolveTimeZone` refuses anything that is not a zone.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    const load = async () => {
      try {
        const res = await fetch(`/api/usage?tz=${encodeURIComponent(tz)}`, {
          cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) {
          // The last good snapshot stays on screen and the banner says it is
          // stale. Blanking the page on one failed poll threw away the only
          // figures the operator had, and a dashboard that vanishes for a
          // second every time the server restarts is worse than a stale one
          // that admits it.
          setPollError(pollFailureMessage(res.status, json.error));
          return;
        }
        setData(json);
        setPollError(null);
      } catch (e) {
        if (alive) {
          setPollError(
            pollFailureMessage(null, e instanceof Error ? e.message : String(e)),
          );
        }
      }
    };
    load();
    const t = setInterval(load, working ? POLL_WORKING_MS : POLL_IDLE_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [working]);

  /**
   * Five separate cards became one switchable list. They were identical in
   * shape — a label, a cost, a share of the window — so five of them side by
   * side spent a screen of vertical space saying "there are five ways to slice
   * this" rather than showing any one slice well.
   */
  const breakdowns = useMemo<Record<Dimension, Breakdown> | null>(() => {
    if (!data) return null;
    const s = data.snapshot;
    return {
      model: {
        rows: s.byModel.map((m) => ({ label: m.model, cost: m.agg.costUSD })),
      },
      project: {
        rows: s.byProject.map((p) => ({
          label: shortPath(p.project),
          cost: p.agg.costUSD,
        })),
      },
      effort: {
        rows: s.byEffort.map((r) => ({ label: r.effort, cost: r.agg.costUSD })),
        hint: "Reasoning effort is usually the largest single cost lever.",
      },
      agent: {
        // The bucket is still whatever the CLI recorded on the turn; the chip
        // says where this install found a definition for that name. Nothing
        // about the registry moves a dollar between rows.
        rows: s.byAgent.map((r) => ({
          label: r.agent,
          cost: r.agg.costUSD,
          mark: agentOriginBadge(r.origin),
        })),
        hint: data.meta.includeSidechains
          ? "Unmarked names have no definition here — a Claude Code built-in, a repository's own .claude/agents, or an agent since deleted."
          : "Sub-agent turns are excluded from totals in Settings, so only main-thread work appears here.",
      },
      skill: {
        rows: s.bySkill.map((r) => ({ label: r.skill, cost: r.agg.costUSD })),
      },
    };
  }, [data]);

  // The banner is a live region so a page that has quietly stopped refreshing
  // announces itself. The figures deliberately are not: a polite region over
  // the meters would read every dollar total aloud every ten seconds.
  const banner = (
    <div aria-live="polite">
      {pollError && <Notice tone="danger">{pollError}</Notice>}
    </div>
  );

  if (!data || !breakdowns) {
    return (
      <>
        <PageHeader>
          {pollError ? "Could not read usage." : "Reading transcripts…"}
        </PageHeader>
        {banner}
        {!pollError && <DashboardSkeleton />}
      </>
    );
  }

  const { snapshot: s, meta, periods, telemetry } = data;
  const noCeilings = !meta.hasSessionCeiling && !meta.hasWeeklyCeiling;
  // Read off the windows rather than off the setting: the setting says we
  // asked, this says we were answered.
  const planPercentages =
    s.session.fractionMetric === "plan" || s.weekly.fractionMetric === "plan";
  // The exhaustion projection is the one thing here that still needs a number
  // rather than a percentage — it extrapolates dollars and tokens per hour —
  // so it stays unavailable on a provider reading alone, and has to say so in
  // its own terms rather than borrowing `noCeilings`.
  const noConfiguredCeilings =
    meta.configuredCeilings.sessionCost === null &&
    meta.configuredCeilings.weeklyCost === null &&
    meta.configuredCeilings.sessionTokens === null &&
    meta.configuredCeilings.weeklyTokens === null;
  const cacheShare =
    s.weekly.tokens > 0 ? s.weekly.agg.tokens.cacheRead / s.weekly.tokens : null;
  const current = breakdowns[dimension];
  const breakdownOmitted = Math.max(0, current.rows.length - MAX_BREAKDOWN_ROWS);
  const blocksOmitted = Math.max(0, s.blocks.length - MAX_BLOCK_ROWS);
  // `wkEnd` is `now` itself unless a weekly anchor is configured, so this is a
  // reading of the window rather than a guess about the setting behind it.
  const weeklyResets = s.weekly.endsAt > s.now;

  const header = (
    <PageHeader>
      <span>
        Computed from{" "}
        <span className="mono" title={meta.transcriptDir}>
          {shortPath(meta.transcriptDir, 2)}
        </span>
      </span>
      <Sep />
      <span>{meta.entryCount.toLocaleString()} deduplicated turns</span>
      <Sep />
      <span>{meta.fileCount.toLocaleString()} session files</span>
      <Sep />
      {/* This app's own footprint. It belongs on the provenance strip rather
          than in a card because it is a fact about the reading, not a reading:
          the parsed turns above are what fills this heap, and it used to be the
          thing that eventually killed the container. */}
      <span
        title={`${meta.memory.cache.entries.toLocaleString()} of at most ${meta.memory.cache.maxEntries.toLocaleString()} parsed turns cached across ${meta.memory.cache.files.toLocaleString()} files`}
      >
        {Math.round(meta.memory.heapUsedBytes / 1e6).toLocaleString()} MB heap of{" "}
        {Math.round(meta.memory.heapLimitBytes / 1e6).toLocaleString()} MB
      </span>
      {meta.entrypoints.length > 0 && (
        <>
          <Sep />
          <span className="mono">{meta.entrypoints.join(", ")}</span>
        </>
      )}
      {/* Names the plan only. Anthropic publishes no number for a tier, so this
          never implies a ceiling — the meters stay indeterminate until one is
          configured. */}
      {meta.account.label && (
        <>
          <Sep />
          <span className="font-medium text-ink">{meta.account.label}</span>
        </>
      )}
    </PageHeader>
  );

  if (meta.entryCount === 0) {
    return (
      <>
        {header}
        {banner}
        <FirstRun
          transcriptDir={shortPath(meta.transcriptDir, 3)}
          fileCount={meta.fileCount}
        />
      </>
    );
  }

  return (
    <>
      {header}
      {banner}

      {/* The one `primary` card on the screen, and the only thing on it sized
          to be read from across a room. Both windows live in it because they
          are one subject — what may be spent — and two co-equal cards side by
          side said neither of them leads. Inside it the session leads: it is
          the allowance that refills on its own, so it is the one an operator
          can act on in the next few minutes, and the week sits under the same
          hairline a grouped list uses. */}
      <Card emphasis="primary" className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <CardTitle className="mb-1">
              5-hour session window
              {s.session.agg.entryCount > 0 && (
                <Badge tone="accent">active</Badge>
              )}
            </CardTitle>
            <Stat size="large">{fmtUSD(s.session.costUSD)}</Stat>
            <StatSub>
              <span className="tabular-nums">
                {fmtTokens(s.session.tokens)} tokens ·{" "}
                {s.session.agg.entryCount.toLocaleString()} turns
              </span>
            </StatSub>
          </div>
          {/* Relative first because that is the decision — whether to start
              something now or wait. The clock time is the confirmation, and
              the exact instant is on the title for anyone reconciling with
              `/usage`. */}
          <div
            className="text-right"
            title={new Date(s.session.endsAt).toLocaleString()}
          >
            <div className="text-sm font-medium tabular-nums text-ink">
              Resets {fmtRelative(s.session.endsAt, s.now)}
            </div>
            <div className="mt-0.5 text-xs tabular-nums text-ink-muted">
              {fmtDateTime(s.session.endsAt)}
            </div>
          </div>
        </div>

        <Meter
          size="hero"
          label="Session consumed"
          fraction={s.session.fraction}
          upperFraction={s.session.guardFraction}
          detail={ceilingDetail(
            s.session,
            s.session.fractionMetric === "tokens"
              ? meta.configuredCeilings.sessionTokens
              : meta.configuredCeilings.sessionCost,
            meta.reservedHeadroomFraction,
            s.plan,
            s.now,
          )}
        />

        {/* One block, so the footnotes read as a group belonging to the meter
            rather than as three unrelated remarks stacked under it. */}
        <div className="mt-3 space-y-1 text-xs text-ink-muted">
          {s.session.tokenFraction !== null &&
            s.session.fractionMetric === "cost" && (
              <div className="tabular-nums">
                Against the raw-token ceiling: {fmtPct(s.session.tokenFraction)}
              </div>
            )}
          {/* Three different provenances for one clock, and they are worth
              telling apart: the provider's own instant, a pinned one, and a
              derived one that can sit minutes off `/usage`. Saying nothing
              makes the third read as a bug rather than as the estimate it
              is — and makes the first read as an estimate when it is not. */}
          {s.plan?.session?.resetsAt ? (
            <div>
              Reset instant reported by Anthropic, so it matches{" "}
              <span className="mono">/usage</span> exactly.
            </div>
          ) : meta.sessionResetOverrideAt !== null &&
            meta.sessionResetOverrideAt > s.now ? (
            <div>
              Window start taken from a{" "}
              <Link href="/settings">manual reset</Link>, not from the
              transcripts — usage before{" "}
              <span className="tabular-nums">
                {new Date(s.session.startsAt).toLocaleString()}
              </span>{" "}
              is excluded from this card and from the budget guard.
            </div>
          ) : (
            <div>
              Reset time derived from your own turns, so it can sit minutes off
              what <span className="mono">/usage</span> reports.{" "}
              <Link href="/settings">Pin it</Link> if they disagree.
            </div>
          )}
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <CardTitle className="mb-1">{s.weekly.label}</CardTitle>
              <Stat>{fmtUSD(s.weekly.costUSD)}</Stat>
              <StatSub>
                <span className="tabular-nums">
                  {fmtTokens(s.weekly.tokens)} tokens ·{" "}
                  {s.weekly.agg.entryCount.toLocaleString()} turns
                </span>
              </StatSub>
            </div>
            {/* Where the session card puts its reset, so the eye finds both in
                one place. Without an anchor this window has no reset instant at
                all, and the sentence under the meter is what explains that —
                the rail only says which of the two kinds of window it is. */}
            <div className="text-right">
              {weeklyResets ? (
                // Days out, so the absolute date rather than `fmtRelative`,
                // which would render this as "in 137h 12m".
                <div
                  className="text-sm font-medium tabular-nums text-ink"
                  title={new Date(s.weekly.endsAt).toLocaleString()}
                >
                  Resets {fmtDateTime(s.weekly.endsAt)}
                </div>
              ) : (
                <div className="text-sm font-medium text-ink">
                  Trailing total
                </div>
              )}
            </div>
          </div>

          <Meter
            label="Weekly consumed"
            fraction={s.weekly.fraction}
            upperFraction={s.weekly.guardFraction}
            detail={ceilingDetail(
              s.weekly,
              s.weekly.fractionMetric === "tokens"
                ? meta.configuredCeilings.weeklyTokens
                : meta.configuredCeilings.weeklyCost,
              meta.reservedHeadroomFraction,
              s.plan,
              s.now,
            )}
          />

          <div className="mt-3 space-y-1 text-xs text-ink-muted">
            {s.weekly.tokenFraction !== null &&
              s.weekly.fractionMetric === "cost" && (
                <div className="tabular-nums">
                  Against the raw-token ceiling: {fmtPct(s.weekly.tokenFraction)}
                </div>
              )}
            {/* An operator waiting for this one to clear the way the 5-hour one
                does is waiting for nothing, so say what it is instead. */}
            {!weeklyResets && (
              <div>
                It falls as old turns age out rather than resetting. Pick a{" "}
                <Link href="/settings">weekly reset</Link> day to measure against
                a fixed week instead.
              </div>
            )}
            {/* A wall that binds without ever reaching this meter: the weekly
                allowance is split per model family on some plans, so Opus can
                be full while the all-model window reads a quarter. The guard
                stops on the worst of them, so name them rather than letting a
                refusal arrive with nothing on screen behind it. */}
            {s.plan && s.plan.scopedWeekly.length > 0 && (
              <div className="tabular-nums">
                Per-model weekly:{" "}
                {s.plan.scopedWeekly
                  .map((x) => `${x.label} ${fmtPct(x.window.utilization)}`)
                  .join(" · ")}
                . The bar above is the all-model window; a guard stops on
                whichever is highest.
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Under the meters, not above them: each of these explains something the
          reader has just looked at — a hatched bar, a span past the fill, a
          figure that is a floor. Stacked above, they were a wall of prose
          between the title and the subject of the page. */}
      {noCeilings && (
        <Notice tone="warn">
          <strong>No percentages available.</strong>{" "}
          {meta.planUsageFromApi ? (
            <>
              Anthropic reports this account&rsquo;s own utilisation, but that
              read did not answer — the credential Claude Code keeps on this
              machine is missing or expired, or the request failed. Sign in with{" "}
              <span className="mono">claude</span> and it will resume by itself.
            </>
          ) : (
            <>
              Reading the account&rsquo;s own utilisation is{" "}
              <Link href="/settings">switched off</Link>, and Anthropic
              publishes no numeric value for a Pro/Max limit
              {meta.account.label && (
                <> — knowing you are on {meta.account.label} does not supply one</>
              )}
              .
            </>
          )}{" "}
          Until then a percentage needs a ceiling of your own:{" "}
          <Link href="/settings">run Calibrate</Link> to derive one from your own
          peak usage, or enter a value manually. Volumes and costs above are
          exact regardless.
        </Notice>
      )}

      {meta.unpricedModels.length > 0 && (
        <Notice tone="warn">
          <strong>Unpriced models seen:</strong>{" "}
          <span className="mono">{meta.unpricedModels.join(", ")}</span>. Their
          tokens count toward volume but contribute $0 to cost, so the dollar
          figures here are a floor. The budget guard does not use that floor —
          it charges these models a conservative rate instead, which is the
          hatched span on the meters above. A run can therefore be stopped
          before the solid bar looks full.
        </Notice>
      )}

      {/* Loud rather than quiet: every number on this page — and every budget
          verdict taken since — is short by however much was behind these
          paths, and the two ordinary reasons are a permissions mismatch on the
          mounted ~/.claude and a descriptor limit. Neither announces itself
          anywhere else. */}
      {meta.readFailureCount > 0 && (
        <Notice tone="warn">
          <strong>
            {meta.readFailureCount.toLocaleString()}{" "}
            {meta.readFailureCount === 1 ? "path" : "paths"} could not be read:
          </strong>{" "}
          {meta.readFailures.map((f, i) => (
            <span key={f.path}>
              {i > 0 && ", "}
              <span className="mono">{f.path}</span> ({f.message})
            </span>
          ))}
          {meta.readFailureCount > meta.readFailures.length && (
            <>
              , and {(meta.readFailureCount - meta.readFailures.length).toLocaleString()}{" "}
              more
            </>
          )}
          . Every figure here is short by whatever those hold, and a run's budget
          guard reads the same scan — so it is measuring against a total that is
          too low.
        </Notice>
      )}

      {/* Shown only while it is true, unlike the blind-spot notice below: this
          one is a state an operator can act on, and it says which way the
          trade went — correctness kept, refresh cost paid. */}
      {meta.memory.cache.evictions > 0 && (
        <Notice quiet>
          <strong>Transcript cache at its bound.</strong>{" "}
          <span className="tabular-nums">
            {meta.memory.cache.evictions.toLocaleString()}
          </span>{" "}
          {meta.memory.cache.evictions === 1 ? "file has" : "files have"} been
          dropped from memory and are re-read from disk on every scan. Figures
          here are unaffected; each refresh costs more. Raise{" "}
          <span className="mono">UF_TRANSCRIPT_CACHE_MAX_ENTRIES</span> — and the
          heap behind it — or keep less history under{" "}
          <span className="mono">CLAUDE_HOME</span>.
        </Notice>
      )}

      {/* Always shown — the blind spot is structural, not a transient state.
          Rendered quiet so the conditional warnings above can outrank it;
          three equally loud warn blocks trained the eye to skip all three. */}
      <Notice quiet>
        <strong>Costs and volumes here cover Claude Code only.</strong> Your
        5-hour and weekly limits are shared with <strong>Cowork</strong>, Claude
        Desktop, web and mobile, none of which write anything locally — so treat
        every dollar and token figure on this page as a <em>floor</em> on your
        real consumption.
        {/* Whether that blind spot also reaches the percentages is the whole
            difference this reading makes, and it decides which of the two
            pieces of advice below is the right one — reserving headroom
            against a figure that already counts every surface would subtract
            the same allowance twice. */}
        {planPercentages ? (
          <>
            {" "}
            The <em>percentages</em> do not have that gap: they are Anthropic&rsquo;s
            own, for the whole account. Reserved headroom no longer applies to
            them and is not being subtracted.
          </>
        ) : meta.reservedHeadroomFraction > 0 ? (
          <>
            {" "}
            The percentages have the same gap. You have reserved{" "}
            <strong>{fmtPct(meta.reservedHeadroomFraction)}</strong> of each
            window for it, so the ceilings above are reduced accordingly.
          </>
        ) : (
          <>
            {" "}
            So do the percentages. <Link href="/settings">Reserve headroom</Link>{" "}
            if you use those too — otherwise a guard can permit a run while your
            real window is already close to full.
          </>
        )}
      </Notice>

      {/* Sits under the session meter because it is a footnote to it: the same
          five hours, read a different way. Absent entirely when agent
          self-reporting is off or nothing has reported — the same rule the run
          page's telemetry card follows. */}
      {telemetry && <LiveTelemetry telemetry={telemetry} now={s.now} />}

      {/* Four equally-weighted bordered boxes said these four readings were as
          important as the meters above them, which none of them is. As a
          grouped list they read as what they are: derived figures about the
          window the card above measures. */}
      <Card emphasis="quiet" className="mb-4">
        <CardTitle>Rate and totals</CardTitle>
        <ListGroup>
          {/* The unit rides in the description rather than beside the figure,
              so the values stay one column of comparable numbers — a dollar
              figure, a duration, a percentage, a dollar figure. */}
          <ListRow label="Burn rate" description="Per hour, trailing 60 minutes">
            <ListValue>{fmtUSD(s.burnCostPerHour)}</ListValue>
          </ListRow>

          <ListRow
            label="Projected exhaustion"
            description={
              s.projectedExhaustionAt ? (
                <span
                  className="tabular-nums"
                  title={new Date(s.projectedExhaustionAt).toLocaleString()}
                >
                  At this burn rate, around{" "}
                  {fmtDateTime(s.projectedExhaustionAt)}
                </span>
              ) : noConfiguredCeilings ? (
                "Needs a configured ceiling"
              ) : (
                "Not projected to run out"
              )
            }
          >
            <ListValue>
              {s.projectedExhaustionAt
                ? fmtDuration(Math.max(0, s.projectedExhaustionAt - s.now))
                : "—"}
            </ListValue>
          </ListRow>

          <ListRow
            label="Cache reads"
            description="Share of all tokens, billed at 0.1× — which is why the dollar figures track work and the token counts do not"
          >
            <ListValue>{fmtPct(cacheShare)}</ListValue>
          </ListRow>

          <ListRow
            label="Lifetime recorded"
            description="Equivalent API cost, all local transcripts"
          >
            <ListValue>{fmtUSD(s.totalCostUSD)}</ListValue>
          </ListRow>
        </ListGroup>
      </Card>

      {/* History, so it sits below everything that describes right now. The
          meters answer whether a run can start; this answers what the last
          fortnight cost. */}
      <UsagePeriods
        series={periods[granularity]}
        // The picker is rendered here rather than inside the card because that
        // component is unit-tested against the plain CommonJS emits, where the
        // path alias `SegmentedControl` reaches `Icon` through does not
        // resolve. The page already owns which granularity is selected.
        control={
          <SegmentedControl
            options={PERIOD_OPTIONS}
            value={granularity}
            onChange={setGranularity}
            label="Period length"
          />
        }
        reservedHeadroomFraction={meta.reservedHeadroomFraction}
      />

      <Card className="mb-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="mb-0">
            Where it went — {s.weekly.label.toLowerCase()}
          </CardTitle>
          {/* Was a hand-rolled pill strip claiming `role="tablist"`. The kit's
              segmented control is the native idiom for one choice from a short
              fixed set, and it owns the roving tabindex and the arrow keys that
              used to be written out here. */}
          <SegmentedControl
            options={DIMENSION_OPTIONS}
            value={dimension}
            onChange={setDimension}
            label="Breakdown dimension"
          />
        </div>

        {/* No tabpanel role and no tabindex: a radiogroup is not a tablist, and
            a focusable region with nothing focusable inside it is a dead tab
            stop. The list names itself with a caption instead. */}
        {current.rows.length === 0 ? (
          <Empty>No usage in this window.</Empty>
        ) : (
          <div className={LIST_VIEW}>
            <Table>
              <caption className="sr-only">
                Cost by {DIMENSION_LABEL[dimension].toLowerCase()} over{" "}
                {s.weekly.label.toLowerCase()}, highest first
              </caption>
              <thead>
                <tr>
                  <Th className={STICKY_HEAD}>{DIMENSION_LABEL[dimension]}</Th>
                  <Th num className={STICKY_HEAD}>
                    Cost
                  </Th>
                  <Th num className={STICKY_HEAD}>
                    Share
                  </Th>
                </tr>
              </thead>
              <tbody>
                {/* Every turn lands in some bucket — including explicit
                    "(main thread)" / "(no skill)" rows — so the column adds to
                    100% instead of quietly omitting a remainder. */}
                {current.rows.slice(0, MAX_BREAKDOWN_ROWS).map((r) => (
                  <Tr key={r.label}>
                    <Td>
                      <span className="mono">{r.label}</span>
                      {r.mark && (
                        <>
                          {" "}
                          <Badge tone={r.mark.tone}>{r.mark.text}</Badge>
                        </>
                      )}
                    </Td>
                    <Td num>{fmtUSD(r.cost)}</Td>
                    <Td num>
                      {s.weekly.costUSD > 0
                        ? fmtPct(r.cost / s.weekly.costUSD)
                        : "—"}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {/* Rows are cost-descending, so the tail really is the cheap end — but
            a list that stops at twelve with nothing said reads as the whole
            set. Same rule a shortened diff follows. */}
        {breakdownOmitted > 0 && (
          <div className="mt-2 text-xs tabular-nums text-ink-muted">
            {breakdownOmitted} cheaper{" "}
            {breakdownOmitted === 1 ? "row is" : "rows are"} in the totals above
            but not listed.
          </div>
        )}
        {current.hint && (
          <div className="mt-2 text-xs text-ink-muted">{current.hint}</div>
        )}
      </Card>

      <Card emphasis="quiet">
        <CardTitle>Recent 5-hour blocks</CardTitle>
        <div className={LIST_VIEW}>
          <Table>
            <caption className="sr-only">
              Each recorded 5-hour window, newest first
            </caption>
            <thead>
              <tr>
                <Th className={STICKY_HEAD}>Started</Th>
                <Th num className={STICKY_HEAD}>
                  Tokens
                </Th>
                <Th num className={STICKY_HEAD}>
                  Cost
                </Th>
                <Th num className={STICKY_HEAD}>
                  Turns
                </Th>
                <Th className={STICKY_HEAD}>Models</Th>
              </tr>
            </thead>
            <tbody>
              {s.blocks.slice(0, MAX_BLOCK_ROWS).map((b) => (
                <Tr key={b.startsAt}>
                  <Td className="whitespace-nowrap tabular-nums">
                    <span title={new Date(b.startsAt).toLocaleString()}>
                      {fmtDateTime(b.startsAt)}
                    </span>
                    {b.isActive && (
                      <>
                        {" "}
                        <Badge tone="ok">live</Badge>
                      </>
                    )}
                  </Td>
                  <Td num>
                    {fmtTokens(
                      b.agg.tokens.input +
                        b.agg.tokens.output +
                        b.agg.tokens.cacheRead +
                        b.agg.tokens.cacheWrite5m +
                        b.agg.tokens.cacheWrite1h,
                    )}
                  </Td>
                  <Td num>{fmtUSD(b.agg.costUSD)}</Td>
                  <Td num>{b.agg.entryCount}</Td>
                  <Td className="mono">
                    {b.models.map((m) => m.replace("claude-", "")).join(", ")}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
        {blocksOmitted > 0 && (
          <div className="mt-2 text-xs tabular-nums text-ink-muted">
            {blocksOmitted} older{" "}
            {blocksOmitted === 1 ? "block is" : "blocks are"} recorded but not
            listed.
          </div>
        )}
      </Card>
    </>
  );
}
