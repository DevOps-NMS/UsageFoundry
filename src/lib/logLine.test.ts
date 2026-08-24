import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunEventDTO } from "./apiTypes";
import {
  describeEvent,
  logFilterActive,
  matchesLogFilter,
  type LogFilter,
} from "./logLine";

/**
 * How a `log` row is set, which is the one event kind whose text this app did
 * not write.
 *
 * Every other row in the feed comes from a branch in this process, so what it
 * says is decided beside the code that decides it. A `log` row is whatever a
 * child wrote to stderr — a build, a compiler, or a plugin registered through
 * `--plugin-dir`, whose hooks' stderr is its only channel back to the operator.
 * Telling the last of those from the first two is a judgement made on the text
 * alone, and both directions of getting it wrong are silent: a plugin's report
 * buried in a build reads as noise, and a compiler's line wearing a plugin's
 * name says something ran that never did.
 *
 * No `DATA_DIR` dance ahead of the import, unlike `retention.test.ts` beside
 * it: `logLine.ts` is client-safe and reaches no module that binds a path.
 */

/** A `log` event as the stream reader hands one over. */
function logEvent(message: string, truncatedFrom?: number): RunEventDTO {
  return {
    id: 1,
    runId: "r",
    ts: 0,
    kind: "log",
    payload: truncatedFrom === undefined ? { message } : { message, truncatedFrom },
  };
}

describe("describeEvent — a plugin's line on stderr", () => {
  it("labels a recognised prefix and does not say it twice", () => {
    const entry = describeEvent(
      logEvent("winnow: team state checkpointed to /home/node/.winnow/team-checkpoint.md"),
    );

    assert.deepEqual(entry, {
      voice: "system",
      tone: "accent",
      label: "winnow",
      text: "team state checkpointed to /home/node/.winnow/team-checkpoint.md",
    });
  });

  it("sets a refusal in the same tone as a success", () => {
    // The prefix carries both and this file cannot tell them apart, so `ok`
    // would dress a refusal as a job done and `warn` would do the reverse. What
    // the row claims is who spoke.
    const entry = describeEvent(logEvent("winnow: refused: guard would terminate this session (§8.3)"));

    assert.equal(entry?.tone, "accent");
    assert.equal(entry?.label, "winnow");
    assert.equal(entry?.text, "refused: guard would terminate this session (§8.3)");
  });

  it("strips the prefix from every line of a chunk that carries it", () => {
    // stderr reaches `run_events` one chunk per row rather than one line, so a
    // hook that wrote twice inside one tick arrives as a single row.
    const entry = describeEvent(logEvent("winnow: PreCompact fired\nwinnow: no session to checkpoint"));

    assert.equal(entry?.label, "winnow");
    assert.equal(entry?.text, "PreCompact fired\nno session to checkpoint");
  });

  it("still marks a labelled line that was cut for storage", () => {
    const entry = describeEvent(logEvent("winnow: team state checkpointed", 12_000));

    assert.equal(entry?.label, "winnow");
    assert.equal(entry?.text, "team state checkpointed · line shortened for storage");
  });
});

describe("describeEvent — what is not a plugin", () => {
  // Every one of these is ordinary output from something a run builds with, and
  // each has the shape a `<word>: ` pattern would have matched. A rule that
  // labels them is worse than no rule: it answers "did the plugin run" with a
  // yes it invented.
  const buildOutput = [
    "error: could not resolve './missing' from 'src/index.ts'",
    "warning: 1 moderate severity vulnerability",
    "note: this error originates in a macro",
    "TypeError: undefined is not a function",
    "src/lib/windows.ts:412:7 - error TS2345: argument of type 'null'",
    "fatal: not a git repository",
  ];

  for (const line of buildOutput) {
    it(`leaves \`${line.slice(0, 28)}…\` unlabelled and neutral`, () => {
      assert.deepEqual(describeEvent(logEvent(line)), {
        voice: "system",
        tone: "neutral",
        label: null,
        text: line,
      });
    });
  }

  it("does not attribute a plugin this build has not heard of", () => {
    // The closed list, stated as a test: a name nobody added renders as it did
    // before any of this existed, which is the cheap direction to be wrong in.
    const entry = describeEvent(logEvent("cozempic: pruned 3 transcripts"));

    assert.equal(entry?.label, null);
    assert.equal(entry?.tone, "neutral");
    assert.equal(entry?.text, "cozempic: pruned 3 transcripts");
  });

  it("needs the space after the colon, so a path stays a path", () => {
    const entry = describeEvent(logEvent("winnow:/home/node/.winnow is not writable"));

    assert.equal(entry?.label, null);
    assert.equal(entry?.tone, "neutral");
  });

  it("attributes a bare prefix to nobody rather than rendering a blank row", () => {
    // A blank `text` means "a tool call that carried no arguments" everywhere
    // else in this file, so the prefix is kept and the row stays a build line.
    const entry = describeEvent(logEvent("winnow: "));

    assert.equal(entry?.label, null);
    assert.equal(entry?.text, "winnow: ");
  });

  it("still drops the CLI's own chatter and an empty row", () => {
    assert.equal(describeEvent(logEvent("system: initialising session")), null);
    assert.equal(describeEvent(logEvent("")), null);
  });
});

