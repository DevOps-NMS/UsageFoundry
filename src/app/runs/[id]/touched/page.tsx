"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type { RunDiffDTO, RunTouchStepDTO, RunTouchedDTO } from "@/lib/apiTypes";
import {
  buildTouchTree,
  planTouchedMap,
  touchedMapView,
  type MapDir,
  type MapFile,
  type PlanNode,
} from "@/lib/touchedMap";
import { placeTouches, replayFrame } from "@/lib/touchReplay";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { GroupLabel } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import {
  Fact,
  TOUCH_IDLE_SENTENCE,
  TouchHeadline,
  TouchNoDiffNotice,
  TouchSweptNotice,
} from "@/components/RunTouchNotes";
import { RunTouchedMap } from "@/components/RunTouchedMap";
import { RunTouchReplay } from "@/components/RunTouchReplay";

/**
 * Where a run's touches are, laid out by directory.
 *
 * A sub-route rather than a sixth tab or a tenth pane: `ui-density-audit.md`
 * freezes the run page's tab strip at five and bans both, and names a sub-route
 * as what replaces them for something that is a screen's worth and read rarely.
 * `activePane` matches on a path *segment*, so `/runs/<id>/touched` keeps Runs
 * highlighted in the sidebar without any of the four readers of `panes.ts`
 * learning about it.
 *
 * The one link in is on the "What it touched" card under the diff, beside the
 * table this draws — and it is the only one, because a destination reachable
 * from three places is three places to keep in step.
 *
 * Both answers are fetched once and neither is polled. The touch scan is an
 * index range over the busiest table in the database and its answer for a
 * settled run cannot change; the diff costs several git processes. This page is
 * a thing an operator opens on purpose, looks at, and leaves.
 */

/**
 * Drawn file nodes before directories start folding.
 *
 * A legibility budget rather than a performance one, and the two are nowhere
 * near each other: the knowledge graph draws 2,500 nodes on the same simulation,
 * and the measured run here named 39 files across one work cycle — an eighth of
 * this. What goes wrong at eight hundred file nodes is not the frame rate, it is
 * that no cluster is distinguishable from the one beside it, which is the same
 * failure as drawing nothing while looking like a picture.
 */
const MAX_DRAWN_FILES = 300;

type Ctx = { params: Promise<{ id: string }> };

