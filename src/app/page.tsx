"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LiveTelemetry } from "@/components/LiveTelemetry";
import { Meter } from "@/components/Meter";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty, Stat, StatSub } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";
import type { UsageResponse, WindowStateDTO } from "@/lib/apiTypes";
import {
  fmtDuration,
  fmtPct,
  fmtRelative,
  fmtTokens,
  fmtUSD,
  shortPath,
} from "@/lib/format";

/** Describe the ceiling a window's percentage is measured against. */
function ceilingDetail(w: WindowStateDTO): string {
  if (w.fractionMetric === "cost") {
    return `Ceiling: ${fmtUSD(w.limit ?? 0)} equivalent API cost — your configured estimate.`;
  }
  if (w.fractionMetric === "tokens") {
    return `Ceiling: ${fmtTokens(w.limit ?? 0)} raw tokens. A cost ceiling is steadier for this workload — see Settings.`;
  }
  return "Set a ceiling in Settings to see a percentage.";
}

type Dimension = "model" | "project" | "effort" | "agent" | "skill";

/** Poll cadence: the second one applies while a run is still working. */
const POLL_IDLE_MS = 10_000;
const POLL_WORKING_MS = 5_000;

export default function Dashboard() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dimension, setDimension] = useState<Dimension>("model");

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
    const load = async () => {
      try {
        const res = await fetch("/api/usage", { cache: "no-store" });
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) setError(json.error ?? "Failed to load usage");
        else {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
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

  if (error) {
    return (
      <Notice tone="danger">
        <strong>Could not read usage.</strong> {error}
      </Notice>
    );
  }

  if (!data || !breakdowns) {
    return <Empty>Reading transcripts…</Empty>;
  }

  const { snapshot: s, meta, telemetry } = data;
  const noCeilings = !meta.hasSessionCeiling && !meta.hasWeeklyCeiling;
  const cacheShare =
    s.weekly.tokens > 0 ? s.weekly.agg.tokens.cacheRead / s.weekly.tokens : null;
  const current = breakdowns[dimension];

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">
        Claude Code usage
      </h1>
      <p className="mb-4 max-w-[68ch] text-ink-muted">
        Computed from local transcripts in{" "}
        <span className="mono">{shortPath(meta.transcriptDir, 2)}</span> —{" "}
        {meta.entryCount.toLocaleString()} deduplicated turns across{" "}
        {meta.fileCount} session files
        {meta.entrypoints.length > 0 && (
          <>
            {" "}
            (<span className="mono">{meta.entrypoints.join(", ")}</span>)
          </>
        )}
        {/* Names the plan only. Anthropic publishes no number for a tier, so
            this never implies a ceiling — the meters stay indeterminate until
            one is configured. */}
        {meta.account.label && (
          <>
            , on{" "}
            <strong className="font-semibold text-ink">
              {meta.account.label}
            </strong>
          </>
        )}
        .
      </p>

      {/* Always shown — the blind spot is structural, not a transient state.
          Rendered quiet so the conditional warnings below can outrank it;
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
            window for it, so the ceilings below are reduced accordingly.
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

      {noCeilings && (
        <Notice tone="warn">
          <strong>No limit ceilings configured.</strong> Anthropic publishes no
          numeric value for a Pro/Max limit and offers no endpoint to read one,
          so percentages cannot be shown until you set a ceiling
          {meta.account.label && (
            <> — knowing you are on {meta.account.label} does not supply one</>
          )}
          . <Link href="/settings">Run Calibrate</Link> to derive one from your
          own peak usage, or enter a value manually. Volumes and costs below are
          exact regardless.
        </Notice>
      )}

      {meta.unpricedModels.length > 0 && (
        <Notice tone="warn">
          <strong>Unpriced models seen:</strong>{" "}
          <span className="mono">{meta.unpricedModels.join(", ")}</span>. Their
          tokens count toward volume but contribute $0 to cost, so the dollar
          figures below are a floor. The budget guard does not use that floor —
          it charges these models a conservative rate instead, which is the
          hatched span on the meters below. A run can therefore be stopped
          before the solid bar looks full.
        </Notice>
      )}

      {/* The two windows are the page's subject. Everything below is support. */}
      <section className="mb-4 grid gap-4 md:grid-cols-2">
        <Card emphasis="primary">
          <CardTitle>
            5-hour session window
            {s.session.agg.entryCount > 0 && <Badge tone="accent">active</Badge>}
          </CardTitle>
          <Stat size="large">{fmtUSD(s.session.costUSD)}</Stat>
          <StatSub>
            {fmtTokens(s.session.tokens)} tokens · {s.session.agg.entryCount}{" "}
            turns · resets {fmtRelative(s.session.endsAt, s.now)}
          </StatSub>
          <Meter
            label="Session consumed"
            fraction={s.session.fraction}
            upperFraction={s.session.guardFraction}
            detail={ceilingDetail(s.session)}
          />
          {s.session.tokenFraction !== null &&
            s.session.fractionMetric === "cost" && (
              <div className="mt-1.5 text-xs text-ink-faint">
                Against the raw-token ceiling: {fmtPct(s.session.tokenFraction)}
              </div>
            )}
          {meta.sessionResetOverrideAt !== null &&
            meta.sessionResetOverrideAt > s.now && (
              <div className="mt-1.5 text-xs text-ink-faint">
                Window start taken from a{" "}
                <Link href="/settings">manual reset</Link>, not from the
                transcripts — usage before{" "}
                {new Date(s.session.startsAt).toLocaleString()} is excluded from
                this card and from the budget guard.
              </div>
            )}
        </Card>

        <Card emphasis="primary">
          <CardTitle>{s.weekly.label}</CardTitle>
          <Stat size="large">{fmtUSD(s.weekly.costUSD)}</Stat>
          <StatSub>
            {fmtTokens(s.weekly.tokens)} tokens · {s.weekly.agg.entryCount} turns
          </StatSub>
          <Meter
            label="Weekly consumed"
            fraction={s.weekly.fraction}
            upperFraction={s.weekly.guardFraction}
            detail={ceilingDetail(s.weekly)}
          />
          {s.weekly.tokenFraction !== null &&
            s.weekly.fractionMetric === "cost" && (
              <div className="mt-1.5 text-xs text-ink-faint">
                Against the raw-token ceiling: {fmtPct(s.weekly.tokenFraction)}
              </div>
            )}
        </Card>
      </section>

      {/* Sits under the session meter because it is a footnote to it: the same
          five hours, read a different way. Absent entirely when agent
          self-reporting is off or nothing has reported — the same rule the run
          page's telemetry card follows. */}
      {telemetry && <LiveTelemetry telemetry={telemetry} now={s.now} />}

      <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card emphasis="quiet">
          <CardTitle>Burn rate</CardTitle>
          <Stat>{fmtUSD(s.burnCostPerHour)}</Stat>
          <StatSub>
            per hour · trailing 60 minutes
          </StatSub>
        </Card>

        <Card emphasis="quiet">
          <CardTitle>Projected exhaustion</CardTitle>
          <Stat>
            {s.projectedExhaustionAt
              ? fmtDuration(Math.max(0, s.projectedExhaustionAt - s.now))
              : "—"}
          </Stat>
          <StatSub>
            {s.projectedExhaustionAt
              ? `at the current rate, ${fmtRelative(s.projectedExhaustionAt, s.now)}`
              : noCeilings
                ? "needs a configured ceiling"
                : "not projected to run out"}
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
            {(Object.keys(breakdowns) as Dimension[]).map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={dimension === d}
                onClick={() => setDimension(d)}
                className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium ${
                  dimension === d
                    ? "border-accent bg-accent-dim text-ink"
                    : "border-line bg-inset text-ink-muted hover:text-ink"
                }`}
              >
                {breakdowns[d].label}
              </button>
            ))}
          </div>
        </div>

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
                {current.rows.slice(0, 12).map((r) => (
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
        {current.hint && (
          <div className="mt-2.5 text-xs text-ink-faint">{current.hint}</div>
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
              {s.blocks.slice(0, 15).map((b) => (
                <Tr key={b.startsAt}>
                  <Td className="whitespace-nowrap">
                    {new Date(b.startsAt).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
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
      </Card>
    </>
  );
}
