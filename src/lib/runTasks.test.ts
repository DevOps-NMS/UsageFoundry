import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RunEventDTO } from "./apiTypes";
import { runTasks } from "./runTasks";

/**
 * This decides what the run page states about work the operator cannot see any
 * other way, and every way it can be wrong is silent.
 *
 * The two that matter most are opposites. A task retired because it left a
 * `background_tasks_changed` snapshot reads as finished when nothing said so —
 * and a finished task leaving that list is the *normal* case, so the panel
 * would be confidently wrong about almost every task on a healthy run. A task
 * still listed as running because a terminal event arrived in an order this
 * reducer did not expect reads as a live shell on a run that is over. Neither
 * throws, and both look exactly like a panel that is working.
 *
 * The payload shapes below are the CLI's own, taken from real
 * `system:task_*` events; the field names are not invented here.
 */

function systemEvent(
  ts: number,
  subtype: string,
  raw: Record<string, unknown>,
): RunEventDTO {
  return {
    runId: "r",
    ts,
    kind: "log",
    payload: { message: `system:${subtype}`, raw: { type: "system", subtype, ...raw } },
  };
}

function started(
  ts: number,
  taskId: string,
  description = "Start production server",
  taskType = "local_bash",
): RunEventDTO {
  return systemEvent(ts, "task_started", {
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description,
    task_type: taskType,
  });
}

function snapshot(
  ts: number,
  tasks: { task_id: string; task_type?: string; description?: string }[],
): RunEventDTO {
  return systemEvent(ts, "background_tasks_changed", { tasks });
}

function updated(
  ts: number,
  taskId: string,
  patch: Record<string, unknown>,
): RunEventDTO {
  return systemEvent(ts, "task_updated", { task_id: taskId, patch });
}

function notified(
  ts: number,
  taskId: string,
  status: string,
  extra: Record<string, unknown> = {},
): RunEventDTO {
  return systemEvent(ts, "task_notification", {
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    status,
    output_file: "",
    summary: "Start production server",
    ...extra,
  });
}

test("a started task is one row, running, with what the CLI said about it", () => {
  const rows = runTasks([started(1000, "b7e1fsm6f")]);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "b7e1fsm6f",
    description: "Start production server",
    taskType: "local_bash",
    toolUseId: "toolu_b7e1fsm6f",
    startedAt: 1000,
    endedAt: null,
    state: "running",
    statusWord: null,
    summary: null,
    outputFile: null,
    backgrounded: false,
  });
});

test("a run with no background task produces no rows", () => {
  assert.deepEqual(runTasks([]), []);
  assert.deepEqual(
    runTasks([
      { runId: "r", ts: 1, kind: "assistant", payload: { text: "Working." } },
      { runId: "r", ts: 2, kind: "log", payload: { message: "system:init", raw: {} } },
      { runId: "r", ts: 3, kind: "log", payload: { message: "npm install" } },
      { runId: "r", ts: 4, kind: "tool", payload: { name: "Bash", input: {} } },
    ]),
    [],
  );
});

test("leaving a snapshot is not an ending", () => {
  // The whole reason this reducer exists in the shape it does. A finished task
  // drops out of `background_tasks_changed`, so deriving an ending from absence
  // would mark every healthy task finished at the moment the *next* one starts
  // — and the panel would look right while saying so.
  const rows = runTasks([
    started(1000, "one"),
    snapshot(1100, [{ task_id: "one", task_type: "local_bash" }]),
    started(1200, "two", "Tail the build log"),
    snapshot(1300, [{ task_id: "two", task_type: "local_bash" }]),
  ]);

  assert.deepEqual(
    rows.map((t) => [t.id, t.state, t.endedAt]),
    [
      ["one", "running", null],
      ["two", "running", null],
    ],
  );
});

