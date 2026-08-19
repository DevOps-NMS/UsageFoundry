"use client";

import type { DiffFileDTO } from "@/lib/apiTypes";
import { gutterDigits, patchRows, type PatchRowKind } from "@/lib/patch";
import { Disclosure } from "@/components/ui/Disclosure";
import { Hint } from "@/components/ui/Hint";

/**
 * A block of git output, coloured by line.
 *
 * Two kinds, and they are not interchangeable. A unified diff has exactly five
 * kinds of line and a leading `+` means an addition. A conflicted file is
 * ordinary file content, where a leading `+` means whatever the file's language
 * means by it — colouring it as a diff would paint half a Markdown document
 * green. So the marker lines are what is highlighted there, and nothing else.
 *
 * Only the diff gets a gutter, and that asymmetry is the same fact: a conflict
 * region is an excerpt of a file with no header saying where it starts, so
 * numbering it from 1 would name lines that are not those lines.
 */

/**
 * Tone per row, as complete class strings — Badge's rule, and here it covers a
 * background as well as a colour. The tint is what a native diff uses to say
 * which side a line is on without the reader parsing the marker column; it is
 * deliberately faint, because a patch is mostly context and a loud one turns
 * three changed lines into a striped page.
 */
const ROW: Record<PatchRowKind, string> = {
  meta: "text-ink-faint",
  hunk: "bg-fill-hover text-accent",
  add: "bg-ok/10 text-ok",
  del: "bg-danger/10 text-danger",
  context: "text-ink-muted",
  note: "text-ink-faint",
};

/** Colour by line prefix, for file content git could not merge. */
function conflictClass(line: string): string {
  if (line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> ")) return "text-warn";
  if (line.startsWith("||||||| ") || line === "=======") return "text-warn";
  return "text-ink-muted";
}

const SHELL =
  "max-h-[420px] overflow-auto rounded-sm border border-line bg-inset py-2.5 font-mono text-xs leading-relaxed";

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
  if (kind === "conflict") {
    return (
      <div
        tabIndex={0}
        role="group"
        aria-label={label ?? "Conflicting file"}
        className={`${SHELL} px-2.5 ${className}`}
      >
        {text.split("\n").map((line, i) => (
          <div key={i} className={`whitespace-pre ${conflictClass(line)}`}>
            {line || " "}
          </div>
        ))}
      </div>
    );
  }

  const rows = patchRows(text);
  const digits = gutterDigits(rows);
  // Exact rather than a guessed pixel width, because the pane is monospace and
  // `ch` is therefore the character cell: a fixed `w-10` truncates a five-digit
  // number in a long file, and a per-row intrinsic width would let every row
  // size its own gutter and none of them line up. The 0.75rem is the `px-1.5`
  // on the spans, which sits inside the width under border-box — so the content
  // box is exactly the digits.
  const gutter = { width: `calc(${Math.max(digits, 2)}ch + 0.75rem)` };

  return (
    <div
      // Focusable for the same reason the run log is: a patch taller than
      // 420px is otherwise unreachable without a pointer.
      tabIndex={0}
      role="group"
      aria-label={label ?? "Patch"}
      className={`${SHELL} ${className}`}
    >
      {rows.map((row, i) => (
        // `w-max min-w-full`: at least the width of the pane, so a row's tint
        // reaches both edges, and as wide as its own line when that is longer,
        // so the tint follows the code out into the horizontal scroll rather
        // than stopping where the pane happens to end.
        <div key={i} className={`flex w-max min-w-full ${ROW[row.kind]}`}>
          {digits > 0 && (
            // `select-none` on both columns, so selecting the patch and pasting
            // it somewhere yields the patch: a gutter that copies is the reason
            // line numbers are usually left out of one altogether.
            <>
              <span
                aria-hidden
                style={gutter}
                className="shrink-0 select-none px-1.5 text-right text-ink-faint"
              >
                {row.oldLine ?? ""}
              </span>
              <span
                aria-hidden
                style={gutter}
                className="shrink-0 select-none border-r border-line px-1.5 text-right text-ink-faint"
              >
                {row.newLine ?? ""}
              </span>
            </>
          )}
          <span className="whitespace-pre px-2.5">{row.text || " "}</span>
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
    <Disclosure
      className="border-b border-line py-1.5 last:border-b-0"
      // The row is the control, so the whole row answers the pointer and the
      // whole row takes focus.
      //
      // Sticky, for the log's work-cycle header reason: an open patch runs to
      // hundreds of lines and the fact that scrolls away first is which file
      // they are in. It needs the card's own background under it, because the
      // patch passes beneath rather than pushing it along — and it has to sit
      // on the summary, since the `<details>` around it is the height of the
      // whole patch and pinning that pins nothing.
      //
      // `--control-h` for the pointer, because `Disclosure` states only the
      // finger's target and leaves the desktop box to the row it is in.
      //
      // `flex` is the one thing here that costs something: it replaces the
      // `list-item` display the disclosure triangle is drawn by, so this row
      // says it opens with the pointer and the hover fill and not with a
      // marker. Four spans that have to sit on one line and share the width
      // is what buys it.
      summaryClassName="sticky top-0 z-10 -mx-1 flex min-h-[var(--control-h)] flex-wrap items-center gap-2 rounded-sm bg-surface px-1 text-sm hover:bg-inset"
      summary={
        <>
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
        </>
      }
    >
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
    </Disclosure>
  );
}
