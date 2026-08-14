import { NextResponse } from "next/server";
import {
  dataDirOwner,
  dataDirOwnership,
  dataDirRefusal,
  ownsDataDir,
} from "@/lib/serverLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether this process may write, and who holds the data directory if not.
 *
 * The whole of what this exists for is that the answer used to be a single
 * `console.warn` at boot, into a container whose stdout nobody is tailing, on a
 * process that then served traffic normally. A second replica reported that it
 * owned nothing and admitted runs anyway; now it refuses them, and this is
 * where an operator — or anything in front of the container — can see why
 * without reading logs.
 *
 * **503 when this process is refusing writes**, and that is the point rather
 * than a detail: a health check that answers 200 for a server which refuses
 * every write is the same silence the warning already provided, and 503 is what
 * takes a second replica out of a load balancer's rotation. It is not an error
 * state — a read-only second server is a supported thing to run, and every page
 * it serves still works — so the body says which case it is in rather than
 * leaving the status code to imply it.
 *
 * Keyed on the refusal rather than on `ownsDataDir`, because those differ for
 * the few seconds before the boot hook has finished asking: an unclaimed
 * directory refuses nothing, and answering 503 there would report a healthy
 * server as down every time it starts.
 *
 * Behind `middleware.ts` like every other route. The exemption list is not
 * widened for this: `/api/mcp` is on it because the edge runtime cannot reach
 * SQLite to check a per-turn capability, which is not true of anything here,
 * and an unauthenticated endpoint naming pids is a fact about the host given
 * away for nothing.
 */
export async function GET() {
  const ownership = dataDirOwnership();
  const owner = dataDirOwner();
  const refusal = dataDirRefusal();

  return NextResponse.json(
    {
      ok: refusal === null,
      pid: process.pid,
      ownsDataDir: ownsDataDir(),
      ownership,
      // The pid is the whole point of naming an owner at all: it is what an
      // operator greps for to find the other process. `ownerId` is this app's
      // own handle on a claim and would say nothing to anyone.
      owner: owner ? { pid: owner.pid, startedAt: owner.startedAt } : null,
      // `error` rather than a field name of its own: every route in this app
      // explains a refusal in that key and `jsonRequest` is what reads it, so
      // the banner that renders this needs no second convention to learn.
      ...(refusal ? { error: refusal } : {}),
    },
    { status: refusal === null ? 200 : 503 },
  );
}
