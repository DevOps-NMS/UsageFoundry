"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { BranchInventoryDTO, BranchSummaryDTO } from "@/lib/apiTypes";
import { fmtDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

/**
 * Every branch the tool has produced, in one place.
 *
 * A branch is created per *run*, not per checkout slot, so a few dozen runs
 * leave a few dozen `uf/*` refs behind — and until this page the only record of
 * which ones mattered was a run detail page you had to open one at a time.
 *
 * Not polled. Nothing here changes on its own, and each row costs a git
 * process to work out.
 */

function StateBadge({ b }: { b: BranchSummaryDTO }) {
  if (!b.exists) return <Badge>gone</Badge>;
  if (b.active) return <Badge tone="accent">still running</Badge>;
  if (b.merged) return <Badge tone="ok">merged</Badge>;
  // Squashing rewrites the commits, so git sees no ancestry — this is the only
  // thing that distinguishes "landed as one commit" from "never landed".
  if (b.landedUnchanged) return <Badge tone="ok">squashed in</Badge>;
  if (!b.target) return <Badge tone="warn">no target</Badge>;
  return <Badge tone="warn">unmerged</Badge>;
}

export default function Branches() {
  const [data, setData] = useState<BranchInventoryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/branches", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as BranchInventoryDTO);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(runId: string) {
    setBusy(runId);
    setNote(null);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/land`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (res.ok) setNote(json.message ?? "Deleted.");
      else setError(json.error ?? "Could not delete that branch.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  const branches = data?.branches ?? [];

  return (
    <>
      <h1>Branches</h1>
      <p className="lede">
        One branch per isolated run. Landing happens on the run&rsquo;s own page,
        where the merge can be previewed first — several branches is several
        merges, and each one changes the base for the next.
      </p>

      {note && <Notice tone="info">{note}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}

      {data && data.notShown > 0 && (
        <Notice tone="warn">
          <strong>{data.notShown} older branches are not listed.</strong> Working
          out how far each one is ahead costs a git call, so this page stops at
          the most recent 60.
        </Notice>
      )}

      <Card>
        <CardTitle>
          {branches.length} branch{branches.length === 1 ? "" : "es"}
          <Button
            variant="secondary"
            className="ml-auto"
            onClick={load}
            disabled={loading}
          >
            {loading ? "Reading…" : "Refresh"}
          </Button>
        </CardTitle>

        {branches.length === 0 ? (
          <Empty>
            {loading ? "Reading repositories…" : "No isolated run has made a branch yet."}
          </Empty>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Branch</Th>
                  <Th>Repository</Th>
                  <Th>Lands into</Th>
                  <Th num>Ahead</Th>
                  <Th>State</Th>
                  <Th>Created</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {branches.map((b) => (
                  <Tr key={b.branch}>
                    <Td>
                      <Link href={`/runs/${b.runId}`} className="mono">
                        {b.branch}
                      </Link>
                      <div
                        className="mt-0.5 max-w-[38ch] truncate text-xs text-ink-faint"
                        title={b.prompt}
                      >
                        {b.prompt}
                      </div>
                    </Td>
                    <Td className="mono">{b.repoLabel}</Td>
                    <Td className="mono">{b.target ?? "—"}</Td>
                    <Td num>{b.exists ? b.ahead : "—"}</Td>
                    <Td>
                      <StateBadge b={b} />
                    </Td>
                    <Td>{fmtDateTime(b.createdAt)}</Td>
                    <Td>
                      {/* Merged branches only. Deleting one with commits of its
                          own is the single action here with no undo, so it is
                          not offered at all rather than offered with a warning. */}
                      {b.exists && (b.merged || b.landedUnchanged) && !b.active ? (
                        <Button
                          variant="ghost"
                          onClick={() => remove(b.runId)}
                          disabled={busy === b.runId}
                        >
                          {busy === b.runId ? "Deleting…" : "Delete"}
                        </Button>
                      ) : (
                        <Link href={`/runs/${b.runId}`} className="text-xs">
                          open run
                        </Link>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
