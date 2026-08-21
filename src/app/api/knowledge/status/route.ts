import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime.
import { knowledgeStatus } from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the settings section reads: is a vault configured, can it be read, and
 * what is in it.
 *
 * 200 even when the vault is unreachable, because "not configured" and "the
 * mount is gone" are both things this endpoint is *for* saying — a 4xx would
 * make the section render an error where it should render a sentence and a
 * picker. The payload carries `configured`, `available` and a full-sentence
 * `error` so the page can tell the three apart.
 */
export async function GET() {
  return NextResponse.json(knowledgeStatus(getSettings()));
}
