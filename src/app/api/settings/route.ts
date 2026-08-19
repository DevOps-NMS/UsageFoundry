import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib and the chat route already do.
import {
  DEFAULTS,
  getSettings,
  PERMISSION_MODES,
  sameValue,
  saveSettings,
  SETTINGS_KEYS,
  type Settings,
} from "../../../lib/settings";
import { normalizePolicy } from "../../../lib/budget";
import { agentKnowledgeOf, agentRefusal, getAgent } from "../../../lib/agents";
import {
  authEnabled,
  hasAdminKey,
  hasGithubToken,
  githubTokenSummary,
  WORKSPACE_MOUNTS,
  WORKSPACE_ROOT,
  CLAUDE_HOME,
} from "../../../lib/config";
import { currentSandbox } from "../../../lib/sandbox";
import { loginFailureSummary } from "../../../lib/loginAttempts";
import { activeSessionCount } from "../../../lib/sessions";
import { FIVE_HOURS_MS } from "../../../lib/windows";
import { invalidatePlanUsage } from "../../../lib/planUsage";
import { auditMutation } from "../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one key of `Settings` the settings form draws as more than one field.
 *
 * Everything else is a single control, so its key and the path that page marks
 * it by are the same string. `chatDefaultGuards` is seven controls, and
 * reporting it whole would tell the page that a fold holding one guard row
 * holds a change when what actually moved was one of the other six.
 */
const SPLIT_KEY = "chatDefaultGuards";

/** Every leaf under a fixed-shape value, as the dotted path that reaches it. */
function leafPaths(value: unknown, prefix: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.keys(value).flatMap((key) =>
    leafPaths((value as Record<string, unknown>)[key], `${prefix}.${key}`),
  );
}

function at(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined,
      obj,
    );
}

/**
 * Which settings this install has moved off the value this build ships.
 *
 * It exists so the settings page can fold a control that is set once per
 * install without hiding one that is *not* at its shipped value — a setting
 * behind a summary at a number the reader does not expect is the standard way
 * a fold costs more than it saves.
 *
 * Derived from `SETTINGS_KEYS` rather than copied from the page's
 * `EDITABLE_PATHS`, which lives in a `"use client"` module a route cannot
 * import: one list is the settings there are, the other is the settings that
 * page draws, and a copy of the second over here would be right on the day it
 * was written and silently short a key afterwards. The page asks about the
 * paths it draws and ignores the rest.
 *
 * The guard set is walked against `DEFAULTS`' own shape, which is safe because
 * `normalizePolicy` below fills every policy field in on the way through — a
 * stored guard set always has exactly those leaves.
 */
function nonDefaultKeys(settings: Settings): string[] {
  const paths: string[] = [];
  for (const key of SETTINGS_KEYS) {
    if (sameValue(settings[key], DEFAULTS[key])) continue;
    if (key !== SPLIT_KEY) {
      paths.push(key);
      continue;
    }
    for (const path of leafPaths(DEFAULTS[key], key)) {
      if (!sameValue(at(settings, path), at(DEFAULTS, path))) paths.push(path);
    }
  }
  return paths;
}

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({
    settings,
    // A third top-level field rather than a member of `env`: that object is
    // about the environment the container was given, and this is about the
    // stored blob.
    nonDefaultKeys: nonDefaultKeys(settings),
    env: {
      workspaceRoot: WORKSPACE_ROOT,
      workspaceMounts: WORKSPACE_MOUNTS,
      claudeHome: CLAUDE_HOME,
      adminKeyConfigured: hasAdminKey(),
      // Reported, never echoed: a run that cannot reach GitHub fails inside a
      // tool call, so the only cheap way to know beforehand is to say here
      // whether the container was given a credential at all.
      githubTokenConfigured: hasGithubToken(),
      // And *how wide* it is, which is the question at more than one
      // repository: one install-wide token reaches every repository the
      // operator points this at, and nothing else on this page says so.
      // Folders, never values.
      githubTokens: githubTokenSummary(),
      // What confines a tool call, which nothing else on any page says. The
      // reading is taken per request rather than at boot for the reason
      // `sandbox.ts` gives: a stale answer about a boundary is the failure this
      // row exists to prevent.
      sandbox: currentSandbox(),
      authEnabled: authEnabled(),
      // How many browser sign-ins are outstanding — a question that had no
      // answer at all while the cookie was UF_AUTH_TOKEN itself.
      activeSessions: authEnabled() ? activeSessionCount() : 0,
      // Failed sign-ins, so a burst is visible after it happened. Nothing
      // anywhere recorded that anybody had ever guessed at the token, which is
      // half of what made an unbounded login route hard to notice.
      signIn: loginFailureSummary(),
    },
  });
}

