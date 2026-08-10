"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Meter } from "@/components/Meter";
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

export default function Dashboard() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error) {
    return (
      <div className="notice" data-tone="danger">
        <strong>Could not read usage.</strong> {error}
      </div>
    );
  }

  if (!data) {
    return <div className="empty">Reading transcripts…</div>;
  }

  const { snapshot: s, meta } = data;
  const noCeilings = !meta.hasSessionCeiling && !meta.hasWeeklyCeiling;

  const wkTokens = s.weekly.agg.tokens;
  const cacheShare =
    s.weekly.tokens > 0 ? wkTokens.cacheRead / s.weekly.tokens : null;

  return (
    <>
      <h1>Claude Code usage</h1>
      <p className="lede">
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
            , on <strong>{meta.account.label}</strong>
          </>
        )}
        .
      </p>

      {/* Always shown. The blind spot is structural, not a transient state. */}
      <div className="notice" data-tone="warn">
        <strong>This covers Claude Code only.</strong> Your 5-hour and weekly
        limits are shared with <strong>Cowork</strong>, Claude Desktop, web, and
        mobile — none of which write anything locally, so none of it appears
        below. Treat these figures as a <em>floor</em> on your real consumption.
        {meta.reservedHeadroomFraction > 0 ? (
          <>
            {" "}
            You have reserved <strong>
              {fmtPct(meta.reservedHeadroomFraction)}
            </strong>{" "}
            of each window for that invisible usage, so the ceilings below are
            reduced accordingly.
          </>
        ) : (
          <>
            {" "}
            If you also use those surfaces, set a{" "}
            <Link href="/settings">reserved headroom</Link> — otherwise a guard
            can permit a run while your real window is already close to full.
          </>
        )}
      </div>

      {noCeilings && (
        <div className="notice" data-tone="warn">
          <strong>No limit ceilings configured.</strong> Anthropic publishes no
          numeric value for a Pro/Max limit and offers no endpoint to read one,
          so percentages cannot be shown until you set a ceiling
          {meta.account.label && (
            <>
              {" "}
              — knowing you are on {meta.account.label} does not supply one
            </>
          )}
          .{" "}
          <Link href="/settings">Run Calibrate</Link> to derive one from your own
          peak usage, or enter a value manually. Volumes and costs below are
          exact regardless.
        </div>
      )}

      {meta.unpricedModels.length > 0 && (
        <div className="notice" data-tone="warn">
          <strong>Unpriced models seen:</strong>{" "}
          <span className="mono">{meta.unpricedModels.join(", ")}</span>. Their
          tokens count toward volume but contribute $0 to cost, so the dollar
          figures below are a floor. The budget guard does not use that floor —
          it charges these models a conservative rate instead, which is the
          hatched span on the meters below. A run can therefore be stopped
          before the solid bar looks full.
        </div>
      )}

      <section className="grid grid-2">
        <div className="card">
          <h2 className="card-title">
            5-hour session window
            {s.session.agg.entryCount > 0 && (
              <span className="badge" data-tone="accent">
                active
              </span>
            )}
          </h2>
          <div className="stat">{fmtUSD(s.session.costUSD)}</div>
          <div className="stat-sub">
            {fmtTokens(s.session.tokens)} tokens · {s.session.agg.entryCount} turns
            · resets {fmtRelative(s.session.endsAt, s.now)}
          </div>
          <Meter
            label="Session consumed"
            fraction={s.session.fraction}
            upperFraction={s.session.guardFraction}
            detail={ceilingDetail(s.session)}
          />
          {s.session.tokenFraction !== null &&
            s.session.fractionMetric === "cost" && (
              <div className="hint">
                Against the raw-token ceiling: {fmtPct(s.session.tokenFraction)}
              </div>
            )}
        </div>

        <div className="card">
          <h2 className="card-title">{s.weekly.label}</h2>
          <div className="stat">{fmtUSD(s.weekly.costUSD)}</div>
          <div className="stat-sub">
            {fmtTokens(s.weekly.tokens)} tokens · {s.weekly.agg.entryCount} turns
          </div>
          <Meter
            label="Weekly consumed"
            fraction={s.weekly.fraction}
            upperFraction={s.weekly.guardFraction}
            detail={ceilingDetail(s.weekly)}
          />
          {s.weekly.tokenFraction !== null &&
            s.weekly.fractionMetric === "cost" && (
              <div className="hint">
                Against the raw-token ceiling: {fmtPct(s.weekly.tokenFraction)}
              </div>
            )}
        </div>
      </section>

      <section className="grid grid-3">
        <div className="card">
          <h2 className="card-title">Burn rate</h2>
          <div className="stat">{fmtUSD(s.burnCostPerHour)}</div>
          <div className="stat-sub">
            per hour · {fmtTokens(s.burnTokensPerHour)} tokens/hour
          </div>
          <div className="hint">Measured over the trailing 60 minutes.</div>
        </div>

        <div className="card">
          <h2 className="card-title">Composition</h2>
          <div className="stat">{fmtPct(cacheShare)}</div>
          <div className="stat-sub">of tokens are cache reads</div>
          <div className="hint">
            Cache reads bill at 0.1×, so they inflate raw token counts far more
            than they consume your plan. That is why the meters above are
            cost-denominated.
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Projected exhaustion</h2>
          <div className="stat">
            {s.projectedExhaustionAt
              ? fmtDuration(Math.max(0, s.projectedExhaustionAt - s.now))
              : "—"}
          </div>
          <div className="stat-sub">
            {s.projectedExhaustionAt
              ? `at the current rate, ${fmtRelative(s.projectedExhaustionAt, s.now)}`
              : noCeilings
                ? "needs a configured ceiling"
                : "not projected to run out"}
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Lifetime recorded</h2>
          <div className="stat">{fmtUSD(s.totalCostUSD)}</div>
          <div className="stat-sub">
            equivalent API cost across all local transcripts
          </div>
        </div>
      </section>

      <section className="grid grid-2">
        <div className="card">
          <h2 className="card-title">By model — {s.weekly.label.toLowerCase()}</h2>
          {s.byModel.length === 0 ? (
            <div className="empty">No usage in this window.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byModel.map((m) => (
                    <tr key={m.model}>
                      <td className="mono">{m.model}</td>
                      <td className="num">
                        {fmtTokens(
                          m.agg.tokens.input +
                            m.agg.tokens.output +
                            m.agg.tokens.cacheRead +
                            m.agg.tokens.cacheWrite5m +
                            m.agg.tokens.cacheWrite1h,
                        )}
                      </td>
                      <td className="num">{fmtUSD(m.agg.costUSD)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">By project — {s.weekly.label.toLowerCase()}</h2>
          {s.byProject.length === 0 ? (
            <div className="empty">No usage in this window.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byProject.slice(0, 12).map((p) => (
                    <tr key={p.project}>
                      <td className="mono" title={p.project}>
                        {shortPath(p.project)}
                      </td>
                      <td className="num">{fmtUSD(p.agg.costUSD)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Recent 5-hour blocks</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Turns</th>
                <th>Models</th>
              </tr>
            </thead>
            <tbody>
              {s.blocks.slice(0, 15).map((b) => (
                <tr key={b.startsAt}>
                  <td>
                    {new Date(b.startsAt).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {b.isActive && (
                      <>
                        {" "}
                        <span className="badge" data-tone="ok">
                          live
                        </span>
                      </>
                    )}
                  </td>
                  <td className="num">
                    {fmtTokens(
                      b.agg.tokens.input +
                        b.agg.tokens.output +
                        b.agg.tokens.cacheRead +
                        b.agg.tokens.cacheWrite5m +
                        b.agg.tokens.cacheWrite1h,
                    )}
                  </td>
                  <td className="num">{fmtUSD(b.agg.costUSD)}</td>
                  <td className="num">{b.agg.entryCount}</td>
                  <td className="mono">
                    {b.models.map((m) => m.replace("claude-", "")).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
