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

/**
 * Above this many files the list gets its own scroll box.
 *
 * Every row is a closed `DiffFileRow` — `ui/Patch`'s `Disclosure` over one
 * file's patch — so a 300-file change is 300 rows of chrome between the
 * operator and the land decision below it. The cap bounds the card rather than
 * the list: nothing is dropped, and the count above it already says how many
 * there are.
 */
const SCROLL_FILE_LIST_ABOVE = 24;

export function RunDiff({ run }: { run: RunDTO }) {
  // Loaded once for a run that is over, on request for one that is not. A diff
  // costs several git processes, and an active run's is a moment-in-time
  // reading that is stale as soon as it renders.
  // A positive list, so a status added to the union and not to it silently makes
  // the card say "still working" about a run that is over and never load.
  const settled =
    run.status === "completed" ||
    run.status === "needs-review" ||
    run.status === "stopped" ||
    run.status === "failed";
  const [diff, setDiff] = useState<RunDiffDTO | null>(null);
  // A settled run starts in the loading state because the effect below is about
  // to fetch: initialising to false renders one frame of "nothing loaded",
  // which is a different sentence from the true one.
  const [loading, setLoading] = useState(settled);
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

  useEffect(() => {
    if (settled) void load();
  }, [settled, load]);

  // A scroll container is not reachable by keyboard unless it is focusable, so
  // the cap above would otherwise hide the tail of a long list from anyone not
  // using a pointer.
  const filesScroll = (diff?.files.length ?? 0) > SCROLL_FILE_LIST_ABOVE;

  return (
    // The outcome once a run is over, and a one-line stub while it is still
    // writing — so it leads only when there is something settled to read.
    <Card emphasis={settled ? "primary" : "quiet"}>
      <CardTitle>
        What changed
        <Button
          variant="secondary"
          className="ml-auto transition-colors duration-150"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Reading…" : diff ? "Refresh" : "Show changes"}
        </Button>
      </CardTitle>

      {error && <Notice tone="danger">{error}</Notice>}

      {/* Shaped like the file list it is standing in for, so the card does not
          resize under the reader when the answer arrives. */}
      {loading && !diff && (
        <div aria-busy="true" aria-live="polite">
          <span className="sr-only">Reading the repository…</span>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-2 border-b border-line py-2.5 last:border-b-0"
            >
              <div className="h-3.5 flex-1 rounded-sm bg-inset" />
              <div className="h-3.5 w-12 rounded-sm bg-inset" />
            </div>
          ))}
        </div>
      )}

      {!diff && !error && !loading && (
        <Empty>
          {settled
            ? "Nothing loaded — read it with the button above."
            : "This run is still working, so its changes are read on request."}
        </Empty>
      )}

      {diff && (
        <>
          {diff.caveat && <Notice tone="warn">{diff.caveat}</Notice>}

          {diff.kind === "none" && <Empty>{diff.reason ?? "Nothing to show."}</Empty>}

          {diff.kind === "range" && (
            <div className="mb-2 text-sm tabular-nums text-ink-muted">
              {diff.filesChanged === 0 ? (
                (diff.reason ?? "No files changed.")
              ) : (
                <>
                  <strong className="font-semibold text-ink">
                    {diff.filesChanged}
                  </strong>{" "}
                  file{diff.filesChanged === 1 ? "" : "s"} on{" "}
                  <span className="mono">{diff.branch}</span> ·{" "}
                  {/* The sign is in the text, not only in the colour: these read
                      the same way in a screenshot, in high contrast, and to a
                      reader who cannot tell green from red. */}
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

          <div
            className={
              filesScroll
                ? "max-h-[26rem] overflow-y-auto rounded-sm border border-line px-2.5"
                : ""
            }
            tabIndex={filesScroll ? 0 : undefined}
            role={filesScroll ? "group" : undefined}
            aria-label={filesScroll ? "Changed files" : undefined}
          >
            {diff.files.map((f) => (
              <DiffFileRow key={`${f.oldPath ?? ""}:${f.path}`} file={f} />
            ))}
          </div>

          {diff.uncommitted.length > 0 && (
            <div className="mt-4 border-t border-line pt-3.5">
              {/* Two wordings for two different places, and the branch is the
                  whole of the difference: an isolated run's checkout is not the
                  operator's folder. There was a third wording on the Land card
                  for the same list; one name each is what the reader needs to
                  match them up. */}
              <div className="mb-2 text-xs font-semibold text-ink">
                {diff.kind === "range"
                  ? "Uncommitted in the checkout"
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
