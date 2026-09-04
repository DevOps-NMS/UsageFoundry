import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  apiContextTokens,
  boundaryAction,
  BOUNDARY_RECHECK_AFTER,
  ceilingDeclineMessage,
  ceilingPayback,
  classifyResume,
  coldAgeRefusalMessage,
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
  parseComposition,
  parseTreatEstimate,
  PLAN_TIER,
  treatRemovedTokens,
  PAYBACK_HORIZON_TURNS,
  CEILING_PAYBACK_HORIZON_TURNS,
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

describe("ceilingPayback — what a manufactured boundary would cost", () => {
  /**
   * The three forks this install actually took, priced against the bill.
   *
   * Each row is a real `fork_attempts` row and the real resume that followed
   * it: `write` is the tokens that resume created at the one-hour class, read
   * out of the new session's first billed turn, and `billed` is that write
   * divided by the `0.1·D` a turn the cut earns back. `netBytes` is the row's
   * own figure.
   *
   * These exist because the gate that was supposed to refuse them read
   * `suffix_bytes` — the tail after the cut line, 70–87k against ~180k written
   * — and priced them at 74, 131 and 275 turns. All three were taken. They cost
   * $5.42 and returned $0.86.
   */
  const MEASURED = [
    { run: "3da14af4", netBytes: 16_839, suffixBytes: 261_172, write: 180_259, billed: 771 },
    { run: "07f9e442", netBytes: 31_962, suffixBytes: 253_583, write: 178_675, billed: 403 },
    { run: "7f361068", netBytes: 63_337, suffixBytes: 311_966, write: 183_187, billed: 209 },
  ];

  it("is not paybackTurns over the suffix, which is what let these through", () => {
    // Pinned so nobody folds the two together again. The suffix is a real
    // quantity and `paybackTurns` prices it correctly; it is simply not what a
    // resume rewrites. Reading these three through it gave 275, 131 and 74
    // turns against a billed 771, 403 and 209 — every one of them less than
    // half the truth, and on the cheapest cut less than a tenth.
    for (const m of MEASURED) {
      const viaSuffix = paybackTurns(
        m.suffixBytes / BYTES_PER_TOKEN,
        m.netBytes / BYTES_PER_TOKEN,
      )!;
      assert.ok(
        viaSuffix < m.billed / 2,
        `${m.run}: the suffix reading gave ${viaSuffix} against a billed ${m.billed}, ` +
          `so it must not be reachable from this decision`,
      );
    }
  });

  for (const m of MEASURED) {
    it(`reproduces the bill on ${m.run}, within a turn`, () => {
      const removed = m.netBytes / BYTES_PER_TOKEN;
      // The conversation as it stood before the cut, in the currency the
      // ceiling reads. `write` is what was left after it.
      const apiContextNow = m.write + removed;
      // `removedTokens` spelled out at the call site rather than derived inside
      // `ceilingPayback`, because the conversion is now the estimator's and
      // differs per engine. These three are `fork_attempts` rows, so the
      // conversion that applies is `ceilingCut`'s winnow branch — `netBytes`
      // over `BYTES_PER_TOKEN` — and the figures below are unchanged by the
      // move.
      const predicted = ceilingPayback(apiContextNow, { removedTokens: removed })!;
      assert.ok(
        Math.abs(predicted - m.billed) <= 1,
        `predicted ${predicted} against a billed ${m.billed}`,
      );
      assert.ok(
        predicted > CEILING_PAYBACK_HORIZON_TURNS,
        "every one of these must now be refused — that is the whole point",
      );
    });
  }

  it("clears the horizon at exactly half the conversation, which is what the constant means", () => {
    // The derivation `CEILING_PAYBACK_HORIZON_TURNS` exists to hold. T* is
    // 20·(1−f)/f, so an exactly-half cut costs 20 — and the horizon is 20 so
    // that it is admitted. Shared with `PAYBACK_HORIZON_TURNS` it was 18, and
    // half priced at 20 was refused by two turns that no decision put there.
    const conversation = 200_000;
    assert.equal(ceilingPayback(conversation, { removedTokens: conversation / 2 }), 20);
    assert.equal(CEILING_PAYBACK_HORIZON_TURNS, 20);

    // And the two constants must not be equal, or the divergence this pins is
    // untestable and the next reader folds them back together.
    assert.notEqual(CEILING_PAYBACK_HORIZON_TURNS, PAYBACK_HORIZON_TURNS);

    const tenth = conversation * 0.1;
    assert.equal(ceilingPayback(conversation, { removedTokens: tenth }), 180);
  });

  it("answers null when there is no measurement, which the caller declines on", () => {
    // The inversion that is the fix. `predictedPayback`'s null means "no history
    // yet" and resolves to prune; this one means "nothing priced it", and the
    // caller must not spend a boundary on it. A number here — 0, or Infinity —
    // would make the gate decide on something nobody measured.
    assert.equal(ceilingPayback(200_000, null), null);
    assert.equal(ceilingPayback(200_000, { removedTokens: 0 }), null);
    assert.equal(ceilingPayback(200_000, { removedTokens: -5 }), null);
  });

  it("does not go negative when the cut is bigger than the conversation", () => {
    // Unreachable through `ceilingCut`'s legacy branch, which takes a share of
    // `apiContextNow` and so cannot exceed it, and bounded but not impossible
    // through the winnow branch: `netBytes` is transcript-measured where
    // `apiContextNow` is API-visible, and the transcript runs high because the
    // intake filter drops results on the wire that Claude Code still writes to
    // disk. Held anyway — this is the floor that stops a units mistake becoming
    // a negative cost.
    assert.equal(ceilingPayback(1_000, { removedTokens: 900_000 }), 0);
  });
});

