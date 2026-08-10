"use client";

import { useEffect, useState } from "react";
import type { SettingsDTO } from "@/lib/apiTypes";
import { fmtTokens, fmtUSD } from "@/lib/format";

interface CalibrateResponse {
  ok: boolean;
  reason?: string;
  suggestion?: {
    sessionCostLimit: number | null;
    weeklyCostLimit: number | null;
    sessionTokenLimit: number | null;
    weeklyTokenLimit: number | null;
  };
  evidence?: Record<string, number>;
  caveat?: string;
  confidence?: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function SettingsPage() {
  const [s, setS] = useState<SettingsDTO | null>(null);
  const [env, setEnv] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cal, setCal] = useState<CalibrateResponse | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  /** Non-null only while the globs field is being edited. */
  const [copyGlobsText, setCopyGlobsText] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setS(d.settings);
        setEnv(d.env ?? {});
      });
  }, []);

  function patch(p: Partial<SettingsDTO>) {
    setS((prev) => (prev ? { ...prev, ...p } : prev));
    setSaved(false);
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s),
      });
      const json = await res.json();
      setS(json.settings);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  async function calibrate() {
    setCalBusy(true);
    try {
      const res = await fetch("/api/calibrate");
      setCal(await res.json());
    } finally {
      setCalBusy(false);
    }
  }

  if (!s) return <div className="empty">Loading settings…</div>;

  const numOrEmpty = (v: number | null) => (v === null ? "" : String(v));
  const workspaceMounts = Array.isArray(env.workspaceMounts)
    ? (env.workspaceMounts as Array<{ id: string; label: string; path: string }>)
    : [];

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">
        Transcripts:{" "}
        <span className="mono">{String(env.claudeHome ?? "—")}</span> · Admin
        key: {env.adminKeyConfigured ? "configured" : "not set"}
        <br />
        Workspaces:{" "}
        {workspaceMounts.length === 0 ? (
          <span className="mono">{String(env.workspaceRoot ?? "—")}</span>
        ) : (
          workspaceMounts.map((m, i) => (
            <span key={m.id}>
              {i > 0 && " · "}
              {m.label} <span className="mono">{m.path}</span>
            </span>
          ))
        )}
      </p>

      <section className="grid grid-2">
        <div className="card">
          <h2 className="card-title">Limit ceilings</h2>
          <div className="notice" data-tone="warn">
            Anthropic does not publish the numeric value of a Pro/Max limit and
            offers no endpoint to read one. Anything you enter here is an{" "}
            <strong>estimate</strong>, and every percentage in this app is
            computed against it. Calibrate derives a lower bound from your own
            peak usage.
          </div>

          <div className="field">
            <label htmlFor="sessc">5-hour ceiling — equivalent API cost (USD)</label>
            <input
              id="sessc"
              type="number"
              min={0}
              step="0.5"
              placeholder="blank = no percentage shown"
              value={numOrEmpty(s.sessionCostLimit)}
              onChange={(e) =>
                patch({
                  sessionCostLimit: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </div>

          <div className="field">
            <label htmlFor="wkc">Weekly ceiling — equivalent API cost (USD)</label>
            <input
              id="wkc"
              type="number"
              min={0}
              step="1"
              placeholder="blank = no percentage shown"
              value={numOrEmpty(s.weeklyCostLimit)}
              onChange={(e) =>
                patch({
                  weeklyCostLimit: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
            <div className="hint">
              Cost is the primary metric because a Claude Code workload is
              mostly cache reads, which bill at 0.1× and would otherwise
              dominate a raw-token count without consuming a comparable share of
              your plan.
            </div>
          </div>

          <div className="field">
            <label htmlFor="head">
              Reserved headroom for Cowork / Desktop / web (%)
            </label>
            <input
              id="head"
              type="number"
              min={0}
              max={95}
              placeholder="e.g. 30 — blank = reserve nothing"
              value={
                s.reservedHeadroomFraction === null
                  ? ""
                  : String(Math.round(s.reservedHeadroomFraction * 100))
              }
              onChange={(e) =>
                patch({
                  reservedHeadroomFraction: e.target.value
                    ? Math.min(Number(e.target.value) / 100, 0.95)
                    : null,
                })
              }
            />
            <div className="hint">
              Your limits are shared with Cowork, Claude Desktop, web, and
              mobile, none of which write local transcripts — so this tool
              cannot see them. Reserving headroom shrinks every ceiling so
              guards trip early rather than letting an invisible 50% of your
              window go unnoticed.
              {s.reservedHeadroomFraction && s.weeklyCostLimit ? (
                <>
                  {" "}
                  Effective weekly ceiling:{" "}
                  <strong>
                    {fmtUSD(
                      s.weeklyCostLimit * (1 - s.reservedHeadroomFraction),
                    )}
                  </strong>{" "}
                  of {fmtUSD(s.weeklyCostLimit)}.
                </>
              ) : null}
            </div>
          </div>

          <details style={{ marginBottom: 14 }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 12,
                color: "var(--fg-muted)",
                marginBottom: 10,
              }}
            >
              Raw-token ceilings (fallback)
            </summary>

            <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Used only when the matching cost ceiling above is blank. Shown as a
              secondary reading on the dashboard when both are set.
            </div>

            <div className="field">
              <label htmlFor="sess">5-hour ceiling (tokens)</label>
              <input
                id="sess"
                type="number"
                min={0}
                placeholder="blank = unused"
                value={numOrEmpty(s.sessionTokenLimit)}
                onChange={(e) =>
                  patch({
                    sessionTokenLimit: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </div>

            <div className="field">
              <label htmlFor="wk">Weekly ceiling (tokens)</label>
              <input
                id="wk"
                type="number"
                min={0}
                placeholder="blank = unused"
                value={numOrEmpty(s.weeklyTokenLimit)}
                onChange={(e) =>
                  patch({
                    weeklyTokenLimit: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </div>
          </details>

          <div className="field">
            <label htmlFor="anchor">Weekly reset</label>
            <select
              id="anchor"
              value={s.weeklyAnchor ? String(s.weeklyAnchor.weekday) : ""}
              onChange={(e) =>
                patch({
                  weeklyAnchor: e.target.value
                    ? {
                        weekday: Number(e.target.value),
                        hourUTC: s.weeklyAnchor?.hourUTC ?? 0,
                      }
                    : null,
                })
              }
            >
              <option value="">Rolling 7 days (no fixed reset)</option>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  Resets {d}
                </option>
              ))}
            </select>
            {s.weeklyAnchor && (
              <input
                type="number"
                min={0}
                max={23}
                style={{ marginTop: 8 }}
                value={s.weeklyAnchor.hourUTC}
                onChange={(e) =>
                  patch({
                    weeklyAnchor: {
                      weekday: s.weeklyAnchor!.weekday,
                      hourUTC: Number(e.target.value),
                    },
                  })
                }
              />
            )}
            <div className="hint">
              Hour is UTC. Leave on rolling if you do not know your reset day —
              the trailing-7-day figure is still meaningful.
            </div>
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Calibrate from history</h2>
          <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
            Scans every transcript, finds the largest fully-elapsed 5-hour block
            and the peak trailing-7-day total, and proposes those as ceilings.
          </p>
          <button className="secondary" onClick={calibrate} disabled={calBusy}>
            {calBusy ? "Scanning…" : "Run calibration"}
          </button>

          {cal && !cal.ok && (
            <div className="notice" data-tone="warn" style={{ marginTop: 14 }}>
              {cal.reason}
            </div>
          )}

          {cal?.ok && cal.suggestion && (
            <div style={{ marginTop: 14 }}>
              <table>
                <tbody>
                  <tr>
                    <td>
                      Suggested 5-hour ceiling
                      <div className="hint" style={{ margin: 0 }}>
                        {fmtTokens(cal.suggestion.sessionTokenLimit ?? 0)} raw
                        tokens
                      </div>
                    </td>
                    <td className="num mono">
                      {cal.suggestion.sessionCostLimit === null
                        ? "—"
                        : fmtUSD(cal.suggestion.sessionCostLimit)}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      Suggested weekly ceiling
                      <div className="hint" style={{ margin: 0 }}>
                        {fmtTokens(cal.suggestion.weeklyTokenLimit ?? 0)} raw
                        tokens
                      </div>
                    </td>
                    <td className="num mono">
                      {cal.suggestion.weeklyCostLimit === null
                        ? "—"
                        : fmtUSD(cal.suggestion.weeklyCostLimit)}
                    </td>
                  </tr>
                  <tr>
                    <td>History available</td>
                    <td className="num mono">
                      {cal.evidence?.historyDays ?? 0} days
                    </td>
                  </tr>
                  <tr>
                    <td>Confidence</td>
                    <td className="num">
                      <span
                        className="badge"
                        data-tone={
                          cal.confidence === "reasonable"
                            ? "ok"
                            : cal.confidence === "moderate"
                              ? "warn"
                              : "danger"
                        }
                      >
                        {cal.confidence}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>

              <div className="notice" data-tone="warn" style={{ marginTop: 12 }}>
                {cal.caveat}
              </div>

              <button
                onClick={() =>
                  patch({
                    sessionCostLimit: cal.suggestion!.sessionCostLimit,
                    weeklyCostLimit: cal.suggestion!.weeklyCostLimit,
                    sessionTokenLimit: cal.suggestion!.sessionTokenLimit,
                    weeklyTokenLimit: cal.suggestion!.weeklyTokenLimit,
                  })
                }
              >
                Apply suggestion
              </button>
              <div className="hint">
                Applies both metrics; cost drives the meters, tokens show as a
                secondary reading. Remember to Save.
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Run defaults</h2>
        <div className="grid grid-2">
          <div>
            <div className="field">
              <label htmlFor="model">Default model</label>
              <input
                id="model"
                type="text"
                placeholder="blank = Claude Code's own default"
                value={s.defaultModel ?? ""}
                onChange={(e) => patch({ defaultModel: e.target.value || null })}
              />
              <div className="hint">
                e.g. <span className="mono">claude-opus-5</span> or{" "}
                <span className="mono">claude-sonnet-5</span>.
              </div>
            </div>

            <div className="field">
              <label htmlFor="pm">Default permission mode</label>
              <select
                id="pm"
                value={s.defaultPermissionMode}
                onChange={(e) => patch({ defaultPermissionMode: e.target.value })}
              >
                <option value="acceptEdits">acceptEdits</option>
                <option value="default">default</option>
                <option value="plan">plan</option>
                <option value="bypassPermissions">bypassPermissions</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="side">Sub-agent turns</label>
              <select
                id="side"
                value={s.includeSidechains ? "1" : "0"}
                onChange={(e) => patch({ includeSidechains: e.target.value === "1" })}
              >
                <option value="1">Include in usage totals</option>
                <option value="0">Exclude from usage totals</option>
              </select>
              <div className="hint">
                Sub-agent (sidechain) turns bill normally, so including them is
                the accurate default. Exclude only to compare main-thread cost.
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="cont">Continuation prompt</label>
            <textarea
              id="cont"
              value={s.continuationPrompt}
              onChange={(e) => patch({ continuationPrompt: e.target.value })}
              style={{ minHeight: 150 }}
            />
            <div className="hint">
              What Claude is told at the start of every work cycle after the
              first, to carry on where it left off. The run ends when the reply
              contains <span className="mono">DONE</span> on its own line, so
              keep that instruction if you change the wording.
            </div>
          </div>

          <div className="subsection">
            <div className="subsection-title">Running several at once</div>

            <div className="field">
              <label htmlFor="conc">Runs allowed at the same time</label>
              <input
                id="conc"
                type="number"
                min={1}
                placeholder="blank = no limit"
                value={s.maxConcurrentRuns ?? ""}
                onChange={(e) =>
                  patch({
                    maxConcurrentRuns: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
              <div className="hint">
                Each run carries its own spending limit, so this multiplies the
                worst case: three runs with a $5 limit each can spend $15. Guards
                are still checked between work cycles, so the overrun is bounded
                by one cycle per run that was active at the time. Runs over the
                limit wait their turn rather than being refused.
              </div>
            </div>

            <div className="field">
              <label htmlFor="copyglobs">Files copied into a new checkout</label>
              {/* Held as raw text while editing. Splitting on every keystroke
                  drops the separator the moment it is typed, which makes a
                  second pattern impossible to enter. */}
              <input
                id="copyglobs"
                value={copyGlobsText ?? s.isolationCopyGlobs.join(", ")}
                onChange={(e) => setCopyGlobsText(e.target.value)}
                onBlur={() => {
                  if (copyGlobsText === null) return;
                  patch({
                    isolationCopyGlobs: copyGlobsText
                      .split(",")
                      .map((g) => g.trim())
                      .filter(Boolean),
                  });
                  setCopyGlobsText(null);
                }}
              />
              <div className="hint">
                A fresh checkout holds committed work only, so an agent would
                start with no environment file. These top-level patterns are
                copied across; prefix one with{" "}
                <span className="mono">!</span> to exclude it. Dependencies are
                not copied — the agent installs them, and they survive into the
                next run that reuses the same checkout.
              </div>
            </div>

            <div className="field">
              <label htmlFor="isopre">Isolated-run preamble</label>
              <textarea
                id="isopre"
                value={s.isolationPreamble}
                onChange={(e) => patch({ isolationPreamble: e.target.value })}
                style={{ minHeight: 110 }}
              />
              <div className="hint">
                Prepended to the first prompt of an isolated run. Keep the
                instruction to commit: work left uncommitted stays in a hidden
                checkout and never reaches your branch.
              </div>
            </div>
          </div>
        </div>

        <div className="btn-row">
          <button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
          {saved && (
            <span className="badge" data-tone="ok">
              saved
            </span>
          )}
        </div>
      </section>
    </>
  );
}
