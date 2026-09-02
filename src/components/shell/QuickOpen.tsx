"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  RunListDTO,
  RunListItemDTO,
  WorkflowListItemDTO,
} from "@/lib/apiTypes";
import { pollFailureMessage, shortPath } from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import { PANES } from "@/components/shell/panes";

/** Recent runs offered before anything is typed. Typing searches all of them. */
const RECENT_RUNS = 6;

/** How long after the last keystroke the route is asked. A keystroke is not a request. */
const SEARCH_SETTLE_MS = 250;

/**
 * A run, as one line: which run, then what it was asked to do.
 *
 * The id alone is what a row carried before, and it is legible only to somebody
 * who already knows which run they want. Now that the query reaches task text on
 * the server, a list of eight-character ids cannot say why a row is in it.
 *
 * Not shortened here. The row's own `truncate` cuts it visually while the whole
 * string stays in the DOM, which is the rule for anything a screen reader
 * announces — and the prompt on the wire is already clipped to
 * `MAX_LIST_PROMPT`. The whitespace collapse is only so a multi-line task reads
 * as one line where it is announced rather than where it is drawn.
 */
function runLabel(run: RunListItemDTO): string {
  const id = run.id.slice(0, 8);
  const task = run.prompt.replace(/\s+/g, " ").trim();
  return task ? `${id} · ${task}` : id;
}

interface QuickItem {
  key: string;
  group: string;
  label: string;
  detail?: string;
  href: string;
  /** Everything a query is matched against, already lowercased. */
  haystack: string;
}

type ItemState = "highlighted" | "plain";

/**
 * `highlighted` is the row Return would open, and it is the *only* thing the
 * arrow keys move — the rows are not focusable, because a listbox that moved
 * DOM focus per keystroke would take it off the field you are typing into.
 */
const ITEM: Record<ItemState, string> = {
  highlighted: "bg-tint text-tint-fg",
  plain: "text-ink hover:bg-fill-hover active:bg-fill-active",
};

const DETAIL: Record<ItemState, string> = {
  highlighted: "text-tint-fg/75",
  plain: "text-ink-faint",
};

/**
 * Go to a pane, a run or a workflow without reaching for the pointer.
 *
 * Navigation and nothing else. It cannot start a run, approve a proposal or
 * stop anything, and that is a rule about what this component is allowed to
 * be rather than a feature not yet written: a keystroke away from spending
 * money is the one thing the approval gates in this app exist to prevent, and
 * a palette is exactly where such a thing would look convenient.
 *
 * A `Sheet` rather than a bespoke overlay, so the focus trap, the top layer
 * and Esc are the browser's. The sheet's one default action is Open, which
 * makes its footer the mouse route to the same thing Return does.
 */
