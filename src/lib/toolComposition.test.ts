import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZERO_TOKENS } from "./pricing";
import { type ToolCall, buildToolComposition, parseToolRecord } from "./toolComposition";

/**
 * The composition reading, both halves of it.
 *
 * The parser earns a test on `toolResultFailures`' and `permissionDenials`'
 * grounds: it is a shape captured from one CLI build, every field of it read
 * defensively, so a rename in the format costs the card its rows *silently* —
 * the page renders, the totals above it are unaffected, and the only symptom is
 * a table that has quietly stopped describing anything. The two records below
 * are copied from this install's own transcripts on the pinned build (2.1.238),
 * trimmed of the fields this reader does not touch.
 *
 * The rollup earns one on the same grounds `byAgent`'s bucket test does, with
 * one word changed. It cannot reconcile to a window total — a `tool_result` is
 * not a billable turn — so what it has to reconcile to is *itself*: every call
 * in exactly one row, the shares adding to 1, and a call whose result never
 * arrived counted in the call total and in no share. A reading that silently
 * dropped a bucket would be a page of plausible percentages that add to 94%.
 */

const CALL_TS = Date.parse("2026-08-22T22:35:53.784Z");
const RESULT_TS = Date.parse("2026-08-22T22:35:53.806Z");

/** A real `tool_use` line, trimmed. */
const USE_LINE = JSON.stringify({
  isSidechain: false,
  type: "assistant",
  uuid: "535be3ff-fa40-4288-b494-9d1b1f0f6c17",
  timestamp: "2026-08-22T22:35:53.784Z",
  sessionId: "d1aca0db-b2e3-46a8-bf82-992c7724d8ad",
  version: "2.1.238",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_01JjxrSdSQZRphUDNtMmDjAf",
        name: "Skill",
        input: { skill: "artifact-design" },
        caller: { type: "direct" },
      },
    ],
  },
});

/** The real `tool_result` line that answered it, trimmed. */
const RESULT_LINE = JSON.stringify({
  isSidechain: false,
  type: "user",
  uuid: "be308df5-4f79-49ce-aa99-df01a754ac9e",
  timestamp: "2026-08-22T22:35:53.806Z",
  toolUseResult: { success: true, commandName: "artifact-design" },
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01JjxrSdSQZRphUDNtMmDjAf",
        content: "Launching skill: artifact-design",
      },
    ],
  },
});

describe("parseToolRecord — a call and the result that answered it", () => {
  it("reads a captured tool_use record", () => {
    const parsed = parseToolRecord(USE_LINE);
    assert.ok(parsed);
    assert.deepEqual(parsed.results, []);
    assert.deepEqual(parsed.calls, [
      {
        id: "toolu_01JjxrSdSQZRphUDNtMmDjAf",
        ts: CALL_TS,
        name: "Skill",
        isSidechain: false,
        resultChars: null,
      },
    ]);
    // Null rather than 0: a call whose result has not been seen and one that
    // answered with nothing are different facts, and only the first is excluded
    // from the character total.
    assert.equal(parsed.calls[0].resultChars, null);
  });

  it("reads a captured tool_result record and keys it on the call", () => {
    const parsed = parseToolRecord(RESULT_LINE);
    assert.ok(parsed);
    assert.deepEqual(parsed.calls, []);
    assert.deepEqual(parsed.results, [
      {
        toolUseId: "toolu_01JjxrSdSQZRphUDNtMmDjAf",
        chars: "Launching skill: artifact-design".length,
      },
    ]);
    // The result record carries no name of its own — the pairing is the whole
    // reason the call is retained rather than counted and forgotten.
    assert.equal(RESULT_TS > CALL_TS, true);
  });

  it("counts text blocks and nothing else in an array-form result", () => {
    const line = JSON.stringify({
      type: "user",
      timestamp: "2026-08-22T22:35:53.806Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_a",
            content: [
              { type: "text", text: "12345" },
              // Base64 whose character count has no relation to the ~1,600
              // tokens an image is billed at. Counting it would make one
              // screenshot the largest thing on the card.
              { type: "image", source: { data: "x".repeat(5000) } },
              { type: "tool_reference", name: "Read" },
              { type: "text", text: "678" },
            ],
          },
        ],
      },
    });
    const parsed = parseToolRecord(line);
    assert.equal(parsed?.results[0].chars, 8);
  });

  it("drops a call with no parsable timestamp rather than dating it to 1970", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "not a date",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_a", name: "Bash", input: {} }],
      },
    });
    // Kept, it would sit before the start of every window this reading is ever
    // scoped to — counted nowhere while still being retained.
    assert.equal(parseToolRecord(line), null);
  });

  it("answers null for every line that carries no tool block", () => {
    // The substring test runs before the parse, so none of these is parsed at
    // all — and a line whose *content* mentions the literal costs one wasted
    // parse and still answers null.
    assert.equal(parseToolRecord(""), null);
    assert.equal(parseToolRecord("not json"), null);
    assert.equal(parseToolRecord('{"type":"assistant","message":{}}'), null);
    assert.equal(parseToolRecord('{"tool_use": broken'), null);
    assert.equal(
      parseToolRecord(
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-22T22:35:53.784Z",
          message: { role: "assistant", content: [{ type: "text", text: "tool_use" }] },
        }),
      ),
      null,
    );
  });

  it("keeps a sub-agent's call marked as one, so the setting can filter it", () => {
    const line = JSON.stringify({
      isSidechain: true,
      type: "assistant",
      timestamp: "2026-08-22T22:35:53.784Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_a", name: "Grep", input: {} }],
      },
    });
    assert.equal(parseToolRecord(line)?.calls[0].isSidechain, true);
  });
});

