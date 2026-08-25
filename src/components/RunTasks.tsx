"use client";

import { useMemo } from "react";
import type { RunEventDTO } from "@/lib/apiTypes";
import { fmtDuration, type BadgeTone } from "@/lib/format";
import { runTasks, type RunTask, type RunTaskState } from "@/lib/runTasks";
import { Badge } from "@/components/ui/Badge";
import { Disclosure } from "@/components/ui/Disclosure";
import { ListView } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/Table";

/**
 * What the run backgrounded, over the log.
 *
 * The events are the ones already in the page's own state — `runTasks` reads
 * them and nothing here fetches, polls or opens a route. That is also why it
 * sits outside the log's scroll container and above its filter: a task's state
 * is the header a reader keeps, not a line they scroll past, and the Find/Show
 * boxes narrow the feed rather than this.
 *
 * A run that backgrounded nothing renders nothing at all. The log tab is the
 * first thing an operator opens on every run, and an empty box saying so on
 * each of them costs more than the panel is worth on the few that have one.
 */

/**
 * Complete class lookup per state, never interpolated — the reason `Badge`'s own
 * map gives.
 *
 * `stopped` is neutral rather than a warning: it is what the CLI reports when a
 * backgrounded task was left behind rather than when it went wrong, and the run
 * that stopped waiting is the subject of the page above. `ended` is a status
 * word this app has not read, so it gets the tone that claims least.
 */
const STATE_TONE: Record<RunTaskState, BadgeTone> = {
  running: "accent",
  completed: "ok",
  stopped: "neutral",
  killed: "warn",
  ended: "neutral",
};

/** The CLI's own word wherever this app does not have one of its own. */
function stateLabel(task: RunTask): string {
  return task.state === "ended" ? (task.statusWord ?? "ended") : task.state;
}

/**
 * How long it ran, and an em dash wherever that is not a measurement.
 *
 * Three separate things land on the dash and all three are "we cannot say":
 * a task recovered from a snapshot, whose start this page never saw; an ending
 * that carried no instant; and a task the log never reported the end of, on a
 * run that has since stopped — where a clock still counting up would be this
 * app timing something it has no reason to believe is still going.
 */
function ranFor(task: RunTask, now: number, active: boolean): string {
  if (task.startedAt === null) return "—";
  if (task.state === "running") {
    return active ? fmtDuration(Math.max(0, now - task.startedAt)) : "—";
  }
  if (task.endedAt === null) return "—";
  return fmtDuration(Math.max(0, task.endedAt - task.startedAt));
}

export function RunTasks({
  events,
  /**
   * How many events the replay never sent. Non-zero means this list may be
   * short a task, and saying so is the whole reason the prop is here.
   */
  droppedEvents,
  /** The run can still produce events, so a running task can still be running. */
  active,
  now,
}: {
  events: readonly RunEventDTO[];
  droppedEvents: number;
  active: boolean;
  now: number;
}) {
  const tasks = useMemo(() => runTasks(events), [events]);

  if (tasks.length === 0) return null;

  const running = tasks.filter((t) => t.state === "running").length;
  // Stated in the past tense on purpose: on a stopped run these are tasks whose
  // ending never reached the log, which is a different fact from one still
  // going, and the badge alone would be read as the second.
  const unfinished = active ? 0 : running;

  return (
    <>
      {/* Above the fold rather than inside it, because the caveat has to be
          visible wherever the count is: "(3)" over a replay that was cut is a
          complete list as far as anyone reading it can tell. `quiet` for the
          reason `Notice` documents — once a replay has been cut this never
          goes away again, so it is standing context and not an alert. */}
      {droppedEvents > 0 && (
        <Notice tone="warn" quiet>
          {droppedEvents.toLocaleString()} earlier events never reached this
          page, so a task that started in them is missing here.
        </Notice>
      )}

      {/* Evidence, which is what a fold is for here — and open while anything
          is running, because a live background task is not the some-users case
          the fold exists to tuck away. `Disclosure` reads this once, at mount,
          so nothing below can close it under a reader who opened it. */}
      <Disclosure
        summary="Background tasks"
        count={tasks.length}
        defaultOpen={running > 0}
        className="mb-3"
      >
        <ListView box="capped" className="mt-2">
          <Table stack>
            <caption className="sr-only">
              Background tasks this run started, oldest first
            </caption>
            <THead>
              <Tr>
                <Th>Task</Th>
                <Th>Kind</Th>
                <Th>State</Th>
                <Th num>Ran for</Th>
              </Tr>
            </THead>
            <TBody>
              {tasks.map((task) => (
                <Tr key={task.id}>
                  {/* The headline the row is identified by, so no stacked
                      label — and the id is the fallback rather than a word
                      like "task", because it is what the log below calls it.
                      The notification's `summary` is deliberately not drawn
                      beside it: on every payload seen it repeats the
                      description, and a second line per row would double the
                      panel to restate it. */}
                  <Td>
                    {task.description ?? (
                      <span className="mono text-ink-muted">{task.id}</span>
                    )}
                  </Td>
                  <Td label="Kind">
                    {task.taskType ? (
                      // Verbatim: `local_bash` and `local_agent` are the CLI's
                      // words, a backgrounded shell and a backgrounded agent
                      // are not the same row, and a friendlier label would be
                      // this app renaming something it does not own.
                      <span className="mono">{task.taskType}</span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td label="State">
                    <Badge tone={STATE_TONE[task.state]}>
                      {stateLabel(task)}
                    </Badge>
                  </Td>
                  <Td num label="Ran for">
                    {ranFor(task, now, active)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </ListView>

        {unfinished > 0 && (
          <p className="mt-2 text-xs leading-snug text-ink-muted">
            No ending reached the log for {unfinished}{" "}
            {unfinished === 1 ? "task" : "tasks"} still shown as running.
          </p>
        )}
      </Disclosure>
    </>
  );
}