export default function RunTouchedPage({ params }: Ctx) {
  const { id } = use(params);

  const [touched, setTouched] = useState<RunTouchedDTO | null>(null);
  const [diff, setDiff] = useState<RunDiffDTO | null>(null);
  const [sequence, setSequence] = useState<readonly RunTouchStepDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** 1-based over the touches; 0 is rest, which is the map as it is without this. */
  const [position, setPosition] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // Together rather than in sequence: no answer is derived from another,
        // and the diff is the slowest of the three by several git processes.
        const [touchRes, diffRes, seqRes] = await Promise.all([
          fetch(`/api/runs/${id}/touched`, { cache: "no-store" }),
          fetch(`/api/runs/${id}/diff`, { cache: "no-store" }),
          fetch(`/api/runs/${id}/touched/sequence`, { cache: "no-store" }),
        ]);
        const touchJson = (await touchRes.json()) as { touched?: RunTouchedDTO };
        const diffJson = (await diffRes.json()) as { diff?: RunDiffDTO };
        const seqJson = (await seqRes.json()) as { sequence?: RunTouchStepDTO[] };
        if (!live) return;
        if (!touchRes.ok || !touchJson.touched) {
          setError("Could not read what this run touched.");
          return;
        }
        setTouched(touchJson.touched);
        // A diff that failed is not an error here. The changed set is then
        // unknown rather than empty, which the map already has a state for, and
        // the touch half is the half this page exists to draw.
        setDiff(diffJson.diff ?? null);
        // Nor is a sequence that failed: the map is the page and the replay is a
        // mode over it. `null` is kept apart from an empty array on purpose —
        // one is "nobody could read the order" and the other is "there was
        // none", and a missing scrubber standing for both would be the fourth
        // way of having nothing that nothing on this page says out loud.
        setSequence(seqRes.ok && seqJson.sequence ? seqJson.sequence : null);
      } catch {
        if (live) setError("Could not read what this run touched.");
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);

  const view = useMemo(
    () => (touched ? touchedMapView(touched, diff) : null),
    [touched, diff],
  );

  const tree = useMemo(
    () => (view?.kind === "map" ? buildTouchTree(view.report) : null),
    [view],
  );

  const plan = useMemo(
    () => (tree ? planTouchedMap(tree, { budget: MAX_DRAWN_FILES, expanded }) : null),
    [tree, expanded],
  );

  // By id and never by index: expanding a fold rebuilds the plan, and a held
  // index would then select whatever had moved into that slot — a node that
  // neither throws nor draws nothing, just describes the wrong file.
  const selected = useMemo(
    () => plan?.nodes.find((node) => node.id === selectedId) ?? null,
    [plan, selectedId],
  );

  // Re-placed against every plan, which is what moves the playhead from a fold
  // onto the file behind it the moment the operator opens that fold. `position`
  // deliberately survives it: it is an index into the sequence, which no fold
  // changes.
  const placed = useMemo(
    () => (plan && sequence ? placeTouches(sequence, plan.nodes) : null),
    [plan, sequence],
  );

  const frame = useMemo(
    () =>
      plan && sequence && placed
        ? replayFrame(sequence, placed, plan.nodes, position)
        : null,
    [plan, sequence, placed, position],
  );

  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);

  const onExpand = useCallback((dirPath: string) => {
    setExpanded((current) => {
      if (current.has(dirPath)) return current;
      const next = new Set(current);
      next.add(dirPath);
      return next;
    });
  }, []);

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">What it touched</h1>
      <p className="mb-4 text-sm text-ink-muted">
        Every file this run named, positioned by where it sits in the repository.{" "}
        <Link href={`/runs/${id}`}>Back to the run</Link> for the same files as an
        ordered, searchable table.
      </p>

      {error && <Notice tone="danger">{error}</Notice>}

      {!touched && !error && (
        <Card>
          <Empty>
            <span aria-busy="true">Reading this run&apos;s events…</span>
          </Empty>
        </Card>
      )}

      {/* The three ways of having nothing, kept apart. All three otherwise draw
          an empty canvas, which reads as a run that touched no file at all. */}
      {view?.kind === "swept" && (
        <Card>
          <TouchSweptNotice horizonDays={view.horizonDays} changesAt="files-tab" />
        </Card>
      )}

      {view?.kind === "idle" && (
        <Card>
          <Empty>{TOUCH_IDLE_SENTENCE}</Empty>
        </Card>
      )}

      {view?.kind === "gone" && (
        <Card>
          <Empty>{view.reason}</Empty>
        </Card>
      )}

      {view?.kind === "map" && plan && tree && (
        <Card emphasis="primary">
          <CardTitle>Laid out by directory</CardTitle>

          <TouchHeadline
            distinctTouched={view.report.distinctTouched}
            touches={sequence?.length ?? null}
            cycles={view.cycles}
          />

          {/* The two figures on this card are different numbers and would read
              as a contradiction side by side: the headline counts what the
              *events* named, and the map positions those plus every file only
              the diff knows about. Saying which is which is cheaper than
              dropping one of them, and the second is the group the survey
              recorded a tool → file graph as unable to draw at all. */}
          {view.report.changedNotTouched.length > 0 && (
            <p className="mb-3 text-sm text-ink-muted">
              <strong className="font-semibold tabular-nums text-ink">
                {tree.files.length}
              </strong>{" "}
              file{tree.files.length === 1 ? " is" : "s are"} positioned below, because{" "}
              <strong className="font-semibold tabular-nums text-ink">
                {view.report.changedNotTouched.length}
              </strong>{" "}
              of them changed without any tool call naming{" "}
              {view.report.changedNotTouched.length === 1 ? "it" : "them"} — drawn
              hollow, and written by something that names no file.
            </p>
          )}

          {!view.changedKnown && <TouchNoDiffNotice reason={view.diffReason} shows="drawn" />}

          {view.unnamedOnly && (
            <Notice tone="warn" quiet>
              {TOUCH_IDLE_SENTENCE} Every file drawn here comes from the branch diff, so
              the map says where this run&apos;s changes landed and nothing at all about
              what it read.
            </Notice>
          )}

          {plan.folded.length > 0 && (
            <Notice tone="neutral" quiet>
              <strong>
                {plan.foldedFiles} file{plan.foldedFiles === 1 ? "" : "s"}
              </strong>{" "}
              {plan.foldedFiles === 1 ? "is" : "are"} behind {plan.folded.length} folded
              director{plan.folded.length === 1 ? "y" : "ies"}, drawn as one node each
              with the count on it. Nothing has been dropped — click a folded node to
              open it.
            </Notice>
          )}

          {sequence === null && (
            <Notice tone="warn" quiet>
              The order this run named files in could not be read, so there is no replay
              below — the map still shows every file it named.
            </Notice>
          )}

          <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <div>
              <RunTouchedMap
                plan={plan}
                changedKnown={view.changedKnown}
                selectedId={selectedId}
                dimmedIds={frame?.dimmed ?? null}
                markedId={frame?.currentId ?? null}
                onSelect={onSelect}
                onExpand={onExpand}
                className="h-[24rem] rounded-md border border-line bg-inset md:h-[30rem] lg:h-[36rem]"
              />
              {/* Never with nothing to scrub. A run whose events aged out has no
                  sequence at all and already has its own notice above; a
                  zero-step track under it would be a control saying the run did
                  nothing, which is the reading those notices exist to prevent. */}
              {frame && sequence && sequence.length > 0 && (
                <RunTouchReplay
                  steps={sequence}
                  frame={frame}
                  onPosition={setPosition}
                  className="mt-3"
                />
              )}
            </div>
            <div>
              <Legend
                changedKnown={view.changedKnown}
                replaying={frame !== null && frame.step !== null}
              />
              <Inspector node={selected} changedKnown={view.changedKnown} />
            </div>
          </div>

          <p className="mt-3 max-w-[70ch] text-xs leading-snug text-ink-muted">
            A line means <em>is in</em> — the path hierarchy, not a tool call. Which tools
            named a file is on the file, because tool&nbsp;→&nbsp;file is a star: a dozen
            hubs with nearly everything hanging off <span className="mono">Read</span>,
            drawing one fact the count above already states. The replay steps the same
            nodes in the order the calls were made; a call on a file behind a folded
            directory lands on the fold, and opening it moves the playhead onto the file.
          </p>
        </Card>
      )}
    </>
  );
}

