"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { RunDTO, RunEventDTO, RunTelemetryDTO } from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtClock,
  fmtDateTime,
  fmtTokens,
  fmtUSD,
  shortPath,
} from "@/lib/format";

/** Render one event as a single log line. */
function lineFor(e: RunEventDTO): string | null {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "iteration":
      return `── work cycle ${p.n}${
        p.resuming ? " (continuing the same conversation)" : ""
      } ──`;
    case "assistant":
      return String(p.text ?? "");
    case "tool":
      return `⚙ ${p.name}${
        p.input ? ` ${JSON.stringify(p.input).slice(0, 220)}` : ""
      }`;
    case "budget":
      return p.allowed
        ? `budget ok — weekly ${
            p.weeklyFraction == null
              ? "n/a"
              : `${((p.weeklyFraction as number) * 100).toFixed(1)}%`
          }`
        : `budget stop — ${p.reason}`;
    case "result":
      return `✓ turn complete — ${fmtUSD(Number(p.costUSD ?? 0))}, ${
        p.numTurns ?? "?"
      } turns`;
    case "error":
      return `✗ ${p.message}`;
    case "handoff": {
      const commits = Array.isArray(p.commits) ? p.commits.length : 0;
      return `⇢ ${commits} commit${commits === 1 ? "" : "s"} on ${p.branch}`;
    }
    case "status":
      return `status → ${p.status}${p.stop_reason ? `: ${p.stop_reason}` : ""}`;
    case "log": {
      const msg = String(p.message ?? "");
      // system:init and friends are noise once the run is underway.
      return msg.startsWith("system:") ? null : msg;
    }
    default:
      return null;
  }
}

