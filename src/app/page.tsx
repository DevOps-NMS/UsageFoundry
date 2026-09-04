"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { LiveTelemetry } from "@/components/LiveTelemetry";
import { Meter } from "@/components/Meter";
import { RecentBlocksCard } from "@/components/RecentBlocksCard";
import { RepoSpendCard } from "@/components/RepoSpendCard";
import { PruneSavingsRows } from "@/components/PruneSavings";
import {
  ContextControlAside,
  FilterSavingsRows,
} from "@/components/ContextControl";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty, Stat, StatSub } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { ListGroup, ListRow } from "@/components/ui/List";
import { ListView, STICKY_HEAD } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import { prunerLine } from "@/lib/pruneStatement";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/Table";
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
  fmtDate,
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

/**
 * One name per slice, read by the picker and by the table's own column head.
 *
 * `agent` was "Sub-agent" while the only way a name reached `attributionAgent`
 * was a turn the main thread handed off. A run can now be *started as* an agent,
 * so a name in this column need not be a sub-agent at all — and the word has to
 * stop asserting that it is, because the arithmetic underneath cannot tell the
 * two apart and never tries to. It groups on whatever the CLI wrote.
 */
const DIMENSION_LABEL: Record<Dimension, string> = {
  model: "Model",
  project: "Project",
  effort: "Effort",
  agent: "Agent",
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
  /**
   * The same recorded turns repriced at a cheaper model's rates, or null/absent
   * where the dimension has no such reading. Only `agent` does: an agent is the
   * one thing here a model can be set on, which is what makes the comparison a
   * lever rather than a curiosity.
   */
  counterfactual?: number | null;
}

interface Breakdown {
  rows: BreakdownRow[];
  hint?: string;
}

/** Poll cadence: the second one applies while a run is still working. */
const POLL_IDLE_MS = 120_000;
const POLL_WORKING_MS = 60_000;

/** Every table cuts its tail. What is cut is counted rather than dropped. */
const MAX_BREAKDOWN_ROWS = 12;
const MAX_TOOL_ROWS = 12;

/**
 * The figure at the right of a grouped row.
 *
 * Tabular for the reason every figure on this page is: the whole card re-renders
 * on every poll, and a proportional digit set moves the right edge of the
 * column each time a 1 becomes an 8.
 */
function ListValue({ children }: { children: ReactNode }) {
  return (
    <span className="text-sm font-medium tabular-nums text-ink">{children}</span>
  );
}

/**
 * A named band of cards, and the one reading every card in it is drawn from.
 *
 * This page carries three readings of overlapping money — our price table over
 * every transcript on the machine, what runs this app started reported
 * spending, and Claude Code's own per-request telemetry — and any sum of two of
 * them double-counts. That prohibition used to be defended by a paragraph at
 * the foot of each card, so every card that landed had to re-derive it and six
 * of the eight landed with a separate feature. As a boundary it is structural:
 * a new card lands in the band whose source it reads, and a total drawn across
 * one is visibly wrong rather than merely undocumented. Each card keeps its own
 * footnote, which is now belt as well as braces.
 *
 * **No figure, meter, badge, total or comparison may be drawn at this level.**
 * A number beside a band's name is a number about two cards at once, which is
 * the arithmetic the bands exist to make impossible.
 *
 * A `div` with an `h2` in it, never a `<section>`: `section + section
 * { margin-top: 24px }` is still in the legacy layer and would fire between
 * every pair of these, which reads as a spacing decision somebody made rather
 * than as a stylesheet rule nobody meant to trigger. `Card` documents the same
 * trap from the other side.
 */
