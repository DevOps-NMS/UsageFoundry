import { NextResponse } from "next/server";
import {
  appendMessage,
  approveProposal,
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
  const note = [
    started.length > 0 ? `Approved and queued ${started.length} run(s).` : "",
    rejected > 0 ? `Rejected ${rejected} proposal(s).` : "",
    ...failed.map((f) => `Could not start “${f.title}”: ${f.reason}`),
    targets.length < wanted.length
      ? `${wanted.length - targets.length} proposal(s) were already decided and were left alone.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (note) appendMessage(id, "system", note);

  return NextResponse.json({
    started,
    rejected,
    failed,
    chat: chatDTO(getChat(id)!),
  });
}
