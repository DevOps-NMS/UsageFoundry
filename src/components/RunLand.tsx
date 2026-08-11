"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ConflictFileDTO,
  LandStateDTO,
  RunDTO,
  RunReviewDTO,
} from "@/lib/apiTypes";
import { fmtDateTime, fmtUSD } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Spinner } from "@/components/ui/Log";
import { DiffFileRow, Patch } from "@/components/ui/Patch";

/**
 * Bringing this run's branch home.
 *
 * The rule the handoff card established holds here: refuse and explain, never
 * show-and-caveat. Every state that cannot be landed says why in a sentence
 * naming what to change, rather than presenting a greyed-out button that
 * leaves the operator guessing.
 */

const PREVIEW_LABEL: Record<LandStateDTO["preview"]["outcome"], string> = {
  "already-merged": "already in",
  "fast-forward": "fast-forward",
  clean: "merges cleanly",
  conflict: "conflicts",
  unknown: "unknown",
};

/**
 * One conflicting file: what kind of conflict it is, and what it looks like.
 *
 * The list used to be a comma-joined line of paths, which says a merge will
 * fail and nothing about whether it is a one-line clash or a rewrite. All of
 * this comes out of the same in-memory merge the preview already ran — the tree
 * `merge-tree` writes holds each file exactly as a real merge would leave it —
 * so the operator can read the conflict before deciding to spend anything on it.
 */
function ConflictFile({ file }: { file: ConflictFileDTO }) {
  const shown = file.regions.length;
  const total = shown + file.regionsOmitted;

  return (
    <details className="border-b border-line py-1.5 last:border-b-0">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
        <span className="mono min-w-0 flex-1 break-all text-ink">{file.path}</span>
        {file.type && (
          <span className="text-2xs uppercase tracking-wide text-warn">{file.type}</span>
        )}
        {total > 0 && (
          <span className="whitespace-nowrap tabular-nums text-xs text-ink-muted">
            {total} clash{total === 1 ? "" : "es"}
          </span>
        )}
      </summary>

      <div className="mt-2">
        {file.message && (
          <div className="mb-2 text-xs leading-snug text-ink-muted">{file.message}</div>
        )}

        {file.regions.map((region, i) => (
          <div key={i} className="mb-2 last:mb-0">
            <Patch text={region.text} kind="conflict" />
            {region.truncated && (
              <Hint tone="warn">Only the first part of this clash is shown</Hint>
            )}
          </div>
        ))}

        {file.regionsOmitted > 0 && (
          <Hint tone="warn">
            {file.regionsOmitted} further clash
            {file.regionsOmitted === 1 ? "" : "es"} in this file are not shown
          </Hint>
        )}
        {!file.regionsRead && (
          <Hint>Its merged content was not read, so nothing is shown here</Hint>
        )}
        {file.regionsRead && total === 0 && !file.message && (
          <Hint>git left no conflict markers in this file</Hint>
        )}
      </div>
    </details>
  );
}

