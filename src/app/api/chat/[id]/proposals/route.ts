import { NextResponse } from "next/server";
import {
  appendMessage,
  approveRunBatch,
  decisionNote,
  getChat,
  getProposal,
  pendingProposals,
  rejectProposal,
  type DecisionTally,
} from "@/lib/chat";
import { approveWorkflowProposal } from "@/lib/workflows";
import { promoteQueued } from "@/lib/orchestrator";
import { chatDTO } from "../../dto";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The approval gate.
 *
 * This is the only route in the app that turns something a model wrote into
 * processes with write access to folders, so it is deliberately narrow: it
 * takes an explicit list of proposal ids belonging to *this* chat, and an
 * action of exactly `approve` or `reject`. There is no "approve everything from
 * now on" and no setting that would create one — the authorisation is the
 * click, and it covers the batch in front of the operator and nothing else.
 * Same reasoning `merge_queue.auto_resolve` follows in recording per row what
 * was authorised per batch.
 *
 * Approvals run in one synchronous pass with no `await` between them, because
 * `createRun`'s folder claim is only atomic within an event-loop turn — two
 * proposals for the same folder must not both decide it is free. That property
 * is load-bearing twice over now that a proposal can name another one: a
 * dependency has to point at a run that exists, and every run it can point at
 * is created in this same pass. `approveRunBatch` is where the order comes
 * from, which is why the run proposals go through it as a batch rather than one
 * at a time — the page sends what it displayed, and what it displayed is
 * creation order, not dependency order.
 *
 * A workflow proposal is the other kind and settles differently: approving one
 * **saves a workflow** and starts nothing. It is still an approval — the
 * operator is agreeing to a graph a model wrote — and the second gate, the one
 * that turns it into agents, is the press of Run on the workflow page.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const chat = getChat(id);
  if (!chat) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json(
      { error: `Unknown action: ${action}` },
      { status: 400 },
    );
  }

  // `ids` is required even for "approve all": the page sends what it displayed,
  // so a proposal the chat added between the render and the click is not swept
  // into an approval nobody saw. Bounded by what is pending on this chat.
  const wanted = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (wanted.length === 0) {
    return NextResponse.json({ error: "No proposals selected." }, { status: 400 });
  }

  const eligible = new Set(pendingProposals(id).map((p) => p.id));
  const targets = wanted.filter((pid) => eligible.has(pid));

  // Why an id is not actionable is two facts, not one. A proposal of this chat
  // that has since been decided is the ordinary stale-page case; an id naming
  // no proposal of this chat came from somewhere else entirely — a selection
  // carried across a chat switch — and those proposals are still waiting where
  // they were made. Calling that "already decided" is a claim about another
  // thread's proposals, written into this one.
  let decided = 0;
  let foreign = 0;
  for (const pid of wanted) {
    if (eligible.has(pid)) continue;
    if (getProposal(pid)?.chat_id === id) decided += 1;
    else foreign += 1;
  }

  // Nothing here to act on — the same refusal an empty `ids` gets above, and
  // for the same reason. A 200 with an empty `started` is indistinguishable
  // from a batch that worked: the page clears the selection on `res.ok` and
  // shows no error, so the click reads as having succeeded silently.
  if (targets.length === 0) {
    return NextResponse.json(
      {
        error: decisionNote({
          action,
          started: 0,
          rejected: 0,
          failed: [],
          saved: 0,
          decided,
          foreign,
        }),
      },
      { status: 400 },
    );
  }

  if (action === "reject") {
    let rejected = 0;
    for (const pid of targets) if (rejectProposal(pid)) rejected += 1;
    const note = decisionNote({
      action,
      started: 0,
      rejected,
      failed: [],
      saved: 0,
      decided,
      foreign,
    });
    if (note) appendMessage(id, "system", note);
    return NextResponse.json({
      started: [],
      rejected,
      failed: [],
      saved: [],
      chat: chatDTO(getChat(id)!),
    });
  }

  // Both halves are synchronous, so the whole approval is still one event-loop
  // turn however they interleave. Runs first: a workflow proposal claims no
  // folder and takes no slot, so nothing it does can change what a run
  // proposal is admitted into.
  const batch = approveRunBatch(id, targets);

  // The click refused whole, before anything was decided, by a condition that
  // will have cleared by the time the operator looks again — the install
  // ceiling's rolling window, or another process holding the data directory.
  // The same 400 an empty batch gets above and for a stronger version of its
  // reason: nothing here is a verdict on a proposal, so every one of them is
  // still pending and the page must not clear the selection. Answered before
  // the workflow half rather than after it, so "nothing was decided" is true of
  // the click and not merely of its run proposals.
  if (batch.refused) {
    return NextResponse.json({ error: batch.refused }, { status: 400 });
  }

  const failed: DecisionTally["failed"] = [...batch.failed];
  const saved: Array<{ workflowId: string; name: string }> = [];

  for (const pid of targets) {
    const proposal = getProposal(pid);
    if (proposal?.kind !== "workflow") continue;
    const res = approveWorkflowProposal(pid);
    if (res.ok) saved.push({ workflowId: res.workflowId, name: res.name });
    else failed.push({ title: proposal.title, reason: res.reason, kind: "workflow" });
  }

  // Runs are admitted or queued by `createRun`; this is what starts whatever
  // the last approval made startable, exactly as `POST /api/runs` relies on.
  if (batch.started.length > 0) promoteQueued();

  // Recorded in the thread rather than only in the proposal rows, so the
  // conversation reads as what happened: the model proposed, a person decided,
  // and the decision is in the same place as the request.
  const note = decisionNote({
    action,
    started: batch.started.length,
    rejected: 0,
    failed,
    saved: saved.length,
    decided,
    foreign,
  });
  if (note) appendMessage(id, "system", note);

  return NextResponse.json({
    started: batch.started,
    rejected: 0,
    failed,
    saved,
    chat: chatDTO(getChat(id)!),
  });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