test("a snapshot recovers a task whose start never reached this page", () => {
  // A replay that begins mid-run has no `task_started` for a task already
  // going. The snapshot is the only evidence the task exists at all.
  const rows = runTasks([
    snapshot(5000, [
      { task_id: "b7wh9igxt", task_type: "local_agent", description: "Audit the routes" },
    ]),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "Audit the routes");
  assert.equal(rows[0].taskType, "local_agent");
  assert.equal(rows[0].state, "running");
  assert.equal(
    rows[0].startedAt,
    null,
    "the snapshot's own timestamp is when the page saw the task, never when it started",
  );
});

test("a killed task ends on the patch, at the instant the patch states", () => {
  const rows = runTasks([
    started(1000, "one"),
    updated(1500, "one", { is_backgrounded: true }),
    updated(2000, "one", { status: "killed", end_time: 1_787_660_701_810 }),
  ]);

  assert.equal(rows[0].state, "killed");
  assert.equal(rows[0].statusWord, "killed");
  assert.equal(rows[0].backgrounded, true);
  assert.equal(
    rows[0].endedAt,
    1_787_660_701_810,
    "the CLI's own end_time, not when the event happened to arrive",
  );
});

test("a terminal notification carries the outcome, and an empty output_file is no file", () => {
  const rows = runTasks([
    started(1000, "one"),
    notified(3000, "one", "completed", { summary: "Install dev dependencies" }),
  ]);

  assert.equal(rows[0].state, "completed");
  assert.equal(rows[0].summary, "Install dev dependencies");
  assert.equal(
    rows[0].outputFile,
    null,
    "the CLI sends \"\" for a task that wrote no file; an empty path rendered as a path is a file that does not exist",
  );
  assert.equal(rows[0].endedAt, 3000);
});

test("a notification with a path keeps it", () => {
  const rows = runTasks([
    started(1000, "one"),
    notified(3000, "one", "stopped", { output_file: "/tmp/tasks/one.output" }),
  ]);

  assert.equal(rows[0].state, "stopped");
  assert.equal(rows[0].outputFile, "/tmp/tasks/one.output");
});

test("a terminal status this app has not read is terminal, and says the CLI's word", () => {
  // The status set is the CLI's, not ours. Mapping an unknown word onto
  // `completed` would claim an outcome; leaving it `running` would claim a live
  // shell on a run that is over.
  const rows = runTasks([started(1000, "one"), notified(3000, "one", "timed_out")]);

  assert.equal(rows[0].state, "ended");
  assert.equal(rows[0].statusWord, "timed_out");
});

test("duplicate events change nothing", () => {
  // A reconnect replays from the last event the page saw, so the same event
  // arriving twice is routine rather than exotic.
  const once = runTasks([
    started(1000, "one"),
    updated(2000, "one", { is_backgrounded: true }),
    notified(3000, "one", "completed"),
  ]);
  const twice = runTasks([
    started(1000, "one"),
    started(1000, "one"),
    updated(2000, "one", { is_backgrounded: true }),
    updated(2000, "one", { is_backgrounded: true }),
    notified(3000, "one", "completed"),
    notified(3000, "one", "completed"),
  ]);

  assert.equal(twice.length, 1);
  assert.deepEqual(twice, once);
});

test("an ended task is not reopened by an event that arrives late", () => {
  const rows = runTasks([
    started(1000, "one"),
    notified(3000, "one", "completed", { summary: "Ran the suite" }),
    // All three arrive after the ending and all three predate it.
    snapshot(3100, [{ task_id: "one", task_type: "local_bash" }]),
    started(1000, "one"),
    updated(2000, "one", { is_backgrounded: true }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "completed");
  assert.equal(rows[0].summary, "Ran the suite");
  assert.equal(rows[0].backgrounded, true, "a patch it missed still applies");
});

test("the later status wins however the two events are ordered", () => {
  const inOrder = runTasks([
    started(1000, "one"),
    updated(2000, "one", { status: "killed", end_time: 2000 }),
    notified(3000, "one", "stopped"),
  ]);
  const reversed = runTasks([
    started(1000, "one"),
    notified(3000, "one", "stopped"),
    updated(2000, "one", { status: "killed", end_time: 2000 }),
  ]);

  assert.equal(inOrder[0].state, "stopped");
  assert.equal(reversed[0].state, "stopped", "order of arrival must not decide the outcome");
});

test("rows keep the order the tasks were first seen, whenever their events land", () => {
  const rows = runTasks([
    started(2000, "second", "Tail the build log"),
    started(1000, "first"),
    notified(3000, "second", "completed"),
  ]);

  assert.deepEqual(
    rows.map((t) => t.id),
    ["first", "second"],
  );
});

test("a patch applies the keys it knows and ignores the rest", () => {
  // `patch` is an open set. A key this app has not seen must be skipped, not
  // treated as a status — and a patch carrying only unknown keys must not
  // retire a live task.
  const rows = runTasks([
    started(1000, "one"),
    updated(2000, "one", { some_future_field: "whatever", is_backgrounded: true }),
  ]);

  assert.equal(rows[0].state, "running");
  assert.equal(rows[0].backgrounded, true);
});

test("an in-flight status word does not end a task", () => {
  const rows = runTasks([
    started(1000, "one"),
    updated(2000, "one", { status: "queued" }),
  ]);

  assert.equal(rows[0].state, "running");
  assert.equal(rows[0].statusWord, "queued");
  assert.equal(rows[0].endedAt, null);
});

test("an end_time with no status word still ends the task", () => {
  const rows = runTasks([
    started(1000, "one"),
    updated(2000, "one", { end_time: 2500 }),
  ]);

  assert.equal(rows[0].state, "ended");
  assert.equal(rows[0].endedAt, 2500);
});

test("task_progress opens no row", () => {
  // Its payload is a sub-agent delegation's — `subagent_type`, `usage`,
  // `last_tool_name`, no `task_type` and no `status`. Those have their own
  // event kind and their own label in the log, and one word for both is the
  // confusion this panel is scoped away from.
  const rows = runTasks([
    systemEvent(1000, "task_progress", {
      task_id: "a23f9f64a2fc15bb0",
      tool_use_id: "toolu_01M3cGktwVGTq58f12MJ7PXU",
      description: "Reading src/components/ui/Card.tsx",
      subagent_type: "general-purpose",
      usage: { total_tokens: 146223, tool_uses: 16, duration_ms: 734422 },
      last_tool_name: "Read",
    }),
  ]);

  assert.deepEqual(rows, []);
});

test("a malformed event is skipped rather than filed as a task", () => {
  const rows = runTasks([
    // No `raw` at all.
    { runId: "r", ts: 1, kind: "log", payload: { message: "system:task_started" } },
    // `raw` present, `task_id` missing.
    systemEvent(2, "task_started", { description: "no id" }),
    // A snapshot whose entries are not objects.
    systemEvent(3, "background_tasks_changed", { tasks: ["one", null, 7] }),
    // A snapshot with no `tasks` key.
    systemEvent(4, "background_tasks_changed", {}),
    // An update naming no task.
    systemEvent(5, "task_updated", { patch: { status: "killed" } }),
    // The real thing, so the loop is proved to have carried on.
    started(6, "one"),
  ]);

  assert.deepEqual(
    rows.map((t) => t.id),
    ["one"],
  );
});

test("an update that names a task but patches nothing still proves the task exists", () => {
  const rows = runTasks([updated(1000, "one", {})]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "one");
  assert.equal(rows[0].state, "running");
  assert.equal(rows[0].startedAt, null);
});
