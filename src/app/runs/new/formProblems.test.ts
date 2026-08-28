import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type RunFormState, runFormProblems } from "./formProblems";

/**
 * Every refusal the new-run form can make, pinned one at a time.
 *
 * The bar this clears is `budgetPayload.test.ts`'s, from the other direction.
 * That one asserts what a limit sends; this one asserts that the form still
 * objects before it sends anything. Both failures are silent: a refusal that
 * stops firing does not throw, does not fail a typecheck and leaves a page that
 * looks right — it just starts the unattended agent the refusal existed to hold
 * back, under a guard the operator was never told was missing.
 *
 * Written as a characterisation of the block that lived inline in `page.tsx`
 * before it was moved here, so these are the record of what the form refused
 * then, not a description of what it ought to refuse.
 */

/** A form with nothing wrong with it: every refusal below is one edit away. */
const CLEAN: RunFormState = {
  mountId: "workspace",
  foldersLoaded: true,
  hasActiveMount: true,
  noMountsUsable: false,
  prompt: "Do the thing",
  agentMissing: false,
  selectedAgent: null,
  iterationsCapped: true,
  effIterations: 5,
  costLimited: true,
  effCost: 5,
  timeLimited: false,
  effMinutes: null,
  noTerminus: false,
  maxSessionFraction: "80",
  effSessionPct: 80,
  maxWeeklyFraction: "",
  effWeeklyPct: null,
};

const focuses = (v: RunFormState) => runFormProblems(v).map((p) => p.focus);

test("a complete form has nothing to say", () => {
  assert.deepEqual(runFormProblems(CLEAN), []);
});

test("a run with nowhere to work is refused, and says which kind of nowhere", () => {
  // Two different sentences behind one focus: no mount chosen is the operator's
  // to fix, no mount *mountable* is not, and offering "choose one" when there is
  // nothing to choose is the failure worth pinning.
  const unchosen = runFormProblems({ ...CLEAN, mountId: "" });
  assert.deepEqual(unchosen.map((p) => p.focus), ["mount"]);
  assert.match(unchosen[0].message, /Choose the workspace/);

  const none = runFormProblems({
    ...CLEAN,
    mountId: "",
    noMountsUsable: true,
  });
  assert.match(none[0].message, /No workspace is mounted/);

  // A named mount that the loaded list does not contain is the same refusal.
  assert.deepEqual(
    focuses({ ...CLEAN, hasActiveMount: false }),
    ["mount"],
  );
  // ...but only once the list has actually landed. A mount cannot be judged
  // missing from a list that has not arrived.
  assert.deepEqual(
    focuses({ ...CLEAN, hasActiveMount: false, foldersLoaded: false }),
    [],
  );
});

test("a blank task is refused, and whitespace is blank", () => {
  assert.deepEqual(focuses({ ...CLEAN, prompt: "" }), ["prompt"]);
  assert.deepEqual(focuses({ ...CLEAN, prompt: "   \n\t " }), ["prompt"]);
});

test("both agent refusals point at the agent, deleted first", () => {
  // Order is what the page reads: it shows one problem per control via `.find`,
  // so if these two ever swapped, an operator whose agent is both gone and
  // unusable would be told to fix a row that no longer exists.
  const both = runFormProblems({
    ...CLEAN,
    agentMissing: true,
    selectedAgent: { name: "Reviewer", usable: false },
  });
  assert.deepEqual(both.map((p) => p.focus), ["agent", "agent"]);
  assert.match(both[0].message, /not in the registry any more/);
  assert.match(both[1].message, /missing its description or its prompt/);
  // The unusable one names the agent, because the operator has several.
  assert.match(both[1].message, /Reviewer/);

  // A usable agent is not a problem.
  assert.deepEqual(
    focuses({ ...CLEAN, selectedAgent: { name: "Reviewer", usable: true } }),
    [],
  );
});

test("a limit switched on with an unreadable box is refused, and off is not", () => {
  // The asymmetry is the point: `null` from an *on* limit is a blank box, which
  // `normalizePolicy` would read as no limit at all.
  assert.deepEqual(focuses({ ...CLEAN, effIterations: null }), ["iters"]);
  assert.deepEqual(focuses({ ...CLEAN, effCost: null }), ["cost"]);
  assert.deepEqual(
    focuses({ ...CLEAN, timeLimited: true, effMinutes: null }),
    ["dur"],
  );

  // Switched off, the same empty box is exactly what is expected.
  assert.deepEqual(
    focuses({ ...CLEAN, iterationsCapped: false, effIterations: null }),
    [],
  );
  assert.deepEqual(focuses({ ...CLEAN, costLimited: false, effCost: null }), []);
});

test("a run with no terminus is refused at the switch, not at the box", () => {
  const p = runFormProblems({ ...CLEAN, noTerminus: true });
  assert.deepEqual(p.map((x) => x.focus), ["cycles-on"]);
  // Immediate: neither limit has a box while it is off, so there is no field to
  // leave, and waiting for a blur that cannot happen would never say it.
  assert.equal(p[0].immediate, true);
});

test("a window guard is refused above 100 and when it will not parse, never when blank", () => {
  // 150 is the case that matters: it is not a stricter guard, it is 1.5%.
  assert.deepEqual(
    focuses({ ...CLEAN, maxSessionFraction: "150", effSessionPct: 150 }),
    ["sess"],
  );
  assert.deepEqual(
    focuses({ ...CLEAN, maxWeeklyFraction: "150", effWeeklyPct: 150 }),
    ["wk"],
  );
  // Typed but unreadable — "abc", or a 0, both of which `positive` gives as null.
  assert.deepEqual(
    focuses({ ...CLEAN, maxSessionFraction: "0", effSessionPct: null }),
    ["sess"],
  );
  // Blank is how these two are switched off; there is no toggle beside them.
  assert.deepEqual(
    focuses({ ...CLEAN, maxSessionFraction: "", effSessionPct: null }),
    [],
  );
  // Exactly 100 is the whole window, and allowed.
  assert.deepEqual(
    focuses({ ...CLEAN, maxWeeklyFraction: "100", effWeeklyPct: 100 }),
    [],
  );
});

test("which refusals wait for a blur and which do not", () => {
  // `immediate` decides whether the form argues with the operator mid-type. An
  // emptiness error must wait; a range error is already true.
  const byFocus = new Map(
    runFormProblems({
      mountId: "",
      foldersLoaded: true,
      hasActiveMount: false,
      noMountsUsable: false,
      prompt: "",
      agentMissing: true,
      selectedAgent: { name: "Reviewer", usable: false },
      iterationsCapped: true,
      effIterations: null,
      costLimited: true,
      effCost: null,
      timeLimited: true,
      effMinutes: null,
      noTerminus: true,
      maxSessionFraction: "150",
      effSessionPct: 150,
      maxWeeklyFraction: "150",
      effWeeklyPct: 150,
    }).map((p) => [p.focus, p.immediate] as const),
  );
  assert.deepEqual(
    [...byFocus].sort(),
    [
      ["agent", true],
      ["cost", false],
      ["cycles-on", true],
      ["dur", false],
      ["iters", false],
      ["mount", false],
      ["prompt", false],
      ["sess", true],
      ["wk", true],
    ],
  );
});
