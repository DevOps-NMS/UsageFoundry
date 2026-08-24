import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type {
  LedgerRequest,
  RequestAnchor,
  UniqueResult,
} from "./intakeFilter";

/**
 * The three decisions behind the intake-filter figure, all of which fail
 * silently and one of which fails by a factor of nineteen.
 *
 * `dedupeResults` is the one this file exists for. The filter is stateless: it
 * re-drops the same tool result on every later request that still carries it,
 * so a ledger line is a *request* and not a removal. Summing the file charges
 * one removal once per surviving request — measured on this install's own
 * ledger at 125 lines, 372 occurrences over 15 distinct results, a 24.8×
 * overstatement of a
 * number nothing else here can be checked against. Nothing throws, the figure
 * is a plausible dollar amount either way, and the only page it appears on is
 * the one built to answer whether the mechanism is worth leaving on.
 *
 * `netFilterSavings` is `2.0·D − 1.0·D + 0.1·D·T`, and the middle term is the
 * one that can go wrong invisibly: it is a **cost** — the filter still sends
 * each result once, uncached — so a sign flip roughly triples the headline
 * while leaving every other row on the card correct. The absence of a
 * break-even term is the property that separates this from a prune, and it is
 * asserted directly rather than left to follow from the formula.
 *
 * `parseLedger` reads a file another process is appending to, in a format this
 * repository does not own. Its failures are `transcriptCompaction.test.ts`'s: a
 * half-written last line must not take the whole reading down, and a field that
 * is not there must not read as a real figure.
 */

let intakeFilter: typeof import("./intakeFilter");
let root: string;