/**
 * Which lines a narrowed log keeps.
 *
 * The failure is the one this whole surface exists to prevent, and it is
 * silent in the worst direction: a filter that drops a line the run wrote
 * answers "did anything fail here" with a no it invented, and a log that hides
 * a line is indistinguishable from a run that never wrote one. Two facts carry
 * that and neither is visible from the page — a failed tool call renders as a
 * *system* row, so grouping on the rendered voice would file it away from the
 * tool calls it belongs with; and the group map is exhaustive over
 * `RunEventDTO["kind"]`, so a kind added later cannot quietly belong to
 * nothing.
 */
describe("matchesLogFilter", () => {
  const toolCall: RunEventDTO = {
    id: 1,
    runId: "r",
    ts: 0,
    kind: "tool",
    payload: { name: "Bash", input: { command: "npm run typecheck" } },
  };
  const toolFailure: RunEventDTO = {
    id: 2,
    runId: "r",
    ts: 0,
    kind: "tool_error",
    payload: { name: "Bash", command: "npm ci", text: "exit 1" },
  };
  const said: RunEventDTO = {
    id: 3,
    runId: "r",
    ts: 0,
    kind: "assistant",
    payload: { text: "I have finished the typecheck" },
  };
  const notice: RunEventDTO = {
    id: 4,
    runId: "r",
    ts: 0,
    kind: "status",
    payload: { status: "paused", message: "waiting out the window" },
  };

  /** The page's own pairing: the event's kind and the line it rendered as. */
  const keeps = (e: RunEventDTO, filter: LogFilter): boolean => {
    const entry = describeEvent(e);
    assert.ok(entry, "the fixture must render a line");
    return matchesLogFilter(e.kind, entry, filter);
  };

  it("keeps a failed tool call under tool calls, not only under problems", () => {
    // `describeEvent` sets `tool_error` as a system row with a danger tone,
    // which is why the filter reads the event kind. Grouped on the voice, an
    // operator narrowing to tool calls would see every call except the ones
    // that failed.
    assert.equal(keeps(toolFailure, { query: "", kind: "tool" }), true);
    assert.equal(keeps(toolFailure, { query: "", kind: "problem" }), true);
    assert.equal(keeps(toolFailure, { query: "", kind: "app" }), false);
  });

  it("separates the agent's words from this app's notices", () => {
    assert.equal(keeps(said, { query: "", kind: "agent" }), true);
    assert.equal(keeps(said, { query: "", kind: "app" }), false);
    assert.equal(keeps(notice, { query: "", kind: "app" }), true);
    assert.equal(keeps(notice, { query: "", kind: "agent" }), false);
  });

  it("counts a warning tone as a problem whatever kind carried it", () => {
    // A parked run is a `status` row at `warn`, so "warnings and failures"
    // crosses the kinds rather than naming one of them.
    assert.equal(keeps(notice, { query: "", kind: "problem" }), true);
    assert.equal(keeps(toolCall, { query: "", kind: "problem" }), false);
  });

  it("matches the body and the label, case-insensitively", () => {
    assert.equal(keeps(toolCall, { query: "TYPECHECK", kind: "all" }), true);
    assert.equal(keeps(toolCall, { query: "bash", kind: "all" }), true);
    assert.equal(keeps(toolCall, { query: "eslint", kind: "all" }), false);
  });

  it("applies the kind and the text together, never either alone", () => {
    assert.equal(keeps(said, { query: "typecheck", kind: "agent" }), true);
    // The words are in the agent's line, not in a tool call.
    assert.equal(keeps(said, { query: "typecheck", kind: "tool" }), false);
    assert.equal(keeps(toolCall, { query: "finished", kind: "tool" }), false);
  });

  it("is off when neither half asks for anything", () => {
    assert.equal(logFilterActive({ query: "", kind: "all" }), false);
    assert.equal(logFilterActive({ query: "   ", kind: "all" }), false);
    assert.equal(logFilterActive({ query: "npm", kind: "all" }), true);
    assert.equal(logFilterActive({ query: "", kind: "tool" }), true);
    // Whitespace is not a query, so a line is kept rather than matched on it.
    assert.equal(keeps(toolCall, { query: "   ", kind: "all" }), true);
  });
});
