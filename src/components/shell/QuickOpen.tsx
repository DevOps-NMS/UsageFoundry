"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RunDTO, WorkflowDTO } from "@/lib/apiTypes";
import { pollFailureMessage, shortPath } from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import { PANES } from "@/components/shell/panes";

/** Recent runs offered before anything is typed. Typing searches all of them. */
const RECENT_RUNS = 6;

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
  const [highlight, setHighlight] = useState(0);
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDTO[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Read when the sheet opens rather than on mount: this is a list of things
  // that move, and a shell component polling two routes for the life of every
  // page would be the dashboard's own cadence spent on a sheet nobody opened.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const [runsResult, workflowsResult] = await Promise.all([
        jsonRequest<{ runs: RunDTO[] }>("/api/runs"),
        jsonRequest<{ workflows: WorkflowDTO[] }>("/api/workflows"),
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

  // Whatever was typed last time is not what you want next time.
  useEffect(() => {
    if (!open) return;
    setQuery("");
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
      detail: `⌘${pane.shortcut}`,
      href: pane.href,
      haystack: pane.label.toLowerCase(),
    }));
    const runItems = runs.map((run) => ({
      key: `run:${run.id}`,
      group: "Runs",
      label: run.id.slice(0, 8),
      detail: `${run.status} · ${shortPath(run.folder, 2)}`,
      href: `/runs/${run.id}`,
      haystack: `${run.id} ${run.status} ${run.folder}`.toLowerCase(),
    }));
    const workflowItems = workflows.map((workflow) => ({
      key: `workflow:${workflow.id}`,
      group: "Workflows",
      label: workflow.name,
      detail: `${workflow.nodes.length} block${workflow.nodes.length === 1 ? "" : "s"}`,
      href: `/workflows/${workflow.id}`,
      haystack: workflow.name.toLowerCase(),
    }));

    const needle = query.trim().toLowerCase();
    if (!needle) {
      return [...paneItems, ...runItems.slice(0, RECENT_RUNS), ...workflowItems];
    }
    return [...paneItems, ...runItems, ...workflowItems].filter((item) =>
      item.haystack.includes(needle),
    );
  }, [query, runs, workflows]);

  // Clamped rather than reset: the list shrinks as the query narrows, and a
  // highlight past the end would make Return open nothing.
  const index = Math.min(highlight, Math.max(items.length - 1, 0));
  const chosen = items[index];

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
          placeholder="Pane, run id, folder, workflow"
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

      {loadError && (
        <Notice tone="warn" className="mt-3">
          {loadError} Panes are still listed.
        </Notice>
      )}

      <ul
        id={listId}
        role="listbox"
        aria-label="Results"
        className="mt-3 max-h-[min(50vh,20rem)] space-y-0.5 overflow-y-auto"
      >
        {items.map((item, i) => {
          const state: ItemState = i === index ? "highlighted" : "plain";
          const first = i === 0 || items[i - 1].group !== item.group;
          return (
            <li key={item.key}>
              {first && (
                <div className="px-2 pt-2 pb-1 text-xs font-medium text-ink-faint">
                  {item.group}
                </div>
              )}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === index}
                onClick={() => go(item)}
                onMouseMove={() => setHighlight(i)}
                className={
                  "ui-transition flex min-h-[var(--control-h)] cursor-pointer " +
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
            </li>
          );
        })}
        {items.length === 0 && (
          <li className="px-2 py-3 text-sm text-ink-faint">
            Nothing matches “{query.trim()}”
          </li>
        )}
      </ul>

      <p className="mt-3 flex items-center gap-1.5 px-1 text-xs text-ink-faint">
        <Icon name="search" size="sm" />
        Goes somewhere. Nothing here starts, approves or stops a run.
      </p>
    </Sheet>
  );
}