async function putHandler(req: Request) {
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
      // will not register is a form that pre-fills a run which dies at the
      // spawn. `agentRefusal` is the one wording, so this says what the run
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

  if ("maxConcurrentAssists" in body) {
    const n = optionalNumber(body.maxConcurrentAssists);
    // Same two rules as the cap above, and the floor of 1 matters more here: a
    // 0 would wedge every review, resolution and chat turn behind a budget
    // nothing can satisfy, and leave a workflow's deciding blocks `waiting`
    // for a slot that can never come free.
    patch.maxConcurrentAssists = n === null ? null : Math.max(1, Math.floor(n));
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

  if ("resolveVerifyTools" in body) {
    // Same two shapes `isolationCopyGlobs` accepts, for the same reason: the
    // page sends an array and a person pasting into the textarea sends lines.
    // An empty list is the meaningful default here rather than an omission —
    // it is how an operator turns the grant back off.
    const raw = body.resolveVerifyTools;
    patch.resolveVerifyTools = (
      Array.isArray(raw)
        ? raw.map((t) => String(t))
        : String(raw ?? "").split(/[\n,]/)
    )
      .map((t) => t.trim())
      .filter(Boolean);
  }

  if ("isolationCopyGlobsByRepo" in body) {
    const raw = body.isolationCopyGlobsByRepo;
    const map: Record<string, string[]> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const folder = key.trim().replace(/\/+$/, "");
        if (!folder) continue;
        const globs = (Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/))
          .map((g) => String(g).trim())
          .filter(Boolean);
        // An entry with no patterns is kept: "this repository copies nothing"
        // is a real answer, and the only way to say it — dropping it would
        // silently hand that repository the install-wide list back.
        map[folder] = globs;
      }
    }
    patch.isolationCopyGlobsByRepo = map;
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

  if ("eventRetentionDays" in body) {
    // Blank means "keep for ever", the reading every switchable rule here
    // takes, and a typed fraction is floored to a whole day rather than
    // refused: the sweep runs four times a day, so half a day is not a horizon
    // it can express. Floored at 1 for the same reason `maxConcurrentRuns` is —
    // a typed 0 would otherwise read as "delete a finished run's log the moment
    // it finishes", which is a retention policy nobody asked for.
    const n = optionalNumber(body.eventRetentionDays);
    patch.eventRetentionDays = n === null ? null : Math.max(1, Math.floor(n));
  }

  if ("checkoutRetentionDays" in body) {
    // Same reading as the horizon above. Floored at 1 for a sharper version of
    // its reason: a 0 here would reclaim a checkout the moment its run ended,
    // which is the slot the *next* run on that repository was going to reuse.
    const n = optionalNumber(body.checkoutRetentionDays);
    patch.checkoutRetentionDays = n === null ? null : Math.max(1, Math.floor(n));
  }

  if ("transcriptRetentionDays" in body) {
    // Same reading again, and the same floor — but this one also decides how
    // far back the dashboard's calendar history is complete, which the period
    // card states from this very number. It is not clamped up to that history:
    // making the horizon a year would defeat the retention, so the card says
    // what is incomplete instead.
    const n = optionalNumber(body.transcriptRetentionDays);
    patch.transcriptRetentionDays = n === null ? null : Math.max(1, Math.floor(n));
  }

  if ("chatTurnBudgetUSD" in body) {
    // Blank means "no cap", the same reading every switchable budget rule here
    // takes. It is the one guard on a chat turn other than the clock, so an
    // operator turning it off should have to type the blank themselves.
    patch.chatTurnBudgetUSD = optionalNumber(body.chatTurnBudgetUSD);
  }

  if ("installDailyCostLimitUSD" in body) {
    // Blank means "no cap", the same reading every switchable budget rule here
    // takes — and the shipped default, so an operator turning it *on* is the
    // deliberate act rather than turning it off.
    patch.installDailyCostLimitUSD = optionalNumber(body.installDailyCostLimitUSD);
  }

  const settings = saveSettings(patch);
  // Answered on the PUT as well as the GET: the page sets its state from this
  // response, so without it every fold's count would be stale from the moment
  // the operator pressed Save.
  return NextResponse.json({ settings, nonDefaultKeys: nonDefaultKeys(settings) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const PUT = auditMutation(putHandler);