export default function RunDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [run, setRun] = useState<RunDTO | null>(null);
  const [telemetry, setTelemetry] = useState<RunTelemetryDTO | null>(null);
  const [events, setEvents] = useState<RunEventDTO[]>([]);
  const [connected, setConnected] = useState(false);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Poll the run row for status/spend; the SSE stream carries the log.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await fetch(`/api/runs/${id}`, { cache: "no-store" });
      if (!res.ok || !alive) return;
      const json = await res.json();
      setRun(json.run);
      setTelemetry(json.telemetry ?? null);
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${id}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as RunEventDTO;
        if (e.kind === "replay-complete") return;
        setEvents((prev) => [...prev, e]);
      } catch {
        /* malformed frame — skip rather than tear down the stream */
      }
    };
    return () => es.close();
  }, [id]);

  // Follow the tail, but stop fighting the user if they scroll up to read.
  useEffect(() => {
    const el = logRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  function onScroll() {
    const el = logRef.current;
    if (!el) return;
    pinnedToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  async function stop() {
    const res = await fetch(`/api/runs/${id}`, { method: "DELETE" });
    const json = (await res.json().catch(() => ({}))) as { outcome?: string };
    // Between work cycles there is no child to signal, but the run still stops
    // at the next check — say so rather than leaving the button looking inert.
    setStopNote(
      json.outcome === "signalled"
        ? "Stopping the current work cycle…"
        : json.outcome === "cancelled"
          ? "Stopping — it will not start another work cycle."
          : "This run is not active.",
    );
  }

  if (!run) return <div className="empty">Loading run…</div>;

  const active = run.status === "running" || run.status === "queued";
  const handoff = [...events].reverse().find((e) => e.kind === "handoff");
  const costPct = run.budget.maxRunCostUSD
    ? Math.min(run.spent_usd / run.budget.maxRunCostUSD, 1)
    : null;

  return (
    <>
      <h1>
        Run <span className="mono">{run.id.slice(0, 8)}</span>{" "}
        <span className="badge" data-tone={STATUS_TONE[run.status]}>
          {run.status}
        </span>
      </h1>
      <p className="lede">
        {run.mountLabel && <>{run.mountLabel} · </>}
        <span className="mono" title={run.folder}>
          {run.mountLabel ? run.relPath || "." : shortPath(run.folder, 3)}
        </span>{" "}
        · started {fmtDateTime(run.started_at ?? run.created_at)} ·{" "}
        <Link href="/runs">back to runs</Link>
      </p>

      {run.status === "queued" && (
        <div className="notice" data-tone="warn">
          <strong>Waiting for its folder.</strong>{" "}
          {(run.queuePosition ?? 0) === 0
            ? "It is next in line and starts as soon as the run ahead of it finishes."
            : `${run.queuePosition} other run${
                run.queuePosition === 1 ? "" : "s"
              } are ahead of it.`}
        </div>
      )}

      {run.isolation === "worktree" && run.worktree_branch && (
        <div className="notice" data-tone="info">
          <strong>Isolated checkout.</strong> This run works on branch{" "}
          <span className="mono">{run.worktree_branch}</span>, not in your copy
          of the folder — so other runs can use the same project at the same
          time. Nothing lands in your checkout until you merge it.
        </div>
      )}

      {stopNote && (
        <div className="notice" data-tone="info">
          {stopNote}
        </div>
      )}

      {run.stop_reason && (
        <div
          className="notice"
          data-tone={run.status === "failed" ? "danger" : "info"}
        >
          <strong>
            {run.status === "blocked" ? "Refused to start:" : "Stopped:"}
          </strong>{" "}
          {run.stop_reason}
        </div>
      )}

      {handoff && (
        <div className="card">
          <h2 className="card-title">Where the work landed</h2>
          {Array.isArray(handoff.payload.commits) &&
          handoff.payload.commits.length > 0 ? (
            <div className="log" style={{ maxHeight: 160 }}>
              {(handoff.payload.commits as string[]).map((c) => (
                <div className="log-line" key={c}>
                  <span className="log-body">{c}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">
              The agent made no commits on this branch.
            </div>
          )}

          {Array.isArray(handoff.payload.uncommitted) &&
            handoff.payload.uncommitted.length > 0 && (
              <div className="notice" data-tone="warn">
                <strong>Uncommitted changes left in the checkout.</strong> They
                are not on the branch, so a merge will not bring them over.
              </div>
            )}

          <div className="subsection">
            <div className="subsection-title">Review it</div>
            {(handoff.payload.review as string[]).map((c) => (
              <div className="mono" key={c}>
                {c}
              </div>
            ))}
          </div>

          <div className="subsection">
            <div className="subsection-title">Bring it in</div>
            {handoff.payload.merge ? (
              <div className="mono">{String(handoff.payload.merge)}</div>
            ) : (
              <div className="hint" style={{ color: "var(--warn)" }}>
                {String(handoff.payload.mergeBlocked)}
              </div>
            )}
          </div>
        </div>
      )}

      <section className="grid grid-3">
        <div className="card">
          <h2 className="card-title">Spent on this run</h2>
          <div className="stat">{fmtUSD(run.spent_usd)}</div>
          <div className="stat-sub">
            {run.budget.maxRunCostUSD
              ? `of a ${fmtUSD(run.budget.maxRunCostUSD)} limit${
                  costPct !== null ? ` — ${(costPct * 100).toFixed(0)}%` : ""
                }`
              : "no spending limit set"}
          </div>
        </div>
        <div className="card">
          <h2 className="card-title">Tokens</h2>
          <div className="stat">{fmtTokens(run.spent_tokens)}</div>
          <div className="stat-sub">reported by Claude Code</div>
        </div>
        {/* A separate measurement, deliberately not folded into the two cards
            above. It counts every API request the agent made, including any
            belonging to a work cycle that ended before the CLI reported its
            cost — so a higher number here is the expected outcome of an
            interrupted run, not a discrepancy to reconcile away. */}
        {telemetry && (
          <div className="card">
            <h2 className="card-title">Telemetry (first-party)</h2>
            <div className="stat">{fmtUSD(telemetry.costUSD)}</div>
            <div className="stat-sub">
              {telemetry.requests} API{" "}
              {telemetry.requests === 1 ? "request" : "requests"} ·{" "}
              {fmtTokens(telemetry.tokens)} tokens
              {telemetry.costUSD > run.spent_usd &&
                " · includes work the run row could not account for"}
            </div>
          </div>
        )}
        <div className="card">
          <h2 className="card-title">Work cycles</h2>
          <div className="stat">
            {run.iterations}
            <span style={{ color: "var(--fg-faint)", fontSize: 18 }}>
              /{run.max_iterations}
            </span>
          </div>
          <div className="stat-sub">
            {active ? (
              <>
                <span className="spinner" /> working
              </>
            ) : (
              `${run.max_iterations === 1 ? "cycle" : "cycles"} used of the limit · exit ${run.exit_code ?? "—"}`
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">
          Live log
          {connected ? (
            <span className="badge" data-tone="ok">
              connected
            </span>
          ) : (
            <span className="badge">disconnected</span>
          )}
          {active && (
            <button
              className="danger"
              style={{ marginLeft: "auto" }}
              onClick={stop}
            >
              Stop run
            </button>
          )}
        </h2>

        <div className="log" ref={logRef} onScroll={onScroll}>
          {events.length === 0 && (
            <div className="empty">Waiting for output…</div>
          )}
          {events.map((e, i) => {
            const text = lineFor(e);
            if (text === null) return null;
            return (
              <div className="log-line" data-kind={e.kind} key={e.id ?? `${e.ts}-${i}`}>
                <span className="log-ts">{fmtClock(e.ts)}</span>
                <span className="log-body">{text}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Task</h2>
        <div className="log" style={{ maxHeight: 200 }}>
          {run.prompt}
        </div>
      </section>
    </>
  );
}
