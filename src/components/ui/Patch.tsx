"use client";

import type { DiffFileDTO } from "@/lib/apiTypes";
import { Hint } from "@/components/ui/Hint";

/**
 * A block of git output, coloured by line.
 *
 * Two kinds, and they are not interchangeable. A unified diff has exactly five
 * kinds of line and a leading `+` means an addition. A conflicted file is
 * ordinary file content, where a leading `+` means whatever the file's language
 * means by it — colouring it as a diff would paint half a Markdown document
 * green. So the marker lines are what is highlighted there, and nothing else.
 */

/** Colour by line prefix, for a unified diff. */
function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-ink-faint";
  if (line.startsWith("@@")) return "text-accent";
  if (line.startsWith("+")) return "text-ok";
  if (line.startsWith("-")) return "text-danger";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-ink-faint";
  return "text-ink-muted";
}

/** Colour by line prefix, for file content git could not merge. */
function conflictClass(line: string): string {
  if (line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> ")) return "text-warn";
  if (line.startsWith("||||||| ") || line === "=======") return "text-warn";
  return "text-ink-muted";
}

export function Patch({
  text,
  kind = "diff",
  label,
  className = "",
}: {
  text: string;
  kind?: "diff" | "conflict";
  /** Names the scrollable region — see the tabIndex note below. */
  label?: string;
  className?: string;
}) {
  const classFor = kind === "conflict" ? conflictClass : diffClass;
  return (
    <div
      // Focusable for the same reason the run log is: a patch taller than
      // 420px is otherwise unreachable without a pointer.
      tabIndex={0}
      role="group"
      aria-label={label ?? (kind === "conflict" ? "Conflicting file" : "Patch")}
      className={`max-h-[420px] overflow-auto rounded-sm border border-line bg-inset p-2.5 font-mono text-xs leading-relaxed ${className}`}
    >
      {text.split("\n").map((line, i) => (
        <div key={i} className={`whitespace-pre ${classFor(line)}`}>
          {line || " "}
        </div>
      ))}
    </div>
  );
}

const STATUS_LABEL: Record<DiffFileDTO["status"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  changed: "type changed",
};

/** One changed file, its patch behind a disclosure. */
export function DiffFileRow({ file }: { file: DiffFileDTO }) {
  return (
    <details className="border-b border-line py-1.5 last:border-b-0">
      {/* The row is the control, so the whole row answers the pointer and the
          whole row takes focus. The disclosure triangle stays: it is the only
          thing on screen that says there is more behind this line. */}
      <summary className="ui-transition -mx-1 flex min-h-[var(--control-h)] cursor-pointer flex-wrap items-center gap-2 rounded-sm px-1 text-sm hover:bg-inset">
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
            render here. See it with <span className="mono">git diff</span> in the
            repository
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
