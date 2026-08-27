"use client";

import { useEffect, useMemo, useState } from "react";
import type { RunDTO, RunDiffDTO, RunTouchedDTO } from "@/lib/apiTypes";
import { reconcileTouches, type TouchedFile } from "@/lib/runTouches";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { GroupLabel } from "@/components/ui/List";
import { ListView, STICKY_HEAD } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import { Table, TBody, THead, Th, Td, Tr } from "@/components/ui/Table";

/**
 * What the run's tool calls named, against what its branch diff changed.
 *
 * The diff beside this says what came out; the log says what happened. Neither
 * answers the three questions that are set differences between them — did this
 * run change a file it never read, what did it read and then not use, and did
 * it touch anything outside the checkout at all.
 *
 * It takes the diff as a prop rather than fetching one. The tab has already
 * loaded that file list, and asking the server to reconcile would mean a second
 * `runDiff` — several more git processes for an answer the page is holding.
 */

/**
 * The four groups, in the order they are read.
 *
 * `changedNotTouched` leads because it is the one an operator would not have
 * guessed at and the only one with no surface anywhere else in the app. The
 * ordinary case — named and changed — is behind a fold: it is the diff's own
 * file list with counts attached, and the list itself is already on screen
 * directly above.
 */
const GROUPS = [
  {
    key: "changedNotTouched",
    label: "Changed, never named by a tool call",
    footnote:
      "Written by something that names no file — a Bash command, a formatter, " +
      "a codegen step — or by a call whose event has since aged out.",
    fold: false,
  },
  {
    key: "touchedAndChanged",
    label: "Named, and changed",
    footnote: null,
    fold: true,
  },
  {
    key: "touchedNotChanged",
    label: "Named, and not changed",
    footnote: "Read and never written, or edited and then reverted.",
    fold: false,
  },
  {
    key: "outsideCheckout",
    label: "Named outside the checkout",
    footnote:
      "Matched neither this run's working directory nor its folder, so the " +
      "diff can say nothing about them.",
    fold: false,
  },
] as const satisfies readonly {
  key: "changedNotTouched" | "touchedNotChanged" | "outsideCheckout" | "touchedAndChanged";
  label: string;
  footnote: string | null;
  fold: boolean;
}[];

export function RunTouches({ run, diff }: { run: RunDTO; diff: RunDiffDTO }) {
  const [touched, setTouched] = useState<RunTouchedDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetched once, on mount. Only the active tab is mounted, so opening Changes
  // is what triggers it; it is deliberately not on the page's 3-second poll,
  // because this is a scan of the busiest table in the database and its answer
  // for a settled run cannot change.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${run.id}/touched`, { cache: "no-store" });
        const json = (await res.json()) as { touched?: RunTouchedDTO };
        if (!live) return;
        if (!res.ok || !json.touched) {
          setError("Could not read what this run touched.");
          return;
        }
        setTouched(json.touched);
      } catch {
        if (live) setError("Could not read what this run touched.");
      }
    })();
    return () => {
      live = false;
    };
  }, [run.id]);

  // `path` alone, not `oldPath`: a rename's old name is a path no tool call
  // would have named, and listing it would put a file in "changed, never named"
  // that was never there under that name.
  const changed = useMemo(() => diff.files.map((f) => f.path), [diff.files]);
  const report = useMemo(
    () =>
      touched?.kind === "report" ? reconcileTouches(touched.touches, changed) : null,
    [touched, changed],
  );

  return (
    <Card className="mt-4">
      <CardTitle>What it touched</CardTitle>

      {error && <Notice tone="danger">{error}</Notice>}

      {/* The hedge belongs here and not on the rows. A tool call is recorded
          when it is made and a result only when it failed, and the failure row
          carries no id joining it back — so no row can honestly say whether its
          call worked, and a column that is wrong inside a retry loop is worse
          than one that is absent. */}
      {touched?.kind === "report" && report && (
        <p className="mb-3 text-sm text-ink-muted">
          <strong className="font-semibold tabular-nums text-ink">
            {report.distinctTouched}
          </strong>{" "}
          distinct file{report.distinctTouched === 1 ? "" : "s"} named across{" "}
          <strong className="font-semibold tabular-nums text-ink">
            {touched.cycles}
          </strong>{" "}
          work cycle{touched.cycles === 1 ? "" : "s"}. A call being recorded means
          it was <em>attempted</em>: this app stores a tool result only when the
          tool failed, so nothing here says a read or a write succeeded.
        </p>
      )}

      {/* Three ways of having nothing, kept apart, because all three otherwise
          render as a run that touched no file at all. */}
      {touched?.kind === "swept" && (
        <Notice tone="warn" quiet>
          This run&apos;s tool events were removed on the {touched.horizonDays}-day
          event horizon, so nothing here can say what it touched. Its changes are
          still above — a checkout is kept on a different clock.
        </Notice>
      )}

      {touched?.kind === "empty" && (
        <Empty>No tool call in this run&apos;s log named a file.</Empty>
      )}

      {touched?.kind === "none" && <Empty>{touched.reason}</Empty>}

      {!touched && !error && (
        <Empty>
          <span aria-busy="true">Reading this run&apos;s events…</span>
        </Empty>
      )}

      {report &&
        GROUPS.map(({ key, label, footnote, fold }) => {
          const rows = report[key];
          if (rows.length === 0) return null;
          const table = (
            <ListView box="capped">
              <TouchTable label={label} rows={rows} />
            </ListView>
          );
          return (
            <div key={key} className="mt-4">
              {fold ? (
                <Disclosure summary={label} count={rows.length}>
                  {table}
                </Disclosure>
              ) : (
                <>
                  <GroupLabel>
                    {label} ({rows.length})
                  </GroupLabel>
                  {table}
                </>
              )}
              {footnote && (
                <p className="mt-1.5 max-w-[70ch] px-1 text-xs leading-snug text-ink-muted">
                  {footnote}
                </p>
              )}
            </div>
          );
        })}
    </Card>
  );
}

function TouchTable({ label, rows }: { label: string; rows: readonly TouchedFile[] }) {
  return (
    <Table stack>
      <caption className="sr-only">{label}, most calls first</caption>
      <THead>
        <tr>
          <Th className={STICKY_HEAD}>File</Th>
          <Th num className={STICKY_HEAD}>
            Reads
          </Th>
          <Th num className={STICKY_HEAD}>
            Writes
          </Th>
          <Th className={STICKY_HEAD}>By</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map((file) => (
          <Tr key={file.path}>
            {/* No label: the path is what the record is. `break-all` below the
                breakpoint because a path has no space in it to wrap at. */}
            <Td className="max-md:break-all">
              <span className="mono">{file.path}</span>
            </Td>
            {/* An em dash rather than 0 on a row with no calls at all: the
                "changed, never named" group has no counts to report, and a
                column of zeroes there reads as a measurement. */}
            <Td num label="Reads" className={file.reads === 0 ? "text-ink-muted" : ""}>
              {file.reads === 0 && file.writes === 0 ? "—" : file.reads}
            </Td>
            <Td num label="Writes" className={file.writes === 0 ? "text-ink-muted" : ""}>
              {file.reads === 0 && file.writes === 0 ? "—" : file.writes}
            </Td>
            <Td label="By" labelPlacement="above" className="text-ink-muted">
              {file.by.length > 0 ? file.by.join(", ") : "—"}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
