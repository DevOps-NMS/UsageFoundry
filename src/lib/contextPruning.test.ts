import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  apiContextTokens,
  contextTokens,
  isPruneTier,
  netReceipt,
  paybackTurns,
  PAYBACK_HORIZON_TURNS,
  PRUNE_TIERS,
  sumPruneSavings,
  type PruneReceiptRow,
} from "./contextPruning";

/**
 * The two decisions behind context pruning that are arithmetic rather than
 * plumbing, and both fail silently.
 *
 * `paybackTurns` decides whether a cycle is ended early. Wrong in one direction
 * it ends a run's cycles for ever chasing a saving that never arrives — each
 * ending paying a full-price rewrite of the conversation — and wrong in the
 * other it never fires, which is indistinguishable from the feature being off
 * because the only thing either produces is a cycle that carries on.
 *
 * `contextTokens` is the whole of what this feature reports. Counting the file
 * rather than the messages inside it is not an approximation, it is a different
 * quantity: measured on a real 2.0 MB transcript here, winnow freed 970 KB of
 * file while removing 290 KB of what is actually sent, so a reader would be told
 * the prune was 3.4× the size it was. Nothing throws either way and the number
 * looks entirely plausible, which is exactly why it is pinned.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uf-ctx-prune-"));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function transcript(name: string, lines: readonly unknown[]): string {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
}

describe("paybackTurns", () => {
  it("is the SPEC's formula, so half the suffix pays back inside the horizon", () => {
    // `19·(S/D) − 20` with S the suffix *before* the cut. Removing half of it
    // makes S/D = 2, so the answer is 18 — which is the number
    // `PAYBACK_HORIZON_TURNS` is set to, and the case winnow's own README names
    // as clearly worth doing. If these two ever disagree the early end stops
    // firing on the one cut everybody agrees pays, and nothing says so.
    //
    // Writing this case as `(1_000, 1_000)` is the mistake the parameter's name
    // guards against: that is not "cut half", it is "cut everything", and it
    // answers 0.
    assert.equal(paybackTurns(1_000, 500), 18);
    assert.ok(
      paybackTurns(1_000, 500)! <= PAYBACK_HORIZON_TURNS,
      "the canonical half-the-suffix cut must clear the horizon the module ships",
    );
  });

  it("refuses a small cut by making it need more turns than a run has", () => {
    // A tenth of the suffix: S/D = 10, so 19·10 − 20 = 170 further turns, which
    // is the second of the two figures winnow's README states. This is
    // the case the whole test exists for — it is a perfectly ordinary-looking
    // prune, it removes real tokens, and paying for it needs more turns than
    // almost any run has. A version of this function that reported bytes, or
    // that dropped the −20, would wave it through.
    assert.equal(paybackTurns(10_000, 1_000), 170);
    assert.ok(paybackTurns(10_000, 1_000)! > PAYBACK_HORIZON_TURNS);
  });

  it("floors at zero rather than going negative on a cut that has already paid", () => {
    // S/D below 20/19 makes the formula negative. "Pays immediately" is the
    // meaning, and a caller comparing against a horizon should not have to know
    // the arithmetic can go below zero to read that correctly.
    assert.equal(paybackTurns(100, 10_000), 0);
  });

  it("answers null when nothing was removed, rather than dividing by zero", () => {
    // The real case, not a defensive one: `gentle` removed literally nothing on
    // a real transcript here, and a prune that finds nothing worth taking is an
    // ordinary outcome. Infinity would compare as "past the horizon" and so
    // happen to behave, but null is the honest answer — there is no edit to pay
    // for — and it is what the caller distinguishes "no history" by.
    assert.equal(paybackTurns(50_000, 0), null);
    assert.equal(paybackTurns(50_000, -5), null);
  });
});

describe("apiContextTokens", () => {
  const usageRecord = (
    prompt: { input: number; create: number; read: number; output: number },
    extra: Record<string, unknown> = {},
  ) => ({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: "hi",
      usage: {
        input_tokens: prompt.input,
        cache_creation_input_tokens: prompt.create,
        cache_read_input_tokens: prompt.read,
        output_tokens: prompt.output,
      },
    },
    ...extra,
  });

  it("reads the whole prompt however it was billed, plus that turn's output", () => {
    // A cached token is still a token the model reads, so the ceiling has to
    // count it. Splitting the same prompt across the three fields must not
    // change the answer.
    const file = transcript("usage.jsonl", [
      usageRecord({ input: 100, create: 900, read: 99_000, output: 500 }),
    ]);
    assert.equal(apiContextTokens(file), 100_500);
  });

  it("takes the last turn, not the first", () => {
    const file = transcript("last.jsonl", [
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
      usageRecord({ input: 10, create: 0, read: 50_000, output: 5 }),
    ]);
    assert.equal(apiContextTokens(file), 50_015);
  });

  it("ignores a sub-agent's turns", () => {
    // A sidechain is its own conversation. Counting it would end a cycle for
    // context this run never carried.
    const file = transcript("sidechain.jsonl", [
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
      usageRecord({ input: 10, create: 0, read: 90_000, output: 5 }, { isSidechain: true }),
    ]);
    assert.equal(apiContextTokens(file), 1_015);
  });

  it("ignores a <synthetic> frame, whose usage is all zeros", () => {
    const file = transcript("synthetic.jsonl", [
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: "",
          usage: { input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ]);
    assert.equal(apiContextTokens(file), 1_015);
  });

  it("is unmoved by message content the API never received", () => {
    // The whole point of the split, in the shape it actually takes here. A tool
    // result winnow's intake filter drops on the wire stays in `message.content`
    // on disk, so `contextTokens` counts it and the ceiling fires against a
    // conversation that was never sent. `usage` reports what was billed, so this
    // reads the same either way.
    //
    // Note this is *not* the `toolUseResult` case — `contextTokens` already
    // ignores that envelope, and the test above holds it to that.
    const plain = transcript("plain.jsonl", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
    ]);
    const fat = transcript("fat.jsonl", [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: "x".repeat(400_000) },
          ],
        },
      },
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
    ]);
    assert.equal(apiContextTokens(plain), apiContextTokens(fat));
    assert.ok(contextTokens(fat) > contextTokens(plain) + 90_000);
  });

  it("falls back to the byte estimate when no usage frame exists", () => {
    // Zero would read as "this run is empty" and silently disable the ceiling,
    // which is the one failure this must not have.
    const file = transcript("nousage.jsonl", [
      { type: "assistant", message: { role: "assistant", content: "x".repeat(40_000) } },
    ]);
    assert.equal(apiContextTokens(file), contextTokens(file));
    assert.ok(apiContextTokens(file) > 0);
  });

  it("returns 0 for a transcript it cannot read", () => {
    assert.equal(apiContextTokens("/nonexistent/nope.jsonl"), 0);
  });
});

describe("contextTokens", () => {
  it("counts the message and ignores the envelope around it", () => {
    // The 3.4× overstatement, in miniature. Both records carry the same tiny
    // message; the second also carries a large `toolUseResult`, which the CLI
    // writes into the transcript and never sends to the API. A reading that
    // counted the file would report the second record as far larger than the
    // first, and every prune that removed one would be credited with a saving
    // nobody was ever billed for.
    const small = transcript("small.jsonl", [
      { type: "assistant", message: { role: "assistant", content: "hi" } },
    ]);
    const withEnvelope = transcript("envelope.jsonl", [
      {
        type: "assistant",
        message: { role: "assistant", content: "hi" },
        toolUseResult: { stdout: "x".repeat(50_000) },
      },
    ]);
    assert.equal(contextTokens(small), contextTokens(withEnvelope));
  });

  it("skips a record with no message at all", () => {
    // Summaries, file-history snapshots and compaction boundaries all sit in the
    // transcript carrying no `message`. Counting them would put content in the
    // total that no turn ever carried.
    const file = transcript("nomsg.jsonl", [
      { type: "summary", summary: "x".repeat(10_000) },
      { type: "assistant", message: { role: "assistant", content: "hi" } },
    ]);
    const only = transcript("only.jsonl", [
      { type: "assistant", message: { role: "assistant", content: "hi" } },
    ]);
    assert.equal(contextTokens(file), contextTokens(only));
  });

  it("survives the torn trailing line a live transcript always has", () => {
    // This runs against a file the CLI is appending to, so the last line is
    // routinely half-written. Throwing here would take out the ceiling check for
    // every run on the tick, and returning 0 would read as "the conversation is
    // empty" — which is below every threshold, so the ceiling would simply stop
    // firing.
    const file = path.join(TMP, "torn.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ message: { role: "user", content: "hello there" } })}\n{"message":{"rol`,
    );
    assert.ok(contextTokens(file) > 0);
  });

  it("answers 0 for a file that is not there rather than throwing", () => {
    // Every caller is on the run loop's path. A transcript that has been swept,
    // or a session id that resolves to nothing, must not end a cycle that is
    // otherwise fine.
    assert.equal(contextTokens(path.join(TMP, "absent.jsonl")), 0);
  });
});

describe("PRUNE_TIERS", () => {
  it("does not offer gentle, which cannot do anything here", () => {
    // Measured: `gentle` freed 0 bytes on a real 2.0 MB transcript, because its
    // one strategy that fires on an ordinary session is `metadata-strip` and
    // orchestrator-safe mode excludes that by name — it deletes the `usage`
    // frames every window and every budget guard in this app is computed from.
    // Offering it would be a control that reads as on and provably does nothing.
    assert.equal(isPruneTier("gentle"), false);
    assert.deepEqual([...PRUNE_TIERS], ["standard", "aggressive"]);
  });

  it("refuses anything else, because the value reaches a child's argv", () => {
    // `-rx <tier>`. Winnow answers an unknown prescription by falling back to a
    // lighter one rather than failing, so a typo would prune less than the
    // operator asked for, on every cycle, with nothing anywhere saying so.
    assert.equal(isPruneTier("Standard"), false);
    assert.equal(isPruneTier(""), false);
    assert.equal(isPruneTier(undefined), false);
    assert.equal(isPruneTier("standard"), true);
  });
});

describe("netReceipt", () => {
  const base: PruneReceiptRow = {
    ts: Date.UTC(2026, 7, 20),
    runId: "r1",
    trigger: "boundary",
    tier: "standard",
    tokensBefore: 250_000,
    tokensAfter: 180_000,
    tokensRemoved: 70_000,
    model: "claude-opus-5",
  };

  it("charges a boundary prune nothing, because the resume was paying anyway", () => {
    // The single most consequential line in this feature. `--resume` rewrites
    // the cached prefix on the next cycle whether or not anything was removed
    // from it, so the rewrite is the resume's cost and was committed before the
    // prune ran. Charging it here would charge twice for one write — and it
    // would do so at the 2× class against a saving at 0.1×, which is a factor of
    // twenty. Every boundary prune would then report a loss, and the feature
    // would look like it was costing money on the very page built to show
    // whether it earns any.
    const net = netReceipt(base, 30);
    assert.equal(net.invalidationUSD, 0);
    assert.ok(net.netUSD > 0);
    assert.equal(net.netUSD, net.cacheSavedUSD);
  });

  it("charges an early end for the resume it manufactured", () => {
    // The other half, and the reason `trigger` is a stored column rather than a
    // label. This boundary was not going to happen, so the write it causes is
    // genuinely new cost and is priced against what the resume actually writes —
    // the pruned conversation, `tokensAfter`.
    const early = netReceipt({ ...base, trigger: "early-end" }, 30);
    assert.ok(early.invalidationUSD > 0);
    assert.ok(
      early.netUSD < netReceipt(base, 30).netUSD,
      "the same cut must be worth less when it had to buy its own boundary",
    );
  });

  it("prices an early end off the write that actually happened", () => {
    // The correction this test exists for, and it was found by measurement
    // rather than by reading the code. `tokensAfter` is an estimate over the
    // transcript's `message` content; the resume writes the *whole* context,
    // including the system prompt, the tool definitions, `CLAUDE.md` and the
    // three appended notices — none of which are in the transcript. Over the
    // first four prunes on this install the estimate charged against 405,049
    // tokens where the resumes actually wrote 485,828: 16.6% under, one-sided,
    // and enough to overstate the net by about 15%.
    //
    // One-sided is the part that matters. The removal figure's ±3% is a
    // difference between two readings of the same file, so the offset cancels;
    // this is an absolute, so it does not.
    // Receipt 1 as it actually happened on this install, so the direction below
    // is the measured one rather than a property of a made-up fixture.
    const real: PruneReceiptRow = {
      ...base,
      trigger: "early-end",
      tokensBefore: 167_666,
      tokensAfter: 91_380,
      tokensRemoved: 76_286,
    };
    const observed = netReceipt(real, 30, { cacheWrite5m: 0, cacheWrite1h: 112_113 });
    const estimated = netReceipt(real, 30);
    assert.ok(
      observed.invalidationUSD > estimated.invalidationUSD,
      "the measured write is larger than the content estimate, so ignoring it flatters the net",
    );
    // $5/Mtok input for opus-5, 2.0x for the one-hour write class.
    assert.equal(
      Math.round(observed.invalidationUSD * 1e4) / 1e4,
      Math.round(112_113 * (5 / 1_000_000) * 2.0 * 1e4) / 1e4,
    );
  });

  it("charges the two write classes at their own rates", () => {
    // The row carries both, and an install writing at the five-minute class
    // would be charged 2x for a 1.25x write if this collapsed them.
    const fiveMin = netReceipt({ ...base, trigger: "early-end" }, 30, {
      cacheWrite5m: 100_000,
      cacheWrite1h: 0,
    });
    const oneHour = netReceipt({ ...base, trigger: "early-end" }, 30, {
      cacheWrite5m: 0,
      cacheWrite1h: 100_000,
    });
    assert.ok(fiveMin.invalidationUSD < oneHour.invalidationUSD);
  });

  it("still charges a boundary prune nothing, whatever the resume wrote", () => {
    // The resume after a *boundary* prune writes just as much, and it must not
    // be charged: that write was happening anyway. Handing the observed figure
    // to a boundary receipt is the obvious way to break this, so it is pinned.
    const net = netReceipt(base, 30, { cacheWrite5m: 0, cacheWrite1h: 150_000 });
    assert.equal(net.invalidationUSD, 0);
  });

  it("saves nothing when no turn has followed it yet", () => {
    // A prune measured the instant it happens has saved exactly nothing, and
    // saying so is the point: this is a measurement over turns that have already
    // run, not a projection of turns that might. A version that reported the
    // hoped-for saving up front would show a large number that quietly shrank if
    // the run ended.
    assert.equal(netReceipt(base, 0).cacheSavedUSD, 0);
    assert.equal(netReceipt(base, 0).netUSD, 0);
  });

  it("marks an unpriced model unpriced rather than reporting a zero saving", () => {
    // `metering.md`'s rule. A prune on a model with no price here saved whatever
    // it saved; reporting $0.00 asserts it saved nothing, which is a different
    // and false claim. The flag is what lets the page say the money covers only
    // some of the prunes behind it.
    const net = netReceipt({ ...base, model: "some-model-nobody-priced" }, 30);
    assert.equal(net.priced, false);
    assert.equal(net.netUSD, 0);
    assert.equal(netReceipt(base, 30).priced, true);
  });

  it("prices at the receipt's own date, not at today's list", () => {
    // Sonnet 5 carried an introductory rate that expires, so the same prune is
    // worth different amounts depending on which day it is priced on. A read-time
    // lookup would reprice last month's history every time the page loaded.
    // Both instants are fixed, so this says the same thing whenever it is run —
    // a `Date.now()` here would have started passing or failing on its own the
    // day the introductory rate expired.
    const sonnet = { ...base, model: "claude-sonnet-5" };
    const intro = netReceipt({ ...sonnet, ts: Date.parse("2026-08-01T00:00:00Z") }, 30);
    const list = netReceipt({ ...sonnet, ts: Date.parse("2026-10-01T00:00:00Z") }, 30);
    assert.ok(intro.priced && list.priced);
    assert.ok(
      intro.cacheSavedUSD < list.cacheSavedUSD,
      "a prune during the introductory rate saved less money for the same tokens",
    );
  });
});

describe("sumPruneSavings", () => {
  it("counts priced and unpriced prunes apart", () => {
    // So the page can say what the money covers. A total that silently omitted
    // the unpriced ones would be a smaller number wearing the same label.
    const row: PruneReceiptRow = {
      ts: Date.UTC(2026, 7, 20),
      runId: "r1",
      trigger: "boundary",
      tier: "standard",
      tokensBefore: 100_000,
      tokensAfter: 60_000,
      tokensRemoved: 40_000,
      model: "claude-opus-5",
    };
    const summed = sumPruneSavings([
      { row, net: netReceipt(row, 10) },
      { row: { ...row, model: null }, net: netReceipt({ ...row, model: null }, 10) },
    ]);
    assert.equal(summed.prunes, 2);
    assert.equal(summed.pricedPrunes, 1);
    // Tokens are counted for both: what came out is known whatever it cost.
    assert.equal(summed.tokensRemoved, 80_000);
  });

  it("is zero for no receipts rather than NaN", () => {
    assert.deepEqual(sumPruneSavings([]).netUSD, 0);
    assert.deepEqual(sumPruneSavings([]).prunes, 0);
  });
});
