import { NextResponse } from "next/server";
import {
  appendMessage,
  approveProposal,
  decisionNote,
  getChat,
  getProposal,
  pendingProposals,
  rejectProposal,
} from "@/lib/chat";
import { promoteQueued } from "@/lib/orchestrator";
import { chatDTO } from "../../dto";

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
 * proposals for the same folder must not both decide it is free.
 */
export async function POST(req: Request, ctx: Ctx) {
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
          decided,
          foreign,
        }),
      },
      { status: 400 },
    );
  }

  const started: string[] = [];
  const failed: Array<{ title: string; reason: string }> = [];
  let rejected = 0;

  for (const pid of targets) {
    if (action === "reject") {
      if (rejectProposal(pid)) rejected += 1;
      continue;
    }
    const proposal = getProposal(pid);
    const res = approveProposal(pid);
    if (res.ok) started.push(res.runId);
    else failed.push({ title: proposal?.title ?? pid, reason: res.reason });
  }

  // Runs are admitted or queued by `createRun`; this is what starts whatever
  // the last approval made startable, exactly as `POST /api/runs` relies on.
  if (started.length > 0) promoteQueued();

  // Recorded in the thread rather than only in the proposal rows, so the
  // conversation reads as what happened: the model proposed, a person decided,
  // and the decision is in the same place as the request.
  const note = decisionNote({
    action,
    started: started.length,
    rejected,
    failed,
    decided,
    foreign,
  });
  if (note) appendMessage(id, "system", note);

  return NextResponse.json({
    started,
    rejected,
    failed,
    chat: chatDTO(getChat(id)!),
  });
}
