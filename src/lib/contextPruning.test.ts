import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  apiContextTokens,
  boundaryAction,
  BOUNDARY_RECHECK_AFTER,
  classifyResume,
  contextTokens,
  forkCutFromRow,
  groupPruneSavingsByRun,
  isPruneTier,
  MIN_CONTROL_RESUMES,
  netReceipt,
  BOUNDARY_BREAK_EVEN_BUDGET,
  freshestPayback,
  parseFork,
  parsePlan,
  paybackTurns,
  PLAN_TIER,
  PAYBACK_HORIZON_TURNS,
  PRUNE_TIERS,
  sumPruneSavings,
  type PruneReceiptRow,
} from "./contextPruning";
import { BYTES_PER_TOKEN } from "./fileCostNotice";

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

  it("finds the last turn without reading the whole of a large transcript", () => {
    // The ceiling runs once a minute per live run and no longer has a size gate
    // in front of it, so this reads the tail rather than the file. Silent if it
    // is wrong in this direction: a miss reports the byte estimate instead, the
    // ceiling stops matching what the API carries, and cycles quietly stop being
    // ended. 1.5 MB is past `TAIL_SCAN_BYTES` with the frame inside the window.
    const file = transcript("big-tail.jsonl", [
      { type: "user", message: { role: "user", content: "x".repeat(1_500_000) } },
      usageRecord({ input: 10, create: 0, read: 90_000, output: 5 }),
    ]);
    assert.ok(fs.statSync(file).size > 1_048_576);
    assert.equal(apiContextTokens(file), 90_015);
  });

  it("pays for the whole file when the tail holds no turn at all", () => {
    // One tool result can be larger than the window — the largest transcript on
    // this install is 9.1 MB over 789 lines — so the last frame can sit outside
    // it. Reporting the byte estimate here would be the same silent failure as
    // above, arriving from the one shape the window cannot cover.
    const file = transcript("frame-outside-tail.jsonl", [
      usageRecord({ input: 10, create: 0, read: 90_000, output: 5 }),
      { type: "user", message: { role: "user", content: "x".repeat(1_500_000) } },
    ]);
    assert.equal(apiContextTokens(file), 90_015);
    assert.notEqual(apiContextTokens(file), contextTokens(file));
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

describe("boundaryAction", () => {
  /**
   * The gate that decides whether a cycle boundary prunes at all.
   *
   * Both ways of being wrong are silent, which is why this is pinned rather than
   * left to the call site. Too eager and a run pays `1.9·S` a cycle for cuts
   * that never earn it back — measured with `winnow inspect` on real
   * orchestrated transcripts from this install, `T*` at tier CB runs 68 to 598
   * turns against runs that billed 113 to 520. Too shy and pruning quietly stops
   * for the rest of a run, which looks exactly like the feature being switched
   * off.
   */
  it("prunes when nothing has measured this run yet", () => {
    // The first cut on a run, and the case that decides the gate's character.
    // `predictedPayback` returns null because there is no receipt to read, and
    // null is unmeasured rather than large. The repo's own corpus has
    // always-prune netting +$214.46 over 175 sessions, so an unknown that
    // refused would cost more in aggregate than one that allows.
    assert.equal(boundaryAction(null, 0), "prune");
    assert.equal(boundaryAction(null, 99), "prune");
  });

  it("prunes when the last cut is inside the horizon", () => {
    assert.equal(boundaryAction(PAYBACK_HORIZON_TURNS, 0), "prune");
    assert.equal(boundaryAction(0, 0), "prune");
  });

  it("declines the cut the ungated path would have taken", () => {
    // A tenth-of-the-suffix cut needs 170 further turns. This is the whole
    // point: it is an ordinary-looking prune that removes real tokens and
    // cannot pay for itself, and the boundary path used to wave it through.
    assert.equal(boundaryAction(170, 0), "decline");
    assert.equal(boundaryAction(PAYBACK_HORIZON_TURNS + 1, 0), "decline");
  });

  it("prunes once anyway when the reading it refused on has gone stale", () => {
    // Without this the first decline is permanent: a decline writes no receipt,
    // so the next boundary re-reads the same prediction for ever. `D` is
    // whatever the newest cycle produced, and one cycle that greps a large tree
    // can make it large again — invisible to a stale figure.
    assert.equal(boundaryAction(170, BOUNDARY_RECHECK_AFTER - 1), "decline");
    assert.equal(boundaryAction(170, BOUNDARY_RECHECK_AFTER), "refresh");
  });

  it("refreshes rather than declining for ever, at any age past the limit", () => {
    assert.equal(boundaryAction(5_000, BOUNDARY_RECHECK_AFTER + 10), "refresh");
  });
});

describe("classifyResume", () => {
  /**
   * The observation the boundary accounting turns on, and the one thing in this
   * feature that is a measurement rather than an argument.
   *
   * A cold resume reads only the static head — system prompt and tool
   * definitions, about 15,900 tokens on this install and the same on every turn
   * — and writes the conversation again. A warm one reads the conversation too.
   * Across 1,316 transcripts in `~/.claude/projects` the cold case read a
   * near-constant 15.9k against conversations of 50k–750k, so nothing real sits
   * near the threshold and it does not have to be delicate.
   */
  it("calls a resume cold when it re-wrote the conversation", () => {
    assert.equal(
      classifyResume({ cacheRead: 15_900, cacheWrite5m: 0, cacheWrite1h: 150_000 }),
      "cold",
    );
  });

  it("calls a resume warm when it re-read the conversation", () => {
    assert.equal(
      classifyResume({ cacheRead: 240_000, cacheWrite5m: 0, cacheWrite1h: 4_000 }),
      "warm",
    );
  });

  it("calls a turn that billed nothing cold rather than dividing by zero", () => {
    // The all-zero record the CLI writes at a restart. `firstBilledTurn` filters
    // these out before they reach here, so this is the belt to that braces — but
    // NaN/0 would propagate into `warmShare` and quietly move an install's
    // verdict, which is worse than a wrong answer that is at least a number.
    assert.equal(
      classifyResume({ cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }),
      "cold",
    );
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

  it("charges an unobserved boundary prune nothing, and says it has not checked", () => {
    // The single most consequential line in this feature, and it used to be
    // stronger than the evidence behind it. `--resume` rewrites the cached
    // prefix on the next cycle whether or not anything was removed from it, so
    // the rewrite is the resume's cost and was committed before the prune ran.
    // Charging it here would charge twice for one write — at the 2× class
    // against a saving at 0.1×, a factor of twenty — and every boundary prune
    // would report a loss on the very page built to show whether it earns any.
    //
    // All of that still stands. What changed is that it was implemented as a
    // certainty: `trigger !== "early-end" ? 0`, which put a floor of exactly
    // $0.00 under every boundary net and made "pruning lost money here" a
    // sentence the schema could not express. The $0 stays; the claim to have
    // measured it does not.
    const net = netReceipt(base, 30);
    assert.equal(net.invalidationUSD, 0);
    assert.equal(net.invalidationKnown, false);
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
    const observed = netReceipt(real, 30, {
      cacheRead: 15_900,
      cacheWrite5m: 0,
      cacheWrite1h: 112_113,
    });
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
      cacheRead: 0,
      cacheWrite5m: 100_000,
      cacheWrite1h: 0,
    });
    const oneHour = netReceipt({ ...base, trigger: "early-end" }, 30, {
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 100_000,
    });
    assert.ok(fiveMin.invalidationUSD < oneHour.invalidationUSD);
  });

  it("still charges a boundary prune nothing when the resume wrote, with no control", () => {
    // The resume after a *boundary* prune writes just as much, and handing that
    // observed figure straight to the receipt is the obvious way to break this.
    // It must not be charged on sight: the write may well have been happening
    // anyway, and that is what the whole boundary argument turns on.
    //
    // But the reading is now taken rather than discarded, and with nothing to
    // compare it against the honest answer is that nobody knows — the edit
    // breaks the cache itself, so a cold resume after a prune is equally
    // consistent with "it would have been cold anyway" and "the prune made it
    // cold".
    const net = netReceipt(base, 30, {
      cacheRead: 15_900,
      cacheWrite5m: 0,
      cacheWrite1h: 150_000,
    });
    assert.equal(net.invalidationUSD, 0);
    assert.equal(net.invalidationKnown, false);
  });

  it("settles a boundary prune at nothing once clean resumes show they run cold", () => {
    // The case the standing argument predicts. Plain resumes on this install
    // rewrite their prefix, so the write was committed before the prune ran and
    // the $0 is right — this time as an observation rather than an assertion.
    const net = netReceipt(
      base,
      30,
      { cacheRead: 15_900, cacheWrite5m: 0, cacheWrite1h: 150_000 },
      { cleanResumes: 12, warmShare: 0 },
    );
    assert.equal(net.invalidationUSD, 0);
    assert.equal(net.invalidationKnown, true);
  });

  it("charges a boundary prune when clean resumes show the prefix survives", () => {
    // The case that was unrepresentable before, and the only reason any of this
    // changed. If a plain resume comes back warm on this install, the cached
    // prefix outlives a cycle boundary; a prune that broke it destroyed
    // something that would have been re-read at 0.1×, and the difference is a
    // real cost. Charged against the *pre*-cut conversation, because that is
    // what the unpruned resume would have carried.
    const net = netReceipt(
      base,
      30,
      { cacheRead: 15_900, cacheWrite5m: 0, cacheWrite1h: 150_000 },
      { cleanResumes: 12, warmShare: 0.9 },
    );
    // $5/Mtok for opus-5: 150,000 written at 2.0x, less 250,000 read at 0.1x.
    const perToken = 5 / 1_000_000;
    assert.equal(
      Math.round(net.invalidationUSD * 1e6) / 1e6,
      Math.round((150_000 * perToken * 2.0 - 250_000 * perToken * 0.1) * 1e6) / 1e6,
    );
    assert.equal(net.invalidationKnown, true);
  });

  it("never lets the boundary charge go negative", () => {
    // A resume that wrote less than the read it replaced is a saving, and
    // `cacheSavedUSD` already counts it. Letting the charge go negative would
    // add it a second time — the double-count this function exists to avoid,
    // arriving from the other side.
    const net = netReceipt(
      base,
      30,
      { cacheRead: 15_900, cacheWrite5m: 0, cacheWrite1h: 1_000 },
      { cleanResumes: 12, warmShare: 0.9 },
    );
    assert.equal(net.invalidationUSD, 0);
  });

  it("takes a thin control as no control at all", () => {
    // One clean resume is not a rate. The floor is deliberately low — the effect
    // is close to binary — but it is not one.
    const thin = netReceipt(
      base,
      30,
      { cacheRead: 15_900, cacheWrite5m: 0, cacheWrite1h: 150_000 },
      { cleanResumes: MIN_CONTROL_RESUMES - 1, warmShare: 1 },
    );
    assert.equal(thin.invalidationUSD, 0);
    assert.equal(thin.invalidationKnown, false);
  });

  it("settles a warm resume at nothing, whatever the control says", () => {
    // If the prefix survived this very prune, the edit invalidated nothing —
    // there is no counterfactual to reason about and the control is irrelevant.
    const net = netReceipt(
      base,
      30,
      { cacheRead: 240_000, cacheWrite5m: 0, cacheWrite1h: 4_000 },
      { cleanResumes: 12, warmShare: 0.9 },
    );
    assert.equal(net.invalidationUSD, 0);
    assert.equal(net.invalidationKnown, true);
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

describe("groupPruneSavingsByRun", () => {
  const receipt = (runId: string, tokensRemoved: number): PruneReceiptRow => ({
    ts: Date.UTC(2026, 7, 20),
    runId,
    trigger: "boundary",
    tier: "standard",
    tokensBefore: 100_000,
    tokensAfter: 100_000 - tokensRemoved,
    tokensRemoved,
    model: "claude-opus-5",
  });

  it("keeps each run's money on its own row", () => {
    // The failure this exists for: one page of the runs list is priced in a
    // single pass, so a receipt filed against the wrong run puts one run's
    // saving on another's row — money that is wrong on two rows at once and
    // still sums to the right total, which is what makes it undetectable
    // downstream.
    const rows = [receipt("r1", 40_000), receipt("r2", 10_000), receipt("r1", 20_000)];
    const grouped = groupPruneSavingsByRun(
      rows.map((row) => ({ row, net: netReceipt(row, 10) })),
    );

    assert.equal(grouped.get("r1")?.prunes, 2);
    assert.equal(grouped.get("r1")?.tokensRemoved, 60_000);
    assert.equal(grouped.get("r2")?.prunes, 1);
    assert.equal(grouped.get("r2")?.tokensRemoved, 10_000);
    // Twice the tokens over the same turns at the same rate, so the money has
    // to divide the same way the tokens do.
    const r1 = grouped.get("r1")?.netUSD ?? 0;
    const r2 = grouped.get("r2")?.netUSD ?? 0;
    assert.ok(r2 > 0);
    assert.ok(Math.abs(r1 / r2 - 6) < 1e-9);
  });

  it("omits a run with no receipts rather than reporting it at zero", () => {
    // The list renders a dash for absent and a signed figure for present, and
    // those are different claims: pruning did not run here, against pruning ran
    // and earned nothing.
    const grouped = groupPruneSavingsByRun([]);
    assert.equal(grouped.size, 0);
    assert.equal(grouped.has("r1"), false);
  });
});

describe("parsePlan", () => {
  /**
   * The reader for `winnow plan --json`.
   *
   * Pinned because every way it can be wrong is silent. This body is produced
   * by another program in another language, on a schedule nobody here controls,
   * and its output is written straight into a table an operator will later use
   * to decide between two rule engines. A field that quietly reads 0 because a
   * key moved is a comparison that says the new engine removes nothing.
   */
  const real = JSON.stringify({
    session_id: "abc",
    selection: { tier: "CB", rules: ["B1", "B2", "C1", "C2", "C3"] },
    results: { tool_calls: 60, stripped: 8, refused_by_g4: 0 },
    bytes: { removed: 24029, pointer_overhead: 1304, net: 22725 },
    arithmetic: { suffix_bytes: 122902, break_even_turns: 82.8 },
  });

  it("reads a real body", () => {
    // The figures are from an actual `winnow safe run -- plan <path> --tier CB
    // --json` over a transcript on this install, not invented.
    const plan = parsePlan(real);
    assert.ok(plan);
    assert.equal(plan.tier, "CB");
    assert.equal(plan.toolCalls, 60);
    assert.equal(plan.stripped, 8);
    assert.equal(plan.removedBytes, 24029);
    assert.equal(plan.pointerOverhead, 1304);
    assert.equal(plan.netBytes, 22725);
    assert.equal(plan.suffixBytes, 122902);
    assert.equal(plan.breakEvenTurns, 82.8);
  });

  it("keeps a missing break-even as null rather than zero", () => {
    // `plan` omits the field when nothing fires — there is no cut, so there is
    // no break-even. Zero would read as "pays immediately", which is the
    // opposite of what happened, and it is the value that would make the new
    // engine look unambiguously better than the one being compared against.
    const plan = parsePlan(
      JSON.stringify({
        selection: { tier: "CB" },
        results: { tool_calls: 12, stripped: 0 },
        bytes: { removed: 0, pointer_overhead: 0, net: 0 },
        arithmetic: { suffix_bytes: 40000 },
      }),
    );
    assert.ok(plan);
    assert.equal(plan.breakEvenTurns, null);
    assert.equal(plan.stripped, 0);
  });

  it("returns null on a body that is not JSON", () => {
    assert.equal(parsePlan("winnow: no such session"), null);
    assert.equal(parsePlan(""), null);
  });

  it("survives a body whose shape moved, without inventing figures", () => {
    // A future winnow that renames `bytes.net` should make this column read 0
    // and be noticed, not read a neighbouring field. Zero is the honest answer
    // for a number that is genuinely absent; the guard is that it never picks
    // up a different one.
    const plan = parsePlan(JSON.stringify({ selection: { tier: "CB" } }));
    assert.ok(plan);
    assert.equal(plan.netBytes, 0);
    assert.equal(plan.removedBytes, 0);
    assert.equal(plan.breakEvenTurns, null);
  });

  it("refuses a non-numeric figure rather than coercing it", () => {
    // `"24029"` is the shape a JSON serialiser change would produce, and
    // Number("24029") would swallow it silently.
    const plan = parsePlan(
      JSON.stringify({
        selection: { tier: "CB" },
        bytes: { removed: "24029", net: null },
        arithmetic: { break_even_turns: "82.8" },
      }),
    );
    assert.ok(plan);
    assert.equal(plan.removedBytes, 0);
    assert.equal(plan.netBytes, 0);
    assert.equal(plan.breakEvenTurns, null);
  });

  it("falls back to the tier it asked for when the body does not name one", () => {
    const plan = parsePlan(JSON.stringify({ results: { tool_calls: 1 } }));
    assert.ok(plan);
    assert.equal(plan.tier, PLAN_TIER);
  });
});

describe("freshestPayback — which engine's record the gates read", () => {
  it("has no prediction when neither engine has cut yet", () => {
    // Null is not a small number, and both callers resolve it to *act*. This is
    // the first-crossing case they are entitled to.
    assert.equal(freshestPayback(null, null), null);
    assert.equal(freshestPayback(undefined, undefined), null);
  });

  it("reads the fork engine's row when that is all there is", () => {
    // The regression this function exists to stop. `prune_receipts` stays empty
    // for a run under the fork engine, so a reader that only knew that table
    // returned null for ever — leaving the boundary gate and the ceiling
    // watcher both permanently open on the engine the app is moving to.
    assert.equal(freshestPayback(null, { ts: 10, s: 702_323, d: 2_625 }), 5063);
  });

  it("takes the newer of the two, whichever engine wrote it", () => {
    const receipt = { ts: 100, s: 100_000, d: 50_000 };
    const fork = { ts: 200, s: 700_000, d: 2_600 };
    assert.equal(freshestPayback(receipt, fork), 5095);
    assert.equal(freshestPayback(receipt, { ...fork, ts: 50 }), 18);
  });

  it("reads S/D as a ratio, so a row in bytes and a row in tokens both work", () => {
    // The two tables count different things and are never combined within a
    // reading. Halving the suffix is 18 turns in either unit.
    assert.equal(freshestPayback(null, { ts: 1, s: 2, d: 1 }), 18);
    assert.equal(freshestPayback(null, { ts: 1, s: 2_000_000, d: 1_000_000 }), 18);
  });

  it("says nothing when the last cut removed nothing", () => {
    assert.equal(freshestPayback({ ts: 1, s: 100, d: 0 }, null), null);
  });
});

describe("parseFork", () => {
  /**
   * The reader for `winnow fork --json`.
   *
   * Both bodies below were produced by running the real command against a real
   * transcript on this install, not written by hand. That matters more here
   * than for `parsePlan`, because this reader decides whether a run switches
   * onto a new conversation, and because the field it depends on most —
   * `written` — is the one a plausible-looking body carries as `false` while
   * still naming a `new_session_id`.
   */
  const REFUSED = JSON.stringify({
    written: false,
    // Present even on a refusal: it is the name the fork *would* have had.
    // Adopting it would point the run's --resume at a file nobody wrote.
    new_session_id: "4356069f-3111-569c-842e-a766dbbfbeab",
    out: "/tmp/warm/4356069f-3111-569c-842e-a766dbbfbeab.jsonl",
    refusals: [
      {
        guard: "cold-age",
        forceable: true,
        reason:
          "this session's last request finished 0s ago, inside the 60m --min-cold-age window, so its prefix may still be cached and the cut is not free (SPEC §7).",
      },
    ],
    cold_age: { seconds: 0.1, threshold: 3600, measured_from: "the newest record timestamp" },
    plan: {
      bytes: { removed: 24029, pointer_overhead: 1304, net: 22725 },
      arithmetic: { suffix_bytes: 122902, break_even_turns: 82.8 },
    },
  });

  const WRITTEN = JSON.stringify({
    written: true,
    new_session_id: "4356069f-3111-569c-842e-a766dbbfbeab",
    out: "/tmp/warm/4356069f-3111-569c-842e-a766dbbfbeab.jsonl",
    refusals: [],
    cold_age: { seconds: 0.1, threshold: 0, measured_from: "the newest record timestamp" },
    plan: {
      bytes: { removed: 24029, pointer_overhead: 1304, net: 22725 },
      arithmetic: { suffix_bytes: 122902, break_even_turns: 82.8 },
    },
  });

  it("never reports a session id for a fork that was not written", () => {
    // The single most consequential assertion in this file. `new_session_id` is
    // present on a refusal because it is derived from the source rather than
    // minted at write time — so a reader that took it on sight would adopt the
    // name of a file that does not exist, and the run's next --resume would
    // fail into a conversation it never had.
    const fork = parseFork(REFUSED);
    assert.ok(fork);
    assert.equal(fork.written, false);
    assert.equal(fork.newSessionId, null);
    assert.equal(fork.out, null);
  });

  it("names the guard that stood, so a refusal does not read as a breakage", () => {
    // `cold-age` at a cycle boundary is the expected outcome and means the cut
    // would not have paid for itself. Reporting it the way a crash is reported
    // would send an operator looking for a broken install every cycle.
    const fork = parseFork(REFUSED);
    assert.ok(fork);
    assert.equal(fork.refusedBy, "cold-age");
    assert.match(fork.reason ?? "", /--min-cold-age/);
    assert.equal(fork.coldAgeSeconds, 0.1);
  });

  it("reads a written fork's id and path", () => {
    const fork = parseFork(WRITTEN);
    assert.ok(fork);
    assert.equal(fork.written, true);
    assert.equal(fork.newSessionId, "4356069f-3111-569c-842e-a766dbbfbeab");
    assert.equal(fork.out, "/tmp/warm/4356069f-3111-569c-842e-a766dbbfbeab.jsonl");
    assert.equal(fork.refusedBy, null);
    assert.equal(fork.netBytes, 22725);
    assert.equal(fork.breakEvenTurns, 82.8);
  });

  /**
   * winnow 1.9.0's own gate, refusing. Produced by running the real command
   * against a real transcript on this install: 2.6 KB of strippable results
   * sitting behind a 686 KB suffix, which needs 5,063 further turns before the
   * 0.1·D it earns each turn covers the 1.9·S it cost once.
   *
   * This app does not arm that gate — `BOUNDARY_BREAK_EVEN_BUDGET` says why —
   * so the body is here to prove the reader keeps working if anyone ever does,
   * and that a refusal on arithmetic reads as a refusal rather than a breakage.
   */
  const REFUSED_BREAK_EVEN = JSON.stringify({
      "written": false,
      "new_session_id": "91ef4603-ef53-56c4-bbf8-af9b8a4b1f1a",
      "out": "/data/projects/91ef4603-ef53-56c4-bbf8-af9b8a4b1f1a.jsonl",
      "refusals": [
          {
              "guard": "break-even",
              "forceable": true,
              "reason": "this cut needs 5,063 further turns to pay for the cache invalidation it causes, and --max-break-even says the session has 60. It removes 2,625 bytes net from behind a 702,323-byte suffix, so S/D is 267.6 and T* = 19·(S/D) − 20 (SPEC §7): the edit costs 1.9·S once and earns back 0.1·D on each later turn. Nothing was written; --force writes it anyway."
          }
      ],
      "cold_age": {
          "seconds": 1209258.407,
          "threshold": 3600,
          "measured_from": "the newest record timestamp"
      },
      "break_even": {
          "turns": 5063.5,
          "budget": 60,
          "pays": false
      },
      "plan": {
          "bytes": {
              "removed": 2787,
              "pointer_overhead": 162,
              "net": 2625
          },
          "arithmetic": {
              "suffix_bytes": 702323,
              "break_even_turns": 5063.5,
              "max_break_even": 60,
              "pays_within_budget": false
          }
      }
  });

  it("reads the break-even guard the same way as any other refusal", () => {
    const fork = parseFork(REFUSED_BREAK_EVEN);
    assert.ok(fork);
    assert.equal(fork.written, false);
    assert.equal(fork.newSessionId, null);
    assert.equal(fork.refusedBy, "break-even");
    assert.equal(fork.breakEvenTurns, 5063.5);
    assert.match(fork.reason ?? "", /--max-break-even/);
  });

  it("does not arm winnow's break-even gate at either moment it forks", () => {
    // A decision, locked, and it covers both callers. A cut only ever happens
    // here where a resume is already committed — the natural boundary, or the
    // one the ceiling watcher manufactures by ending a cycle early — so the
    // `1.9·S` the gate prices is spent whether or not anything is cut. The
    // `WRITTEN` body above is the proof by example: a real fork of this install
    // at 82.8 break-even turns, which winnow's default budget of 60 now refuses.
    //
    // The gate that does belong on the early-end path is the one deciding
    // whether to interrupt at all, and it is already there and is not this.
    assert.equal(BOUNDARY_BREAK_EVEN_BUDGET, null);
    assert.ok((parseFork(WRITTEN)?.breakEvenTurns ?? 0) > 60);
    assert.ok(PAYBACK_HORIZON_TURNS > 0);
  });

  it("returns null on a body that is not JSON, so stderr can be tried next", () => {
    // `cmd_fork` prints its body to stdout on exit 0 and 2 and to stderr on
    // exit 3. The caller parses stdout then stderr, which only works if a
    // non-body parses to null rather than to an empty result.
    assert.equal(parseFork(""), null);
    assert.equal(
      parseFork("winnow: `winnow fork --write` is refused right now: a live Claude process"),
      null,
    );
  });

  it("does not invent a session id when the body has no fields it knows", () => {
    const fork = parseFork(JSON.stringify({ something: "else" }));
    assert.ok(fork);
    assert.equal(fork.written, false);
    assert.equal(fork.newSessionId, null);
    assert.equal(fork.refusedBy, null);
  });

  it("refuses a non-string session id rather than coercing it", () => {
    const fork = parseFork(JSON.stringify({ written: true, new_session_id: 12345 }));
    assert.ok(fork);
    assert.equal(fork.newSessionId, null);
  });
});

describe("forkCutFromRow", () => {
  /**
   * A fork, converted into the terms the netting prices.
   *
   * Both conversions here are silent when wrong. The basis change turns bytes
   * — what `winnow plan`/`fork` report, because SPEC section 6 measures `len()`
   * of the content string — into the tokens the price table is denominated in.
   * And `suffix_bytes` feeds the counterfactual read that decides whether a
   * fork taken over a warm cache shows a loss, which is the one thing this
   * whole panel exists to be able to say.
   *
   * The figures are from a real `winnow fork --write --json` over a transcript
   * on this install: 24,029 bytes out, 22,725 net after pointers, against a
   * 122,902-byte suffix.
   */
  const REAL = {
    ts: 1_000,
    runId: "r",
    removedBytes: 24_029,
    netBytes: 22_725,
    suffixBytes: 122_902,
    model: "claude-opus-5",
  };

  it("counts the net of the cut, not the gross", () => {
    // The pointers winnow writes back are really in the fork. Counting the
    // gross would claim a saving on bytes the conversation still carries.
    const cut = forkCutFromRow(REAL);
    assert.equal(cut.tokensRemoved, Math.round(22_725 / BYTES_PER_TOKEN));
    assert.notEqual(cut.tokensRemoved, Math.round(24_029 / BYTES_PER_TOKEN));
  });

  it("puts a fork on the same basis a prune is already on", () => {
    // `BYTES_PER_TOKEN` rather than winnow's own ÷4, deliberately: a fork and a
    // prune are added together in one figure, and the comparison is only
    // meaningful if both carry the same estimate. Neither is better; they have
    // to match.
    assert.equal(forkCutFromRow(REAL).tokensRemoved, 6_313);
  });

  it("takes the suffix as it stands, because S is already the pre-cut figure", () => {
    // This assertion used to add the removed tokens back on, and was wrong in
    // the way that is hardest to see: both versions produce a plausible number.
    // `winnow plan` computes `suffix_bytes` over the **source** transcript —
    // the file before anything was removed — so the removed bytes are already
    // inside it. Adding them counted them twice, inflating the counterfactual
    // read by 18% on this real fork and understating the invalidation with it.
    const cut = forkCutFromRow(REAL);
    assert.equal(cut.tokensBefore, Math.round(122_902 / BYTES_PER_TOKEN));
    assert.ok(
      cut.tokensBefore > cut.tokensRemoved,
      "the suffix contains the cut, so it cannot be smaller than it",
    );
    assert.equal(cut.tokensAfter, cut.tokensBefore - cut.tokensRemoved);
  });

  it("falls back conservatively for a row written before the column existed", () => {
    // Understating the suffix understates the avoided read, which overstates
    // the invalidation and understates the net. That is the direction to be
    // wrong in on a number that decides whether to keep a feature switched on.
    const old = forkCutFromRow({ ...REAL, suffixBytes: 0 });
    const now = forkCutFromRow(REAL);
    assert.equal(old.tokensBefore, old.tokensRemoved);
    assert.ok(old.tokensBefore < now.tokensBefore);
  });

  it("is a boundary cut, so it inherits the unanswered invalidation question", () => {
    // A fork rides the resume the next cycle was going to make anyway — the
    // same claim, unproven in the same way, as the boundary prune's. It must
    // not be filed as an early end, which is charged its write in full.
    assert.equal(forkCutFromRow(REAL).trigger, "boundary");
    const net = netReceipt(forkCutFromRow(REAL), 10);
    assert.equal(net.invalidationKnown, false);
    assert.equal(net.invalidationUSD, 0);
  });

  it("charges a fork when the control says clean resumes run warm", () => {
    // The row the old accounting could not produce at all. 90,000 tokens
    // written at the one-hour class, less what re-reading the pre-cut
    // conversation would have cost at 0.1x.
    const cut = forkCutFromRow(REAL);
    const net = netReceipt(
      cut,
      4,
      { cacheRead: 15_900, cacheWrite5m: 0, cacheWrite1h: 90_000 },
      { cleanResumes: 5, warmShare: 1 },
    );
    const perToken = 5 / 1_000_000;
    assert.equal(net.invalidationKnown, true);
    assert.equal(
      Math.round(net.invalidationUSD * 1e4) / 1e4,
      Math.round((90_000 * perToken * 2.0 - cut.tokensBefore * perToken * 0.1) * 1e4) / 1e4,
    );
    assert.ok(net.netUSD < 0, "a fork over a warm cache must be able to report a loss");
  });
});
