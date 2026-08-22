"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  KnowledgeBrokenLinkDTO,
  KnowledgeBrowseDTO,
  KnowledgeEdgeDTO,
  KnowledgeHealthDTO,
  KnowledgeNoteDTO,
  KnowledgeNoteRefDTO,
  KnowledgeSortDTO,
  KnowledgeStatusDTO,
} from "@/lib/apiTypes";
import { fmtDateTime, pollFailureMessage } from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { KnowledgeGraphView } from "@/components/KnowledgeGraphView";
import { Markdown, type Wikilink, type WikilinkResolution } from "@/components/Markdown";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText, Stat, StatSub } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { ListView, STICKY_HEAD } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/Table";

/**
 * The mounted knowledge base: browse it, read a note, follow its links, and see
 * what is wrong with it.
 *
 * **Read-only, and it says so on the page.** There is no write endpoint under
 * `/api/knowledge` and no control here that could reach one. The vault is a
 * store somebody edits in Obsidian, usually while a run is working in it, and
 * an app that could half-edit it from a second place is one nobody could trust
 * either half of. Everything this page finds — a broken link, a note with no
 * frontmatter — is reported with enough to go and fix it there: the note, the
 * target that failed and the line it was written on.
 *
 * ## Why the note is state and the URL follows it
 *
 * Following a wikilink has to be undoable with Back, or a reader five links
 * deep leaves the page to get out. So the selected note lives in the query
 * string, written with the native history API — which Next supports for a
 * same-route URL — rather than through `useSearchParams`, which would put this
 * whole page behind a Suspense boundary purely to read one optional parameter.
 * That is the same trade `/runs/new` records at its `window.location.search`.
 *
 * Every link to a note on this page is a real `<a href>`, and one delegated
 * handler on the wrapper turns an unmodified left click into a state change.
 * One mechanism covers the list, the backlinks, the health rows and the
 * `[[wikilinks]]` inside a note body — and because the href is real, ⌘-click
 * still opens a second note in a second tab, which is the only way this page
 * offers to hold two notes at once.
 */

const NOTE_HREF = "/knowledge?note=";

function noteHref(path: string): string {
  return `${NOTE_HREF}${encodeURIComponent(path)}`;
}

/**
 * The note a same-page anchor addresses, or `null` for an anchor that is not
 * one. Parsed through `URL` rather than `decodeURIComponent`, which throws on a
 * malformed escape — inside a click handler that is a page that stops
 * responding rather than a link that does nothing.
 */
function notePathOf(href: string | null): string | null {
  if (!href || !href.startsWith(NOTE_HREF)) return null;
  return new URL(href, window.location.origin).searchParams.get("note");
}

const SORT_OPTIONS: readonly SegmentedOption<KnowledgeSortDTO>[] = [
  { value: "title", label: "Title" },
  { value: "updated", label: "Updated" },
  { value: "links", label: "Links" },
];

/** Frontmatter is shown as it was written, so a value renders as its own text. */
function frontmatterValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  }
  return JSON.stringify(value) ?? String(value);
}

