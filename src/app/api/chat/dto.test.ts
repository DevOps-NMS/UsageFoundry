import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { BudgetPolicy } from "../../../lib/budget";
import type { RunTemplate } from "../../../lib/templates";
import { spellGuards } from "./dto";

/**
 * The sentence every proposal card is approved against.
 *
 * `spellGuards` is the whole of what a reader is told about what a press of
 * Approve authorises, and it has two callers whose figures come from different
 * places — the operator's default guard set, and a template they wrote. Its
 * failure is the kind this suite is reserved for: a card asserting a ceiling
 * the run does not have throws nothing, fails no typecheck, renders as an
 * ordinary card, and the money is spent under the number nobody was shown.
 *
 * So both callers' shapes are pinned against one expected string, which is the
 * property that matters — a second spelling for the templated case would pass a
 * test written against either one alone and diverge the day a limit is added.
 * The null cases are pinned beside them because `null` is this app's wire form
 * of "no limit at all": a cap invented for one, or a real one dropped, are the
 * two directions the same clause fails in.
 */

function budget(over: Partial<BudgetPolicy> = {}): BudgetPolicy {
  return {
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    maxRunCostUSD: null,
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxIterations: null,
    maxDurationMinutes: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
    ...over,
  };
}

const CAPPED = budget({
  maxIterations: 12,
  maxDurationMinutes: 45,
  maxRunCostUSD: 4,
  maxRunCostFactor: null,
});

test("the default guard set is spelled out in full", () => {
  assert.equal(
    spellGuards({
      permissionMode: "acceptEdits",
      isolate: true,
      budget: CAPPED,
    }),
    "acceptEdits · own checkout · 12 cycles · 45 min · $4.00",
  );
});

test("a template's own guards are spelled out by the same function", () => {
  // A whole `RunTemplate`, not a triple picked off one: this is the call site
  // `guardsDetail` is built at, and what it proves is that the card behind the
  // name and the card that has no name to give cannot say different things
  // about one guard set.
  const template: RunTemplate = {
    id: "t1",
    name: "Bug fix",
    prompt: "Fix the failing test.",
    mountId: "work",
    folder: "app",
    isolate: true,
    permissionMode: "acceptEdits",
    agentId: null,
    // Named, and deliberately absent from the sentence below: a model moves
    // cost and bounds nothing, so a guard line that mentioned it would be
    // claiming it guards something.
    model: "claude-sonnet-5",
    budget: CAPPED,
    createdAt: 0,
    updatedAt: 0,
  };

  assert.equal(
    spellGuards(template),
    "acceptEdits · own checkout · 12 cycles · 45 min · $4.00",
  );
});

test("a limit that is off is left out rather than invented", () => {
  // No cycle cap, no deadline, no ceiling — which is a legal guard set the
  // install's own limits still bound. A zero, a dash or an omitted separator
  // here would each read as a figure somebody set.
  assert.equal(
    spellGuards({
      permissionMode: "bypassPermissions",
      isolate: false,
      budget: budget(),
    }),
    "bypassPermissions · your folder",
  );
});

test("one cycle is one cycle", () => {
  assert.equal(
    spellGuards({
      permissionMode: "default",
      isolate: false,
      budget: budget({ maxIterations: 1, maxRunCostUSD: 0.5 }),
    }),
    "default · your folder · 1 cycle · $0.50",
  );
});