export function RunLand({ run }: { run: RunDTO }) {
  const [state, setState] = useState<LandStateDTO | null>(null);
  const [resolution, setResolution] = useState<RunReviewDTO | null>(null);
  const [strategy, setStrategy] = useState<"merge" | "squash">("merge");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/runs/${run.id}/land`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as {
      state: LandStateDTO | null;
      defaultStrategy: "merge" | "squash";
      resolution: RunReviewDTO | null;
    };
    setState(json.state);
    setStrategy(json.defaultStrategy);
    setResolution(json.resolution);
  }, [run.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only while Claude is working on a conflict. A resolution changes the branch,
  // so the whole card — preview included — has to be re-read when it lands.
  const resolving = resolution?.status === "running";
  useEffect(() => {
    if (!resolving) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [resolving, load]);

  async function act(action: "land" | "delete" | "resolve") {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/runs/${run.id}/land`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, strategy }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (res.ok) setNote(json.message ?? null);
      else setError(json.error ?? "That did not work.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  const canLand = state.blocked === null;
  const settled = !["running", "queued", "paused"].includes(state.runStatus);
  // A squashed branch is never an ancestor of its target, so `merged` alone
  // would leave it undeletable for ever.
  const canDelete =
    (state.merged || state.landedUnchanged) && state.branchExists && settled;
  // Offered only for a real conflict on a run that has stopped committing.
  // The merge happens the other way round, in an isolated checkout — see
  // `resolveConflicts`.
  const canResolve = state.preview.outcome === "conflict" && settled;

  return (
    <Card className="mt-6">
      <CardTitle>
        Land this work
        {state.landedAt && <Badge tone="ok">landed</Badge>}
      </CardTitle>

      <div className="text-sm text-ink-muted">
        <span className="mono text-ink">{state.branch}</span>
        {state.target ? (
          <>
            {" → "}
            <span className="mono text-ink">{state.target}</span>
          </>
        ) : (
          " → no recorded target"
        )}
        {state.branchExists && (
          <>
            {" · "}
            {state.ahead} commit{state.ahead === 1 ? "" : "s"} ahead
            {state.behind > 0 && `, ${state.behind} behind`}
            {" · "}
            <span
              className={
                state.preview.outcome === "conflict" ? "text-warn" : "text-ink-muted"
              }
            >
              {PREVIEW_LABEL[state.preview.outcome]}
            </span>
          </>
        )}
      </div>

      {state.targetInferred && (
        <Hint tone="warn">
          This run predates target recording — {state.target} is where its base
          commit sits, not what it was told to land into
        </Hint>
      )}

      {/* One line about the state, not three. "Already in main", "landed on
          Tuesday" and "merged just now" are the same fact told three ways, and
          a card that stacks them reads as three separate things happening. */}
      {error ? (
        <Notice tone="danger" className="mt-3">
          {error}
        </Notice>
      ) : note ? (
        <Notice tone="info" className="mt-3">
          {note}
        </Notice>
      ) : state.landedAt ? (
        <Notice tone="info" quiet className="mt-3">
          Merged into <span className="mono">{state.landedInto}</span> on{" "}
          {fmtDateTime(state.landedAt)} ({state.landedStrategy}). Reopening this run
          can put new commits on the branch, so this describes a moment, not a
          permanent state.
        </Notice>
      ) : state.preview.outcome === "conflict" ? (
        <>
          <Notice tone="warn" className="mt-3">
            <strong>
              Conflicts with {state.target} in {state.preview.files.length} file
              {state.preview.files.length === 1 ? "" : "s"}.
            </strong>{" "}
            Nothing was written to find that out — the merge was tried in memory,
            and what is below is how it would land.
          </Notice>
          <div className="mt-2">
            {state.preview.files.map((f) => (
              <ConflictFile key={f.path} file={f} />
            ))}
          </div>
        </>
      ) : (
        state.blocked && (
          <Notice tone={state.merged ? "info" : "warn"} className="mt-3">
            {state.blocked}
          </Notice>
        )
      )}

      {resolution && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span>Claude resolved conflicts · {fmtDateTime(resolution.createdAt)}</span>
            {resolution.status === "running" ? (
              <Badge tone="accent">
                <Spinner /> working
              </Badge>
            ) : resolution.status === "failed" ? (
              <Badge tone="danger">failed</Badge>
            ) : (
              <Badge tone="ok">resolved</Badge>
            )}
            <span>{fmtUSD(resolution.costUSD)}</span>
          </div>
          {resolution.status === "failed" && (
            <Notice tone="danger">{resolution.error}</Notice>
          )}
          {resolution.status === "running" && (
            <Hint>
              Merging {state.target} into the branch in an isolated checkout —
              your own is not involved
            </Hint>
          )}
          {resolution.paths.length > 0 && resolution.status !== "completed" && (
            <div className="mono text-xs text-ink-muted">
              {resolution.paths.join(", ")}
            </div>
          )}
          {resolution.status === "completed" && resolution.text && (
            <div className="max-h-52 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
              {resolution.text}
            </div>
          )}

          {/* What it says it did, and then what it did. The answer above is the
              agent's account of the work; this is the work, read back off the
              branch — and it is the thing that gets landed. */}
          {resolution.changed && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-semibold text-ink">
                How the conflicting files ended up
              </div>
              {resolution.changed.files.length === 0 ? (
                <Hint tone="warn">
                  None of them changed on the branch, so every clash was settled
                  by keeping the branch&rsquo;s side whole
                </Hint>
              ) : (
                <>
                  {resolution.changed.files.map((f) => (
                    <DiffFileRow key={`${f.oldPath ?? ""}:${f.path}`} file={f} />
                  ))}
                  {resolution.changed.omittedPatches > 0 && (
                    <Hint tone="warn">
                      {resolution.changed.omittedPatches} file
                      {resolution.changed.omittedPatches === 1 ? "" : "s"} listed
                      without contents — too large to render here
                    </Hint>
                  )}
                  <Hint>
                    Against the branch before the merge, so what arrived from{" "}
                    {state.target} shows here too
                  </Hint>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {(canLand || canDelete || canResolve) && (
        <ButtonRow className="mt-3.5">
          {canLand && (
            <>
              <select
                className="w-auto rounded-sm border border-line bg-inset px-2.5 py-2 text-sm text-ink"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as "merge" | "squash")}
                aria-label="How to land it"
              >
                <option value="merge">Merge, keeping its commits</option>
                <option value="squash">Squash into one commit</option>
              </select>
              <Button onClick={() => act("land")} disabled={busy}>
                {busy ? "Landing…" : `Land into ${state.target}`}
              </Button>
            </>
          )}
          {canResolve && (
            <Button onClick={() => act("resolve")} disabled={busy || resolving}>
              {resolving ? "Resolving…" : "Resolve with Claude"}
            </Button>
          )}
          {canDelete && (
            <Button variant="danger" onClick={() => act("delete")} disabled={busy}>
              Delete branch
            </Button>
          )}
        </ButtonRow>
      )}

      {canLand && (
        <Hint>
          Runs in your own checkout, which has to be clean and on {state.target}. A
          conflict is rolled back
        </Hint>
      )}
      {canResolve && !resolving && (
        <Hint>
          Merges {state.target} into the branch in a throwaway checkout and has
          Claude reconcile the markers. Billed, and your checkout is untouched
        </Hint>
      )}
    </Card>
  );
}