export function QuickOpen({
  open,
  onDismiss,
}: {
  open: boolean;
  onDismiss: () => void;
}) {
  const router = useRouter();
  const listId = useId();
  const fieldRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  // What the route has been asked, as against what is in the field. See the
  // search effect below.
  const [settled, setSettled] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [runs, setRuns] = useState<RunListItemDTO[]>([]);
  const [matches, setMatches] = useState<RunListItemDTO[]>([]);
  const [searching, setSearching] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowListItemDTO[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Held apart from `loadError` rather than written over it: a search that
  // succeeds says nothing about the workflow list that failed to load beside it,
  // and clearing one message on the other's success is how a failed read comes
  // to look like an empty one.
  const [searchError, setSearchError] = useState<string | null>(null);

  // Read when the sheet opens rather than on mount: this is a list of things
  // that move, and a shell component polling two routes for the life of every
  // page would be the dashboard's own cadence spent on a sheet nobody opened.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const [runsResult, workflowsResult] = await Promise.all([
        jsonRequest<RunListDTO>("/api/runs"),
        jsonRequest<{ workflows: WorkflowListItemDTO[] }>("/api/workflows"),
      ]);
      if (!live) return;
      const failure = !runsResult.ok ? runsResult : !workflowsResult.ok ? workflowsResult : null;
      setLoadError(
        failure ? pollFailureMessage(failure.status, failure.error) : null,
      );
      if (runsResult.ok) setRuns(runsResult.data.runs);
      if (workflowsResult.ok) setWorkflows(workflowsResult.data.workflows);
    })();
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * The typed query, answered by the route rather than by the page it cached.
   *
   * This is the whole of what quick open could not do. It held the newest
   * hundred runs and filtered *those*, so a run further back than that produced
   * an empty list — and an empty list here reads as "no such run exists" rather
   * than as "that run is on a page nothing could ask for". `?q=` matches the
   * task, the folder and the id across every row in the table.
   *
   * The unfiltered list is deliberately still the one the sheet read when it
   * opened: the six newest runs are an offer rather than an answer, and asking
   * the route for them again would be the same request a second time.
   */
  useEffect(() => {
    if (!open || !settled) return;
    let live = true;
    setSearching(true);
    void (async () => {
      const res = await jsonRequest<RunListDTO>(
        `/api/runs?q=${encodeURIComponent(settled)}`,
      );
      if (!live) return;
      setSearching(false);
      if (!res.ok) {
        setSearchError(pollFailureMessage(res.status, res.error));
        return;
      }
      setMatches(res.data.runs);
      setSearchError(null);
    })();
    return () => {
      live = false;
    };
  }, [open, settled]);

  /**
   * Whatever was typed last time is not what you want next time.
   *
   * Cleared on the way *out* rather than on the way in. React runs a
   * component's effects in the order they are declared, so a reset that sat
   * below the search effect above would land after it — and the search would
   * already have fired once for the previous visit's query, which is a request
   * for an answer this sheet is about to throw away.
   */
  useEffect(() => {
    if (open) return;
    setQuery("");
    setSettled("");
    setMatches([]);
    setSearchError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlight(0);
    // After the parent's effect has run `showModal()`, which moves focus to the
    // dialog's own autofocus target. Child effects run first in a commit, so
    // this has to wait a frame to be the last word on where focus lands.
    const frame = requestAnimationFrame(() =>
      fieldRef.current?.querySelector("input")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const items = useMemo<QuickItem[]>(() => {
    const paneItems = PANES.map((pane) => ({
      key: `pane:${pane.href}`,
      group: "Panes",
      label: pane.label,
      // `QuickItem.detail` is optional and its render site is already
      // conditional, so a row past the ninth simply draws no chip. Unguarded,
      // this printed the string "⌘undefined" beside it.
      detail: pane.shortcut ? `⌘${pane.shortcut}` : undefined,
      href: pane.href,
      haystack: pane.label.toLowerCase(),
    }));
    const needle = query.trim().toLowerCase();
    // The unfiltered list is cut to the newest few, so the heading says so —
    // a shortened list that reads like a whole one is the thing this app
    // refuses to do with a diff, a run table or a telemetry card. With
    // something typed the rows are the route's answer instead, so the heading
    // stops claiming they are the recent ones.
    const runItems = (needle ? matches : runs.slice(0, RECENT_RUNS)).map((run) => ({
      key: `run:${run.id}`,
      group: needle ? "Runs" : "Recent runs",
      label: runLabel(run),
      detail: `${run.status} · ${shortPath(run.folder, 2)}`,
      href: `/runs/${run.id}`,
      haystack: `${run.id} ${run.status} ${run.folder}`.toLowerCase(),
    }));
    const workflowItems = workflows.map((workflow) => ({
      key: `workflow:${workflow.id}`,
      group: "Workflows",
      label: workflow.name,
      detail: `${workflow.nodeCount} block${workflow.nodeCount === 1 ? "" : "s"}`,
      href: `/workflows/${workflow.id}`,
      haystack: workflow.name.toLowerCase(),
    }));

    if (!needle) {
      return [...paneItems, ...runItems, ...workflowItems];
    }
    // The runs are the route's answer to this needle and are deliberately not
    // filtered again: the server matched the whole task text, while the prompt
    // on the wire is clipped to `MAX_LIST_PROMPT`, so a match further into a
    // long task would be found there and then dropped here. Panes and workflows
    // are still matched in the client — both lists are small, whole, and already
    // in hand.
    return [
      ...paneItems.filter((item) => item.haystack.includes(needle)),
      ...runItems,
      ...workflowItems.filter((item) => item.haystack.includes(needle)),
    ];
  }, [query, runs, matches, workflows]);

  /**
   * Whether the list on screen is behind the field.
   *
   * The 250ms settle means the first keystroke of a search has an empty run list
   * that is not yet an answer, and "Nothing matches" is the one sentence this
   * component must not say while it is still asking.
   */
  const pending =
    query.trim() !== "" && (searching || query.trim() !== settled);

  // Clamped rather than reset: the list shrinks as the query narrows, and a
  // highlight past the end would make Return open nothing.
  const index = Math.min(highlight, Math.max(items.length - 1, 0));
  const chosen = items[index];

  // Grouped for display, and each item keeps its index in the flat list —
  // that index is what the arrows move and what `aria-activedescendant`
  // names, so a per-group counter would point at the wrong row.
  const groups = useMemo(() => {
    const ordered: Array<{ name: string; items: Array<{ item: QuickItem; i: number }> }> = [];
    items.forEach((item, i) => {
      const last = ordered[ordered.length - 1];
      if (last?.name === item.group) last.items.push({ item, i });
      else ordered.push({ name: item.group, items: [{ item, i }] });
    });
    return ordered;
  }, [items]);

  function go(item: QuickItem | undefined) {
    if (!item) return;
    onDismiss();
    router.push(item.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(items.length ? (index + 1) % items.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(items.length ? (index - 1 + items.length) % items.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(chosen);
    }
  }

  return (
    <Sheet
      open={open}
      onDismiss={onDismiss}
      title="Quick open"
      confirmLabel="Open"
      onConfirm={() => go(chosen)}
      confirmDisabled={!chosen}
    >
      <div ref={fieldRef}>
        <Input
          type="text"
          value={query}
          placeholder="Pane, task, run id, folder, workflow"
          aria-label="Search panes, runs and workflows"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={chosen ? `${listId}-${index}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {/* The search's own failure first, because it is the one the operator just
          caused. Both read the same either way: something could not be read, and
          the panes below are still there. */}
      {(searchError ?? loadError) && (
        <Notice tone="warn" className="mt-3">
          {searchError ?? loadError} Panes are still listed.
        </Notice>
      )}

      {/* A listbox may only contain options and groups, which rules out the
          <ul>/<li> this would otherwise be: a `listitem` between the listbox
          and its options is exactly the nesting screen readers stop announcing
          a position in. The heading is aria-hidden because the group already
          carries the same word as its label. */}
      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        className="mt-3 max-h-[min(50vh,20rem)] overflow-y-auto"
      >
        {groups.map((group) => (
          <div key={group.name} role="group" aria-label={group.name}>
            <div
              aria-hidden
              className="px-2 pt-2 pb-1 text-xs font-medium text-ink-faint"
            >
              {group.name}
            </div>
            {group.items.map(({ item, i }) => {
              const state: ItemState = i === index ? "highlighted" : "plain";
              return (
                <div
                  key={item.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === index}
                  onClick={() => go(item)}
                  onMouseMove={() => setHighlight(i)}
                  className={
                    // A row is the whole control here — the click navigates and
                    // the Open button is a formality — so it takes the 44px
                    // target below the breakpoint that every other tappable
                    // row in the shell does. See Sidebar's pane link.
                    "ui-transition mt-0.5 flex min-h-[var(--control-h)] max-md:min-h-11 cursor-pointer " +
                    `items-center gap-2 rounded-[6px] px-2 text-sm ${ITEM[state]}`
                  }
                >
                  <span className="truncate">{item.label}</span>
                  {item.detail && (
                    <span className={`ml-auto truncate text-xs ${DETAIL[state]}`}>
                      {item.detail}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {items.length === 0 && (
          <p className="px-2 py-3 text-sm text-ink-faint">
            {pending ? "Searching…" : `Nothing matches “${query.trim()}”`}
          </p>
        )}
      </div>

      {/* Not an explanation of the control — a fact about it the operator
          cannot see, in an app where most lists of runs have a button that
          spends money beside them. */}
      <p className="mt-3 flex items-center gap-1.5 px-1 text-xs text-ink-faint">
        <Icon name="search" size="sm" />
        Navigation only — nothing here starts, approves or stops a run
      </p>
    </Sheet>
  );
}