/**
 * What each mark means, permanently on screen rather than in a tooltip.
 *
 * Four encodings on one node is three more than a reader can hold, and a
 * tooltip has no touch equivalent — which is why this app's closed vocabulary
 * refuses to put anything a reader needs inside one.
 *
 * The replay's two marks are drawn **only while it is running**, and that is the
 * same decision as `changedKnown` withholding the changed ring rather than a
 * tidiness one: eight rows is already at the edge of what a column this narrow
 * can be read as a list, and two of them standing permanently for marks nothing
 * on the canvas is currently making is a legend describing a picture that is not
 * there. They appear exactly when a node starts wearing one.
 */
function Legend({
  changedKnown,
  replaying,
}: {
  changedKnown: boolean;
  /** The scrubber is off rest, so some node is marked and others are washed. */
  replaying: boolean;
}) {
  return (
    <>
      <GroupLabel>What a node says</GroupLabel>
      <ul className="mb-4 space-y-1.5 text-xs text-ink-muted">
        <LegendRow swatch={<span className="block size-3 rounded-full bg-ink-muted" />}>
          Read, never written
        </LegendRow>
        <LegendRow swatch={<span className="block size-3 rounded-full bg-accent" />}>
          Written
        </LegendRow>
        <LegendRow
          swatch={
            <span className="flex size-3 items-center justify-center rounded-full bg-accent">
              <span className="block size-1.5 rounded-full bg-ink-muted" />
            </span>
          }
        >
          Both — read and written
        </LegendRow>
        <LegendRow
          swatch={
            <span className="block size-3 rounded-full border border-danger bg-inset" />
          }
        >
          Changed, never named by a tool call
        </LegendRow>
        {changedKnown && (
          <LegendRow
            swatch={
              <span className="block size-3 rounded-full border-2 border-ink bg-transparent" />
            }
          >
            Ringed: the branch diff lists it
          </LegendRow>
        )}
        <LegendRow
          swatch={
            <span className="block size-3 rounded-full border border-dashed border-warn bg-transparent" />
          }
        >
          Dashed: outside the checkout
        </LegendRow>
        <LegendRow
          swatch={<span className="block size-3.5 rounded-full bg-ink-muted/25 ring-1 ring-ink-muted" />}
        >
          A folded directory, sized by what is behind it
        </LegendRow>
        <LegendRow swatch={<span className="block size-3 rounded-full border border-ink-faint bg-surface" />}>
          A directory, holding the files under it
        </LegendRow>
        {replaying && (
          <>
            <LegendRow
              swatch={
                <span className="flex size-3.5 items-center justify-center rounded-full bg-tint/35">
                  <span className="block size-2 rounded-full bg-ink-muted" />
                </span>
              }
            >
              Haloed: the tool call at the playhead
            </LegendRow>
            <LegendRow
              swatch={<span className="block size-3 rounded-full bg-ink-muted opacity-20" />}
            >
              Faded: the replay has not reached it. A file the diff lists and no call
              named is never reached, which is what its hollow already says.
            </LegendRow>
          </>
        )}
      </ul>
      <p className="mb-4 max-w-[42ch] text-xs leading-snug text-ink-muted">
        A file&apos;s size is how many calls named it. Drag to pan, scroll to zoom, drag a
        node to arrange it.
      </p>
    </>
  );
}