function SourceRegion({
  heading,
  statement,
  children,
}: {
  heading: string;
  /** Where the figures below come from, in one sentence. Never a figure. */
  statement: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold text-ink">{heading}</h2>
      <p className="mt-0.5 mb-3 max-w-[68ch] text-xs text-ink-muted">
        {statement}
      </p>
      {children}
    </div>
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
        // about the registry moves a dollar between rows, and neither does
        // starting a run as an agent — this app never infers a bucket.
        rows: s.byAgent.map((r) => ({
          label: r.agent,
          cost: r.agg.costUSD,
          mark: agentOriginBadge(r.origin),
          counterfactual: r.counterfactualUSD,
        })),
        // `(main thread)` is the bucket whose meaning moved. It was "not an
        // agent"; it is now "no agent name on the turn", which a run started as
        // one may or may not land in — unmeasured, and nothing here branches on
        // the answer. Saying so is what stops a column of agent names reading as
        // proof of delegation, and an all-main-thread column reading as proof
        // that no run was ever started as anything.
        hint: data.meta.includeSidechains
          ? "Unmarked names have no definition here — a Claude Code built-in, a repository's own .claude/agents, or an agent since deleted. (main thread) is a turn Claude Code recorded no agent name on, which may include a run started as one."
          : "Sub-agent turns are excluded from totals in Settings. A name can still appear here: a session started as an agent may record that name on its own turns.",
      },
      skill: {
        rows: s.bySkill.map((r) => ({ label: r.skill, cost: r.agg.costUSD })),
      },
    };
  }, [data]);

  // The banner is a live region so a page that has quietly stopped refreshing
  // announces itself. The figures deliberately are not: a polite region over
  // the meters would read every dollar total aloud on every poll.
  const banner = (
    <div aria-live="polite">
      {pollError && <Notice tone="danger">{pollError}</Notice>}
      {/* Above the meters rather than under them with the other notices, and
          that is the whole distinction: those explain a number the reader has
          just looked at, where this one says the numbers may be describing the
          wrong machine. A mount that is not a directory and a CLAUDE_HOME with
          no transcripts under it both render as the zeros below — which is also
          what a quiet week looks like. A refusal never reaches here (the boot
          exits on one), but it is rendered as danger rather than dropped, so a
          route that somehow serves one still shows it. */}
      {data?.meta.configProblems.map((p) => (
        <Notice
          key={`${p.variable}:${p.message}`}
          tone={p.severity === "refuse" ? "danger" : "warn"}
        >
          <strong className="mono">{p.variable}</strong> {p.message}
        </Notice>
      ))}
      {/* In words, because a held fleet and a quiet one are identical on this
          page otherwise: every meter reads the same and the only difference is
          that the queue never moves. It sits with the poll failure rather than
          among the cards for the same reason — it is a fact about whether what
          is below can still change. */}
      {data?.meta?.newWorkPaused && (
        <Notice tone="warn">
          <strong>New work is held.</strong> Nothing starts — queued runs stay
          queued, dependents stay waiting, schedules do not fire and an
          orchestrator block cannot emit. Work already in flight carries on.{" "}
          <Link href="/runs">Resume it on the runs page</Link>.
        </Notice>
      )}
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

  const {
    snapshot: s,
    meta,
    periods,
    telemetry,
    install,
    pruning,
    intakeFilter,
  } = data;
  const noCeilings = !meta.hasSessionCeiling && !meta.hasWeeklyCeiling;
  // Gates both context-control surfaces, and they have to agree: an empty tile
  // beside the meters is a standing invitation to read $0.00 as "this saves
  // nothing" when it means "this has not run".
  //
  // Either half is enough, because either half alone is a real reading and the
  // card names both. The prune total is the pruning half's gate because it is a
  // superset of both windows by construction — the route starts its span at or
  // before the weekly window's own start, whatever the retention is set to.
  // The filter's is `running` rather than a figure: an operator who has it
  // switched on is owed the reason it has no number yet.
  const hasContextControl =
    pruning.total.prunes > 0 ||
    // The pruner's own liveness, and the asymmetry it fixes: the filter's
    // disjunct above was already a *state* and the pruner's was an *outcome*.
    // An install with pruning switched on and nothing cut yet — or one built
    // with `WINNOW_REF=` empty, where nothing ever will be — rendered no
    // context-control surface at all, which reads as the feature not existing.
    pruning.pruner.state !== "off" ||
    // A window whose pruning has since been switched off still has boundaries
    // in it worth reading.
    pruning.activity.total.boundaries > 0 ||
    intakeFilter.running ||
    intakeFilter.ledger === "read";
  // Spelled out per case rather than assembled from parts. Tailwind scans this
  // file for literal class strings and emits nothing for a computed one, so a
  // template built from a variable arrives in the browser as a class with no
  // rule behind it — and the failure is the silent kind this page is full of:
  // the row keeps stacking at every width and nothing throws, warns or fails a
  // typecheck. (Scanning is literal in the other direction too: an arbitrary
  // value written out in a comment here is compiled into the stylesheet.)
  //
  // Which template applies is the same question as which cards render, so the
  // two conditions are the same ones their call sites carry. A track with no
  // card in it is not free: the row packs left and the leftover is blank.
  const topRowColumns = telemetry
    ? hasContextControl
      ? // Three columns only from `xl`. The 50% cap does not scale down: the
        // two columns beside it are 16rem and a gap whatever the row is, so at
        // the `lg` breakpoint — 1024px less a 14rem sidebar and the pane's
        // gutters — half the row leaves the middle card 85px. Measured, not
        // estimated. Below `xl` the row is what it was and the live card takes
        // a row of its own under it, which is what `lg:order-last` below does.
        "lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] xl:grid-cols-[minmax(0,50%)_minmax(0,1fr)_minmax(0,16rem)]"
      : // Nothing fixed-width in this one, so the cap costs nothing at any
        // width and can start where the row does.
        "lg:grid-cols-[minmax(0,50%)_minmax(0,1fr)]"
    : hasContextControl
      ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]"
      : // Nothing beside it, so nothing to make room for. Half a row of white
        // space to the right of the meters is a worse answer to "this box could
        // be shorter" than the wide box was.
        "";
  // Only when there is a third card to get out of the way of. `order-last` puts
  // the live card after the tile in the *flow* while leaving it second in the
  // DOM, which is the order it is read in at every width where it is beside the
  // meters; between `lg` and `xl` it spans the row under them instead, because
  // a full-width card is a better answer to a narrow row than a 16rem column
  // and a hole where the third one did not fit.
  const liveTelemetryPlacement = hasContextControl
    ? "lg:order-last lg:col-span-2 xl:order-none xl:col-span-1"
    : "";
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
  // The column and the sentence under the table are one decision: a second
  // dollar figure beside the first, with nothing saying it describes a run that
  // never happened, is a figure a reader will quote as a saving.
  const counterfactualModel = s.counterfactualModel;
  const showCounterfactual = dimension === "agent" && counterfactualModel !== null;
  // The table's key is `claude-sonnet-5`; the column head has one line for it.
  const counterfactualLabel = (counterfactualModel ?? "").replace("claude-", "");
  const toolsOmitted = Math.max(0, s.byTool.rows.length - MAX_TOOL_ROWS);
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
      {/* This app's own footprint used to get its own segment here — it is a
          fact about the reading, not a reading, and it used to be the thing
          that eventually killed the container — but a reader skimming this
          strip for usage facts has no use for a live number, so it now rides
          the count it fills rather than standing beside it: the parsed turns
          are what fills this heap. Still findable on hover, not on the eviction
          Notice below, because that one only renders once the cache is already
          past its bound and this figure is the thing an operator would want
          before that happens. */}
      <span
        title={`${Math.round(meta.memory.heapUsedBytes / 1e6).toLocaleString()} MB heap of ${Math.round(meta.memory.heapLimitBytes / 1e6).toLocaleString()} MB — ${meta.memory.cache.entries.toLocaleString()} of at most ${meta.memory.cache.maxEntries.toLocaleString()} parsed turns cached across ${meta.memory.cache.files.toLocaleString()} files`}
      >
        {meta.entryCount.toLocaleString()} deduplicated turns
      </span>
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

      {/* Up to three columns: the window card capped at half the row, the
          live-telemetry card taking what is left of the remainder, the
          context-control tile keeping its fixed 16rem. Which template applies,
          and from which breakpoint, is `topRowColumns` above.

          The window card used to be `minmax(0,1fr)` against that 16rem alone —
          about 84% of a 1920px row — and the comment here defended the
          asymmetry, the objection being that two co-equal cards side by side
          would say neither leads. That objection stands and so does the answer
          to it; what changed is which property carries it. `primary` against
          `default`, and a hero meter against a `text-xl` figure, are what say
          this card leads. Width was never doing that work: at 84% the extra
          space went to a `max-w-[68ch]` paragraph in a 1400px box, while the
          first-party spend figure — the one number on this page that moves
          *during* a work cycle — sat 5,700px below the fold. Half a row is
          still the widest box on the page and still the only one an elevation
          up, so nothing about what leads has changed, and neither aside's
          conclusion is now reachable only from the bottom of the page.

          Capped at half only where something is in fact beside it. A template
          with a track no card was rendered for packs the cards left and leaves
          the rest of the row blank, and a cap with nothing in the space it
          freed does the same thing on purpose — both read as something that
          failed to load, which is what `items-start` is here to avoid one axis
          over.

          `items-start` so the asides keep their own height; stretching them
          would pad a three-line card out to the meters' and make the empty
          space look like something failed to load. Below `lg` it is one column
          and they follow the meters, which is the same reading order. */}
      <div className={`mb-4 grid gap-4 lg:items-start ${topRowColumns}`}>
        {/* The one `primary` card on the screen, and the only thing on it sized
            to be read from across a room. Both windows live in it because they
            are one subject — what may be spent — and two co-equal cards side by
            side said neither of them leads. Inside it the session leads: it is
            the allowance that refills on its own, so it is the one an operator
            can act on in the next few minutes, and the week sits under the same
            hairline a grouped list uses. */}
        <Card emphasis="primary">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <CardTitle>
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
          <div className="mt-3 max-w-[68ch] space-y-1 text-xs text-ink-muted">
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
                <CardTitle>{s.weekly.label}</CardTitle>
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

            <div className="mt-3 max-w-[68ch] space-y-1 text-xs text-ink-muted">
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

        {/* Gated on the window itself, and it has to be: `telemetryWindow`
            answers `null` when agent self-reporting is off or nothing has
            reported, so an absent card is "no run has reported" rather than
            "$0.00" — and $0.00 at the top of the dashboard, beside the meters,
            is a reading an operator would act on. The gate is the setting and
            what came back on it, never the guard figure. */}
        {telemetry && (
          <div className={liveTelemetryPlacement}>
            <LiveTelemetry telemetry={telemetry} now={s.now} />
          </div>
        )}

        {hasContextControl && (
          <ContextControlAside
            filter={intakeFilter}
            pruning={pruning.total}
            pruningFrom={pruning.totalFrom}
            session={pruning.session}
            weekly={pruning.weekly}
          />
        )}
      </div>

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

      {/* The four cards this page's own price table produced. The two meters
          above are the same reading; these are what it breaks down into. */}
      <SourceRegion
        heading="Your subscription"
        statement="This app’s price table over every Claude Code transcript on this machine."
      >
        {/* Four equally-weighted bordered boxes said these four readings were as
            important as the meters above them, which none of them is. As a
            grouped list they read as what they are: derived figures about the
            window the card above measures. */}
        <Card className="mb-4">
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

            {/* The second clause used to read "which is why the dollar figures
                track work and the token counts do not", and this install's own
                telemetry says otherwise: across a week of run cycles, cache reads
                were 60% of the *bill* as well as 96% of the tokens, with the
                1-hour cache write another 26% and generated output 14%. Cheap per
                token is not the same as small, and a reader told the dollars track
                work will look for the expensive run rather than the long one. */}
            <ListRow
              label="Cache reads"
              description="Share of all tokens, billed at 0.1× — cheap each, and still the largest share of the bill once conversations run long"
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

        <Card emphasis="quiet" className="mb-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            {/* The row above already states the gap under this heading, so the
                title's own `mb-3` is not a gap here at all — it is 12px inside
                the flex line, and `items-center` centres each item's *margin*
                box, so the words sat 6px above the control beside them. The
                cancellation is on a wrapper rather than an `mb-0` on the title
                for the reason `ui/Field` states about width: two utilities for
                one property on one element resolve by stylesheet order, and
                Tailwind emits `mb-*` ascending, so the component's larger value
                wins whatever a call site writes. */}
            <div className="-mb-3">
              <CardTitle>
                Where it went — {s.weekly.label.toLowerCase()}
              </CardTitle>
            </div>
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
            <ListView box="capped">
              <Table stack>
                <caption className="sr-only">
                  Cost by {DIMENSION_LABEL[dimension].toLowerCase()} over{" "}
                  {s.weekly.label.toLowerCase()}, highest first
                </caption>
                <THead>
                  <tr>
                    <Th className={STICKY_HEAD}>{DIMENSION_LABEL[dimension]}</Th>
                    <Th num className={STICKY_HEAD}>
                      Cost
                    </Th>
                    {showCounterfactual && (
                      <Th num className={STICKY_HEAD}>
                        On {counterfactualLabel}
                      </Th>
                    )}
                    <Th num className={STICKY_HEAD}>
                      Share
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {/* Every turn lands in some bucket — including explicit
                      "(main thread)" / "(no skill)" rows — so the column adds to
                      100% instead of quietly omitting a remainder. */}
                  {current.rows.slice(0, MAX_BREAKDOWN_ROWS).map((r) => (
                    <Tr key={r.label}>
                      {/* No label: the bucket's own name is what the record is,
                          and the picker above already says which of the five
                          dimensions is being named. `break-all` below the
                          breakpoint because a project bucket is a path, which has
                          no space to wrap at and would take the pane sideways. */}
                      <Td className="max-md:break-all">
                        <span className="mono">{r.label}</span>
                        {r.mark && (
                          <>
                            {" "}
                            <Badge tone={r.mark.tone}>{r.mark.text}</Badge>
                          </>
                        )}
                      </Td>
                      <Td num label="Cost">
                        {fmtUSD(r.cost)}
                      </Td>
                      {/* Labelled with the model rather than "Counterfactual":
                          stacked below `md` this line is read on its own, and
                          the word the reader needs there is which model it is. */}
                      {showCounterfactual && (
                        <Td num label={`On ${counterfactualLabel}`}>
                          {r.counterfactual === null ||
                          r.counterfactual === undefined
                            ? "—"
                            : fmtUSD(r.counterfactual)}
                        </Td>
                      )}
                      <Td num label="Share">
                        {s.weekly.costUSD > 0
                          ? fmtPct(r.cost / s.weekly.costUSD)
                          : "—"}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </ListView>
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
          {/* Never folded away and never shortened. The column beside Cost is a
              dollar figure for work that did not happen, and a reader who quotes
              it as a saving has been misled by this page rather than by their
              own arithmetic. */}
          {showCounterfactual && (
            <div className="mt-2 max-w-[68ch] text-xs text-ink-muted">
              <strong>On {counterfactualLabel}</strong> is these exact turns —
              the same input, output and cache tokens — repriced at that
              model&rsquo;s rate on the day each one ran. It is a counterfactual,
              not a forecast: the same task on a smaller model may take more work
              cycles, longer conversations or more retries, and this figure knows
              nothing about that. It is worth reading because the discount lands
              on cache reads, which are {fmtPct(cacheShare)} of the tokens here
              and the largest single share of the bill. An agent carries a model
              and a run started as that agent runs on it, so pointing a
              template&rsquo;s agent at it is how you would find out for real.
            </div>
          )}
          {current.hint && (
            <div className="mt-2 text-xs text-ink-muted">{current.hint}</div>
          )}
        </Card>

        {/* Sits with the breakdowns because it reads the same transcripts, and
            it is deliberately *not* a sixth slice of them: every row above is a
            share of the money, and every row here is a share of the characters.
            A tool result is not a billable turn — it carries no usage block at
            all — so this card draws no per-tool dollar figure and none can be
            derived from it. What it does carry is the price of *placing* a
            token, which is the number that makes the composition actionable. */}
        <Card emphasis="quiet" className="mb-4">
          <CardTitle>What filled the context</CardTitle>
          <p className="mb-3 max-w-[68ch] text-xs text-ink-muted">
            Tool results are what an agent puts into a context and then pays to
            carry: each one is re-read on every later turn of the session. The
            shares below are of characters of tool output over{" "}
            {s.weekly.label.toLowerCase()} — not of money, and not comparable
            with any figure above.
          </p>

          <ListGroup>
            <ListRow
              label="Tokens placed"
              description="Entered a context once — as fresh input, as a cache write, or as generated output. Re-reads are excluded, which is the point of the two rows below."
            >
              <ListValue>{fmtTokens(s.byTool.placedTokens)}</ListValue>
            </ListRow>
            <ListRow
              label="Read back"
              description="Times the average placed token was re-read across this window"
            >
              <ListValue>
                {s.byTool.reReadRatio === null
                  ? "—"
                  : `${s.byTool.reReadRatio.toFixed(1)}×`}
              </ListValue>
            </ListRow>
            <ListRow
              label="Cost per million placed"
              description="This window’s whole bill over the tokens placed into it. Not a rate anyone is charged — it is what a token ends up costing once it has been carried, which is far above any list input price."
            >
              <ListValue>
                {s.byTool.costPerMillionPlacedUSD === null
                  ? "—"
                  : fmtUSD(s.byTool.costPerMillionPlacedUSD)}
              </ListValue>
            </ListRow>
          </ListGroup>

          {s.byTool.rows.length === 0 ? (
            <div className="mt-4">
              <Empty>No tool calls recorded in this window.</Empty>
            </div>
          ) : (
            <div className="mt-4">
              <ListView box="capped">
                <Table stack>
                  <caption className="sr-only">
                    Characters of tool output placed into contexts over{" "}
                    {s.weekly.label.toLowerCase()}, largest first
                  </caption>
                  <THead>
                    <tr>
                      <Th className={STICKY_HEAD}>Tool</Th>
                      <Th num className={STICKY_HEAD}>
                        Calls
                      </Th>
                      <Th num className={STICKY_HEAD}>
                        Characters
                      </Th>
                      <Th num className={STICKY_HEAD}>
                        Share
                      </Th>
                    </tr>
                  </THead>
                  <TBody>
                    {s.byTool.rows.slice(0, MAX_TOOL_ROWS).map((r) => (
                      <Tr key={r.tool}>
                        {/* No label: the tool's own name is what the record is.
                            `break-all` below the breakpoint because an MCP tool
                            id is one long token with nothing to wrap at. */}
                        <Td className="max-md:break-all">
                          <span className="mono">{r.tool}</span>
                        </Td>
                        <Td num label="Calls">
                          {r.calls.toLocaleString()}
                        </Td>
                        <Td num label="Characters">
                          {fmtTokens(r.resultChars)}
                        </Td>
                        <Td num label="Share">
                          {fmtPct(r.share)}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </ListView>
            </div>
          )}

          {toolsOmitted > 0 && (
            <div className="mt-2 text-xs tabular-nums text-ink-muted">
              {toolsOmitted} smaller{" "}
              {toolsOmitted === 1 ? "tool is" : "tools are"} in the totals above
              but not listed.
            </div>
          )}
          {/* Only where there is something to qualify: an empty window has
              already said so above, and a caveat with no figure under it is a
              sentence the eye learns to skip. */}
          {s.byTool.totalCalls > 0 && (
            <div className="mt-2 max-w-[68ch] text-xs text-ink-muted">
              {s.byTool.totalCalls.toLocaleString()} calls placed{" "}
              {fmtTokens(s.byTool.totalResultChars)} characters.
              {s.byTool.unansweredCalls > 0 && (
                <>
                  {" "}
                  {s.byTool.unansweredCalls.toLocaleString()} of them have no
                  recorded result — interrupted, or answered in a transcript this
                  scan could not read — and count towards the calls and towards
                  no share.
                </>
              )}{" "}
              A result that came back as an image counts no characters, so a tool
              that answers in pictures reads low here.
            </div>
          )}
        </Card>

        <RecentBlocksCard blocks={s.blocks} />
      </SourceRegion>

      <SourceRegion
        heading="What this app spent"
        statement="Money runs this app started reported spending."
      >
        {/* The one ceiling on this page that is about the *install* rather than
            about a window Anthropic enforces, so it sits outside the meters: its
            span is a rolling 24 hours, its figures are money this app recorded
            spending rather than our price table over every transcript on the
            machine, and the two must never be added. Always shown — with no
            ceiling configured the meter is the hatched indeterminate one, which
            is this app's standing answer to a reading with no denominator, and
            the hint is where the operator finds out the limit exists at all. */}
        <Card className="mb-4">
          <CardTitle>This install, last {install.windowHours} hours</CardTitle>
          <Meter
            label="Spent by everything this app runs"
            fraction={
              install.limitUSD === null ? null : install.spentUSD / install.limitUSD
            }
            upperFraction={
              install.limitUSD === null
                ? null
                : install.spentGuardUSD / install.limitUSD
            }
            unknownHint="no install limit set"
            detail={
              install.limitUSD === null
                ? `${fmtUSD(install.spentGuardUSD)} spent`
                : `${fmtUSD(install.spentGuardUSD)} of ${fmtUSD(install.limitUSD)}`
            }
          />
          <Hint>
            {install.limitUSD === null ? (
              <>
                Every guard in this app bounds one run, one workflow or one chat
                turn. Nothing bounds the total until you{" "}
                <Link href="/settings">set an install limit</Link>.
              </>
            ) : (
              <>
                Runs, workflow blocks and chat turns together. A run still going,
                or one that finished inside the window, counts its whole spend —
                which over-counts rather than under-counts, because this is a
                limit. Not comparable with the meters above: those measure every
                transcript on this machine against Anthropic&rsquo;s windows.
              </>
            )}
          </Hint>
        </Card>

        {/* A different question with a different source: the cards above
            slice the transcript window by what produced it, this one says what
            each repository's own runs reported spending. The two are never
            added — see the card. */}
        <RepoSpendCard />
      </SourceRegion>

      {/* Not a fourth cost source, and the heading has to carry that — the word
          is "saved", never "spent": these are re-reads that did not happen,
          netted against what buying them cost. Nothing here may be added to a
          meter above — see `PruneSavingsDTO`.

          The net moved up beside the meters, so what is left here is the
          derivation, and the heading says so. It is not redundant with the
          tile and must not be folded into it: a net is four figures netted,
          and an operator deciding whether to leave pruning on is deciding on
          which way each of the four went, not on their sum. Every span the
          tile prints has its own block here, the total included — a headline
          with no derivation under it is the thing this band exists to prevent.

          Two cards, never one table, and nothing added across them. The tile
          adds the two mechanisms because that is the question it answers and
          it prints how much the sum overstates; this band is where each half's
          own arithmetic lives, and a total here would be the same sum a second
          time with nothing beside it saying so.

          Gated on `hasContextControl`, the same const the tile reads. */}
      {hasContextControl && (
        <SourceRegion
          heading="What context control saved, in detail"
          statement="The figure beside the meters is these two added: tool results kept out of the request as it was sent, and conversation removed between work cycles."
        >
          {/* The filter first, matching the tile: it acts before the pruner
              does, so what the pruner reports is the residual of it. */}
          <Card className="mb-4">
            <CardTitle>Intake filter</CardTitle>
            <FilterSavingsRows filter={intakeFilter} />
            <Hint>
              A tool result the filter recognises is replaced with a pointer past
              the last cache breakpoint, so the API never writes it and no later
              turn re-reads it. Nothing is edited, so unlike a prune there is no
              invalidation to pay and no break-even — it earns on the first
              request. What it still costs is sending the result once, uncached,
              which is the middle row.{" "}
              {intakeFilter.ledger === "read" && (
                <>
                  Measured over {intakeFilter.requests} rewritten{" "}
                  {intakeFilter.requests === 1 ? "request" : "requests"}
                  {intakeFilter.unjoinedRequests > 0 && (
                    <>
                      , {intakeFilter.unjoinedRequests} of which matched no
                      main-thread turn this install still holds — a sub-agent&rsquo;s
                      request, or one whose transcript has been swept. What they
                      saved is missing from the figure rather than counted as
                      nothing
                    </>
                  )}
                  .
                </>
              )}
            </Hint>
          </Card>

          <Card className="mb-4">
            <CardTitle>Context pruning</CardTitle>
            {/* Full strength rather than `quiet`, because this is not a
                standing banner: it appears only while pruning is switched on
                with nothing behind it, which an operator either fixes with a
                rebuild or turns off deliberately. Every figure under it is
                then a history, not a reading of now. */}
            {pruning.pruner.state === "unavailable" ? (
              <Notice tone="warn">
                <strong>Context pruning cannot run here.</strong>{" "}
                {pruning.pruner.detail} Nothing below was removed by it.
              </Notice>
            ) : (
              /* Once, at the top, rather than on each of the three spans under
                 it: what is configured is one fact about now, and repeating it
                 per span would read as three readings of it. */
              <p className="mb-3 text-sm text-ink-muted">
                {prunerLine(pruning.pruner)}
              </p>
            )}
            {/* The total first, because it is what the tile leads with and this
                band is that figure's derivation. The two windows under it are
                the same arithmetic over shorter spans. */}
            <PruneSavingsRows
              label={
                pruning.totalFrom === null
                  ? "All time"
                  : `Since ${fmtDate(pruning.totalFrom)}`
              }
              savings={pruning.total}
              pruner={pruning.pruner}
              activity={pruning.activity.total}
            />
            <PruneSavingsRows
              label="This 5-hour window"
              savings={pruning.session}
              pruner={pruning.pruner}
              activity={pruning.activity.session}
            />
            <PruneSavingsRows
              label="This week"
              savings={pruning.weekly}
              pruner={pruning.pruner}
              activity={pruning.activity.weekly}
            />
            <Hint>
              Removing conversation does not simply make a run cheaper: an edit
              invalidates the cached prefix, so the saving is what later turns did
              not have to re-read, less what the edit itself cost. A prune between
              two work cycles was believed to pay nothing, because the next cycle
              was going to rewrite that conversation anyway — that is the most
              likely reading and it has not been measured, so a total still
              carrying unsettled prunes is printed as a ceiling. One that ended a
              cycle early pays for the restart it caused. Both are counted here.
              A cut is left alone when the last one on that run would need more
              than 18 further turns to pay for itself.
              {/* Why the first block stops where it does. It belongs here rather
                  than on the tile: it is the one line that explains a span, and
                  a reader who wants to know why the total starts on a date has
                  already come looking for the arithmetic. */}
              {pruning.totalFrom !== null && (
                <>
                  {" "}
                  It stops at{" "}
                  <span className="tabular-nums">
                    {fmtDate(pruning.totalFrom)}
                  </span>{" "}
                  because a saving is measured over the turns that followed it,
                  and transcripts older than your{" "}
                  <Link href="/settings">retention</Link> have been deleted —
                  what those prunes saved is unknown rather than nothing.
                </>
              )}
            </Hint>
          </Card>
        </SourceRegion>
      )}
    </>
  );
}