describe("buildToolComposition — a share of characters, never of money", () => {
  const from = Date.parse("2026-08-20T00:00:00Z");
  const call = (
    id: string,
    name: string,
    resultChars: number | null,
    ts = from + 1,
  ): ToolCall => ({ id, ts, name, isSidechain: false, resultChars });

  it("puts every call in one row, with the shares adding to 1", () => {
    const composition = buildToolComposition(
      [
        call("a", "Read", 600),
        call("b", "Read", 200),
        call("c", "Bash", 200),
      ],
      from,
      ZERO_TOKENS,
      0,
    );

    assert.equal(composition.totalCalls, 3);
    assert.equal(composition.totalResultChars, 1000);
    assert.equal(
      composition.rows.reduce((n, r) => n + r.calls, 0),
      composition.totalCalls,
    );
    assert.equal(
      composition.rows.reduce((n, r) => n + r.resultChars, 0),
      composition.totalResultChars,
    );
    assert.equal(
      composition.rows.reduce((s, r) => s + r.share, 0),
      1,
    );
    // Character-descending, so the tail a card cuts really is the small end.
    assert.deepEqual(
      composition.rows.map((r) => r.tool),
      ["Read", "Bash"],
    );
    assert.equal(composition.rows[0].share, 0.8);
  });

  it("counts an unanswered call and gives it no share", () => {
    const composition = buildToolComposition(
      [call("a", "Bash", 100), call("b", "Bash", null)],
      from,
      ZERO_TOKENS,
      0,
    );

    assert.equal(composition.totalCalls, 2);
    assert.equal(composition.unansweredCalls, 1);
    assert.equal(composition.totalResultChars, 100);
    assert.equal(composition.rows[0].calls, 2);
    assert.equal(composition.rows[0].resultChars, 100);
  });

  it("keeps a result that came back empty apart from one that never came", () => {
    const composition = buildToolComposition(
      [call("a", "Write", 0), call("b", "Write", null)],
      from,
      ZERO_TOKENS,
      0,
    );
    assert.equal(composition.unansweredCalls, 1);
    assert.equal(composition.totalCalls, 2);
  });

  it("covers the window it is given and nothing before it", () => {
    const composition = buildToolComposition(
      [call("old", "Read", 900, from - 1), call("new", "Read", 100)],
      from,
      ZERO_TOKENS,
      0,
    );
    assert.equal(composition.totalCalls, 1);
    assert.equal(composition.totalResultChars, 100);
    assert.equal(composition.from, from);
  });

  it("prices placing a token, counting the ways in and not the re-reads", () => {
    // A window whose context was read back nine times over: 100k tokens went
    // in, 900k came back out of cache, and the bill was $30.
    const composition = buildToolComposition([], from, {
      input: 10_000,
      output: 20_000,
      cacheRead: 900_000,
      cacheWrite5m: 40_000,
      cacheWrite1h: 30_000,
    }, 30);

    assert.equal(composition.placedTokens, 100_000);
    assert.equal(composition.reReadRatio, 9);
    // $30 over 100k placed is $300 per million placed — which is the point of
    // the figure: nothing in the price table charges anything like that for an
    // input token, and almost the whole bill is the re-reading.
    assert.equal(composition.costPerMillionPlacedUSD, 300);
  });

  it("reports nothing rather than zero when nothing was placed", () => {
    const composition = buildToolComposition([], from, ZERO_TOKENS, 0);
    assert.equal(composition.placedTokens, 0);
    assert.equal(composition.reReadRatio, null);
    assert.equal(composition.costPerMillionPlacedUSD, null);
    assert.deepEqual(composition.rows, []);
  });
});
