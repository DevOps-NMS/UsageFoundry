"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import Link from "next/link";
import { LiveTelemetry } from "@/components/LiveTelemetry";
import { Meter } from "@/components/Meter";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty, Stat, StatSub } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";
import { UsagePeriods } from "@/components/UsagePeriods";
import type {
  PeriodGranularityDTO,
  UsageResponse,
  WindowStateDTO,
} from "@/lib/apiTypes";
import {
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
): string {
  const reduced = reserve > 0 && configured !== null;

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

/** Fixed order, so the tab strip and its keyboard navigation cannot disagree. */
const DIMENSIONS = ["model", "project", "effort", "agent", "skill"] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** Poll cadence: the second one applies while a run is still working. */
const POLL_IDLE_MS = 10_000;
const POLL_WORKING_MS = 5_000;

/** Both tables cut their tail. What is cut is counted rather than dropped. */
const MAX_BREAKDOWN_ROWS = 12;
const MAX_BLOCK_ROWS = 15;

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
      <section className="mb-4 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card emphasis="primary" className="lg:col-span-3">
          <div className="h-3 w-40 rounded-sm bg-inset" />
          <div className="mt-4 h-7 w-32 rounded-sm bg-inset" />
          <div className="mt-2 h-3 w-48 rounded-sm bg-inset" />
          <div className="mt-5 h-3 w-full rounded-full bg-inset" />
          <div className="mt-3 h-3 w-3/4 rounded-sm bg-inset" />
        </Card>
        <Card className="lg:col-span-2">
          <div className="h-3 w-28 rounded-sm bg-inset" />
          <div className="mt-4 h-6 w-24 rounded-sm bg-inset" />
          <div className="mt-2 h-3 w-40 rounded-sm bg-inset" />
          <div className="mt-5 h-2 w-full rounded-full bg-inset" />
          <div className="mt-3 h-3 w-2/3 rounded-sm bg-inset" />
        </Card>
      </section>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} emphasis="quiet">
            <div className="h-3 w-24 rounded-sm bg-inset" />
            <div className="mt-4 h-5 w-20 rounded-sm bg-inset" />
            <div className="mt-2 h-3 w-32 rounded-sm bg-inset" />
          </Card>
        ))}
      </section>
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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
   * Five separate cards became one switchable table. They were identical in
   * shape — a label, a cost, a share of the window — so five of them side by
   * side spent a screen of vertical space saying "there are five ways to slice
   * this" rather than showing any one slice well.
   */
  const breakdowns = useMemo(() => {
    if (!data) return null;
    const s = data.snapshot;
    return {
      model: {
        label: "Model",
        rows: s.byModel.map((m) => ({ label: m.model, cost: m.agg.costUSD })),
        hint: undefined as string | undefined,
      },
      project: {
        label: "Project",
        rows: s.byProject.map((p) => ({
          label: shortPath(p.project),
          cost: p.agg.costUSD,
        })),
        hint: undefined,
      },
      effort: {
        label: "Effort",
        rows: s.byEffort.map((r) => ({ label: r.effort, cost: r.agg.costUSD })),
        hint: "Reasoning effort is usually the largest single cost lever.",
      },
      agent: {
        label: "Sub-agent",
        rows: s.byAgent.map((r) => ({ label: r.agent, cost: r.agg.costUSD })),
        hint: data.meta.includeSidechains
          ? "Sub-agent turns bill separately from the main thread."
          : "Sub-agent turns are excluded from totals in Settings, so only main-thread work appears here.",
      },
      skill: {
        label: "Skill",
        rows: s.bySkill.map((r) => ({ label: r.skill, cost: r.agg.costUSD })),
        hint: undefined,
      },
    } satisfies Record<
      Dimension,
      { label: string; rows: Array<{ label: string; cost: number }>; hint?: string }
    >;
  }, [data]);

  /**
   * Roving tabindex plus arrow keys, because the strip already claims
   * `role="tablist"` and a tablist that answers only to Tab is a promise to a
   * screen reader that the page does not keep.
   */
  const onTabKey = useCallback((e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = DIMENSIONS.length - 1;
    let next: number;
    if (e.key === "ArrowRight") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    setDimension(DIMENSIONS[next]);
    tabRefs.current[next]?.focus();
  }, []);

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

      {/* The subject of the page, and the only thing on it sized to be read
          from across a room. The session window leads: it is the one allowance
          that refills on its own, so it is the one an operator can act on in
          the next few minutes. */}
      <section className="mb-4 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card emphasis="primary" className="lg:col-span-3">
          <CardTitle>
            5-hour session window
            {s.session.agg.entryCount > 0 && <Badge tone="accent">active</Badge>}
          </CardTitle>

          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
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
            {/* Anthropic sends the real reset instant back on every API response
                but writes it nowhere local, so this one is derived: the window
                opens with your first turn and runs five hours. Say so next to
                the time, or a few minutes' disagreement with `/usage` reads as
                a bug rather than as the estimate it is. */}
            {meta.sessionResetOverrideAt !== null &&
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
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle>{s.weekly.label}</CardTitle>
          <Stat>{fmtUSD(s.weekly.costUSD)}</Stat>
          <StatSub>
            <span className="tabular-nums">
              {fmtTokens(s.weekly.tokens)} tokens ·{" "}
              {s.weekly.agg.entryCount.toLocaleString()} turns
            </span>
          </StatSub>
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
            )}
          />
          <div className="mt-3 space-y-1 text-xs text-ink-muted">
            {s.weekly.tokenFraction !== null &&
              s.weekly.fractionMetric === "cost" && (
                <div className="tabular-nums">
                  Against the raw-token ceiling: {fmtPct(s.weekly.tokenFraction)}
                </div>
              )}
            {/* Without an anchor this window has no reset instant at all — the
                total decays as old turns age out. An operator waiting for it to
                clear the way the 5-hour one does is waiting for nothing. */}
            <div>
              {weeklyResets ? (
                // Days out, so the absolute date rather than `fmtRelative`,
                // which would render this as "in 137h 12m".
                <span
                  className="tabular-nums"
                  title={new Date(s.weekly.endsAt).toLocaleString()}
                >
                  Resets {fmtDateTime(s.weekly.endsAt)}.
                </span>
              ) : (
                <>
                  A trailing total: it falls as old turns age out rather than
                  resetting. Pick a <Link href="/settings">weekly reset</Link>{" "}
                  day to measure against a fixed week instead.
                </>
              )}
            </div>
          </div>
        </Card>
      </section>

      {/* Under the meters, not above them: each of these explains something the
          reader has just looked at — a hatched bar, a span past the fill, a
          figure that is a floor. Stacked above, they were a wall of prose
          between the title and the subject of the page. */}
      {noCeilings && (
        <Notice tone="warn">
          <strong>No limit ceilings configured.</strong> Anthropic publishes no
          numeric value for a Pro/Max limit and offers no endpoint to read one,
          so percentages cannot be shown until you set a ceiling
          {meta.account.label && (
            <> — knowing you are on {meta.account.label} does not supply one</>
          )}
          . <Link href="/settings">Run Calibrate</Link> to derive one from your
          own peak usage, or enter a value manually. Volumes and costs above are
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

      {/* Always shown — the blind spot is structural, not a transient state.
          Rendered quiet so the conditional warnings above can outrank it;
          three equally loud warn blocks trained the eye to skip all three. */}
      <Notice quiet>
        <strong>This covers Claude Code only.</strong> Your 5-hour and weekly
        limits are shared with <strong>Cowork</strong>, Claude Desktop, web and
        mobile, none of which write anything locally — so treat these figures as
        a <em>floor</em> on your real consumption.
        {meta.reservedHeadroomFraction > 0 ? (
          <>
            {" "}
            You have reserved{" "}
            <strong>{fmtPct(meta.reservedHeadroomFraction)}</strong> of each
            window for it, so the ceilings above are reduced accordingly.
          </>
        ) : (
          <>
            {" "}
            <Link href="/settings">Reserve headroom</Link> if you use those too —
            otherwise a guard can permit a run while your real window is already
            close to full.
          </>
        )}
      </Notice>

      {/* Sits under the session meter because it is a footnote to it: the same
          five hours, read a different way. Absent entirely when agent
          self-reporting is off or nothing has reported — the same rule the run
          page's telemetry card follows. */}
      {telemetry && <LiveTelemetry telemetry={telemetry} now={s.now} />}

      <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card emphasis="quiet">
          <CardTitle>Burn rate</CardTitle>
          <Stat>{fmtUSD(s.burnCostPerHour)}</Stat>
          <StatSub>per hour · trailing 60 minutes</StatSub>
        </Card>

        <Card emphasis="quiet">
          <CardTitle>Projected exhaustion</CardTitle>
          <Stat>
            {s.projectedExhaustionAt
              ? fmtDuration(Math.max(0, s.projectedExhaustionAt - s.now))
              : "—"}
          </Stat>
          <StatSub>
            {s.projectedExhaustionAt ? (
              <span
                className="tabular-nums"
                title={new Date(s.projectedExhaustionAt).toLocaleString()}
              >
                at this burn rate, around {fmtDateTime(s.projectedExhaustionAt)}
              </span>
            ) : noCeilings ? (
              "needs a configured ceiling"
            ) : (
              "not projected to run out"
            )}
          </StatSub>
        </Card>

        <Card emphasis="quiet">
          <CardTitle>Cache reads</CardTitle>
          <Stat>{fmtPct(cacheShare)}</Stat>
          <StatSub>
            of tokens · they bill at 0.1×, which is why the meters are
            cost-denominated
          </StatSub>
        </Card>

        <Card emphasis="quiet">
          <CardTitle>Lifetime recorded</CardTitle>
          <Stat>{fmtUSD(s.totalCostUSD)}</Stat>
          <StatSub>equivalent API cost, all local transcripts</StatSub>
        </Card>
      </section>

      {/* History, so it sits below everything that describes right now. The
          meters answer whether a run can start; this answers what the last
          fortnight cost. */}
      <UsagePeriods
        series={periods[granularity]}
        granularity={granularity}
        onGranularityChange={setGranularity}
        reservedHeadroomFraction={meta.reservedHeadroomFraction}
      />

      <Card className="mb-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="mb-0">
            Where it went — {s.weekly.label.toLowerCase()}
          </CardTitle>
          <div
            className="flex flex-wrap gap-1"
            role="tablist"
            aria-label="Breakdown dimension"
          >
            {DIMENSIONS.map((d, i) => (
              <button
                key={d}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`breakdown-tab-${d}`}
                aria-selected={dimension === d}
                aria-controls="breakdown-panel"
                tabIndex={dimension === d ? 0 : -1}
                onKeyDown={(e) => onTabKey(e, i)}
                onClick={() => setDimension(d)}
                // 32px tall in both states, and bordered in both, so selecting
                // one does not nudge the strip. Full class strings either side:
                // Tailwind scans source as text and emits nothing for an
                // interpolated fragment.
                className={`inline-flex h-8 cursor-pointer items-center rounded-full border px-3 text-xs font-medium ${
                  dimension === d
                    ? "border-accent bg-accent-dim text-ink"
                    : "border-line bg-inset text-ink-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {breakdowns[d].label}
              </button>
            ))}
          </div>
        </div>

        <div
          id="breakdown-panel"
          role="tabpanel"
          aria-labelledby={`breakdown-tab-${dimension}`}
          // The panel holds nothing focusable, so it takes focus itself — else
          // a keyboard user arrows through the strip and can never reach what
          // the strip is switching.
          tabIndex={0}
        >
          {current.rows.length === 0 ? (
            <Empty>No usage in this window.</Empty>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{current.label}</Th>
                    <Th num>Cost</Th>
                    <Th num>Share</Th>
                  </tr>
                </thead>
                <tbody>
                  {/* Every turn lands in some bucket — including explicit
                      "(main thread)" / "(no skill)" rows — so the column adds to
                      100% instead of quietly omitting a remainder. */}
                  {current.rows.slice(0, MAX_BREAKDOWN_ROWS).map((r) => (
                    <Tr key={r.label}>
                      <Td className="mono">{r.label}</Td>
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
            </TableWrap>
          )}
        </div>

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
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Started</Th>
                <Th num>Tokens</Th>
                <Th num>Cost</Th>
                <Th num>Turns</Th>
                <Th>Models</Th>
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
        </TableWrap>
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
