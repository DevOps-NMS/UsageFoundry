"use client";

import { useCallback, useEffect, useState } from "react";
import type { DiffFileDTO, RunDTO, RunDiffDTO } from "@/lib/apiTypes";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";

/**
 * What the run actually changed.
 *
 * The event log next to this is a transcript of the process — every tool call,
 * every assistant turn — and reading it to find out what a run *did* is slower
 * than reading the diff. This is the outcome.
 */

const STATUS_LABEL: Record<DiffFileDTO["status"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  changed: "type changed",
};

/** Colour by line prefix. A unified diff has exactly five kinds of line. */
function classFor(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-ink-faint";
  if (line.startsWith("@@")) return "text-accent";
  if (line.startsWith("+")) return "text-ok";
  if (line.startsWith("-")) return "text-danger";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-ink-faint";
  return "text-ink-muted";
}

function Patch({ text }: { text: string }) {
  return (
    <div className="max-h-[420px] overflow-auto rounded-sm border border-line bg-inset p-2.5 font-mono text-xs leading-relaxed">
      {text.split("\n").map((line, i) => (
        <div key={i} className={`whitespace-pre ${classFor(line)}`}>
          {line || " "}
        </div>
      ))}
    </div>
  );
}

function FileRow({ file }: { file: DiffFileDTO }) {
  return (
    <details className="border-b border-line py-1.5 last:border-b-0">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
        <span className="mono min-w-0 flex-1 break-all text-ink">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="text-2xs uppercase tracking-wide text-ink-faint">
          {STATUS_LABEL[file.status]}
        </span>
        {file.binary ? (
          <span className="text-2xs text-ink-faint">binary</span>
        ) : (
          <span className="whitespace-nowrap tabular-nums text-xs">
            <span className="text-ok">+{file.added ?? 0}</span>{" "}
            <span className="text-danger">−{file.deleted ?? 0}</span>
          </span>
        )}
      </summary>
      <div className="mt-2">
        {file.patch === null ? (
          <Hint tone="warn">
            This file&rsquo;s contents were left out — the change is too large to
            render here. See it with{" "}
            <span className="mono">git diff</span> in the repository
          </Hint>
        ) : (
          <>
            <Patch text={file.patch} />
            {file.patchTruncated && (
              <Hint tone="warn">Only the first part of this file&rsquo;s change is shown</Hint>
            )}
          </>
        )}
      </div>
    </details>
  );
}

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
              <FileRow key={`${f.oldPath ?? ""}:${f.path}`} file={f} />
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
