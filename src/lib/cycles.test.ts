import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RunEventDTO } from "./apiTypes";
import { cycleOutputs } from "./cycles";

/**
 * The run page now renders each cycle's final message as its own block, so this
 * function decides what a reader is shown as "what the agent reported". Every
 * way it can be wrong is silent: text filed under the cycle before it, a cycle
 * blanked by the empty content block that routinely follows a real one, or a
 * reopened run's cycle 4 relabelled 1 — none of them throw, and all of them
 * read as a plausible report of work that did not happen that way.
 */

function iteration(ts: number, n: number, resuming: string | null = null): RunEventDTO {
  return { runId: "r", ts, kind: "iteration", payload: { n, prompt: "go", resuming } };
}

function assistant(ts: number, text: string): RunEventDTO {
  return { runId: "r", ts, kind: "assistant", payload: { text } };
}

function tool(ts: number, name: string): RunEventDTO {
  return { runId: "r", ts, kind: "tool", payload: { name, input: {} } };
}

test("each work cycle reports its own last assistant turn", () => {
  const out = cycleOutputs([
    iteration(1, 1),
    assistant(2, "Looking at the parser."),
    tool(3, "Read"),
    assistant(4, "Fixed the off-by-one."),
    iteration(5, 2, "sess-1"),
    assistant(6, "Nothing left to do."),
  ]);

  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((c) => [c.n, c.text, c.ts, c.resumed]),
    [
      [1, "Fixed the off-by-one.", 4, false],
      [2, "Nothing left to do.", 6, true],
    ],
  );
});

test("a trailing empty content block does not blank the cycle", () => {
  // Claude Code emits one `assistant` event per content block and a blank one
  // after a real one is routine. Taking the literal last turn loses the report.
  const out = cycleOutputs([
    iteration(1, 1),
    assistant(2, "Here is what changed."),
    assistant(3, "   \n  "),
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Here is what changed.");
  assert.equal(out[0].ts, 2, "the timestamp must follow the text that was kept");
});

test("a cycle that said nothing is left out rather than listed empty", () => {
  const out = cycleOutputs([
    iteration(1, 1),
    tool(2, "Bash"),
    iteration(3, 2, "sess-1"),
    assistant(4, "Done."),
  ]);

  assert.deepEqual(
    out.map((c) => c.n),
    [2],
  );
});

test("cycle numbers come off the event, so a reopened run is not renumbered", () => {
  // `reopenRun` keeps the row's iteration count, so the first cycle of the
  // second segment is 4. Numbering by position would say the run started over.
  const out = cycleOutputs([iteration(1, 4, "sess-1"), assistant(2, "Picking up.")]);

  assert.deepEqual(
    out.map((c) => c.n),
    [4],
  );
});

test("assistant text with no cycle open is not attributed to one", () => {
  assert.deepEqual(cycleOutputs([assistant(1, "orphan")]), []);
  assert.deepEqual(cycleOutputs([]), []);
});

test("only the assistant kind is read as the agent's own words", () => {
  // `log`, `result` and `status` all carry text-shaped payloads, and a run whose
  // report was the string "status → completed" would be worse than no card.
  const out = cycleOutputs([
    iteration(1, 1),
    assistant(2, "The real report."),
    { runId: "r", ts: 3, kind: "log", payload: { message: "not the report" } },
    { runId: "r", ts: 4, kind: "result", payload: { subtype: "success", text: "nor this" } },
    { runId: "r", ts: 5, kind: "status", payload: { status: "completed" } },
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].text, "The real report.");
});

/**
 * `--forward-subagent-text` puts a second voice into the same stream, and this
 * is the reader that decides which one the operator is shown as the run's own
 * account of its work. Getting it wrong is silent in the worst way: a sub-agent
 * finishes its piece and reports on it, that turn arrives after the main
 * thread's last words because it finished later, and the card then presents one
 * sub-agent's summary of one subtask as what the run did.
 */
test("a sub-agent's words are never the cycle's report", () => {
  const out = cycleOutputs([
    iteration(1, 1),
    assistant(2, "Delegating the search."),
    {
      runId: "r",
      ts: 3,
      kind: "subagent",
      payload: { text: "I found four call sites.", parentToolUseId: "toolu_1" },
    },
    assistant(4, "Fixed all four."),
    {
      runId: "r",
      ts: 5,
      kind: "subagent",
      payload: { text: "Nothing else to check.", parentToolUseId: "toolu_2" },
    },
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Fixed all four.");
  assert.equal(out[0].ts, 4);
});

test("a delegated turn is skipped on its parent id whatever kind it arrives as", () => {
  // The orchestrator routes on `parent_tool_use_id` and this checks the same
  // field, so the two cannot disagree about which voice a line is — including
  // for a stream shape this app has not seen.
  const out = cycleOutputs([
    iteration(1, 1),
    assistant(2, "The real report."),
    {
      runId: "r",
      ts: 3,
      kind: "assistant",
      payload: { text: "A sub-agent's summary.", parentToolUseId: "toolu_1" },
    },
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].text, "The real report.");
});

test("a cycle whose only words were a sub-agent's is left out", () => {
  // Not "reported nothing" dressed up as a report: the run said nothing itself,
  // and the log above already shows that the delegation happened.
  const out = cycleOutputs([
    iteration(1, 1),
    {
      runId: "r",
      ts: 2,
      kind: "subagent",
      payload: { text: "Only the sub-agent spoke.", parentToolUseId: "toolu_1" },
    },
  ]);

  assert.deepEqual(out, []);
});
