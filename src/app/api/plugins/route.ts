import { NextResponse } from "next/server";
// Relative rather than aliased, which is what every route with a test here
// does: `node --test` runs the compiled output, and nothing resolves `@/` there.
import { discoverPlugins, setPluginEnabled } from "../../../lib/plugins";
import { auditMutation } from "../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Claude Code plugins found in the workspace mounts, and which are switched on.
 *
 * There is no install step and deliberately so: `plugins.ts` records why the
 * CLI's own registry cannot be written from in here without breaking the
 * operator's host sessions. What this route toggles is a list this app owns,
 * which becomes `--plugin-dir` on every work cycle's argv.
 *
 * `problems` travels beside `plugins` for the reason `/api/agents` answers with
 * `ambient`: the failures worth knowing about are the ones where something is
 * *absent* — a malformed manifest, an enabled plugin whose repository has been
 * unmounted — and a list that simply omits them is a page that cannot explain
 * why the plugin an operator is looking at is not there.
 */
export async function GET() {
  const { plugins, problems } = discoverPlugins();
  return NextResponse.json({ plugins, problems });
}

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const dir = typeof body.path === "string" ? body.path.trim() : "";
  if (!dir) {
    return NextResponse.json({ error: "A plugin directory path is required." }, { status: 400 });
  }
  // Narrowed against the literal rather than coerced: `Boolean(body.enabled)`
  // would read a missing field as "switch it off", so a malformed request would
  // silently disable a plugin instead of being refused.
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "`enabled` must be true or false." },
      { status: 400 },
    );
  }

  try {
    setPluginEnabled(dir, body.enabled);
  } catch (err) {
    // Containment failures and malformed manifests both arrive here as a
    // sentence naming the directory, because the page has to show it.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const { plugins, problems } = discoverPlugins();
  return NextResponse.json({ plugins, problems });
}

/** Wrapped so the request that changed what every agent loads is on the audit log. */
export const POST = auditMutation(postHandler);
