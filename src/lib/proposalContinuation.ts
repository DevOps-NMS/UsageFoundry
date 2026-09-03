import type { ProposalDependency, ProposalStatus } from "./chat";

/**
 * One proposal of a chat, as the continuation rule reads it.
 *
 * A structural shape rather than `ChatProposalRow`, so this module imports
 * nothing at runtime: `chat.ts` reaches `config.ts`, which binds `DATA_DIR` at
 * module load, and a pure rule about labels should not be a reason to open a
 * database. The caller passes `proposalDeps(row)` in already parsed, which is
 * also what keeps the unreadable-column reading in the one place that owns it.
 */
export interface ContinuationCandidate {
  /** The chat's own label for this proposal, or null when it named none. */
  specId: string | null;
  title: string;
  status: ProposalStatus;
  dependsOn: readonly ProposalDependency[];
}

/**
 * The proposal of this chat already set to carry on `label`'s branch, or null.
 *
 * Two runs cannot extend one branch, and `admitDependencies` is what actually
 * refuses it: against the live `runs` table, when the operator clicks Approve,
 * naming two run ids that were on no card — and it also catches a proposal
 * continuing a run this chat never proposed, which nothing here can see. This
 * is the earlier half rather than a replacement. `propose_run` refuses the
 * second proposal as it is written, in the labels the model chose, for the
 * reason that whole function is deliberately stricter than it has to be.
 *
 * Only a **pending** rival counts, and both halves of that matter. A rejected
 * or failed proposal never became a run and holds no branch — the reading the
 * two checks beside this one already take of a decided proposal. An *approved*
 * one is deliberately not counted either, and that is the half worth writing
 * down: its run may have been refused at the door with no work cycle behind it,
 * which `admitDependencies` reads as leaving the branch free, so counting it
 * here would refuse a chain the approval would have allowed.
 *
 * The scan is over every proposal of the chat rather than only the labelled
 * ones, because a rival needs no label of its own to claim a branch — a model
 * naming ids only for the proposals something points *at* writes exactly that
 * shape, and it is the case a scan of `labels` alone would miss entirely.
 */
export function rivalContinuation(
  label: string,
  proposals: readonly ContinuationCandidate[],
): ContinuationCandidate | null {
  for (const proposal of proposals) {
    if (proposal.status !== "pending") continue;
    const claims = proposal.dependsOn.some(
      (dependency) => dependency.continueBranch && dependency.specId === label,
    );
    if (claims) return proposal;
  }
  return null;
}
