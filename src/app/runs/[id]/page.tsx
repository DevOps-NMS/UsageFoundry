"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { RunDTO, RunEventDTO, RunTelemetryDTO } from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtClock,
  fmtDateTime,
  fmtRelative,
  fmtTokens,
  fmtUSD,
  shortPath,
} from "@/lib/format";
import { RunDiff } from "@/components/RunDiff";
import { RunLand } from "@/components/RunLand";
import { RunOutput } from "@/components/RunOutput";
import { RunReview } from "@/components/RunReview";

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
        : `${p.disposition === "pause" ? "budget pause" : "budget stop"}${
            p.live ? " (mid-cycle)" : ""
          } — ${p.reason}`;
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
    case "land": {
      if (p.purged) {
        return `⌫ purged ${p.branch} — ${p.commits} commit${
          p.commits === 1 ? "" : "s"
        } and ${p.discarded} uncommitted path${p.discarded === 1 ? "" : "s"} gone`;
      }
      if (p.deleted) return `⌫ deleted ${p.branch}`;
      if (p.commit) {
        return `⊕ committed ${p.files} path${p.files === 1 ? "" : "s"} to ${
          p.branch
        } as ${p.commit}`;
      }
      const resolved = Array.isArray(p.resolved) ? p.resolved.length : null;
      return resolved !== null
        ? `⇄ merged ${p.target} into ${p.branch}, resolving ${resolved} file${
            resolved === 1 ? "" : "s"
          }`
        : `⇥ landed ${p.branch} into ${p.target} (${p.strategy})`;
    }
    case "review": {
      // The same event kind carries both — a read-only review and a conflict
      // resolution — because they are the same billed, out-of-cycle spawn.
      const what = p.assist === "resolve" ? "conflict resolution" : "review";
      return p.status === "running"
        ? `⌕ ${what} started — ${p.shown}/${p.files} files`
        : p.status === "failed"
          ? `⌕ ${what} failed: ${p.error}`
          : `⌕ ${what} done — ${fmtUSD(Number(p.costUSD ?? 0))}`;
    }
    case "status": {
      // `message` is what a hand-driven transition says about itself — a
      // pick-up, a park, a resume. Without it the log shows the status flipping
      // and nothing about why.
      const why = p.stop_reason ?? p.message;
      return `status → ${p.status}${why ? `: ${why}` : ""}`;
    }
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
  // The reopen form. Held as strings because blank is meaningful — it is what
  // `normalizePolicy` reads as "no limit" — and a number input cannot hold it.
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopenCycles, setReopenCycles] = useState("");
  const [reopenCost, setReopenCost] = useState("");
  const [reopenMinutes, setReopenMinutes] = useState("");
  const [reopenNote, setReopenNote] = useState("");
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

  // Only ticks while parked, so a finished run's page does no work. Must sit
  // above the `if (!run)` early return — hooks cannot live behind one.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (run?.status !== "paused") return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run?.status]);

  async function stop() {
    const res = await fetch(`/api/runs/${id}`, { method: "DELETE" });
    const json = (await res.json().catch(() => ({}))) as { outcome?: string };
    // Between work cycles there is no child to signal, but the run still stops
    // at the next check — say so rather than leaving the button looking inert.
    setStopNote(
      json.outcome === "signalled"
        ? "Stopping the current work cycle…"
        : json.outcome === "cancelled"
          ? run?.status === "paused"
            ? "Stopped — it will not resume."
            : "Stopping — it will not start another work cycle."
          : "This run is not active.",
    );
  }

  async function tryNow() {
    const res = await fetch(`/api/runs/${id}/resume`, { method: "POST" });
    const json = (await res.json().catch(() => ({}))) as { outcome?: string };
    // Deliberately does not bypass the guard — it rejoins the queue and the
    // ordinary pre-cycle check decides. Asking early while the window is still
    // full parks it again, which is the honest outcome; a button that spends
    // past a limit the operator set would be worse than no button.
    setStopNote(
      json.outcome === "requeued"
        ? "Trying now — if the 5-hour window is still too full it steps aside again."
        : "This run is not waiting.",
    );
  }

  function openReopen() {
    if (!run) return;
    const blankIfNull = (v: number | null) => (v === null ? "" : String(v));
    setReopenCycles(blankIfNull(run.budget.maxIterations));
    setReopenCost(blankIfNull(run.budget.maxRunCostUSD));
    setReopenMinutes(blankIfNull(run.budget.maxDurationMinutes));
    setReopenNote("");
    setReopenError(null);
    setStopNote(null);
    setReopenOpen(true);
  }

  async function submitReopen() {
    if (!run) return;
    setReopenError(null);
    const asLimit = (v: string) => (v.trim() === "" ? null : Number(v));
    const res = await fetch(`/api/runs/${id}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Everything not on this form carries over untouched — the window
        // percentages, the enforcement mode, and what happens after DONE.
        budget: {
          ...run.budget,
          maxIterations: asLimit(reopenCycles),
          maxRunCostUSD: asLimit(reopenCost),
          maxDurationMinutes: asLimit(reopenMinutes),
        },
        followUp: reopenNote,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setReopenError(json.error ?? "Could not pick this run up.");
      return;
    }
    setReopenOpen(false);
    setStopNote(
      reopenNote.trim()
        ? "Back in the queue — your note is the first thing it reads."
        : "Back in the queue — it carries on from where it stopped.",
    );
  }

  if (!run) return <div className="empty">Loading run…</div>;

  // Paused counts as active: the run still holds its folder, will spend money
  // again on its own, and must keep offering the control that ends it.
  const active =
    run.status === "running" ||
    run.status === "queued" ||
    run.status === "paused";
  // Finished, but with somewhere to carry on from — including `completed`: the
  // agent's judgement that a task is done is not the operator's, and seeing
  // what it built is usually what shows up the next thing to ask for.
  const resumable =
    run.status === "failed" ||
    run.status === "stopped" ||
    run.status === "completed";
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
        {/* Not a resume: this opens the new-run form pre-filled from this
            run's stored config — same task, same folder, same guards, same
            permission mode — and changes nothing until it is submitted. It is
            also how a template gets seeded from something already known to
            work, since the form can save whatever it is holding. */}
        <Link href={`/runs/new?from=${run.id}`}>start another like this</Link> ·{" "}
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

      {run.status === "paused" && (
        <div className="notice" data-tone="warn">
          <strong>Waiting for the next 5-hour window.</strong> Your 5-hour window
          reached the percentage this run was told to step aside at.{" "}
          {run.resume_at ? (
            <>
              It tries again at {fmtDateTime(run.resume_at)} —{" "}
              <strong>{fmtRelative(run.resume_at, nowTick)}</strong>.
            </>
          ) : (
            "It tries again when the window rolls over."
          )}{" "}
          It is still holding{" "}
          <span className="mono" title={run.work_dir ?? run.folder}>
            {run.relPath || run.mountLabel || shortPath(run.folder, 2)}
          </span>
          , so nothing else can run there until it finishes or you stop it.
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
            {run.status === "blocked"
              ? "Refused to start:"
              : run.status === "paused"
                ? "Waiting:"
                : "Stopped:"}
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

      {/* The outcome, then what it means, then what to do with it — above the
          accounting, because "was any of this worth keeping?" is the question
          a finished run actually raises. The agent's own account comes first
          within that: it is the only one of these that says why. */}
      <RunOutput events={events} />
      <RunDiff run={run} />
      {run.isolation === "worktree" && run.worktree_branch && (
        <>
          <RunReview run={run} />
          <RunLand run={run} />
        </>
      )}

      {/* The spacing between the blocks on this page came from the legacy
          `section + section` rule, which only fires between two <section>
          siblings. RunDiff/RunReview/RunLand are component-kit cards — plain
          divs — so the rule stopped matching the moment they were inserted
          above, and this section welded itself to the card above it. Stated
          here rather than restored there: every other page already carries its
          own margin, and adjacency is the wrong thing to depend on. */}
      <section className="mt-6 grid grid-3">
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
          {/* Held apart from the measured figure above, not added to it: this
              is what work cycles that were cut short before Claude Code could
              report their cost are estimated to have spent, worked out from
              your transcripts. */}
          {(run.spent_usd_est ?? 0) > 0 && (
            <div className="stat-sub" style={{ color: "var(--warn)" }}>
              + {fmtUSD(run.spent_usd_est ?? 0)} estimated from transcripts for
              cycles that were cut short
            </div>
          )}
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
              {/* 0 is the stored sentinel for "no cap" — see db.ts. */}
              {run.max_iterations > 0 ? `/${run.max_iterations}` : " · no cap"}
            </span>
          </div>
          <div className="stat-sub">
            {/* A spinner on a run that is deliberately idle for hours is a lie,
                so the paused branch comes first. */}
            {run.status === "paused" ? (
              "paused — waiting for the next 5-hour window"
            ) : active ? (
              <>
                <span className="spinner" /> working
              </>
            ) : run.max_iterations > 0 ? (
              `${run.max_iterations === 1 ? "cycle" : "cycles"} used of the limit · exit ${run.exit_code ?? "—"}`
            ) : (
              `cycles used · exit ${run.exit_code ?? "—"}`
            )}
            {(run.done_retriggers ?? 0) > 0 &&
              ` · ${run.done_retriggers} after it reported done`}
          </div>
        </div>
      </section>

      <section className="mt-6 card">
        <h2 className="card-title">
          Live log
          {connected ? (
            <span className="badge" data-tone="ok">
              connected
            </span>
          ) : (
            <span className="badge">disconnected</span>
          )}
          {resumable && !reopenOpen && (
            <button style={{ marginLeft: "auto" }} onClick={openReopen}>
              {run.status === "completed" ? "Ask for more" : "Resume"}
            </button>
          )}
          {run.status === "paused" && (
            <button style={{ marginLeft: "auto" }} onClick={tryNow}>
              Try now
            </button>
          )}
          {active && (
            <button
              className="danger"
              style={run.status === "paused" ? undefined : { marginLeft: "auto" }}
              onClick={stop}
            >
              {run.status === "paused" ? "Give up" : "Stop run"}
            </button>
          )}
        </h2>

        {reopenOpen && (
          <div className="subsection">
            <div className="subsection-title">
              {!run.session_id
                ? "Start this run again from its original task"
                : run.status === "completed"
                  ? "Send this run back into the same session"
                  : "Carry on from where this run stopped"}
            </div>

            <div className="field">
              <label htmlFor="re-note">What else needs doing?</label>
              <textarea
                id="re-note"
                value={reopenNote}
                onChange={(e) => setReopenNote(e.target.value)}
                placeholder="The retry logic is missing a test for the timeout path."
              />
              <div className="hint">
                {!run.session_id
                  ? "This run never reported a session to resume, so it starts the original task again with this added to the end."
                  : run.status === "completed"
                    ? "Sent verbatim as the next turn of the same conversation. Blank asks it to re-check the original task, run the tests and fix what fails."
                    : "Sent verbatim as the next turn of the same conversation. Blank just tells it to continue."}
              </div>
            </div>

            <div className="field">
              <label htmlFor="re-cycles">Work cycles before stopping</label>
              <div className="input-row">
                <input
                  id="re-cycles"
                  type="number"
                  min={1}
                  value={reopenCycles}
                  onChange={(e) => setReopenCycles(e.target.value)}
                />
                <span className="unit">cycles in total</span>
              </div>
              <div className="hint">
                Counts the {run.iterations} this run has already had, so it needs
                to be higher than that. Blank means no cycle limit, which needs a
                time limit below.
              </div>
            </div>

            <div className="field">
              <label htmlFor="re-cost">Spending limit for this run</label>
              <div className="input-row">
                <span className="unit">$</span>
                <input
                  id="re-cost"
                  type="number"
                  min={0}
                  step="0.5"
                  value={reopenCost}
                  onChange={(e) => setReopenCost(e.target.value)}
                />
              </div>
              <div className="hint">
                Counts the {fmtUSD(run.spent_usd + (run.spent_usd_est ?? 0))} it
                has already spent. Blank means no limit.
              </div>
            </div>

            <div className="field">
              <label htmlFor="re-minutes">Time limit</label>
              <div className="input-row">
                <input
                  id="re-minutes"
                  type="number"
                  min={1}
                  value={reopenMinutes}
                  onChange={(e) => setReopenMinutes(e.target.value)}
                />
                <span className="unit">minutes</span>
              </div>
              <div className="hint">
                Runs from when it starts again, not from when it first ran.
                Blank means no limit.
              </div>
            </div>

            <div className="hint">
              Everything else carries over: the window percentages, how the
              limits are enforced, what happens after DONE, and the permission
              mode. It keeps its folder
              {run.isolation === "worktree" && run.worktree_branch
                ? ` and its checkout on ${run.worktree_branch}`
                : ""}
              .
            </div>

            {reopenError && (
              <div className="hint" style={{ color: "var(--danger)" }}>
                {reopenError}
              </div>
            )}

            <div className="input-row">
              <button onClick={submitReopen}>Resume run</button>
              <button onClick={() => setReopenOpen(false)}>Cancel</button>
            </div>
          </div>
        )}

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

      <section className="mt-6 card">
        <h2 className="card-title">Task</h2>
        <div className="log" style={{ maxHeight: 200 }}>
          {run.prompt}
        </div>
      </section>
    </>
  );
}
