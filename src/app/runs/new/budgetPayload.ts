import type { EnforcementModeDTO } from "@/lib/apiTypes";

/**
 * The half of the new-run form's values that becomes a `BudgetPolicy` on the
 * wire. `FormValues` on the page extends it with the four answers that do not —
 * the workspace, the folder, the task, the agent, the permission mode.
 *
 * The four limits are strings because blank is meaningful: it is what
 * `normalizePolicy` reads as "no limit", and a number input cannot hold it.
 */
export interface BudgetFields {
  iterationsCapped: boolean;
  maxIterations: string;
  costLimited: boolean;
  maxRunCostUSD: string;
  timeLimited: boolean;
  maxDurationMinutes: string;
  maxSessionFraction: string;
  maxWeeklyFraction: string;
  enforcement: EnforcementModeDTO;
  continueAfterDone: boolean;
}

/**
 * What the form's limits and window guards mean on the wire.
 *
 * Pure, and in a module of its own, because its failure is both silent and
 * expensive: a limit sent as the number still sitting in a box the operator
 * switched off starts an unattended agent under a cap nobody set, and neither
 * the page nor a typecheck would say so.
 * `budgetPayload.test.ts` walks the matrix. Nothing here may import a component
 * or a browser API, or that test stops running — the note beside `Meter.tsx`'s
 * own import says why.
 *
 * Shared by starting a run and by saving a template, so the two cannot describe
 * one form differently: a template that normalised even slightly unlike the run
 * it was saved from would start something other than what was tested.
 */
export function budgetFromForm(v: BudgetFields) {
  return {
    // null is the wire form of "no limit" for all four of these —
    // normalizePolicy maps it to an unset cap rather than to a default. A limit
    // that is off keeps whatever number is in its box, so this reads the
    // picker and never the box.
    maxIterations: v.iterationsCapped ? v.maxIterations : null,
    maxRunCostUSD: v.costLimited ? v.maxRunCostUSD : null,
    maxDurationMinutes: v.timeLimited ? v.maxDurationMinutes : null,
    // Sent as a 0–1 fraction rather than the 0–100 the field shows.
    // normalizePolicy's frac() reads a bare 1 as 100%, so a user typing
    // "1" into a field labelled (%) would otherwise get no guard at all.
    maxWeeklyFraction: v.maxWeeklyFraction
      ? Number(v.maxWeeklyFraction) / 100
      : null,
    maxSessionFraction: v.maxSessionFraction
      ? Number(v.maxSessionFraction) / 100
      : null,
    enforcement: v.enforcement,
    continueAfterDone: v.continueAfterDone,
  };
}

/**
 * What the Model field means on the wire: a `model` key, or no key at all.
 *
 * Beside the budget rather than inside it, and that is the whole reason it is a
 * separate function: a model moves cost and bounds nothing, so a `BudgetPolicy`
 * that grew one would be claiming a guard where there is none — the same line
 * the form draws by putting the field beside the agent instead of among the
 * limits.
 *
 * An object to spread rather than a `string | null`, because *absent* is what a
 * blank field has to send. `createRun` resolves a run's model as
 * `input.model ?? settings.defaultModel`, so the fallback belongs to the run
 * that named none — and the form shows today's default as the input's
 * placeholder rather than pre-filling it, because a pre-filled value would be
 * posted, frozen onto `runs.model`, and would then survive every later change
 * to the setting it was copied from.
 *
 * Trimmed, and otherwise sent verbatim. An alias, a full id, or a name this
 * build has never heard of are all valid — narrowing to a list would refuse the
 * model that ships next week — but whitespace is not a value: `--model "  "` is
 * a spawn the CLI refuses, where a blank field is a run that starts.
 */
export function modelFromForm(raw: string): { model?: string } {
  const model = raw.trim();
  return model ? { model } : {};
}