function LegendRow({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{swatch}</span>
      <span>{children}</span>
    </li>
  );
}

/**
 * The selected node, in words.
 *
 * The canvas cannot carry a path, a tool list and an actor list at once, and
 * this is where the four groups' own vocabulary is repeated exactly — a second
 * wording for "named outside the checkout" would be a second claim.
 */
function Inspector({ node, changedKnown }: { node: PlanNode | null; changedKnown: boolean }) {
  if (!node) {
    return (
      <>
        <GroupLabel>Selected</GroupLabel>
        <Empty>Click a node to read it.</Empty>
      </>
    );
  }

  return (
    <>
      <GroupLabel>Selected</GroupLabel>
      <div className="rounded-sm border border-line bg-inset p-2.5">
        <div className="mono mb-2 break-all text-xs text-ink">
          {node.kind === "file" ? node.path : node.path === "" ? "." : node.path}
        </div>
        {node.kind === "file" && node.file ? (
          <FileFacts file={node.file} changedKnown={changedKnown} />
        ) : node.dir ? (
          // No branch for `folded`: clicking a fold opens it, and the selection
          // it leaves behind is the open directory. A row about being folded
          // could never render, which is a worse thing for it to be than absent.
          <DirFacts dir={node.dir} changedKnown={changedKnown} />
        ) : null}
      </div>
    </>
  );
}

/** The state a call log can support, and nothing past it. */
const FILE_STATE: Record<MapFile["state"], string> = {
  read: "Read, never written",
  written: "Written",
  both: "Read and written",
  unnamed: "Changed, never named by a tool call",
};

function FileFacts({ file, changedKnown }: { file: MapFile; changedKnown: boolean }) {
  return (
    <dl className="space-y-1 text-xs">
      <Fact label="Calls">{FILE_STATE[file.state]}</Fact>
      {file.state !== "unnamed" && (
        <Fact label="Counts">
          <span className="tabular-nums">{file.reads}</span> read,{" "}
          <span className="tabular-nums">{file.writes}</span> written
        </Fact>
      )}
      {file.tools.length > 0 && <Fact label="Tools">{file.tools.join(", ")}</Fact>}
      {file.by.length > 0 && <Fact label="By">{file.by.join(", ")}</Fact>}
      {file.outside ? (
        <Fact label="Diff">
          Outside the checkout, so the diff can say nothing about it
        </Fact>
      ) : changedKnown ? (
        <Fact label="Diff">{file.inDiff ? "Listed by the branch diff" : "Not changed"}</Fact>
      ) : (
        // With no diff the changed set is unknown, and "not changed" over a file
        // nobody can speak for is the claim this whole reconciliation exists to
        // check rather than to make.
        <Fact label="Diff">Unknown — there is no diff for this run</Fact>
      )}
    </dl>
  );
}

function DirFacts({ dir, changedKnown }: { dir: MapDir; changedKnown: boolean }) {
  return (
    <dl className="space-y-1 text-xs">
      <Fact label="Holds">
        <span className="tabular-nums">{dir.subtreeFiles}</span> file
        {dir.subtreeFiles === 1 ? "" : "s"}, <span className="tabular-nums">{dir.subtreeCalls}</span>{" "}
        call{dir.subtreeCalls === 1 ? "" : "s"}
      </Fact>
      <Fact label="Written">
        <span className="tabular-nums">{dir.subtreeWritten}</span> of them
      </Fact>
      {changedKnown && (
        <Fact label="In the diff">
          <span className="tabular-nums">{dir.subtreeInDiff}</span> of them
        </Fact>
      )}
      {dir.tools.length > 0 && <Fact label="Tools">{dir.tools.join(", ")}</Fact>}
    </dl>
  );
}