describe("parseTreatEstimate — the in-place pruner's dry run", () => {
  /**
   * Real output, from `winnow safe run -- treat <session> -rx aggressive` at
   * 1.8.39 in the deployed image, on session `02584a86` — the conversation the
   * ceiling declined on 2026-08-28 while reading `plan`'s 8.0k tokens.
   */
  const REAL = [
    "",
    "  winnow — aggressive prescription",
    "",
    "  Before     311.7K tokens    3.65MB  791 messages",
    "  After      311.7K tokens    1.87MB  791 messages",
    "  Saved           0 tokens (0.0%)  1.79MB freed",
    "  Context  [====----------------] 20% of 1.00M",
    "",
    "  What changed:",
    "    tool-use-result-strip          1.35MB   183 msgs",
    "    envelope-strip                 41.0KB   269 msgs",
    "",
    "  Dry run — pass --execute to apply.",
  ].join("\n");

  it("reads the size and the saving off the summary", () => {
    // Not rounded: both figures exist only to be divided by each other, and a
    // round trip through an integer would cost precision the share cannot spare
    // — winnow prints two decimals at MB, so the share is already ±0.2pp.
    const e = parseTreatEstimate(REAL)!;
    assert.equal(e.totalBytes, 3.65 * 1024 * 1024);
    assert.equal(e.freedBytes, 1.79 * 1024 * 1024);
  });

  it("takes the byte figure and never the token figure beside it", () => {
    // The trap this parse exists to avoid. Under orchestrator-safe mode
    // `metadata-strip` is excluded, so the `usage` frames survive and winnow's
    // exact token count re-anchors on the same turn — it prints "0 tokens
    // (0.0%)" for a cut that halves the file. A parser that took the first
    // number on the line would price every legacy cut at nothing and decline
    // for ever, which is the bug being fixed wearing a different hat.
    const e = parseTreatEstimate(REAL)!;
    assert.ok(e.freedBytes > 0, "the saving must come from the byte column");
  });

  it("reads binary KB and MB, which is what winnow prints", () => {
    // `fmt_bytes` divides by 1024 and 1024², so decimal units would be 2.4%
    // low at MB — small, in the direction of declining, and invisible.
    const e = parseTreatEstimate(
      "  Before      53.2KB  10 messages\n  Saved       22.0KB (41.4%)",
    )!;
    assert.equal(e.totalBytes, 53.2 * 1024);
    assert.equal(e.freedBytes, 22.0 * 1024);
  });

  it("reads a prescription that found nothing rather than failing on it", () => {
    // `-rx gentle` on a real transcript here prints exactly this. Zero is an
    // answer — `ceilingPayback` declines on it — and null is a fault, so the
    // two must not collapse.
    const e = parseTreatEstimate(
      "  Before     194.9K tokens    9.95MB  310 messages\n" +
        "  Saved           0 tokens (0.0%)  0B freed",
    )!;
    assert.equal(e.freedBytes, 0);
  });

  it("is null when the wording moves, rather than reporting a saving of zero", () => {
    // The failure mode worth separating: a winnow release that renames these
    // lines must not read as "nothing worth removing" on every install at once.
    // `estimateTreatCut` files an ops event on this branch.
    assert.equal(parseTreatEstimate("Before 3.65MB\nnothing else"), null);
    assert.equal(parseTreatEstimate("  Saved  1.79MB freed"), null);
    assert.equal(parseTreatEstimate(""), null);
  });
});

