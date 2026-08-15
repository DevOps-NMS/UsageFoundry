// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib already does.
import { healthReport } from "../../../lib/health";
import { jsonNoStore } from "../../../lib/http";
import {
  dataDirOwner,
  dataDirOwnership,
  dataDirRefusal,
} from "../../../lib/serverLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness probe. Unauthenticated, and exempt in `middleware.ts` — the comment
 * beside that exemption states why it is safe and what must never be added
 * here. Keep the two together.
 *
 * `healthReport` documents in full what this does and does not detect. The one
 * thing worth repeating at the route: a server whose event loop is blocked
 * outright never reaches this handler at all, so what catches that case is the
 * probe's own timeout rather than anything in the body.
 *
 * 503 rather than 500 for an unhealthy answer: this is a statement about the
 * server's own state, not about the request that asked.
 *
 * **It also answers 503 when this process is refusing writes**, which is a
 * second reason for the same status code and is the point rather than a detail.
 * The answer used to be a single `console.warn` at boot, into a container whose
 * stdout nobody is tailing, on a process that then served traffic normally: a
 * second replica reported that it owned nothing and admitted runs anyway. Now
 * it refuses them, and 503 is what takes it out of a load balancer's rotation.
 * It is not an error state — a read-only second server is a supported thing to
 * run, and every page it serves still works — so the body says which case it is
 * in rather than leaving the status code to imply it.
 *
 * Keyed on the refusal rather than on `report.checks.dataDirOwned`, because
 * those differ for the few seconds before the boot hook has finished asking: an
 * unclaimed directory refuses nothing, and answering 503 there would report a
 * healthy server as down every time it starts. `healthReport` names the same
 * fact as a *problem* — reported, never fatal — and the two are consistent by
 * construction: an owned directory refuses nothing.
 *
 * Everything added here is still counts, slugs and a pid. The exemption in
 * `middleware.ts` is justified by the shape of this payload and by nothing
 * else, and the pid is the whole point of naming an owner at all: it is what an
 * operator greps for to find the other process, where `ownerId` is this app's
 * own handle on a claim and would say nothing to anyone.
 */
export async function GET() {
  const report = await healthReport();
  const owner = dataDirOwner();
  const refusal = dataDirRefusal();

  return jsonNoStore(
    {
      ...report,
      // `ok` stays `healthReport`'s answer to "can this server do its job",
      // which a read-only replica still can for every page it serves. The
      // status code is the wider question and is derived below.
      ownership: dataDirOwnership(),
      owner: owner ? { pid: owner.pid, startedAt: owner.startedAt } : null,
      // `error` rather than a field name of its own: every route in this app
      // explains a refusal in that key and `jsonRequest` is what reads it, so
      // the banner that renders this needs no second convention to learn.
      ...(refusal ? { error: refusal } : {}),
    },
    { status: report.ok && refusal === null ? 200 : 503 },
  );
}