before(async () => {
  // `intakeFilter.ts` statically imports `transcripts.ts` and so reaches
  // `config.ts`, which binds `DATA_DIR` at import — on a developer's machine
  // that is the real database and the real transcript tree.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-intake-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");

  const config = await import("./config");
  assert.equal(
    config.CLAUDE_HOME,
    process.env.CLAUDE_HOME,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real transcript tree",
  );

  intakeFilter = await import("./intakeFilter");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** $/Mtok input for opus-5, as `pricing.ts` has it. */
const OPUS_INPUT = 5;
const BYTES_PER_TOKEN = 3.6;

const SESSION = "sess-a";

function anchor(over: Partial<RequestAnchor> = {}): RequestAnchor {
  return {
    sessionId: SESSION,
    ts: Date.UTC(2026, 7, 20, 10, 0, 0),
    model: "claude-opus-5",
    turnsAfter: 0,
    ...over,
  };
}

/** One ledger line as winnow writes it, before `tool_use_id` existed. */
function line(
  requestId: string,
  results: Array<{
    tool?: string;
    rule?: string;
    bytes?: number;
    tool_use_id?: string;
  }>,
  kind: "dropped" | "deferred" = "dropped",
): string {
  return JSON.stringify({
    request_id: requestId,
    [kind]: results.map((r) => ({
      tool: r.tool ?? "Bash",
      rule: r.rule ?? "B2",
      bytes: r.bytes ?? 3600,
      ...(r.tool_use_id ? { tool_use_id: r.tool_use_id } : {}),
    })),
  });
}

/** Every request joins to the same session, which is the ordinary case. */
const oneSession = () => anchor();

describe("parseLedger", () => {
  it("keeps every whole line before a half-written one", () => {
    const text = [
      line("req_1", [{ bytes: 4000 }]),
      line("req_2", [{ bytes: 5000 }]),
      '{"request_id":"req_3","dropped":[{"tool":"Ba',
    ].join("\n");

    const parsed = intakeFilter.parseLedger(text);

    // The file is appended to by another process, so the tail is routinely
    // mid-write. Throwing there would take the whole card down for one
    // truncated line and put it back on the next poll, which reads as a
    // flapping figure rather than as a parse failure.
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      parsed.map((r) => r.requestId),
      ["req_1", "req_2"],
    );
  });

  it("skips a line carrying no request id", () => {
    const text = [
      JSON.stringify({ dropped: [{ tool: "Bash", rule: "B2", bytes: 9000 }] }),
      line("req_1", [{ bytes: 4000 }]),
    ].join("\n");

    // The id is the only join to a clock, a model and a session. A line without
    // one can be dated by nothing, so counting it would put unpriceable bytes
    // into a total whose denominator nobody can see.
    assert.deepEqual(
      intakeFilter.parseLedger(text).map((r) => r.requestId),
      ["req_1"],
    );
  });

  it("reads deferred results alongside dropped ones and marks which is which", () => {
    const text = JSON.stringify({
      request_id: "req_1",
      dropped: [{ tool: "Grep", rule: "C1", bytes: 8000 }],
      deferred: [{ tool: "Bash", rule: "B2", bytes: 4000 }],
    });

    const [request] = intakeFilter.parseLedger(text);

    assert.equal(request.results.length, 2);
    assert.deepEqual(
      request.results.map((r) => [r.tool, r.dropped]),
      [
        ["Grep", true],
        ["Bash", false],
      ],
    );
  });

  it("drops a result with no readable byte count", () => {
    const text = JSON.stringify({
      request_id: "req_1",
      dropped: [
        { tool: "Bash", rule: "B2" },
        { tool: "Bash", rule: "B2", bytes: "4000" },
        { tool: "Bash", rule: "B2", bytes: 4000 },
      ],
    });

    // Zero saved nothing, and it would take a slot in the fallback key where
    // every other unreadable line would pool with it into one phantom result.
    const [request] = intakeFilter.parseLedger(text);
    assert.equal(request.results.length, 1);
    assert.equal(request.results[0].bytes, 4000);
  });
});

describe("dedupeResults", () => {
  it("counts a result carried by many requests exactly once", () => {
    // The shape the real ledger takes: one long-lived tool result re-dropped on
    // every request for the rest of the session.
    const requests: LedgerRequest[] = Array.from({ length: 30 }, (_, i) =>
      intakeFilter.parseLedger(
        line(`req_${i}`, [{ tool: "Bash", rule: "B2", bytes: 36_000 }]),
      ),
    ).flat();

    const unique = intakeFilter.dedupeResults(requests, oneSession);

    assert.equal(unique.length, 1, "30 requests, one result");
    assert.equal(unique[0].occurrences, 30);
    assert.equal(unique[0].bytes, 36_000);
    // The first request is where the baseline would have written it to cache,
    // so it is the one that dates and prices the saving.
    assert.equal(unique[0].requestId, "req_0");

    // Stated in tokens as well as in results, because this is the assertion
    // that fails if the de-dupe is removed: summing the file instead reports
    // 300,000 tokens where 10,000 went, which is a plausible figure on a card
    // nothing else can be checked against.
    const net = intakeFilter.netFilterSavings(unique);
    assert.equal(net.tokensRemoved, Math.round(36_000 / BYTES_PER_TOKEN));
    assert.equal(net.results, 1);
  });

  it("keeps byte-identical output of one tool in two sessions apart", () => {
    const requests = intakeFilter.parseLedger(
      [
        line("req_a", [{ tool: "Bash", rule: "B2", bytes: 4000 }]),
        line("req_b", [{ tool: "Bash", rule: "B2", bytes: 4000 }]),
      ].join("\n"),
    );

    // Without a `tool_use_id` the only identity available is what the line
    // says, and `npm test` printing the same 4,000 bytes in two runs is one
    // ledger line each. Pooling them across sessions would report one saving
    // for two, which is the direction this whole figure already errs in and
    // does not need help erring further.
    const unique = intakeFilter.dedupeResults(requests, (id) =>
      anchor({ sessionId: id === "req_a" ? "sess-a" : "sess-b" }),
    );

    assert.equal(unique.length, 2);
  });

  it("prefers the tool id over the fallback key", () => {
    // Same tool, same rule, same size, same session — two different results,
    // and only the id says so. A key that ignored it would silently halve the
    // figure on exactly the lines winnow is being changed to write.
    const requests = intakeFilter.parseLedger(
      [
        line("req_a", [{ bytes: 4000, tool_use_id: "toolu_1" }]),
        line("req_b", [{ bytes: 4000, tool_use_id: "toolu_2" }]),
      ].join("\n"),
    );

    const unique = intakeFilter.dedupeResults(requests, oneSession);

    assert.equal(unique.length, 2);
    assert.deepEqual(
      unique.map((r) => r.fallbackKeyed),
      [false, false],
    );
  });

  it("treats a result deferred and then dropped as one result", () => {
    const requests = intakeFilter.parseLedger(
      [
        line("req_a", [{ bytes: 4000 }], "deferred"),
        line("req_b", [{ bytes: 4000 }]),
      ].join("\n"),
    );

    const unique = intakeFilter.dedupeResults(requests, oneSession);

    // `keep_newest` holds the newest match in full for one turn and drops it on
    // the next, so this is the ordinary life of a result rather than an edge
    // case. Two entries would price one removal twice.
    assert.equal(unique.length, 1);
    assert.equal(unique[0].occurrences, 2);
    assert.equal(unique[0].everDropped, true);
  });
});

describe("netFilterSavings", () => {
  const result = (over: Partial<UniqueResult> = {}): UniqueResult => ({
    key: "id:toolu_1",
    bytes: 36_000,
    requestId: "req_1",
    anchor: anchor(),
    occurrences: 1,
    everDropped: true,
    fallbackKeyed: false,
    ...over,
  });

  const TOKENS = Math.round(36_000 / BYTES_PER_TOKEN);
  const PER_TOKEN = OPUS_INPUT / 1_000_000;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;

  it("nets the write it avoided against the one send it still pays", () => {
    const net = intakeFilter.netFilterSavings([
      result({ anchor: anchor({ turnsAfter: 12 }) }),
    ]);

    assert.equal(net.tokensRemoved, TOKENS);
    // $5/Mtok input for opus-5, 2.0x for the one-hour write class this install
    // was measured to write at.
    assert.equal(round(net.cacheWriteAvoidedUSD), round(TOKENS * PER_TOKEN * 2));
    assert.equal(round(net.uncachedSendUSD), round(TOKENS * PER_TOKEN));
    assert.equal(
      round(net.cacheReadAvoidedUSD),
      round(TOKENS * 12 * PER_TOKEN * 0.1),
    );
    // The middle term is subtracted. It is a real cost — the result is sent
    // once, in full, before it becomes a pointer — and adding it instead
    // overstates the headline by two thirds while leaving all three rows above
    // it correct, which is the only place a reader could catch it.
    assert.equal(
      round(net.netUSD),
      round(
        net.cacheWriteAvoidedUSD - net.uncachedSendUSD + net.cacheReadAvoidedUSD,
      ),
    );
    assert.ok(net.netUSD < net.cacheWriteAvoidedUSD + net.cacheReadAvoidedUSD);
  });

  it("earns on the first request, with no break-even term", () => {
    const net = intakeFilter.netFilterSavings([
      result({ anchor: anchor({ turnsAfter: 0 }) }),
    ]);

    // Nothing is edited, so no cached prefix is thrown away — the whole of what
    // separates this from a prune, which loses money until enough turns follow
    // it. A result nothing followed still nets `2.0·D − 1.0·D`.
    assert.equal(net.cacheReadAvoidedUSD, 0);
    assert.equal(round(net.netUSD), round(TOKENS * PER_TOKEN));
    assert.ok(net.netUSD > 0);
  });

  it("counts a result on an unpriced model and gives it no dollars", () => {
    const net = intakeFilter.netFilterSavings([
      result({ anchor: anchor({ model: "claude-next", turnsAfter: 8 }) }),
    ]);

    // `metering.md`'s rule: unknown is excluded from money and counted, never
    // guessed. $0.00 would assert it saved nothing, and the gap between
    // `results` and `pricedResults` is what the card prints instead.
    assert.equal(net.results, 1);
    assert.equal(net.tokensRemoved, TOKENS);
    assert.equal(net.pricedResults, 0);
    assert.equal(net.netUSD, 0);
  });

  it("leaves a result out that no request ever dropped", () => {
    const net = intakeFilter.netFilterSavings([
      result({ everDropped: false }),
      result({ key: "id:toolu_2" }),
    ]);

    // A deferred result has the cache breakpoint moved in front of it instead,
    // and that move fails silently once a request already holds the maximum
    // number of breakpoints. The ledger does not record which happened, so it
    // is not proved out of the cache and is reported rather than priced.
    assert.equal(net.deferredOnly, 1);
    assert.equal(net.results, 1);
    assert.equal(net.tokensRemoved, TOKENS);
  });

  it("reports how much of the figure rests on the fallback key", () => {
    const net = intakeFilter.netFilterSavings([
      result({ fallbackKeyed: true }),
      result({ key: "id:toolu_2" }),
    ]);

    // Every line this install has written is on it, so a figure that did not
    // say so would be claiming an identity winnow does not yet record.
    assert.equal(net.fallbackKeyed, 1);
    assert.equal(net.results, 2);
  });
});

describe("resultsSince", () => {
  const result = (over: Partial<UniqueResult> = {}): UniqueResult => ({
    key: "id:toolu_1",
    bytes: 36_000,
    requestId: "req_1",
    anchor: anchor(),
    occurrences: 1,
    everDropped: true,
    fallbackKeyed: false,
    ...over,
  });

  const START = Date.UTC(2026, 7, 20, 10, 0, 0);

  it("keeps a result anchored on the window's own start", () => {
    const kept = intakeFilter.resultsSince(
      [
        result({ key: "id:before", anchor: anchor({ ts: START - 1 }) }),
        result({ key: "id:on", anchor: anchor({ ts: START }) }),
        result({ key: "id:after", anchor: anchor({ ts: START + 1 }) }),
      ],
      START,
    );

    // The window meters are `>= startsAt`, and the card prints this as a share
    // of one of them. A `>` here would drop the turn a window opened on out of
    // the share while leaving it in the figure the share is of — a discrepancy
    // of one result, in a card whose whole job is that the two agree.
    assert.deepEqual(
      kept.map((r) => r.key),
      ["id:on", "id:after"],
    );
  });

  it("drops a result no transcript turn could date", () => {
    const kept = intakeFilter.resultsSince(
      [result({ key: "id:unjoined", anchor: null }), result({ key: "id:dated" })],
      START,
    );

    // An unjoined result is counted in the total, where being undated costs
    // nothing. Keeping it here would put a sub-agent's saving — most of this
    // install's ledger — into whichever window happened to be asking, and the
    // 5-hour figure would then move every time the window rolled over rather
    // than when anything was filtered.
    assert.deepEqual(
      kept.map((r) => r.key),
      ["id:dated"],
    );
  });
});
