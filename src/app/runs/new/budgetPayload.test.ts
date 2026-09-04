import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type BudgetFields,
  budgetFromForm,
  modelFromForm,
} from "./budgetPayload";

/**
 * What `POST /api/runs` and `POST /api/templates` are handed, pinned field by
 * field.
 *
 * The bar this clears is the repo's own: silent and expensive. Every limit here
 * has an off state, `null` is what expresses it, and a number left in a box the
 * operator switched off is a valid `BudgetPolicy` — so sending it starts an
 * unattended agent under a cap nobody set, with nothing on the page, in the
 * types or in the log saying so. The window pair fails the other way: the field
 * shows 0–100 and the wire wants 0–1, and `normalizePolicy`'s `frac()` reads a
 * bare 1 as 100%, so a factor-of-a-hundred slip is a guard that never fires.
 *
 * These assertions are the record of what the form sent before it was
 * restructured onto `LimitField`, not a description of what it sends now.
 *
 * The model is pinned here too, and fails a third way: the key's *absence* is
 * what reaches `createRun`'s `input.model ?? settings.defaultModel`, so a form
 * that sends the placeholder it shows — or a `model` key holding the spaces
 * somebody typed — starts a run on a model nobody chose, with nothing on the
 * page or in the types saying which one it was.
 */

const ON: BudgetFields = {
  iterationsCapped: true,
  maxIterations: "5",
  costLimited: true,
  maxRunCostUSD: "5",
  timeLimited: true,
  maxDurationMinutes: "60",
  maxSessionFraction: "80",
  maxWeeklyFraction: "50",
  enforcement: "between-cycles",
  continueAfterDone: false,
};

test("every limit on sends what is in its box, unparsed", () => {
  assert.deepEqual(budgetFromForm(ON), {
    maxIterations: "5",
    maxRunCostUSD: "5",
    maxDurationMinutes: "60",
    maxWeeklyFraction: 0.5,
    maxSessionFraction: 0.8,
    enforcement: "between-cycles",
    continueAfterDone: false,
  });
});

test("a limit switched off sends null, however full its box is", () => {
  // The number stays on the form — switching one back on has to offer a
  // sensible figure rather than an empty field that reads as zero — so this is
  // the case where the box and the wire disagree on purpose.
  const off = budgetFromForm({
    ...ON,
    iterationsCapped: false,
    costLimited: false,
    timeLimited: false,
  });
  assert.equal(off.maxIterations, null);
  assert.equal(off.maxRunCostUSD, null);
  assert.equal(off.maxDurationMinutes, null);
  // And the two window guards are not switches: they are off by being blank.
  assert.equal(off.maxWeeklyFraction, 0.5);
  assert.equal(off.maxSessionFraction, 0.8);
});

test("a blank window guard is off, and a typed 0 is sent as 0", () => {
  const blank = budgetFromForm({
    ...ON,
    maxSessionFraction: "",
    maxWeeklyFraction: "",
  });
  assert.equal(blank.maxSessionFraction, null);
  assert.equal(blank.maxWeeklyFraction, null);

  // Not folded to null here, deliberately: `null`, `""` and `0` all mean "off"
  // and `normalizePolicy` is the one place that says so, so this projection
  // reports what was typed rather than pre-empting the authority. The form
  // refuses a 0 in front of the operator before it ever gets sent.
  const zero = budgetFromForm({
    ...ON,
    maxSessionFraction: "0",
    maxWeeklyFraction: "0",
  });
  assert.equal(zero.maxSessionFraction, 0);
  assert.equal(zero.maxWeeklyFraction, 0);
});

test("a percentage is divided by a hundred exactly once", () => {
  const one = budgetFromForm({ ...ON, maxSessionFraction: "1" });
  assert.equal(one.maxSessionFraction, 0.01);
  const hundred = budgetFromForm({ ...ON, maxWeeklyFraction: "100" });
  assert.equal(hundred.maxWeeklyFraction, 1);
});

test("enforcement and what happens after DONE are carried, never derived", () => {
  for (const enforcement of ["between-cycles", "live", "live-resume"] as const) {
    assert.equal(budgetFromForm({ ...ON, enforcement }).enforcement, enforcement);
  }
  assert.equal(
    budgetFromForm({ ...ON, continueAfterDone: true }).continueAfterDone,
    true,
  );
});

test("a blank model sends no key at all, not an empty one", () => {
  // The absence is the message: `createRun` reads `input.model ??
  // settings.defaultModel`, so the operator who never touched the field is the
  // one asking for whatever Settings says — at the moment the run is created,
  // not the moment the form was drawn.
  assert.deepEqual(modelFromForm(""), {});
  assert.equal("model" in modelFromForm("   "), false);
});

test("a typed model is trimmed and otherwise sent verbatim", () => {
  assert.deepEqual(modelFromForm("claude-opus-5"), { model: "claude-opus-5" });
  assert.deepEqual(modelFromForm("  sonnet\n"), { model: "sonnet" });
  // Not narrowed to anything this build recognises: an alias, a full id and a
  // model released after this code was written are all valid, and an
  // unrecognised one is refused by the CLI, which is where the set is known.
  assert.deepEqual(modelFromForm("claude-next-9"), { model: "claude-next-9" });
});

test("nothing else reaches the budget", () => {
  // `permissionMode`, the agent, the model and the folder go on the run's own
  // payload and never through here — a budget that grew a permission mode would
  // be a second route to `--permission-mode`, which the run door refuses to
  // become, and one that grew a model would put a figure that only moves cost
  // in among the guards that bound it.
  assert.deepEqual(Object.keys(budgetFromForm(ON)).sort(), [
    "continueAfterDone",
    "enforcement",
    "maxDurationMinutes",
    "maxIterations",
    "maxRunCostUSD",
    "maxSessionFraction",
    "maxWeeklyFraction",
  ]);
});
