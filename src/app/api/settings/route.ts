import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib and the chat route already do.
import {
  getSettings,
  PERMISSION_MODES,
  saveSettings,
  type Settings,
} from "../../../lib/settings";
import { normalizePolicy } from "../../../lib/budget";
import { agentKnowledgeOf, agentRefusal, getAgent } from "../../../lib/agents";
import {
  hasAdminKey,
  hasGithubToken,
  WORKSPACE_MOUNTS,
  WORKSPACE_ROOT,
  CLAUDE_HOME,
} from "../../../lib/config";
import { FIVE_HOURS_MS } from "../../../lib/windows";
import { invalidatePlanUsage } from "../../../lib/planUsage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    settings: getSettings(),
    env: {
      workspaceRoot: WORKSPACE_ROOT,
      workspaceMounts: WORKSPACE_MOUNTS,
      claudeHome: CLAUDE_HOME,
      adminKeyConfigured: hasAdminKey(),
      // Reported, never echoed: a run that cannot reach GitHub fails inside a
      // tool call, so the only cheap way to know beforehand is to say here
      // whether the container was given a credential at all.
      githubTokenConfigured: hasGithubToken(),
    },
  });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const optionalNumber = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const patch: Partial<Settings> = {};

  if ("sessionCostLimit" in body)
    patch.sessionCostLimit = optionalNumber(body.sessionCostLimit);
  if ("weeklyCostLimit" in body)
    patch.weeklyCostLimit = optionalNumber(body.weeklyCostLimit);
  if ("sessionTokenLimit" in body)
    patch.sessionTokenLimit = optionalNumber(body.sessionTokenLimit);
  if ("weeklyTokenLimit" in body)
    patch.weeklyTokenLimit = optionalNumber(body.weeklyTokenLimit);

  if ("reservedHeadroomFraction" in body) {
    const n = optionalNumber(body.reservedHeadroomFraction);
    // Accept a percentage typed as 0–100 as well as a 0–1 fraction. Capped at
    // 0.95 so a slip cannot drive the effective ceiling to zero and wedge
    // every run behind a guard that can never pass.
    patch.reservedHeadroomFraction =
      n === null ? null : Math.min(n > 1 ? n / 100 : n, 0.95);
  }

  if ("weeklyAnchor" in body) {
    const a = body.weeklyAnchor as { weekday?: unknown; hourUTC?: unknown } | null;
    if (!a) patch.weeklyAnchor = null;
    else {
      const weekday = Number(a.weekday);
      const hourUTC = Number(a.hourUTC);
      patch.weeklyAnchor =
        Number.isInteger(weekday) &&
        weekday >= 0 &&
        weekday <= 6 &&
        Number.isInteger(hourUTC) &&
        hourUTC >= 0 &&
        hourUTC <= 23
          ? { weekday, hourUTC }
          : null;
    }
  }

  if ("sessionResetOverrideAt" in body) {
    const raw = body.sessionResetOverrideAt;
    if (raw === null || raw === undefined || raw === "") {
      patch.sessionResetOverrideAt = null;
    } else {
      const at = Number(raw);
      // A window resets five hours after it opens and it cannot have opened in
      // the future, so anything past now+5h describes no window at all — almost
      // always a date typo. Refusing beats storing it: it would silently blank
      // the session meter the moment its anchor arrived.
      if (!Number.isFinite(at) || at <= 0 || at > Date.now() + FIVE_HOURS_MS) {
        return NextResponse.json(
          {
            error:
              "sessionResetOverrideAt must be a past or near-future epoch " +
              `(no more than 5 hours ahead); got ${String(raw)}.`,
          },
          { status: 400 },
        );
      }
      patch.sessionResetOverrideAt = at;
    }
  }

  if ("defaultPermissionMode" in body) {
    const allowed = ["default", "acceptEdits", "bypassPermissions", "plan"];
    const v = String(body.defaultPermissionMode);
    if (allowed.includes(v)) patch.defaultPermissionMode = v as Settings["defaultPermissionMode"];
  }

  if ("defaultModel" in body) {
    const v = body.defaultModel;
    patch.defaultModel = typeof v === "string" && v.trim() ? v.trim() : null;
  }

  if ("defaultAgentId" in body) {
    const raw = body.defaultAgentId;
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) {
      patch.defaultAgentId = null;
    } else {
      // Refused here rather than stored and discovered later, which is
      // `normalizeTemplateInput`'s rule: this is the door with a person behind
      // it and an error channel, and a default that names an agent Claude Code
      // would drop in silence is a form that pre-fills a specialist no run will
      // ever have. `agentRefusal` is the one wording, so this says what the run
      // door and the template door say.
      const refusal = agentRefusal(id, agentKnowledgeOf(getAgent(id)));
      if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
      patch.defaultAgentId = id;
    }
  }

  if ("continuationPrompt" in body) {
    const v = String(body.continuationPrompt ?? "").trim();
    if (v) patch.continuationPrompt = v;
  }

  if ("telemetryForRuns" in body) {
    patch.telemetryForRuns = Boolean(body.telemetryForRuns);
  }

  if ("planUsageFromApi" in body) {
    patch.planUsageFromApi = Boolean(body.planUsageFromApi);
    // The cached reading outlives the setting otherwise: switching this off
    // and reloading would keep showing provider percentages for up to five
    // minutes, which reads as the switch not working.
    invalidatePlanUsage();
  }

  if ("includeSidechains" in body) {
    patch.includeSidechains = Boolean(body.includeSidechains);
  }

  if ("forwardSubAgentText" in body) {
    patch.forwardSubAgentText = Boolean(body.forwardSubAgentText);
  }

  if ("maxConcurrentRuns" in body) {
    const n = optionalNumber(body.maxConcurrentRuns);
    // Blank means no limit, matching every other switchable rule. Floor at 1 so
    // a typed 0 cannot wedge every run behind a cap nothing can satisfy.
    patch.maxConcurrentRuns = n === null ? null : Math.max(1, Math.floor(n));
  }

  if ("isolationCopyGlobs" in body) {
    const raw = body.isolationCopyGlobs;
    const list = Array.isArray(raw)
      ? raw.map((g) => String(g).trim()).filter(Boolean)
      : String(raw ?? "")
          .split(/[\n,]/)
          .map((g) => g.trim())
          .filter(Boolean);
    patch.isolationCopyGlobs = list;
  }

  if ("isolationPreamble" in body) {
    const v = String(body.isolationPreamble ?? "").trim();
    if (v) patch.isolationPreamble = v;
  }

  if ("continuedWorkPrompt" in body) {
    // Blank keeps whatever is stored, the same rule the three prompts around it
    // take: what is generated beside this guidance is facts — the branch, the
    // predecessor, the two commands — so emptying it would leave a continuing
    // agent told where the work is and nothing about not undoing it.
    const v = String(body.continuedWorkPrompt ?? "").trim();
    if (v) patch.continuedWorkPrompt = v;
  }

  if ("donePushbackPrompt" in body) {
    // Blank keeps whatever is stored, matching continuationPrompt: emptying it
    // would silently turn "carry on past DONE" into a wasted, contentless turn.
    const v = String(body.donePushbackPrompt ?? "").trim();
    if (v) patch.donePushbackPrompt = v;
  }

  if ("liveGuardIntervalSeconds" in body) {
    const n = optionalNumber(body.liveGuardIntervalSeconds);
    // Blank restores the default rather than meaning "no limit", unlike
    // maxConcurrentRuns above. There is no such thing as "no interval": a live
    // run is either checked on some cadence or it is not a live run. Floored at
    // 15s because below that the server re-walks ~/.claude faster than Claude
    // Code writes to it. Not a breach of "blank disables a guard" — that rule
    // is about budget rules, and this is a cadence.
    patch.liveGuardIntervalSeconds = n === null ? 60 : Math.max(15, Math.floor(n));
  }

  if ("maxCycleSilenceMinutes" in body) {
    const n = optionalNumber(body.maxCycleSilenceMinutes);
    // Blank restores the default rather than meaning "no deadline", for the
    // reason above and one more: a work cycle with no deadline is the defect
    // this setting exists to fix, so there has to be no way to type it. The
    // floor is what keeps the other failure out — a value of a minute or two
    // kills healthy cycles, since the stream is silent for the whole of one
    // model turn and the whole of one tool call.
    patch.maxCycleSilenceMinutes = n === null ? 120 : Math.max(5, Math.floor(n));
  }

  if ("resumeGraceHours" in body) {
    const n = optionalNumber(body.resumeGraceHours);
    patch.resumeGraceHours = n === null ? 24 : Math.max(1, Math.floor(n));
  }

  if ("landStrategy" in body) {
    const v = String(body.landStrategy);
    if (v === "merge" || v === "squash") patch.landStrategy = v;
  }

  if ("killProcessGroup" in body) {
    patch.killProcessGroup = Boolean(body.killProcessGroup);
  }

  if ("chatDefaultGuards" in body) {
    const g = (body.chatDefaultGuards ?? {}) as Record<string, unknown>;
    const rawBudget = (g.budget ?? {}) as Record<string, unknown>;
    const mode = String(g.permissionMode ?? "");
    if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
      return NextResponse.json(
        { error: `Unknown permission mode: ${mode}` },
        { status: 400 },
      );
    }

    const budget = normalizePolicy(rawBudget);
    // The same pair `POST /api/runs` and `normalizeTemplateInput` refuse, and
    // refused here for the third time rather than coerced: a proposal approved
    // under a guard set with no terminus would be admitted and then refused by
    // `evaluateBudget` seconds later, with the row flickering queued → stopped
    // and nothing said about what to change.
    if (budget.maxIterations === null && budget.maxDurationMinutes === null) {
      return NextResponse.json(
        {
          error:
            "A guard set with no work-cycle limit needs a time limit. Wall " +
            "clock is the only limit that keeps advancing whether or not the " +
            "agent reports what it spent.",
        },
        { status: 400 },
      );
    }

    patch.chatDefaultGuards = {
      permissionMode: mode as Settings["defaultPermissionMode"],
      isolate: g.isolate !== false,
      budget,
    };
  }

  if ("chatTurnBudgetUSD" in body) {
    // Blank means "no cap", the same reading every switchable budget rule here
    // takes. It is the one guard on a chat turn other than the clock, so an
    // operator turning it off should have to type the blank themselves.
    patch.chatTurnBudgetUSD = optionalNumber(body.chatTurnBudgetUSD);
  }

  return NextResponse.json({ settings: saveSettings(patch) });
}
