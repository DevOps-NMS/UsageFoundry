import { NextResponse } from "next/server";
import { parseLogsPayload, recordTelemetry, runForIngestToken } from "@/lib/otlp";

/**
 * OTLP/HTTP-JSON logs receiver.
 *
 * Claude Code appends the signal suffix to whatever base endpoint it is given,
 * so `OTEL_EXPORTER_OTLP_ENDPOINT=http://host/api/otlp` lands here — verified
 * against a captured POST from CLI v2.1.226, which also confirmed the body is
 * plain `application/json` with no compression. Nothing needs to be added to
 * `package.json` to read it.
 *
 * `src/middleware.ts` exempts this path and the route authenticates itself, for
 * the reason `/api/mcp` does: the credential it takes is not `UF_AUTH_TOKEN`.
 * The exporter used to carry that one — the app's master token, in the agent's
 * own environment, in a variable `env` prints — and it now carries a capability
 * minted per run and revoked when that run's loop ends. **If the check below is
 * ever removed, the exemption in `middleware.ts` makes this an open write into
 * `otlp_requests`; keep the two together.** An open one would matter: a
 * pre-inserted `request_id` is silently dropped by the `INSERT OR IGNORE` in
 * `recordTelemetry`, which understates the figure a live spending guard reads.
 *
 * The run id comes from the **token**, not from the payload's `uf.run_id`. The
 * attribute is still stamped, so a captured payload says which run it claims to
 * be, but a record cannot move spend onto a run whose credential it does not
 * hold.
 *
 * Past authentication the response is always 200. A batch exporter retries on
 * failure, and a malformed or unrecognised record is not something a retry will
 * fix — it would just cost the same batch again on a loop. An unauthenticated
 * caller is the opposite case and gets a 401: retrying is the right thing for it
 * to do, and answering 200 while dropping the batch would report success for
 * telemetry that never arrived.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const runId = runForIngestToken(
    header.startsWith("Bearer ") ? header.slice(7) : "",
  );
  if (!runId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = parseLogsPayload(await req.json());
    const inserted = recordTelemetry(rows.map((r) => ({ ...r, runId })));
    return NextResponse.json({ partialSuccess: {}, seen: rows.length, inserted });
  } catch {
    return NextResponse.json({ partialSuccess: {} });
  }
}
