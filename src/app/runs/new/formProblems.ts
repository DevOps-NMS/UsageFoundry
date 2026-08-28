/**
 * Something that would stop this run from starting, said where it is wrong.
 *
 * `immediate` separates the two kinds. A range error ("150 is not a
 * percentage") is true the moment it is typed and worth saying then. An
 * emptiness error is not an error yet while the field still has the cursor in
 * it, so it waits for the operator to leave — a form that turns red under the
 * caret is a form that argues with you as you type.
 */
export interface Problem {
  /** The control to put the cursor in when the operator asks what is missing. */
  focus: string;
  message: string;
  immediate: boolean;
}

/**
 * Everything the refusals below read, resolved by the page.
 *
 * The four `eff*` figures arrive already through `positive()` because the page
 * needs them anyway for its summary, and a second reading here could disagree
 * with the one the operator is looking at. The raw percent strings come too:
 * blank is not the same answer as out of range, and only the string says which.
 */
export interface RunFormState {
  mountId: string;
  foldersLoaded: boolean;
  hasActiveMount: boolean;
  noMountsUsable: boolean;
  prompt: string;
  agentMissing: boolean;
  selectedAgent: { name: string; usable: boolean } | null;
  iterationsCapped: boolean;
  effIterations: number | null;
  costLimited: boolean;
  effCost: number | null;
  timeLimited: boolean;
  effMinutes: number | null;
  noTerminus: boolean;
  maxSessionFraction: string;
  effSessionPct: number | null;
  maxWeeklyFraction: string;
  effWeeklyPct: number | null;
}

/**
 * Every reason this form would refuse to start a run.
 *
 * Pure, and in a module of its own, for `budgetFromForm`'s reason: a refusal
 * that quietly stops firing starts the unattended agent it existed to hold
 * back, and neither the page nor a typecheck would say so. `formProblems.test.ts`
 * walks each one. Nothing here may import a component or a browser API, or that
 * test stops running — the note beside `budgetPayload.ts` says why, and it is
 * also why every message is a plain string rather than the markup some of the
 * descriptions around them use.
 *
 * **Order is load-bearing.** The page shows one problem per control and finds it
 * with `.find()`, so where two refusals name the same control — a deleted agent
 * and an unusable one both point at `agent` — the first one pushed is the one
 * the operator reads.
 */
export function runFormProblems(v: RunFormState): Problem[] {
  const problems: Problem[] = [];
  if (!v.mountId || (v.foldersLoaded && !v.hasActiveMount)) {
    problems.push({
      focus: "mount",
      message: v.noMountsUsable
        ? "No workspace is mounted, so there is nowhere for a run to work."
        : "Choose the workspace this run should work in.",
      immediate: false,
    });
  }
  if (v.prompt.trim() === "") {
    problems.push({
      focus: "prompt",
      message: "Describe what Claude should work on.",
      immediate: false,
    });
  }
  // The refusal `POST /api/runs` will give, said beside the control instead of
  // after a round trip. Immediate, because nothing the operator does to this row
  // except changing it can clear it, and it is usually a template naming an
  // agent that has been deleted since it was saved.
  if (v.agentMissing) {
    problems.push({
      focus: "agent",
      message:
        "That agent is not in the registry any more, so this run cannot start. Pick another one, or start with none.",
      immediate: true,
    });
  }
  if (v.selectedAgent && !v.selectedAgent.usable) {
    problems.push({
      focus: "agent",
      message: `“${v.selectedAgent.name}” is missing its description or its prompt, and Claude Code will not register an agent like that — the run would fail the moment it spawned. Fix it, or start with none.`,
      immediate: true,
    });
  }
  if (v.iterationsCapped && v.effIterations === null) {
    problems.push({
      focus: "iters",
      message: "Set at least one work cycle, or switch the cycle limit off.",
      immediate: false,
    });
  }
  if (v.costLimited && v.effCost === null) {
    problems.push({
      focus: "cost",
      message:
        "Enter an amount above $0, or switch the spending limit off — a blank box starts a run with no spending limit at all.",
      immediate: false,
    });
  }
  if (v.timeLimited && v.effMinutes === null) {
    problems.push({
      focus: "dur",
      message:
        "Enter a number of minutes, or switch the time limit off — a blank box starts a run with no time limit at all.",
      immediate: false,
    });
  }
  if (v.noTerminus) {
    problems.push({
      // Neither limit has a value box while it is switched off, so this points
      // at the switch that brings one back — which is stable in both states,
      // where the number input only exists in one of them.
      focus: "cycles-on",
      message:
        "Set a time limit, or cap the work cycles. Nothing else here only moves one way, so without one of them nothing would ever end this run.",
      immediate: true,
    });
  }
  // Above 100 is not a stricter guard, it is a hundredth of one: the form sends
  // a fraction and `normalizePolicy` divides anything over 1 by a hundred
  // again, so a typed 150 arrives as 1.5%.
  if (
    v.maxSessionFraction !== "" &&
    !(v.effSessionPct !== null && v.effSessionPct <= 100)
  ) {
    problems.push({
      focus: "sess",
      message: "The 5-hour guard has to be between 1 and 100 percent.",
      immediate: true,
    });
  }
  if (
    v.maxWeeklyFraction !== "" &&
    !(v.effWeeklyPct !== null && v.effWeeklyPct <= 100)
  ) {
    problems.push({
      focus: "wk",
      message: "The weekly guard has to be between 1 and 100 percent.",
      immediate: true,
    });
  }
  return problems;
}
