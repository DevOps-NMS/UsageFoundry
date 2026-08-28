"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type { LandStateDTO } from "@/lib/apiTypes";
import { jsonRequest } from "@/lib/jsonRequest";
import {
  buildConflictTree,
  conflictMapView,
  planConflictMap,
  summariseClashes,
  type ClashDir,
  type ClashFile,
  type ClashKind,
  type ClashNode,
  type ConflictMapView,
} from "@/lib/conflictMap";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { GroupLabel } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { RunConflictMap } from "@/components/RunConflictMap";

/**
 * Where a pending merge's conflicts are, laid out by directory.
 *
 * A sub-route rather than a sixth tab or a tenth pane, for the reason
 * `/runs/[id]/touched` is one: `ui-density-audit.md` freezes the run page's tab
 * strip at five, bans both a sixth segment and a tenth pane, and names a
 * sub-route as what replaces them for something that is a screen's worth and
 * read rarely. `activePane` matches on a path *segment*, so this keeps Runs
 * highlighted in the sidebar without any of the four readers of `panes.ts`
 * learning about it.
 *
 * The one link in is on the land card's conflict section, beside the list of
 * markers — and it is the only one, because a destination reachable from three
 * places is three places to keep in step.
 *
 * **This page draws and never acts.** It reads the same `GET /api/runs/<id>/land`
 * the card polls and offers no Land, no Resolve, no Delete: the card is where
 * the decisions live and where every refusal is written, and a second surface
 * carrying the same button is a second place for the chain rules to be wrong. It
 * is also fetched exactly once and not polled — the card polls only while a
 * resolution is running, and this is a thing an operator opens on purpose, looks
 * at, and leaves.
 *
 * **It is legible at n=1 and does not pretend otherwise.** Most conflicts are a
 * handful of files, where a map of four dots is worse than the list; the count
 * and the inspector carry that case. There is deliberately no guard that hides
 * the page when the picture would be thin — a surface that sometimes refuses to
 * draw is worse than one that draws four honest dots.
 */

/**
 * Drawn file nodes before directories start folding.
 *
 * The touch map's figure, and a legibility budget rather than a performance one
 * for the same reason. A conflict this large is not something this app has
 * measured — `MAX_CONTENT_FILES` means the preview stops opening files at ten,
 * not that it stops listing them — so the budget is inherited rather than
 * guessed at downward.
 */
const MAX_DRAWN_FILES = 300;

type Ctx = { params: Promise<{ id: string }> };

