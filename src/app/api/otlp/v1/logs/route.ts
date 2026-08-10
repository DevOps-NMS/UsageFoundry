import { NextResponse } from "next/server";
import { parseLogsPayload, recordTelemetry } from "@/lib/otlp";

/**
 * OTLP/HTTP-JSON logs receiver.
 *
 * Claude Code appends the signal suffix to whatever base endpoint it is given,
 * so `OTEL_EXPORTER_OTLP_ENDPOINT=http://host/api/otlp` lands here — verified
 * against a captured POST from CLI v2.1.226, which also confirmed the body is
 * plain `application/json` with no compression. Nothing needs to be added to
 * `package.json` to read it.
 *
 * `src/middleware.ts` gates every `/api/` path when `UF_AUTH_TOKEN` is set, and
 * that is left alone deliberately: the exporter can send the token itself via
 * `OTEL_EXPORTER_OTLP_HEADERS`, so an open ingest hole is not required to make
 * telemetry work.
 *
 * The response is always 200. A batch exporter retries on failure, and a
 * malformed or unrecognised record is not something a retry will fix — it
 * would just cost the same batch again on a loop.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const rows = parseLogsPayload(await req.json());
    const inserted = recordTelemetry(rows);
    return NextResponse.json({ partialSuccess: {}, seen: rows.length, inserted });
  } catch {
    return NextResponse.json({ partialSuccess: {} });
  }
}
