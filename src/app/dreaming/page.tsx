"use client";

import { useCallback, useEffect, useState } from "react";
import type { DreamingDTO, DreamingNoteDTO, DreamingSignatureDTO } from "@/lib/apiTypes";
import { fmtDateTime, pollFailureMessage } from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText, Stat, StatSub } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { TBody, THead, Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

/**
 * What recurred, and what was written down about it.
 *
 * ## Two halves, and only one of them can be wrong
 *
 * The readout is arithmetic over this install's own transcripts: a count of
 * failures that happened on more than one day, each quoted verbatim from the
 * machine that produced it. It writes nothing, needs no configuration, and its
 * failure mode is a bug rather than a false claim in somebody's document store.
 * The ledger beside it is the record of what a nightly run wrote into the
 * operator's vault — and that half can be wrong, so it carries the provenance
 * the vault itself cannot: which night, which run, which file, and whether the
 * file is still there.
 *
 * ## Why it does not poll
 *
 * `conventions.md` asks that a poll stand down when its subject can no longer
 * move, and this pane's subject moves **once a night**. A 120-second poll
 * against a table that changes at 03:04 is 720 requests for an answer that
 * cannot have changed, and the re-arm logic that makes polling correct on the
 * runs page has nothing to key on here. So it loads on mount and offers a
 * refresh. A run that Dreaming started is watched on `/runs`, which already
 * does this properly.
 *
 * ## The three kinds of nothing
 *
 * An empty table is the wrong answer to all of them, and telling them apart is
 * most of what this page is for. Never configured is a sentence and a link to
 * Settings. Ran and wrote nothing is the *success* case for a write-on-
 * recurrence policy — six of the twenty-three measured days had no failure
 * reach a second day — and must not read as a failure. Ran and failed links to
 * the run. The nights table below carries all three, which is why it exists
 * separately from the notes.
 */

type Tab = "recurring" | "written" | "nights";

const TABS: SegmentedOption<Tab>[] = [
  { value: "recurring", label: "Recurring" },
  { value: "written", label: "Written" },
  { value: "nights", label: "Nights" },
];

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The machine's own words, in a box that scrolls rather than one that wraps
 * into a wall.
 *
 * Quoted and never described: the whole design of this feature is that the
 * transcription half is what can be trusted, so the surface that shows it does
 * not paraphrase, truncate to a single line, or prettify whitespace.
 */
function Sample({ text }: { text: string }) {
  return (
    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-inset p-2 text-2xs leading-relaxed text-ink-muted">
      {text.trim()}
    </pre>
  );
}

export default function DreamingPage() {
  const [data, setData] = useState<DreamingDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("recurring");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await jsonRequest<DreamingDTO>("/api/dreaming");
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setError(pollFailureMessage(res.status, res.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runNow = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const res = await jsonRequest<{
      outcome: string;
      reason: string | null;
      runId: string | null;
      selected: number;
    }>("/api/dreaming/run", { method: "POST" });
    if (!res.ok) {
      setNotice(pollFailureMessage(res.status, res.error) ?? "The pass could not be started.");
    } else if (res.data.outcome === "quiet") {
      setNotice("Nothing recurred that was not already written down.");
    } else if (res.data.outcome === "selected") {
      setNotice(`Started a run for ${res.data.selected} signature(s).`);
    } else {
      setNotice(res.data.reason ?? "The pass did not run.");
    }
    setBusy(false);
    await load();
  }, [load]);

  const forget = useCallback(
    async (signature: string) => {
      const res = await jsonRequest(
        `/api/dreaming/note?signature=${encodeURIComponent(signature)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setNotice(pollFailureMessage(res.status, res.error) ?? "That note could not be forgotten.");
        return;
      }
      setNotice("Forgotten here. The file in the vault is untouched.");
      await load();
    },
    [load],
  );

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold tracking-tight text-ink">Dreaming</h1>

      <Notice quiet>
        Every row here is a <strong>normalised string</strong>, not a cause. Numbers, hashes
        and path interiors are collapsed, so one problem can appear as several rows — four
        permission denials at four paths are one denial — and one row can carry many causes.
        A count is a count of strings that recurred.
      </Notice>

      {error && <Notice tone="danger" live>{error}</Notice>}
      {notice && <Notice tone="info" live>{notice}</Notice>}

      {loading && !data ? (
        <Card>
          <div className="p-4">
            <SkeletonText lines={4} />
          </div>
        </Card>
      ) : !data ? null : (
        <>
          <Summary data={data} busy={busy} onRun={runNow} onRefresh={load} />

          <Card>
            <div className="p-4">
              <CardTitle>
                <SegmentedControl
                  value={tab}
                  options={TABS}
                  onChange={setTab}
                  label="Which half to look at"
                />
              </CardTitle>

              {tab === "recurring" && <Recurring data={data} />}
              {tab === "written" && <Written data={data} onForget={forget} />}
              {tab === "nights" && <Nights data={data} />}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Summary({
  data,
  busy,
  onRun,
  onRefresh,
}: {
  data: DreamingDTO;
  busy: boolean;
  onRun: () => void;
  onRefresh: () => void;
}) {
  const share =
    data.totalInstances > 0
      ? Math.round((100 * data.recurringInstances) / data.totalInstances)
      : 0;

  return (
    <Card>
      <div className="p-4">
        <CardTitle>
          The readout
          <ButtonRow className="ml-auto">
            <Button variant="secondary" onClick={onRefresh}>
              Rescan
            </Button>
            <Button onClick={onRun} disabled={busy || !!data.refusal}>
              {busy ? "Running…" : "Run tonight's pass now"}
            </Button>
          </ButtonRow>
        </CardTitle>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Stat>{data.recurring.length}</Stat>
            <StatSub>
              signatures on {data.minDays}+ days, of {data.totalSignatures} distinct
            </StatSub>
          </div>
          <div>
            <Stat>{share}%</Stat>
            <StatSub>
              of {data.totalInstances.toLocaleString()} failures belong to one of them
            </StatSub>
          </div>
          <div>
            <Stat>{data.days.length}</Stat>
            <StatSub>days in the scanned window carried a failure</StatSub>
          </div>
          <div>
            <Stat>{data.notes.length}</Stat>
            <StatSub>notes written into the vault</StatSub>
          </div>
        </div>

        <Hint>
          Scanned {data.filesWalked.toLocaleString()} transcript files in {data.scannedInMs}
          ms, {data.filesRead.toLocaleString()} of them re-read
          {data.duplicates > 0 &&
            `, ${data.duplicates.toLocaleString()} records skipped as copies a resumed session rewrote`}
          . This scan keeps its own cache and never rides the dashboard&apos;s.
        </Hint>

        {data.refusal ? (
          <Notice tone="warn" className="mt-3">
            <strong>Nothing will be written.</strong> {data.refusal} The readout above needs
            none of that and is always available.{" "}
            <ButtonLink href="/settings">Settings</ButtonLink>
          </Notice>
        ) : (
          <Notice tone="info" quiet className="mt-3">
            A nightly pass runs at {hhmm(data.fireAtMinutes)} {data.timeZone}, writing up to{" "}
            {data.maxPerNight} note(s) into <strong>{data.vaultLabel}</strong> for failures
            seen on {data.minDays} or more separate days, under a ${data.maxCostUSD.toFixed(2)}{" "}
            ceiling.
          </Notice>
        )}
      </div>
    </Card>
  );
}

function Recurring({ data }: { data: DreamingDTO }) {
  if (data.recurring.length === 0) {
    // Not an empty list: a corpus with no repeated failure is a *good* reading,
    // and it is a different fact from an unscanned one. The counts say which.
    return (
      <Empty>
        Nothing has failed on more than {data.minDays === 1 ? "one day" : `${data.minDays - 1} day(s)`}{" "}
        in the scanned window — {data.totalSignatures.toLocaleString()} distinct failures across{" "}
        {data.days.length} day(s), none of them recurring.
      </Empty>
    );
  }

  return (
    <TableWrap>
      <Table stack>
        <THead>
          <Tr>
            <Th>What the machine said</Th>
            <Th num>Days</Th>
            <Th num>Times</Th>
            <Th>Seen on</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {data.recurring.map((r) => (
            <SignatureRow key={r.signature} row={r} />
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}

function SignatureRow({ row }: { row: DreamingSignatureDTO }) {
  return (
    <Tr>
      <Td>
        <Sample text={row.sample} />
      </Td>
      <Td num>{row.days.length}</Td>
      <Td num>{row.instances}</Td>
      <Td>
        <span className="text-xs text-ink-muted">
          {row.days[0]} → {row.days[row.days.length - 1]}
        </span>
      </Td>
      <Td>
        {row.written ? (
          <Badge tone="ok">written</Badge>
        ) : (
          <Badge tone="neutral">not written</Badge>
        )}
      </Td>
    </Tr>
  );
}

function Written({
  data,
  onForget,
}: {
  data: DreamingDTO;
  onForget: (signature: string) => void;
}) {
  if (data.notes.length === 0) {
    return (
      <Empty>
        Nothing has been written into the vault yet.
        {data.refusal ? " Writing is off." : " The next qualifying night will write the first."}
      </Empty>
    );
  }

  return (
    <TableWrap>
      {data.notesTruncated && (
        <Notice tone="warn" quiet className="mb-3">
          Showing the newest {data.noteLimit} notes. This list is the record of what this app
          has written into the vault, so a cut one is saying less than it knows.
        </Notice>
      )}
      <Table stack>
        <THead>
          <Tr>
            <Th>What it was about</Th>
            <Th>Note</Th>
            <Th>Night</Th>
            <Th>Run</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {data.notes.map((n) => (
            <NoteRow key={n.signature} row={n} onForget={onForget} />
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}

function NoteRow({
  row,
  onForget,
}: {
  row: DreamingNoteDTO;
  onForget: (signature: string) => void;
}) {
  return (
    <Tr>
      <Td>
        <Sample text={row.sample} />
        <div className="mt-1 text-2xs text-ink-faint">
          seen on {row.daysSeen} day(s), {row.instances} time(s), when it was written
        </div>
      </Td>
      <Td>
        {row.notePath ? (
          <>
            <code className="text-xs">{row.notePath}</code>
            <div className="mt-1">
              {/* Three values, never two. A vault with no version control cannot
                  tell "deleted" from "we could not look", and rendering the
                  second as the first would report a note gone that is not. */}
              {row.present === true && <Badge tone="ok">present</Badge>}
              {row.present === false && <Badge tone="warn">deleted</Badge>}
              {row.present === null && <Badge tone="neutral">cannot check</Badge>}
            </div>
          </>
        ) : (
          <span className="text-xs text-ink-faint">
            claimed, no file reported — the run may have decided it was not worth a note
          </span>
        )}
      </Td>
      <Td>
        <span className="text-xs text-ink-muted">{row.night}</span>
        <div className="text-2xs text-ink-faint">{fmtDateTime(row.writtenAt)}</div>
      </Td>
      <Td>
        {row.runId ? (
          <ButtonLink href={`/runs/${row.runId}`} variant="secondary">
            Log
          </ButtonLink>
        ) : (
          <span className="text-xs text-ink-faint">—</span>
        )}
      </Td>
      <Td>
        <Button variant="secondary" onClick={() => onForget(row.signature)}>
          Forget
        </Button>
      </Td>
    </Tr>
  );
}

function Nights({ data }: { data: DreamingDTO }) {
  if (data.nights.length === 0) {
    return (
      <Empty>
        No night has run yet.
        {data.refusal ? " Writing is off, so none will." : " The first is tonight."}
      </Empty>
    );
  }

  return (
    <TableWrap>
      {data.nightsTruncated && (
        <Notice tone="neutral" quiet className="mb-3">
          Showing the last {data.nightLimit} nights.
        </Notice>
      )}
      <Table stack>
        <THead>
          <Tr>
            <Th>Night</Th>
            <Th>What happened</Th>
            <Th num>Selected</Th>
            <Th>Run</Th>
          </Tr>
        </THead>
        <TBody>
          {data.nights.map((n) => (
            <Tr key={n.night}>
              <Td>{n.night}</Td>
              <Td>
                {/* "Quiet" is the success case for a write-on-recurrence policy
                    and is toned as one. Six of the twenty-three days measured
                    for this feature had no failure reach a second day. */}
                {n.outcome === "selected" && <Badge tone="accent">wrote</Badge>}
                {n.outcome === "quiet" && <Badge tone="ok">nothing recurred</Badge>}
                {n.outcome === "refused" && <Badge tone="warn">refused</Badge>}
                {n.outcome === "failed" && <Badge tone="danger">failed</Badge>}
                {n.reason && (
                  <div className="mt-1 text-xs text-ink-muted">{n.reason}</div>
                )}
              </Td>
              <Td num>{n.selected}</Td>
              <Td>
                {n.runId ? (
                  <ButtonLink href={`/runs/${n.runId}`} variant="secondary">
                    Log
                  </ButtonLink>
                ) : (
                  <span className="text-xs text-ink-faint">—</span>
                )}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}