export default function RunConflictsPage({ params }: Ctx) {
  const { id } = use(params);

  const [state, setState] = useState<LandStateDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await jsonRequest<{ state: LandStateDTO | null }>(`/api/runs/${id}/land`);
      if (!live) return;
      if (!res.ok) {
        // A 404 is a fact about the id in the address bar and not about the
        // merge, so it says so: "could not read the preview" over a run that
        // does not exist sends the reader back to a card that is not there.
        setError(
          res.status === 404
            ? "There is no run with that id."
            : (res.error ?? "Could not read this run's merge preview."),
        );
        setLoaded(true);
        return;
      }
      // Null is an answer here — a run that was never isolated has no branch —
      // so the flag is what tells a loaded null from a fetch still in flight.
      setState(res.data.state ?? null);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, [id]);

  const view = useMemo(() => (loaded && !error ? conflictMapView(state) : null), [
    loaded,
    error,
    state,
  ]);

  const tree = useMemo(
    () => (view?.kind === "map" ? buildConflictTree(view.files) : null),
    [view],
  );

  const totals = useMemo(() => (tree ? summariseClashes(tree.files) : null), [tree]);

  const plan = useMemo(
    () => (tree ? planConflictMap(tree, { budget: MAX_DRAWN_FILES, expanded }) : null),
    [tree, expanded],
  );

  // By id and never by index: expanding a fold rebuilds the plan, and a held
  // index would then describe whatever had moved into that slot.
  const selected = useMemo(
    () => plan?.nodes.find((node) => node.id === selectedId) ?? null,
    [plan, selectedId],
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

  const target = state?.target ?? null;

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Where the conflicts are</h1>
      <p className="mb-4 text-sm text-ink-muted">
        Every file this merge could not reconcile, positioned by where it sits in the
        repository. <Link href={`/runs/${id}`}>Back to the run</Link> for the same files
        in order, with their conflict markers — which is what resolving one needs.
      </p>

      {error && (
        <div role="alert">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}

      {!loaded && !error && (
        <Card>
          <Empty>
            <span aria-busy="true">Reading this run&apos;s merge preview…</span>
          </Empty>
        </Card>
      )}

      {/* The ways of having no conflict, kept apart. Every one of them otherwise
          draws an empty canvas, and an empty canvas reads as a merge with
          nothing wrong with it — which for three of these is false. */}
      {view && view.kind !== "map" && (
        <Card>
          {state && <Header state={state} />}
          <Nothing view={view} target={target} />
        </Card>
      )}

      {view?.kind === "map" && plan && tree && totals && state && (
        <Card emphasis="primary">
          <CardTitle>Laid out by directory</CardTitle>
          <Header state={state} />

          <p className="mb-3 text-sm text-ink-muted">
            <Count n={tree.files.length} /> file{tree.files.length === 1 ? "" : "s"}{" "}
            {tree.files.length === 1 ? "conflicts" : "conflict"},{" "}
            {totals.subtreeUnread === 0 ? (
              <>
                with <Count n={totals.subtreeClashes} /> clash
                {totals.subtreeClashes === 1 ? "" : "es"}{" "}
                {tree.files.length === 1 ? "in it" : "between them"}.
              </>
            ) : (
              <>
                with <Count n={totals.subtreeClashes} /> clash
                {totals.subtreeClashes === 1 ? "" : "es"} in the{" "}
                <Count n={tree.files.length - totals.subtreeUnread} /> this preview
                opened.
              </>
            )}{" "}
            Nothing was written to find that out — the merge was tried in memory, and
            this is how it would land.
          </p>

          {/* The load-bearing one. `land.ts` reads the merged content of a
              bounded number of files per preview; the path list past that point
              is complete and the clash counts are not. "We did not look" and
              "there are no clashes here" are different sentences, and a node
              drawn at a size nobody read would merge them silently. */}
          {totals.subtreeUnread > 0 && (
            <Notice tone="warn" quiet>
              <strong className="tabular-nums">{totals.subtreeUnread}</strong> of{" "}
              {totals.subtreeUnread === 1 ? "these files was" : "these files were"} never
              opened. The preview reads the merged content of a bounded number of files
              per load and lists the rest from git&apos;s stage records alone, so how many
              clashes {totals.subtreeUnread === 1 ? "it holds is" : "they hold are"}{" "}
              unknown rather than zero. {totals.subtreeUnread === 1 ? "It is" : "They are"}{" "}
              drawn hollow and dashed at the smallest size, and that size is not a count.
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

          <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <RunConflictMap
              plan={plan}
              selectedId={selectedId}
              onSelect={onSelect}
              onExpand={onExpand}
              className="h-[24rem] rounded-md border border-line bg-inset md:h-[30rem] lg:h-[36rem]"
            />
            <div>
              <Legend />
              <Inspector node={selected} />
            </div>
          </div>

          <p className="mt-3 max-w-[70ch] text-xs leading-snug text-ink-muted">
            A line means <em>is in</em> — the path hierarchy, and never a cause. This map
            answers where in the tree a conflict falls and nothing else; the markers
            themselves, in order and readable, are on{" "}
            <Link href={`/runs/${id}`}>the run&apos;s land card</Link>, which is where
            resolving one starts.
          </p>
        </Card>
      )}
    </>
  );
}

/** The branch and its target, in the land card's own words and order. */
function Header({ state }: { state: LandStateDTO }) {
  return (
    <div className="mb-3 text-sm tabular-nums text-ink-muted">
      <span className="mono text-ink">{state.branch}</span>
      {state.target ? (
        <>
          {" → "}
          <span className="mono text-ink">{state.target}</span>
        </>
      ) : (
        " → no recorded target"
      )}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <strong className="font-semibold tabular-nums text-ink">{n}</strong>;
}

/**
 * The several ways of having nothing to draw, each with its own sentence.
 *
 * `already-merged`, `fast-forward` and `clean` are three different true
 * statements about three different branches, and a single "nothing to show here"
 * would tell two of them something false. The last three are not empty states at
 * all — they are answers this app does not have, and a reader who takes any of
 * them for a clean merge lands work on the strength of it.
 */
function Nothing({
  view,
  target,
}: {
  view: Exclude<ConflictMapView, { kind: "map" }>;
  target: string | null;
}) {
  const into = target ? <span className="mono">{target}</span> : "its target";

  switch (view.kind) {
    case "no-branch":
      return (
        <Empty>
          This run has no branch. It did not work in an isolated checkout, or it stopped
          before one existed — so there is no merge to preview and nothing to draw.
        </Empty>
      );
    case "gone":
      // The land card's own sentence, not a second wording of it: this page
      // knows nothing about why a branch went and must not invent a reason.
      return <Empty>{view.reason}</Empty>;
    case "already-merged":
      return (
        <Empty>
          This branch is already in {into}. There is no merge left to make, so there is
          nothing here to conflict.
        </Empty>
      );
    case "fast-forward":
      return (
        <Empty>
          {into} has not moved since this branch left it, so landing is a fast-forward.
          Nothing is merged and nothing can conflict.
        </Empty>
      );
    case "clean":
      return (
        <Empty>
          Every file merges cleanly. git tried the whole merge in memory and found
          nothing to reconcile.
        </Empty>
      );
    case "unknown":
      return (
        <Notice tone="warn">
          git could not work out how this branch would merge: {view.reason} That is not
          the same as a clean merge — it is an answer this app does not have, so there is
          nothing to draw and nothing here says landing is safe.
        </Notice>
      );
    case "none-named":
      return (
        <Notice tone="warn">
          git reported a conflict and named no file, so there is nothing to position.
          That is not a clean merge either — what conflicts is read from the merge&apos;s
          stage records, and this time they could not be read.
        </Notice>
      );
  }
}

/**
 * What each mark means, permanently on screen rather than in a tooltip.
 *
 * Two encodings and one hedge is already most of what a reader can hold, and a
 * tooltip has no touch equivalent — which is why this app's closed vocabulary
 * refuses to put anything a reader needs inside one.
 */
function Legend() {
  return (
    <>
      <GroupLabel>What a node says</GroupLabel>
      <ul className="mb-4 space-y-1.5 text-xs text-ink-muted">
        <LegendRow swatch={<span className="block size-3 rounded-full bg-warn" />}>
          A content clash — both sides changed the same lines
        </LegendRow>
        <LegendRow swatch={<span className="block size-3 rounded-full bg-danger" />}>
          <span className="mono">modify/delete</span> — one side deleted the file, so
          there are no markers to read
        </LegendRow>
        <LegendRow swatch={<span className="block size-3 rounded-full bg-accent" />}>
          Another kind git named — a rename, an add/add, a binary. The inspector says
          which
        </LegendRow>
        <LegendRow swatch={<span className="block size-3 rounded-full bg-ink-muted" />}>
          git named no kind for it
        </LegendRow>
        <LegendRow
          swatch={
            <span className="block size-3 rounded-full border border-dashed border-warn bg-inset" />
          }
        >
          Dashed and hollow: its merged content was never opened, so its clash count is
          unknown — never zero
        </LegendRow>
        <LegendRow
          swatch={
            <span className="block size-3.5 rounded-full bg-ink-muted/25 ring-1 ring-ink-muted" />
          }
        >
          A folded directory, sized by how many files are behind it
        </LegendRow>
        <LegendRow
          swatch={
            <span className="block size-3 rounded-full border border-ink-faint bg-surface" />
          }
        >
          A directory, holding the files under it
        </LegendRow>
      </ul>
      <p className="mb-4 max-w-[42ch] text-xs leading-snug text-ink-muted">
        A file&apos;s size is how many clash regions git left in it. A dashed one is
        drawn at the smallest size, which is not a count. Drag to pan, scroll to zoom,
        drag a node to arrange it.
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
 * The selected node, in words — and what carries the small case.
 *
 * A conflict of four files is a picture of four dots, which is worse than the
 * list beside it; this line and the count above the map are what make the page
 * worth opening at that size, so neither is optional decoration.
 */
function Inspector({ node }: { node: ClashNode | null }) {
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
          <FileFacts file={node.file} />
        ) : node.dir ? (
          // No branch for `folded`: clicking a fold opens it, and the selection
          // it leaves behind is the open directory.
          <DirFacts dir={node.dir} />
        ) : null}
      </div>
    </>
  );
}

/** What each fill stands for, in the same words as the legend. */
const CLASH_KIND: Record<ClashKind, string> = {
  content: "Content — both sides changed the same lines",
  "modify-delete": "One side deleted the file",
  other: "Another kind git named",
  untyped: "git named no kind for it",
};

function FileFacts({ file }: { file: ClashFile }) {
  return (
    <dl className="space-y-1 text-xs">
      {/* git's own string beside this map's reading of it, because the reading
          is a four-way collapse and the operator may want the word git used. */}
      <Fact label="Kind">
        {file.type ? (
          <>
            <span className="mono">{file.type}</span> — {CLASH_KIND[file.kind]}
          </>
        ) : (
          CLASH_KIND.untyped
        )}
      </Fact>
      <Fact label="Clashes">
        {file.clashes === null ? (
          // Never "0". This file's merged content was not read, and a zero here
          // is the one sentence the whole encoding exists to avoid saying.
          "Unknown — its merged content was not opened by this preview"
        ) : file.clashes === 0 ? (
          "None — git left no conflict markers in it"
        ) : (
          <>
            <span className="tabular-nums">{file.clashes}</span> clash
            {file.clashes === 1 ? "" : "es"}
          </>
        )}
      </Fact>
      {file.message && <Fact label="git says">{file.message}</Fact>}
    </dl>
  );
}

function DirFacts({ dir }: { dir: ClashDir }) {
  return (
    <dl className="space-y-1 text-xs">
      <Fact label="Holds">
        <span className="tabular-nums">{dir.subtreeFiles}</span> conflicted file
        {dir.subtreeFiles === 1 ? "" : "s"}
      </Fact>
      <Fact label="Clashes">
        <span className="tabular-nums">{dir.subtreeClashes}</span>
        {/* A floor rather than a total whenever anything under it went unread,
            and it says which it is rather than leaving the reader to assume. */}
        {dir.subtreeUnread > 0 ? " and more — see below" : ""}
      </Fact>
      {dir.subtreeUnread > 0 && (
        <Fact label="Not opened">
          <span className="tabular-nums">{dir.subtreeUnread}</span> of them, so the count
          above is a floor
        </Fact>
      )}
      {dir.types.length > 0 && <Fact label="Kinds">{dir.types.join(", ")}</Fact>}
      {dir.subtreeUntyped > 0 && (
        <Fact label="Untyped">
          <span className="tabular-nums">{dir.subtreeUntyped}</span> git named no kind for
        </Fact>
      )}
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-muted">{children}</dd>
    </div>
  );
}