describe("parseComposition — what the window is made of", () => {
  /**
   * Real output, verbatim from `winnow safe run -- context <session> --depth 3
   * --json` at the pinned ref, with only the session id, its path and the
   * checkout it names replaced.
   *
   * Kept whole rather than reduced to the fields the parse reads, on
   * `parseTreatEstimate`'s grounds: this is another program's output, nothing
   * here can ask it for a schema, and a fixture trimmed to what today's parser
   * happens to look at cannot fail when the shape around it moves. At depth 3
   * that argument gets sharper rather than weaker — the levels below a band are
   * where winnow composes labels, and a hand-written tree would be this app's
   * idea of that composition rather than winnow's.
   */
  const REAL = `{
  "session": "02584a86-0000-0000-0000-000000000000",
  "path": "/root/.claude/projects/-workspace-repo/02584a86-0000-0000-0000-000000000000.jsonl",
  "records": 339,
  "requests": 78,
  "requests_in_window": 78,
  "model": "claude-opus-5",
  "chars_per_token": 2.6,
  "depth": 3,
  "by_path": false,
  "pooled_by_path": {
    "tools": [
      "Edit",
      "NotebookEdit",
      "Read",
      "Write"
    ],
    "paths": 20,
    "repeated_paths": 1,
    "tokens": {
      "tokens": 28831,
      "kind": "estimated"
    },
    "repeated": {
      "tokens": 6428,
      "percent": 22.2943,
      "kind": "estimated"
    }
  },
  "window": {
    "tokens": 258165,
    "kind": "exact"
  },
  "fullness": null,
  "compaction": {
    "boundaries": 0,
    "dropped": {
      "tokens": 0,
      "kind": "exact"
    },
    "last_boundary": null
  },
  "shedding": {
    "events": [],
    "shed": {
      "tokens": 0,
      "kind": "exact"
    }
  },
  "nodes": [
    {
      "label": "tool traffic",
      "tokens": 118974,
      "kind": "estimated",
      "share": 0.460845,
      "note": "",
      "children": [
        {
          "label": "tool_use inputs",
          "tokens": 56500,
          "kind": "estimated",
          "share": 0.218852,
          "note": "",
          "children": [
            {
              "label": "Write  \\u00d711",
              "tokens": 44057,
              "kind": "estimated",
              "share": 0.170654,
              "note": "",
              "children": []
            },
            {
              "label": "Bash  \\u00d769",
              "tokens": 12076,
              "kind": "estimated",
              "share": 0.046776,
              "note": "",
              "children": []
            },
            {
              "label": "Read  \\u00d711",
              "tokens": 367,
              "kind": "estimated",
              "share": 0.001422,
              "note": "",
              "children": []
            }
          ]
        },
        {
          "label": "Bash results",
          "tokens": 33643,
          "kind": "estimated",
          "share": 0.130316,
          "note": "",
          "children": [
            {
              "label": "$ export  \\u00d75",
              "tokens": 18106,
              "kind": "estimated",
              "share": 0.070133,
              "note": "",
              "children": []
            },
            {
              "label": "$ cd  \\u00d745",
              "tokens": 10030,
              "kind": "estimated",
              "share": 0.038851,
              "note": "",
              "children": []
            },
            {
              "label": "$ grep  \\u00d74",
              "tokens": 3505,
              "kind": "estimated",
              "share": 0.013577,
              "note": "",
              "children": []
            },
            {
              "label": "$ ls",
              "tokens": 642,
              "kind": "estimated",
              "share": 0.002487,
              "note": "",
              "children": []
            },
            {
              "label": "$ npm  \\u00d74",
              "tokens": 488,
              "kind": "estimated",
              "share": 0.00189,
              "note": "",
              "children": []
            },
            {
              "label": "$ echo  \\u00d72",
              "tokens": 304,
              "kind": "estimated",
              "share": 0.001178,
              "note": "",
              "children": []
            },
            {
              "label": "$ node  \\u00d73",
              "tokens": 267,
              "kind": "estimated",
              "share": 0.001034,
              "note": "",
              "children": []
            },
            {
              "label": "$ which",
              "tokens": 86,
              "kind": "estimated",
              "share": 0.000333,
              "note": "",
              "children": []
            },
            {
              "label": "$ find",
              "tokens": 69,
              "kind": "estimated",
              "share": 0.000267,
              "note": "",
              "children": []
            },
            {
              "label": "$ rm",
              "tokens": 54,
              "kind": "estimated",
              "share": 0.000209,
              "note": "",
              "children": []
            },
            {
              "label": "$ set",
              "tokens": 51,
              "kind": "estimated",
              "share": 0.000198,
              "note": "",
              "children": []
            },
            {
              "label": "$ wc",
              "tokens": 41,
              "kind": "estimated",
              "share": 0.000159,
              "note": "",
              "children": []
            }
          ]
        },
        {
          "label": "Read results",
          "tokens": 28352,
          "kind": "estimated",
          "share": 0.109821,
          "note": "",
          "children": [
            {
              "label": "/workspace/repo/src/lib/db.ts  \\u00d73",
              "tokens": 6428,
              "kind": "estimated",
              "share": 0.024899,
              "note": "",
              "children": []
            },
            {
              "label": "/workspace/repo/src/lib/serverLock.ts",
              "tokens": 3879,
              "kind": "estimated",
              "share": 0.015025,
              "note": "",
              "children": []
            },
            {
              "label": "/workspace/repo/Dockerfile",
              "tokens": 3648,
              "kind": "estimated",
              "share": 0.01413,
              "note": "",
              "children": []
            },
            {
              "label": "/workspace/repo/src/lib/logLine.ts",
              "tokens": 3647,
              "kind": "estimated",
              "share": 0.014127,
              "note": "",
              "children": []
            },
            {
              "label": "/workspace/repo/src/lib/config.ts",
              "tokens": 3122,
              "kind": "estimated",
              "share": 0.012093,
              "note": "",
              "children": []
            },
            {
              "label": "/workspace/repo/src/instrumentation.ts",
              "tokens": 2400,
              "kind": "estimated",
              "share": 0.009296,
              "note": "",
              "children": []
            },
            {
              "label": "/workspace/repo/docker-compose.yml",
              "tokens": 2208,
              "kind": "estimated",
              "share": 0.008553,
              "note": "",
              "children": []
            },
            {
              "label": "/workspace/repo/src/lib/transcripts.ts",
              "tokens": 1963,
              "kind": "estimated",
              "share": 0.007604,
              "note": "",
              "children": []
            },
            {
              "label": "/workspace/repo/src/middleware.ts",
              "tokens": 1057,
              "kind": "estimated",
              "share": 0.004094,
              "note": "",
              "children": []
            }
          ]
        },
        {
          "label": "Write results",
          "tokens": 479,
          "kind": "estimated",
          "share": 0.001855,
          "note": "",
          "children": [
            {
              "label": "/tmp/uf-97-correction.md",
              "tokens": 46,
              "kind": "estimated",
              "share": 0.000178,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-summary.md",
              "tokens": 46,
              "kind": "estimated",
              "share": 0.000178,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-1.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-2.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-3.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-4.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-5.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-6.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-7.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-8.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            },
            {
              "label": "/tmp/uf-ops-9.md",
              "tokens": 43,
              "kind": "estimated",
              "share": 0.000167,
              "note": "",
              "children": []
            }
          ]
        }
      ]
    },
    {
      "label": "prefix",
      "tokens": 82313,
      "kind": "derived",
      "share": 0.318839,
      "note": "89,960 exact at the first request in this window, less 7,647 estimated visible before it \\u2014 the system prompt and tool definitions, which no transcript records (--explain prefix)",
      "children": []
    },
    {
      "label": "retained reasoning",
      "tokens": 40831,
      "kind": "derived",
      "share": 0.158159,
      "note": "60 thinking blocks over 60 responses, median 541 tokens per block in this session; the control is 17 responses with no thinking block, median 64 left over",
      "children": []
    },
    {
      "label": "standing configuration",
      "tokens": 6622,
      "kind": "estimated",
      "share": 0.02565,
      "note": "",
      "children": [
        {
          "label": "nested_memory",
          "tokens": 3456,
          "kind": "estimated",
          "share": 0.013387,
          "note": "",
          "children": [
            {
              "label": "~/.claude/rules/typescript.md",
              "tokens": 3456,
              "kind": "estimated",
              "share": 0.013387,
              "note": "",
              "children": []
            }
          ]
        },
        {
          "label": "skill_listing",
          "tokens": 2407,
          "kind": "estimated",
          "share": 0.009323,
          "note": "",
          "children": []
        },
        {
          "label": "agent_listing_delta",
          "tokens": 549,
          "kind": "estimated",
          "share": 0.002127,
          "note": "",
          "children": []
        },
        {
          "label": "deferred_tools_delta",
          "tokens": 155,
          "kind": "estimated",
          "share": 0.0006,
          "note": "",
          "children": []
        },
        {
          "label": "task_reminder",
          "tokens": 55,
          "kind": "estimated",
          "share": 0.000213,
          "note": "",
          "children": []
        }
      ]
    },
    {
      "label": "conversation",
      "tokens": 5670,
      "kind": "estimated",
      "share": 0.021963,
      "note": "",
      "children": [
        {
          "label": "user turns",
          "tokens": 4536,
          "kind": "estimated",
          "share": 0.01757,
          "note": "",
          "children": []
        },
        {
          "label": "assistant text",
          "tokens": 1134,
          "kind": "estimated",
          "share": 0.004393,
          "note": "",
          "children": []
        }
      ]
    },
    {
      "label": "unattributed",
      "tokens": 3755,
      "kind": "residual",
      "share": 0.014545,
      "note": "",
      "children": []
    }
  ],
  "notes": [],
  "derivations": {
    "exact": "read from usage.{input,cache_creation,cache_read}_tokens on the anchoring request",
    "derived": "an exact number minus an estimate",
    "estimated": "payload characters / 2.6 (01- \\u00a72.3; the band is 2.4-3.0)",
    "residual": "the window less everything above it; what no kind accounts for"
  }
}
`;

  it("reads the exact window and every top-level node", () => {
    const c = parseComposition(REAL)!;
    assert.equal(c.window, 258_165);
    assert.deepEqual(
      c.slices.map((s) => s.label),
      [
        "tool traffic",
        "prefix",
        "retained reasoning",
        "standing configuration",
        "conversation",
        "unattributed",
      ],
    );
    // The bands sum to the window by construction — the residual is one of
    // them. A parse that dropped a node would still draw a plausible stack,
    // just one that quietly stops short of its own total.
    assert.equal(
      c.slices.reduce((n, s) => n + s.tokens, 0),
      c.window,
    );
  });

  it("carries the kind, which is the one thing a band cannot show", () => {
    const c = parseComposition(REAL)!;
    const kinds = new Map(c.slices.map((s) => [s.label, s.kind]));
    // `prefix` is two exact readings subtracted, `tool traffic` is characters
    // over a constant, `unattributed` is what nothing accounted for. Drawn
    // identically, and three different claims about how far to trust a figure.
    assert.equal(kinds.get("prefix"), "derived");
    assert.equal(kinds.get("tool traffic"), "estimated");
    assert.equal(kinds.get("unattributed"), "residual");
  });

  it("passes a label through rather than binning it", () => {
    // Winnow owns this vocabulary and has already changed it once. A label this
    // app has not seen must render as itself: folded into an "other" bin it
    // would be indistinguishable from the residual, which is the one node whose
    // whole job is to say what nothing accounted for.
    const c = parseComposition(
      JSON.stringify({
        window: { tokens: 1_000, kind: "exact" },
        nodes: [{ label: "a provenance from a later winnow", tokens: 1_000, kind: "estimated" }],
      }),
    )!;
    assert.equal(c.slices[0].label, "a provenance from a later winnow");
  });

  it("is null with no anchoring request, and zero is not that", () => {
    // Winnow reports a null window when no request in the file was priced —
    // there is nothing exact to apportion, so every figure under it would be an
    // estimate of an estimate. A *measured* zero band is an answer and survives.
    assert.equal(
      parseComposition(JSON.stringify({ window: null, nodes: [] })),
      null,
    );
    const c = parseComposition(
      JSON.stringify({
        window: { tokens: 1_000, kind: "exact" },
        nodes: [
          { label: "tool traffic", tokens: 1_000, kind: "estimated" },
          { label: "conversation", tokens: 0, kind: "estimated" },
        ],
      }),
    )!;
    assert.equal(c.slices.length, 2, "a band measured at zero is a measurement");
  });

  it("is null when the body is not a reading, rather than an empty stack", () => {
    // The `parseTreatEstimate` failure mode in this command's clothes: a winnow
    // release that moves this shape must not read as "this conversation is made
    // of nothing" on every install at once. `contextComposition` writes no row
    // on null, so the graph keeps its last honest reading.
    assert.equal(parseComposition(""), null);
    assert.equal(parseComposition("not json at all"), null);
    assert.equal(parseComposition(JSON.stringify({ window: { tokens: 500 } })), null);
    assert.equal(
      parseComposition(JSON.stringify({ window: { tokens: 500 }, nodes: [] })),
      null,
    );
  });

  it("carries both levels below a band, and a band that has none", () => {
    // The whole of what depth 3 buys: the tool or attachment class, then the
    // artefact. Silent both ways — a parse that stopped at the class would leave
    // a detail view saying "Read results" and nothing about which file, and one
    // that flattened the two would put file paths and tool names in one list
    // where no reader could tell which was which.
    const c = parseComposition(REAL)!;
    const byLabel = new Map(c.slices.map((s) => [s.label, s]));
    assert.deepEqual(
      byLabel.get("tool traffic")!.children.map((n) => n.label),
      ["tool_use inputs", "Bash results", "Read results", "Write results"],
    );
    assert.deepEqual(
      byLabel
        .get("tool traffic")!
        .children.find((n) => n.label === "Read results")!
        .children.slice(0, 2)
        .map((n) => [n.label, n.tokens]),
      [
        ["/workspace/repo/src/lib/db.ts", 6428],
        ["/workspace/repo/src/lib/serverLock.ts", 3879],
      ],
    );
    // `prefix` is a subtraction and `unattributed` is what nothing accounted
    // for; neither decomposes into anything, and an empty subtree on them is
    // winnow's answer rather than a parse that gave up.
    assert.deepEqual(byLabel.get("prefix")!.children, []);
    assert.deepEqual(byLabel.get("unattributed")!.children, []);
  });

  it("lifts winnow's repeat count off the label instead of leaving it in", () => {
    // `context.py`'s `decorate()` welds the count onto the key — `db.ts  ×3`.
    // Silent if it is left there: a detail view keyed on the label treats one
    // file read three times and the same file read four as two different files,
    // and any view rendering the label as a path prints `×3` inside it. The two
    // halves are separate facts and are stored as two.
    const c = parseComposition(REAL)!;
    const reads = c.slices
      .find((s) => s.label === "tool traffic")!
      .children.find((n) => n.label === "Read results")!.children;
    const db = reads.find((n) => n.label === "/workspace/repo/src/lib/db.ts")!;
    assert.equal(db.repeat, 3);
    // Read once, so winnow attached no count. Null rather than 1: 1 would be
    // this app asserting a number winnow never printed.
    assert.equal(reads.find((n) => n.label === "/workspace/repo/Dockerfile")!.repeat, null);
    // Nothing above the artefact level carries one, and a key that ends in
    // something shaped like a count but was never decorated keeps it.
    assert.equal(
      c.slices.find((s) => s.label === "tool traffic")!.children[0].repeat,
      null,
    );
    const literal = parseComposition(
      JSON.stringify({
        window: { tokens: 100, kind: "exact" },
        nodes: [
          {
            label: "tool traffic",
            tokens: 100,
            children: [{ label: "a file called  ×0", tokens: 100 }],
          },
        ],
      }),
    )!;
    assert.equal(literal.slices[0].children[0].label, "a file called  ×0");
    assert.equal(literal.slices[0].children[0].repeat, null);
  });

  it("drops a child it cannot read rather than drawing it at zero", () => {
    // The top level's rule one level down, and it has to be the same rule: a
    // zero says winnow measured nothing there, which is a claim, where a missing
    // child leaves the subtree short of its parent — visible, and the only
    // signal a detail view has that something did not survive the parse.
    const c = parseComposition(
      JSON.stringify({
        window: { tokens: 1_000, kind: "exact" },
        nodes: [
          {
            label: "tool traffic",
            tokens: 1_000,
            kind: "estimated",
            children: [
              { label: "Read results", tokens: 600, kind: "estimated" },
              { label: "no tokens at all", kind: "estimated" },
              { label: "not a number", tokens: "600", kind: "estimated" },
              { label: "", tokens: 100, kind: "estimated" },
              { label: "measured at zero", tokens: 0, kind: "estimated" },
            ],
          },
        ],
      }),
    )!;
    assert.deepEqual(
      c.slices[0].children.map((n) => n.label),
      ["Read results", "measured at zero"],
    );
    assert.ok(
      c.slices[0].children.reduce((n, x) => n + x.tokens, 0) < c.slices[0].tokens,
      "a dropped child must leave the subtree visibly short of its band",
    );
  });

  it("caps a node's children at the largest, and never pools the tail", () => {
    // The one dimension nothing on this path caps: a run may touch any number of
    // distinct files, and each is a row. Silent if the cap took the tail instead
    // — a detail view headed by eleven-token artefacts, with the file that is
    // actually filling the window absent. Shuffled here rather than fed in
    // winnow's own descending order, because the guarantee must not rest on
    // another program's sort.
    const many = Array.from({ length: 200 }, (_, i) => ({
      label: `/workspace/repo/file-${i}.ts`,
      tokens: (i * 977) % 200,
      kind: "estimated",
    }));
    const c = parseComposition(
      JSON.stringify({
        window: { tokens: 100_000, kind: "exact" },
        nodes: [
          {
            label: "tool traffic",
            tokens: 100_000,
            kind: "estimated",
            children: [{ label: "Read results", tokens: 100_000, children: many }],
          },
        ],
      }),
    )!;
    const kept = c.slices[0].children[0].children;
    assert.equal(kept.length, 64);
    const largest = [...many].sort((a, b) => b.tokens - a.tokens).slice(0, 64);
    assert.deepEqual(
      kept.map((n) => n.tokens),
      largest.map((n) => n.tokens),
    );
    // No "other", no residual, nothing summed into a neighbour. The dropped tail
    // is dropped, on the same argument as the line above: a manufactured bin is
    // a node indistinguishable from `unattributed`, whose whole job is to say
    // what nothing accounted for.
    assert.ok(!kept.some((n) => /other/i.test(n.label)));
    assert.ok(
      kept.reduce((n, x) => n + x.tokens, 0) < c.slices[0].children[0].tokens,
      "the tail is gone, not folded in",
    );
  });
});

