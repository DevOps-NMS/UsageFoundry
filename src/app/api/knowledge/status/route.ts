import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime.
import { knowledgeStatus, resolveKnowledgeRoot } from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";
import { findSearchScript, vaultSkillEnabled } from "../../../../lib/vaultSkill";

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
 *
 * The skill half is composed here rather than inside `knowledgeStatus`, which
 * reads only `Settings` and the filesystem. `skillSearchScript` is relative to
 * the vault for the same reason every other path this app shows an operator is:
 * the absolute one is a container path they have no way to check.
 */
export async function GET() {
  const settings = getSettings();
  const root = resolveKnowledgeRoot(settings);
  const script = root.ok ? findSearchScript(root.root) : null;
  return NextResponse.json({
    ...knowledgeStatus(settings),
    skillEnabled: vaultSkillEnabled(),
    skillSearchScript:
      script && root.ok ? script.slice(root.root.length).replace(/^\/+/, "") : null,
  });
}
