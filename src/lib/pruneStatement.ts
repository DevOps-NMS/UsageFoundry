import type { ContextPrunerDTO, PruneActivityDTO } from "./apiTypes";

/**
 * How the two engines are named on screen.
 *
 * By what they do to the conversation, never by module name: `legacy`,
 * `winnow` and `cozempic` are all names for the same two behaviours, and none
 * of them tells a first-time reader which one edits their transcript. The
 * settings page reads this rather than keeping its own copy, so the engine is
 * named identically in the three places it now appears.
 */
export const PRUNE_ENGINE_LABEL: Record<ContextPrunerDTO["engine"], string> = {
  legacy: "Edit in place",
  winnow: "Fork",
};

export interface PruneStatement {
  kind: "activity";
  /** The whole sentence. Complete per variant, never assembled at a call site. */
  text: string;
  /** `warn` is a fault an operator can fix; `neutral` is standing context. */
  severity: "neutral" | "warn";
}

/**
 * What is running, in one sentence that is never absent.
 *
 * Split from `pruneStatement` below, and the split is the whole point. That one
 * answers "what happened in this span" and is allowed to say nothing when the
 * money beside it already has. This one answers "what is switched on", which no
 * figure carries and which was therefore missing from every screen: an install
 * with fourteen prunes on the card still could not tell you which of the two
 * engines made them or whether the tool was still present.
 *
 * Never null, and that is deliberate. An absent line is the ambiguity this
 * whole module exists to remove.
 */
export function prunerLine(pruner: ContextPrunerDTO): string {
  const engine = PRUNE_ENGINE_LABEL[pruner.engine].toLowerCase();
  if (pruner.state === "off") {
    return (
      "Context pruning is switched off, so nothing is removed from a run's " +
      "conversation between work cycles."
    );
  }
  if (pruner.state === "unavailable") {
    return (
      `Context pruning is switched on (${engine}), but ${
        pruner.detail ?? "the tool behind it could not be found"
      }. Nothing has been removed at any cycle boundary.`
    );
  }
  return `Context pruning is on, ${engine}.`;
}

/** True where `prunerLine` describes a fault an operator can act on. */
export function prunerIsFault(pruner: ContextPrunerDTO): boolean {
  return pruner.state === "unavailable";
}

/** `3 ended in a cut`, or null when the count is zero and the clause is dropped. */
function clause(n: number, phrase: string): string | null {
  return n > 0 ? `${n} ${phrase}` : null;
}

/**
 * What happened at this span's cycle boundaries, or null when nothing did.
 *
 * `noFigureReason`'s rule one mechanism over: the outcomes call for different
 * actions — a rebuild, a wait, or nothing at all because the arithmetic said so
 * — so they may not share a sentence, and none of them may be `$0.00`.
 *
 * Null in exactly two cases, and neither is ambiguous once `prunerLine` sits
 * beside it: no boundary was reached in the span, or every one of them cut and
 * the figures already say so. A caption restating its own number is noise on the
 * one card built to carry that number.
 */
export function pruneStatement(
  activity: PruneActivityDTO | null | undefined,
): PruneStatement | null {
  if (!activity || activity.boundaries === 0) return null;
  if (activity.cut === activity.boundaries) return null;

  const clauses = [
    clause(activity.cut, "ended in a cut"),
    clause(activity.declined, "left alone on the payback test"),
    clause(activity.nothing, "where nothing was worth removing"),
    clause(activity.refused, "refused by the fork engine"),
    clause(activity.unavailable, "where winnow was not installed"),
    clause(activity.failed, "that could not be read"),
  ].filter((c): c is string => c !== null);

  const detail = activity.lastDetail ? ` Most recently: ${activity.lastDetail}` : "";
  return {
    kind: "activity",
    // A fault only where an operator has something to fix. A decline is the
    // gate working, and a run of them is not a warning.
    severity: activity.unavailable + activity.failed > 0 ? "warn" : "neutral",
    text:
      `${activity.boundaries} cycle ` +
      `${activity.boundaries === 1 ? "boundary" : "boundaries"} in this span: ` +
      `${clauses.join(", ")}.${detail}`,
  };
}