describe("treatRemovedTokens — a share, never a byte count", () => {
  it("is bounded by the conversation it is subtracted from", () => {
    // The whole reason this is not `freedBytes / BYTES_PER_TOKEN`. Session
    // `02584a86` stood at 3.83 MB against an API context of 258.3k tokens —
    // 14.8 bytes a token — so the 1.79 MB this dry run frees reads as 521k
    // tokens at 3.6, from a 258k-token conversation. `ceilingPayback` would
    // floor the remainder at zero and price the cut at 0 turns: prune always.
    const estimate = { totalBytes: 3_832_363, freedBytes: 1_876_951 };
    const apiContextNow = 258_300;

    const viaBytes = estimate.freedBytes / BYTES_PER_TOKEN;
    assert.ok(
      viaBytes > apiContextNow,
      "the reading this replaces must exceed the conversation, or this proves nothing",
    );
    assert.equal(ceilingPayback(apiContextNow, { removedTokens: viaBytes }), 0);

    const removed = treatRemovedTokens(estimate, apiContextNow);
    assert.ok(removed < apiContextNow);
    assert.equal(removed, 126_506);
  });

  it("prices a real declined crossing at the boundary the physics puts it on", () => {
    // Both measured on 2026-08-28 with the deployed image. The in-place pruner
    // frees about half of these transcripts, so `T*` lands next to the horizon
    // rather than three orders away from it — one side each, which is the
    // answer being right rather than the gate being switched off.
    const declined = treatRemovedTokens(
      { totalBytes: 3_832_363, freedBytes: 1_876_951 },
      258_300,
    );
    assert.equal(ceilingPayback(258_300, { removedTokens: declined }), 21);

    const allowed = treatRemovedTokens(
      { totalBytes: 2_963_312, freedBytes: 1_572_864 },
      254_800,
    );
    assert.ok(ceilingPayback(254_800, { removedTokens: allowed })! <= CEILING_PAYBACK_HORIZON_TURNS);
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

describe("ceilingDeclineMessage — a run left alone still says so", () => {
  const AT_205K = {
    contextTokens: 205_600,
    removedTokens: 17_594,
    turnsNeeded: 209,
    engine: "winnow" as const,
  };

  it("explains itself the first time, numbers and cadence included", () => {
    const m = ceilingDeclineMessage({ ...AT_205K, repeat: false });
    assert.match(m, /17\.6k tokens/, "what a cut would take");
    assert.match(m, /8\.6% of it/, "and what share of the conversation that is");
    assert.match(m, /209 further turns/, "and what it would cost in turns");
    assert.match(m, new RegExp(`limit of ${CEILING_PAYBACK_HORIZON_TURNS}`));
    // The question an operator asks next, answered before they ask it.
    assert.match(m, /Checked again every 25\.0k tokens of growth/);
  });

  it("names the engine that measured, because that is what went wrong", () => {
    // A day of "a cut would remove 8.0k tokens" on an install whose pruner
    // would have removed half the conversation: the figure was `plan`'s, the
    // engine was the in-place pruner, and no line anywhere said which. Both
    // spellings are pinned so a rename on one screen cannot leave this one
    // saying the other thing.
    assert.match(
      ceilingDeclineMessage({ ...AT_205K, engine: "legacy", repeat: false }),
      /pruner in use \(edit in place\)/,
    );
    assert.match(
      ceilingDeclineMessage({ ...AT_205K, engine: "winnow", repeat: true }),
      /pruner in use \(fork\)/,
    );
  });

  it("carries the ceiling's horizon and never the boundary's", () => {
    // The two constants price different formulas, and this line reports the
    // ceiling's decision. Printing 18 beside an answer computed against 20 is
    // the kind of off-by-two nobody reads twice.
    const m = ceilingDeclineMessage({ ...AT_205K, repeat: false });
    assert.ok(
      !new RegExp(`limit of ${PAYBACK_HORIZON_TURNS}\\b`).test(m),
      "the boundary gate's number must not appear on the ceiling's line",
    );
  });

  it("keeps saying it as the run climbs, which is the whole point", () => {
    // A latch here left a run silent for an hour while the gate re-decided
    // behind it. The repeat is shorter, not absent: the numbers are the part
    // that moves, and a share that keeps falling is a run drifting further from
    // ever being worth cutting.
    const later = ceilingDeclineMessage({
      contextTokens: 255_400,
      removedTokens: 15_600,
      turnsNeeded: 307,
      engine: "legacy" as const,
      repeat: true,
    });
    assert.match(later, /255\.4k tokens/);
    assert.match(later, /6\.1% of it/);
    assert.match(later, /307 further turns/);
    assert.ok(
      later.length < ceilingDeclineMessage({ ...AT_205K, repeat: false }).length,
      "a follow-up carries the numbers, not the explanation again",
    );
  });

  it("separates a pruner that found nothing from a measurement that never happened", () => {
    // Two facts that shared one sentence, and they are opposites: a clean
    // conversation on one side, and on the other a winnow that would not run, a
    // wording change in its output, or a transcript that could not be read.
    // Both render as "no cut" and only one of them is the feature working.
    const nothingToCut = ceilingDeclineMessage({
      contextTokens: 240_000,
      removedTokens: 0,
      turnsNeeded: null,
      engine: "legacy",
      repeat: false,
    });
    assert.match(nothingToCut, /pruner in use \(edit in place\) found nothing/);

    const unmeasured = ceilingDeclineMessage({
      contextTokens: 240_000,
      removedTokens: 0,
      turnsNeeded: null,
      engine: null,
      repeat: false,
    });
    assert.match(unmeasured, /nothing here could be measured/);
    assert.notEqual(nothingToCut, unmeasured);
  });

  it("says so plainly when nothing could be priced", () => {
    for (const repeat of [false, true]) {
      const m = ceilingDeclineMessage({
        contextTokens: 240_000,
        removedTokens: 0,
        turnsNeeded: null,
        engine: null,
        repeat,
      });
      assert.match(m, /nothing here could be measured/);
      // Never a percentage of nothing, and never a bare NaN where a figure goes.
      assert.doesNotMatch(m, /NaN|Infinity|0\.0% of it/);
    }
  });
});

describe("coldAgeRefusalMessage — the number that decides it appears in it", () => {
  /**
   * These are the readings this install actually refused on, taken from its own
   * `fork_attempts` rows: four boundaries across two days, `min_cold_age` 30 on
   * every one of them, ages 0.395s to 0.619s. Not one line said "30", so the
   * refusal was read as a hot transcript and chased into this app's defaults
   * while the stored setting sat there unexamined.
   */
  it("names the threshold, which is the only thing that varies", () => {
    const message = coldAgeRefusalMessage(0.463, 30);
    assert.match(message, /30s/, "the threshold must be in the line");
    assert.match(message, /0s old/, "so must the age it was compared against");
  });

  it("says a threshold above zero refuses always, rather than delays", () => {
    const message = coldAgeRefusalMessage(0.395, 30);
    // The distinction the first wording lost. "Not yet" invites waiting;
    // "never" sends the operator to the setting, which is where the fix is.
    assert.match(message, /nothing is ever forked/);
    assert.match(message, /contextPruningForkMinColdAge to 0/);
  });

  it("distinguishes an unset quiet period from a set one", () => {
    // Unset is not lenient: winnow supplies its own hour, and an hour at a
    // boundary is the same off switch a 30 is, reached by a different route.
    assert.match(coldAgeRefusalMessage(0.4, null), /winnow applied its own hour/);
    assert.doesNotMatch(coldAgeRefusalMessage(0.4, null), /set to/);
    assert.match(coldAgeRefusalMessage(0.4, 0), /set to 0s/);
  });

  it("still reads when winnow reported no age at all", () => {
    const message = coldAgeRefusalMessage(null, 30);
    assert.match(message, /younger than the threshold/);
    assert.doesNotMatch(message, /NaN|undefined|null/);
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
    trigger: "boundary" as const,
    contextTokensAfter: null,
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

  it("keeps a boundary fork's unanswered invalidation question", () => {
    // A fork at a *natural* boundary rides the resume the next cycle was going
    // to make anyway — the same claim, unproven in the same way, as the
    // boundary prune's.
    assert.equal(forkCutFromRow(REAL).trigger, "boundary");
    const net = netReceipt(forkCutFromRow(REAL), 10);
    assert.equal(net.invalidationKnown, false);
    assert.equal(net.invalidationUSD, 0);
  });

  it("charges a fork taken at an early end, as the legacy pruner already is", () => {
    // The bug this column exists to close. Every fork used to be filed as a
    // `boundary` whatever moment it was taken at, so a cut at a boundary this
    // app manufactured — by ending a cycle at the context ceiling *in order to
    // cut* — was priced free, while the identical operation under the legacy
    // engine was charged its whole rewrite. Measured on the three forks that
    // first ran here: $0.00 reported against $1.79–1.83 billed.
    const cut = forkCutFromRow({ ...REAL, trigger: "early-end" });
    assert.equal(cut.trigger, "early-end");
    const net = netReceipt(cut, 10);
    assert.equal(net.invalidationKnown, true, "an early end's write is not in doubt");
    assert.ok(net.invalidationUSD > 0, "and it is not free");
  });

  it("reads a row with no trigger as an early end, the conservative way", () => {
    // Rows written before the column. Unknown resolves to *charged* rather than
    // free, because this figure decides whether to keep a feature switched on
    // and the failure that hid this bug for two days was a cost silently
    // reported as zero.
    const { trigger: _dropped, ...noTrigger } = REAL;
    const cut = forkCutFromRow({ ...noTrigger, trigger: null });
    assert.equal(cut.trigger, "early-end");
    assert.ok(netReceipt(cut, 10).invalidationUSD > 0);
  });

  it("prices the rewrite off the forked conversation, not off the suffix", () => {
    // `tokensAfter` is what a resume has to write. The suffix after the cut is
    // not that: on the first three forks here the suffix ran 70–87k against
    // conversations of ~180k, and estimating the write from it put the cost at
    // $0.62–0.69 where $1.79–1.83 was billed.
    const measured = forkCutFromRow({
      ...REAL,
      trigger: "early-end",
      contextTokensAfter: 180_000,
    });
    assert.equal(measured.tokensAfter, 180_000);

    const inferred = forkCutFromRow({ ...REAL, trigger: "early-end" });
    assert.ok(
      measured.tokensAfter > inferred.tokensAfter * 2,
      "the suffix-derived fallback is the one that understates the cost",
    );
    assert.ok(
      netReceipt(measured, 10).invalidationUSD >
        netReceipt(inferred, 10).invalidationUSD,
    );
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