export default function KnowledgePage() {
  const [status, setStatus] = useState<KnowledgeStatusDTO | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [folder, setFolder] = useState("");
  const [tag, setTag] = useState("");
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<KnowledgeSortDTO>("title");
  const [offset, setOffset] = useState(0);

  // The query the *server* is asked for, which trails the box by a beat. 759
  // notes is a request per keystroke otherwise, and the answers then race each
  // other into the list.
  const [settledQuery, setSettledQuery] = useState("");

  const [browse, setBrowse] = useState<KnowledgeBrowseDTO | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<KnowledgeNoteDTO | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);

  const [health, setHealth] = useState<KnowledgeHealthDTO | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  /* ------------------------------- the vault ------------------------------ */

  const loadStatus = useCallback(async () => {
    const res = await jsonRequest<KnowledgeStatusDTO>("/api/knowledge/status");
    if (!res.ok) {
      setStatusError(pollFailureMessage(res.status, res.error));
      return;
    }
    setStatus(res.data);
    setStatusError(null);
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const available = status?.configured === true && status.available;

  /* ------------------------------ the browse ------------------------------ */

  const loadBrowse = useCallback(async () => {
    setBrowseLoading(true);
    const params = new URLSearchParams({ sort, offset: String(offset) });
    if (folder) params.set("folder", folder);
    if (tag) params.set("tag", tag);
    if (type) params.set("type", type);
    if (settledQuery) params.set("q", settledQuery);

    const res = await jsonRequest<KnowledgeBrowseDTO>(`/api/knowledge/notes?${params}`);
    setBrowseLoading(false);
    if (!res.ok) {
      setBrowseError(pollFailureMessage(res.status, res.error));
      return;
    }
    setBrowse(res.data);
    setBrowseError(null);
  }, [folder, tag, type, settledQuery, sort, offset]);

  useEffect(() => {
    if (!available) return;
    void loadBrowse();
  }, [available, loadBrowse]);

  const loadHealth = useCallback(async () => {
    const res = await jsonRequest<KnowledgeHealthDTO>("/api/knowledge/health");
    if (!res.ok) {
      setHealthError(pollFailureMessage(res.status, res.error));
      return;
    }
    setHealth(res.data);
    setHealthError(null);
  }, []);

  useEffect(() => {
    if (!available) return;
    void loadHealth();
  }, [available, loadHealth]);

  /* ------------------------- the note, and the URL ------------------------ */

  useEffect(() => {
    const read = () => setSelected(new URLSearchParams(window.location.search).get("note"));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  useEffect(() => {
    if (!selected) {
      setNote(null);
      setNoteError(null);
      return;
    }
    // The one place on this page that needs a liveness flag: a reader clicking
    // through wikilinks issues a read per click, and without this a slow answer
    // for the note they left replaces the one they are on.
    let live = true;
    setNoteLoading(true);
    void (async () => {
      const res = await jsonRequest<KnowledgeNoteDTO>(
        `/api/knowledge/note?path=${encodeURIComponent(selected)}`,
      );
      if (!live) return;
      setNoteLoading(false);
      if (!res.ok) {
        setNote(null);
        setNoteError(pollFailureMessage(res.status, res.error));
        return;
      }
      setNote(res.data);
      setNoteError(null);
    })();
    return () => {
      live = false;
    };
  }, [selected]);

  const openNote = useCallback((path: string | null) => {
    window.history.pushState(null, "", path ? noteHref(path) : "/knowledge");
    setSelected(path);
  }, []);

  const onNavigate = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // The modified clicks stay the browser's: ⌘-click into a new tab is how a
      // reader keeps two notes open, and this page has no second pane to offer.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as HTMLElement).closest("a");
      const path = notePathOf(anchor?.getAttribute("href") ?? null);
      if (!path) return;
      event.preventDefault();
      openNote(path);
    },
    [openNote],
  );

  /**
   * A wikilink in the open note's body, answered from the edges the indexer
   * already drew for that note.
   *
   * Resolved here rather than in `Markdown` because the vault is what resolves
   * it, and the renderer is also what draws model-written text that has no
   * vault behind it. The three answers are the three the edge carries.
   */
  const byTarget = useMemo(() => {
    const map = new Map<string, KnowledgeEdgeDTO>();
    for (const edge of note?.outgoing ?? []) map.set(edge.target.toLowerCase(), edge);
    return map;
  }, [note]);

  const resolveWikilink = useCallback(
    (link: Wikilink): WikilinkResolution => {
      // `[[#Heading]]` addresses this note. The indexer records no edge for it,
      // which is not the same thing as a link to nowhere.
      if (!link.target) return { kind: "other" };
      const edge = byTarget.get(link.target.toLowerCase());
      if (!edge) return { kind: "missing" };
      if (edge.toNotePath) return { kind: "note", href: noteHref(edge.toNotePath) };
      return edge.resolved ? { kind: "other" } : { kind: "missing" };
    },
    [byTarget],
  );

  /* ------------------------------- filtering ------------------------------ */

  function refilter(apply: () => void) {
    apply();
    // A filter change lands on the first page. Keeping the offset would answer
    // a narrower filter with an empty page, which reads as "nothing matches".
    setOffset(0);
  }

  const shown = browse?.notes ?? [];
  const filtered = folder !== "" || tag !== "" || type !== "" || settledQuery !== "";

  if (statusError) {
    return (
      <>
        <PageHead />
        <div role="alert">
          <Notice tone="danger">{statusError}</Notice>
        </div>
      </>
    );
  }

  if (status && !available) {
    return (
      <>
        <PageHead />
        <Notice tone="warn" quiet>
          {status.error ?? "No knowledge base is configured."}
        </Notice>
        <ButtonRow className="mt-4">
          <ButtonLink href="/settings#knowledge">Open Settings</ButtonLink>
        </ButtonRow>
      </>
    );
  }

  return (
    // One delegated handler for every note link on the page — the list, the
    // backlinks, the health rows and the wikilinks inside a body.
    <div onClick={onNavigate}>
      <PageHead mount={status} />

      <div role="alert">
        {browseError && <Notice tone="danger">{browseError}</Notice>}
        {healthError && <Notice tone="danger">{healthError}</Notice>}
      </div>

      {browse?.truncated && (
        <Notice tone="warn" quiet className="mb-4">
          The vault walk hit its cap, so every figure on this page is a floor
          rather than a total.
        </Notice>
      )}

      {/* --------------------------- browse --------------------------- */}
      <div className="mb-8">
        <CardTitle>
          Notes
          {browse && <Badge tone="neutral">{browse.total}</Badge>}
        </CardTitle>

        {/* Each `Field`'s own `mb-3.5` is the row gap, so this row states only
            the horizontal one. A `mb-0` at these call sites would be a silent
            no-op: two margin utilities on one element resolve by stylesheet
            order, and `mb-3.5` is emitted after `mb-0` whatever the caller
            wrote. The segmented control gets the same margin by hand. */}
        <div className="mb-1 flex flex-wrap items-end gap-x-4">
          {/* The width is on each wrapper, never on the control: `Select` and
              `Input` already carry `w-full`, and two width utilities on one
              element resolve by stylesheet order rather than by what the caller
              wrote — the rule `Field` states at the top of its own file. */}
          <Field label="Search" htmlFor="kb-q">
            <div className="w-[26ch] max-w-full">
              <Input
                id="kb-q"
                type="search"
                value={query}
                placeholder="Title, alias or path"
                onChange={(e) => refilter(() => setQuery(e.target.value))}
              />
            </div>
          </Field>

          <Field label="Folder" htmlFor="kb-folder">
            <div className="w-[30ch] max-w-full">
              <Select
                id="kb-folder"
                value={folder}
                onChange={(e) => refilter(() => setFolder(e.target.value))}
              >
                <option value="">Every folder</option>
                {(browse?.folders ?? []).map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.value} ({f.count})
                  </option>
                ))}
              </Select>
            </div>
          </Field>

          <Field label="Tag" htmlFor="kb-tag">
            <div className="w-[26ch] max-w-full">
              <Select
                id="kb-tag"
                value={tag}
                onChange={(e) => refilter(() => setTag(e.target.value))}
              >
                <option value="">Every tag</option>
                {(browse?.tags ?? []).map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.value} ({t.count})
                  </option>
                ))}
              </Select>
            </div>
          </Field>

          {/* Offered only where the vault classifies its notes. An empty picker
              beside three full ones reads as a filter that is broken rather
              than as a property nobody wrote. */}
          {(browse?.types.length ?? 0) > 0 && (
            <Field label="Type" htmlFor="kb-type">
              <div className="w-[22ch] max-w-full">
                <Select
                  id="kb-type"
                  value={type}
                  onChange={(e) => refilter(() => setType(e.target.value))}
                >
                  <option value="">Every type</option>
                  {(browse?.types ?? []).map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.value} ({t.count})
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
          )}

          <div className="mb-3.5">
            <SegmentedControl
              options={SORT_OPTIONS}
              value={sort}
              onChange={(next) => refilter(() => setSort(next))}
              label="Order the notes by"
            />
          </div>
        </div>

        <Card emphasis="default">
          {!browse ? (
            <div aria-busy="true">
              <span className="sr-only">Reading the vault…</span>
              <SkeletonText lines={5} />
            </div>
          ) : shown.length === 0 ? (
            <Empty>
              {filtered
                ? "No note matches those filters."
                : "The vault has no notes in it."}
            </Empty>
          ) : (
            <ListView box="capped">
              <Table stack>
                <THead>
                  <Tr>
                    <Th scope="col" className={STICKY_HEAD}>
                      Note
                    </Th>
                    <Th scope="col" className={STICKY_HEAD}>
                      Folder
                    </Th>
                    <Th scope="col" className={STICKY_HEAD}>
                      Tags
                    </Th>
                    <Th scope="col" num className={STICKY_HEAD}>
                      Links
                    </Th>
                    <Th scope="col" className={STICKY_HEAD}>
                      Updated
                    </Th>
                  </Tr>
                </THead>
                <TBody>
                  {shown.map((entry) => (
                    <Tr key={entry.path}>
                      {/* The record's headline, so deliberately no `label`. */}
                      <Td>
                        <a href={noteHref(entry.path)} className={NOTE_LINK}>
                          {entry.title}
                        </a>
                        {entry.type && (
                          <span className="ml-2 text-xs text-ink-muted">{entry.type}</span>
                        )}
                      </Td>
                      <Td label="Folder" labelPlacement="above" className="text-ink-muted">
                        {entry.folder || "—"}
                      </Td>
                      <Td label="Tags" labelPlacement="above" className="text-ink-muted">
                        {entry.tags.length > 0 ? entry.tags.join(" ") : "—"}
                      </Td>
                      <Td label="Links" num className="whitespace-nowrap">
                        {entry.inDegree + entry.outDegree}
                      </Td>
                      <Td label="Updated" className="whitespace-nowrap text-ink-muted">
                        {fmtDateTime(entry.updatedAt)}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </ListView>
          )}

          {browse && browse.total > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="text-sm tabular-nums text-ink-muted">
                {browse.offset + 1}–{browse.offset + shown.length} of {browse.total}
              </span>
              <ButtonRow className="ml-auto">
                <Button
                  variant="secondary"
                  disabled={browseLoading || browse.offset === 0}
                  onClick={() => setOffset(Math.max(0, browse.offset - browse.limit))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={browseLoading || browse.offset + browse.limit >= browse.total}
                  onClick={() => setOffset(browse.offset + browse.limit)}
                >
                  Next
                </Button>
              </ButtonRow>
            </div>
          )}
        </Card>
      </div>

      {/* ---------------------------- the note ---------------------------- */}
      {selected && (
        <div className="mb-8">
          <CardTitle>
            {note?.title ?? "Note"}
            <Button variant="ghost" size="compact" onClick={() => openNote(null)}>
              Close
            </Button>
          </CardTitle>
          <p className="sr-only" aria-live="polite">
            {note ? `Reading ${note.title}` : ""}
          </p>

          {noteError ? (
            <div role="alert">
              <Notice tone="warn">{noteError}</Notice>
            </div>
          ) : !note ? (
            <Card emphasis="default">
              <div aria-busy="true">
                <span className="sr-only">Reading the note…</span>
                <SkeletonText lines={6} />
              </div>
            </Card>
          ) : (
            // The links sit *beside* the note above `lg` and under it below,
            // which is the one place on this page that needs two columns: a
            // backlink is context for what you are reading, not a second page.
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
              <Card emphasis="default" className={noteLoading ? "opacity-60" : ""}>
                <p className="mb-3 font-mono text-xs text-ink-muted [overflow-wrap:anywhere]">
                  {note.path}
                </p>

                {Object.keys(note.frontmatter).length > 0 ? (
                  <dl className="mb-4 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-line pb-4 text-sm">
                    {Object.entries(note.frontmatter).map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="truncate font-mono text-xs text-ink-muted">{key}</dt>
                        <dd className="[overflow-wrap:anywhere]">{frontmatterValue(value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <Hint tone="warn" className="mb-4">
                    This note has no frontmatter
                  </Hint>
                )}

                <Markdown text={note.body} resolveWikilink={resolveWikilink} />
              </Card>

              <div>
                <LinkList
                  title="Links out"
                  edges={note.outgoing}
                  empty="This note links to nothing."
                />
                <LinkList
                  title="Backlinks"
                  edges={note.incoming}
                  empty="Nothing links here."
                  className="mt-4"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------------------------- the graph ---------------------------- */}
      {/*
        `openNote` is the same door the list, the backlinks and every wikilink
        already go through, so a click on a node lands in the reader above with
        Back still working.

        The graph deliberately does *not* read this page's four browse filters,
        which an earlier note here expected it to. Its own search and toggles
        are the ones Obsidian's graph view has, over the whole vault; a graph
        silently showing only the twenty notes the list happened to be filtered
        to would be a second view that disagrees with the first about what is in
        the vault. See the note at the top of `KnowledgeGraphView`.
      */}
      <KnowledgeGraphView notePath={selected} onOpenNote={openNote} />

      {/* ---------------------------- the health --------------------------- */}
      <div className="mb-8">
        <CardTitle>Health</CardTitle>
        <p className="mb-3 max-w-[68ch] text-sm text-ink-muted">
          Three absences a browse list cannot show. Each is fixed in Obsidian —
          nothing here changes the vault.
        </p>

        {!health ? (
          <Card emphasis="default">
            <div aria-busy="true">
              <span className="sr-only">Reading the vault's health…</span>
              <SkeletonText lines={3} />
            </div>
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            <HealthCard
              title="Broken links"
              count={health.brokenLinkCount}
              shown={health.brokenLinks.length}
              listLimit={health.listLimit}
              sub={`across ${health.noteCount} notes`}
              empty="Every link in the vault resolves."
            >
              <Table stack>
                <THead>
                  <Tr>
                    <Th scope="col" className={STICKY_HEAD}>
                      Written in
                    </Th>
                    <Th scope="col" className={STICKY_HEAD}>
                      Target
                    </Th>
                    <Th scope="col" num className={STICKY_HEAD}>
                      Line
                    </Th>
                  </Tr>
                </THead>
                <TBody>
                  {health.brokenLinks.map((broken, i) => (
                    <Tr key={brokenKey(broken, i)}>
                      <Td>
                        <a href={noteHref(broken.from)} className={NOTE_LINK}>
                          {broken.fromTitle}
                        </a>
                      </Td>
                      <Td label="Target" labelPlacement="above" className="text-warn">
                        {broken.target}
                      </Td>
                      <Td label="Line" num className="whitespace-nowrap">
                        {broken.line}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </HealthCard>

            <HealthCard
              title="Orphans"
              count={health.orphanCount}
              shown={health.orphans.length}
              listLimit={health.listLimit}
              sub="joined to no other note"
              empty="Every note is joined to another."
            >
              <NoteRefTable notes={health.orphans} />
            </HealthCard>

            <HealthCard
              title="No frontmatter"
              count={health.missingFrontmatterCount}
              shown={health.missingFrontmatter.length}
              listLimit={health.listLimit}
              sub={`of ${health.noteCount} notes`}
              empty="Every note has a frontmatter block."
            >
              <NoteRefTable notes={health.missingFrontmatter} />
            </HealthCard>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/**
 * Same utilities as `Markdown`'s own links rather than an import of them: that
 * file states, at the top, that it has no local imports, and exporting its
 * class string to be pulled in the other direction would be the same coupling
 * written backwards.
 */
const NOTE_LINK =
  "text-accent underline decoration-accent/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-accent";

function PageHead({ mount }: { mount?: KnowledgeStatusDTO | null }) {
  const where = mount?.mountLabel
    ? `${mount.mountLabel}${mount.subpath ? `/${mount.subpath}` : ""}`
    : null;
  return (
    <div className="mb-6">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Knowledge</h1>
      <p className="max-w-[68ch] text-ink-muted">
        The Obsidian vault this install is pointed at{where ? ` — ${where}` : ""}.{" "}
        <strong className="font-semibold text-ink">Read-only:</strong> nothing on this
        page writes to it, so a fix belongs in Obsidian.
      </p>
    </div>
  );
}

/** A count worth acting on, and the rows behind it. */
function HealthCard({
  title,
  count,
  shown,
  listLimit,
  sub,
  empty,
  children,
}: {
  title: string;
  count: number;
  shown: number;
  listLimit: number;
  sub: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <Card emphasis={count > 0 ? "default" : "quiet"}>
      <CardTitle>{title}</CardTitle>
      <Stat>{count}</Stat>
      <StatSub>{sub}</StatSub>
      {count === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <div className="mt-3">
          <ListView box="capped">{children}</ListView>
          {shown < count && (
            <Hint className="mt-2">
              Showing the first {listLimit}. The count above is the whole figure
            </Hint>
          )}
        </div>
      )}
    </Card>
  );
}

function NoteRefTable({ notes }: { notes: KnowledgeNoteRefDTO[] }) {
  return (
    <Table stack>
      <THead>
        <Tr>
          <Th scope="col" className={STICKY_HEAD}>
            Note
          </Th>
          <Th scope="col" className={STICKY_HEAD}>
            Folder
          </Th>
        </Tr>
      </THead>
      <TBody>
        {notes.map((ref) => (
          <Tr key={ref.path}>
            <Td>
              <a href={noteHref(ref.path)} className={NOTE_LINK}>
                {ref.title}
              </a>
            </Td>
            <Td label="Folder" labelPlacement="above" className="text-ink-muted">
              {ref.folder || "—"}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

/**
 * One direction of a note's links.
 *
 * A link that resolves to nothing is drawn here the way `Markdown` draws it in
 * the body — marked, not hidden — because this list is the other place an
 * operator meets one, and two renderings of the same fact is how a vault comes
 * to look healthier in one panel than in another.
 *
 * The rows are capped and the badge is not. A hub note in the vault this was
 * measured against has 782 backlinks, and `capped` releases its height below
 * `md` for the reason `ListView` records — so an uncapped list is a 782-item
 * flat column on a phone, and the count that mattered is at the top of it. The
 * cap is stated on the page rather than implied, because a silently shortened
 * list reads as the whole one.
 */
const LINK_ROWS = 100;

function LinkList({
  title,
  edges,
  empty,
  className = "",
}: {
  title: string;
  edges: KnowledgeEdgeDTO[];
  empty: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <CardTitle>
        {title}
        {edges.length > 0 && <Badge tone="neutral">{edges.length}</Badge>}
      </CardTitle>
      <Card emphasis="quiet">
        {edges.length === 0 ? (
          <Empty>{empty}</Empty>
        ) : (
          <ListView box="capped">
            <ul className="flex flex-col gap-1.5 p-2 text-sm">
              {edges.slice(0, LINK_ROWS).map((edge, i) => (
                // The index is in the key because nothing else is unique: a
                // note may write the same link twice on one line, and this
                // list never reorders — it is rebuilt whole per note.
                <li key={`${edge.from}:${edge.target}:${edge.line}:${i}`} className="min-w-0">
                  {edge.toNotePath ? (
                    <a href={noteHref(edge.toNotePath)} className={NOTE_LINK}>
                      {edge.label ?? edge.target}
                    </a>
                  ) : (
                    <span
                      className={
                        edge.resolved
                          ? "text-ink-muted [overflow-wrap:anywhere]"
                          : "text-warn underline decoration-dotted decoration-warn underline-offset-2 [overflow-wrap:anywhere]"
                      }
                    >
                      {edge.label ?? edge.target}
                      {!edge.resolved && <span className="sr-only"> — broken link</span>}
                    </span>
                  )}
                  {edge.heading && (
                    <span className="text-ink-muted"> › {edge.heading}</span>
                  )}
                </li>
              ))}
            </ul>
          </ListView>
        )}
        {edges.length > LINK_ROWS && (
          <Hint className="mt-2">
            Showing the first {LINK_ROWS} of {edges.length}
          </Hint>
        )}
      </Card>
    </div>
  );
}

/**
 * A note can write the same dangling link twice on one line — a template with
 * two of the same placeholder does exactly that — so the position is part of
 * the key. Safe here because this list is rebuilt whole and never reorders.
 */
function brokenKey(broken: KnowledgeBrokenLinkDTO, index: number): string {
  return `${broken.from}:${broken.line}:${broken.target}:${index}`;
}
