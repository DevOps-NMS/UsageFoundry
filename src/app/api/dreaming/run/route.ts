import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime.
import { runDreamingNight } from "../../../../lib/dreamingRun";
import { auditMutation, SUBJECT_HEADER } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run tonight's pass now, with a person present.
 *
 * `origin: "form"` rather than `"schedule"`, and that is the whole difference
 * between this and the timer: the column exists to record which gate a run came
 * through, and a press is not a clock. The refusals are the same ones either
 * way — `dreamingRefusal` is asked inside `runDreamingNight` — so a press
 * cannot spend where a night would have been refused.
 *
 * The night's own cursor is deliberately **not** advanced by a press. A person
 * pressing this at noon has not consumed the night; if they press it and it
 * writes, the signatures are claimed and the 03:04 pass finds nothing left to
 * write, which is the same outcome by a better route.
 */
export const POST = auditMutation(async () => {
  const result = await runDreamingNight({ origin: "form" });

  // A refusal is a 200 carrying a sentence, not a 4xx: every reason this can
  // decline — off, no ceiling, no vault — is a state the page is *for* showing,
  // and a 4xx would render it as a fault.
  const headers = result.runId ? { [SUBJECT_HEADER]: result.runId } : undefined;
  return NextResponse.json(
    {
      night: result.night,
      outcome: result.outcome,
      reason: result.reason,
      runId: result.runId,
      selected: result.selected.length,
    },
    { headers },
  );
});
