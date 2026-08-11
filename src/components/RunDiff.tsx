"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunDTO, RunDiffDTO } from "@/lib/apiTypes";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { DiffFileRow } from "@/components/ui/Patch";

/**
 * What the run actually changed.
 *
 * The event log next to this is a transcript of the process — every tool call,
 * every assistant turn — and reading it to find out what a run *did* is slower
 * than reading the diff. This is the outcome.
 */

export function RunDiff({ run }: { run: RunDTO }) {
  const [diff, setDiff] = useState<RunDiffDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${run.id}/diff`, { cache: "no-store" });
      const json = (await res.json()) as { diff?: RunDiffDTO; error?: string };
      if (!res.ok || !json.diff) {
        setError(json.error ?? "Could not read this run's changes.");
        return;
      }
      setDiff(json.diff);
    } catch {
      setError("Could not read this run's changes.");
    } finally {
      setLoading(false);
    }
  }, [run.id]);

  // Loaded once for a run that is over, on request for one that is not. A diff
  // costs several git processes, and an active run's is a moment-in-time
  // reading that is stale as soon as it renders.
  const settled =
    run.status === "completed" || run.status === "stopped" || run.status === "failed";
  useEffect(() => {
    if (settled) void load();
  }, [settled, load]);

  return (
    <Card className="mt-6">
      <CardTitle>
        What changed
        <Button
          variant="secondary"
          className="ml-auto"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Reading…" : diff ? "Refresh" : "Show changes"}
        </Button>
      </CardTitle>

      {error && <Notice tone="danger">{error}</Notice>}

      {!diff && !error && (
        <Empty>{loading ? "Reading the repository…" : "Not loaded yet."}</Empty>
      )}

      {diff && (
        <>
          {diff.caveat && <Notice tone="warn">{diff.caveat}</Notice>}

          {diff.kind === "none" && <Empty>{diff.reason ?? "Nothing to show."}</Empty>}

          {diff.kind === "range" && (
            <div className="mb-2 text-sm text-ink-muted">
              {diff.filesChanged === 0 ? (
                (diff.reason ?? "No files changed.")
              ) : (
                <>
                  <strong className="text-ink">{diff.filesChanged}</strong> file
                  {diff.filesChanged === 1 ? "" : "s"} on{" "}
                  <span className="mono">{diff.branch}</span> ·{" "}
                  <span className="text-ok">+{diff.added}</span>{" "}
                  <span className="text-danger">−{diff.deleted}</span>
                </>
              )}
            </div>
          )}

          {diff.omittedPatches > 0 && (
            <Notice tone="warn">
              <strong>
                {diff.omittedPatches} file{diff.omittedPatches === 1 ? "" : "s"} listed
                without contents.
              </strong>{" "}
              The change is too large to render whole. Every changed file is still in
              the list below.
            </Notice>
          )}

          <div>
            {diff.files.map((f) => (
              <DiffFileRow key={`${f.oldPath ?? ""}:${f.path}`} file={f} />
            ))}
          </div>

          {diff.uncommitted.length > 0 && (
            <div className="mt-4 border-t border-line pt-3.5">
              <div className="mb-2 text-xs font-semibold text-ink">
                {diff.kind === "range"
                  ? "Left uncommitted in the checkout"
                  : "Uncommitted in this folder"}
              </div>
              <div className="mono max-h-40 overflow-auto rounded-sm border border-line bg-inset p-2.5">
                {diff.uncommitted.map((l) => (
                  <div key={l} className="whitespace-pre text-ink-muted">
                    {l}
                  </div>
                ))}
              </div>
              {diff.kind === "range" && (
                <Hint tone="warn">
                  Not on the branch, so landing it will not bring these over
                </Hint>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
