"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BudgetPolicyDTO, RunGuardsDTO, SettingsDTO } from "@/lib/apiTypes";
import { fmtTokens, fmtUSD } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import {
  Field,
  Input,
  Select,
  Subsection,
  Textarea,
  Toggle,
} from "@/components/ui/Field";
import { Hint, type HintTone } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

interface CalibrateResponse {
  ok: boolean;
  reason?: string;
  suggestion?: {
    sessionCostLimit: number | null;
    weeklyCostLimit: number | null;
    sessionTokenLimit: number | null;
    weeklyTokenLimit: number | null;
  };
  evidence?: Record<string, number>;
  caveat?: string;
  confidence?: string;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Mirrors the ceiling `PUT /api/settings` refuses a reset override past. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Anchors for the section nav; order is the page order. */
const SECTIONS = [
  { id: "guards", label: "Default guards" },
  { id: "limits", label: "Subscription limits" },
  { id: "runs", label: "Runs" },
  { id: "prompts", label: "Prompts" },
  { id: "unattended", label: "Unattended runs" },
];

/**
 * Least to most permissive, rather than the order the literals happen to be
 * declared in. The list is a scale, so it should read as one.
 */
const PERMISSION_MODES = ["plan", "default", "acceptEdits", "bypassPermissions"];

/**
 * Every path the form can edit, so the page can mark *which* fields are
 * unsaved rather than only that something is.
 *
 * Written out rather than derived from the settings object: the page does not
 * render every stored key (enforcement and the window fractions are carried
 * through untouched), and a rail beside a control nobody can see would be a
 * change the operator cannot find.
 */
const EDITABLE_PATHS = [
  "chatDefaultGuards.permissionMode",
  "chatDefaultGuards.isolate",
  "chatDefaultGuards.budget.maxRunCostUSD",
  "chatDefaultGuards.budget.maxIterations",
  "chatDefaultGuards.budget.maxDurationMinutes",
  "chatTurnBudgetUSD",
  "sessionCostLimit",
  "weeklyCostLimit",
  "reservedHeadroomFraction",
  "sessionTokenLimit",
  "weeklyTokenLimit",
  "weeklyAnchor",
  "sessionResetOverrideAt",
  "includeSidechains",
  "defaultModel",
  "defaultPermissionMode",
  "maxConcurrentRuns",
  "isolationCopyGlobs",
  "landStrategy",
  "continuationPrompt",
  "donePushbackPrompt",
  "isolationPreamble",
  "liveGuardIntervalSeconds",
  "killProcessGroup",
  "resumeGraceHours",
  "telemetryForRuns",
] as const;

/**
 * Drops the trailing field margin so a card's bottom padding matches its top.
 *
 * `mb-0` on the last `Field` does not do this and never did: two margin
 * utilities on one element resolve by their order in the generated stylesheet,
 * and `.mb-0` is emitted before `.mb-3.5`, so the primitive's own margin wins.
 * The `last:` variant compiles to `.last\:mb-0:last-child`, which outranks a
 * bare utility, and is inert on a field that is not last.
 */
const FLUSH = "last:mb-0";

function at(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === "object"
          ? (v as Record<string, unknown>)[k]
          : undefined,
      obj,
    );
}

/**
 * What a run's own spending limit can overshoot by, which depends entirely on
 * when the guard is read. Rendered from the stored mode rather than hardcoded:
 * nothing on this page can set it, but a guard set written by another build
 * could carry `live`, and a sentence describing the wrong mode is worse than
 * no sentence.
 */
const SPEND_READ_AT: Record<BudgetPolicyDTO["enforcement"], string> = {
  "between-cycles":
    "Read before each work cycle, so a run can pass it by one cycle's spend.",
  live: "Read on a ticker while a cycle is going, so a run can pass it by about one model turn.",
  "live-resume":
    "Read on a ticker while a cycle is going, so a run can pass it by about one model turn.",
};

/** What the selected permission mode lets an agent nobody is watching do. */
function permissionNote(
  mode: string,
  isolate: boolean,
): { text: ReactNode; tone: HintTone } {
  switch (mode) {
    case "plan":
      return { text: "Reads and reports; it cannot write a file", tone: "neutral" };
    case "default":
      return {
        text: "Every edit needs an approval nobody is there to give, so tool calls come back refused",
        tone: "warn",
      };
    case "bypassPermissions":
      return {
        text: (
          <>
            No approval for anything — the agent also gets the network and{" "}
            <span className="mono">rm</span>. Only{" "}
            <span className="mono">pkill</span> and{" "}
            <span className="mono">killall</span> stay refused
          </>
        ),
        tone: "danger",
      };
    default:
      return {
        text: isolate ? (
          <>
            Edits files and runs read-only shell without asking.{" "}
            <span className="mono">git add</span> and{" "}
            <span className="mono">git commit</span> are allowed too, because
            the run has its own checkout
          </>
        ) : (
          <>
            Edits files and runs read-only shell without asking.{" "}
            <span className="mono">git add</span> and{" "}
            <span className="mono">git commit</span> come back refused — only a
            run with its own checkout is granted those
          </>
        ),
        tone: "neutral",
      };
  }
}

/**
 * The cost ceilings as the meters and guards actually see them, once reserved
 * headroom is off.
 *
 * Both windows, not just the weekly one. The 5-hour meter is what an operator
 * watches while a run is going, and with only the weekly figure named here
 * nothing anywhere stated the effective session ceiling — so a session bar
 * sitting at 25% of $552.50 reads as a miscalculation of the $650 typed above
 * it, which is the one reading on this page a person acts on.
 */
function effectiveCeilings(
  reserve: number | null,
  sessionCost: number | null,
  weeklyCost: number | null,
): Array<{ label: string; raw: number; effective: number }> {
  if (!reserve) return [];
  return [
    { label: "5-hour", raw: sessionCost },
    { label: "weekly", raw: weeklyCost },
  ]
    .filter((c): c is { label: string; raw: number } => !!c.raw && c.raw > 0)
    .map((c) => ({ ...c, effective: c.raw * (1 - reserve) }));
}

/** Epoch ms → the `YYYY-MM-DDTHH:mm` a datetime-local input wants, in local time. */
function toLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const local = new Date(ms - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** Comma-separated globs, as the field holds them while being typed. */
function parseGlobs(text: string): string[] {
  return text
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

function Section({
  id,
  title,
  lede,
  lead = false,
  children,
}: {
  id: string;
  title: string;
  lede?: ReactNode;
  lead?: boolean;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    // `mt-0` neutralises the legacy sheet's `section + section` rule, so the
    // gap between cards is this one margin rather than that one plus this one.
    <section
      id={id}
      aria-labelledby={headingId}
      className="mt-0 mb-6 scroll-mt-4"
    >
      <Card emphasis={lead ? "primary" : "default"}>
        {lead ? (
          // Not CardTitle: the leading card is the one thing on this page that
          // should be read first, and size and weight are how that is said.
          // Overriding CardTitle's own utilities through className would be a
          // coin toss on stylesheet order — see the note in Field.tsx.
          <h2
            id={headingId}
            className={`${lede ? "mb-1" : "mb-4"} text-md font-semibold tracking-tight text-ink`}
          >
            {title}
          </h2>
        ) : (
          <CardTitle>
            <span id={headingId}>{title}</span>
          </CardTitle>
        )}
        {lede && (
          // Pulled up rather than tightening CardTitle's own `mb-3` through
          // className: two margin utilities on one element resolve by their
          // order in the generated stylesheet, not in the class attribute.
          <p
            className={`${lead ? "" : "-mt-1.5 "}mb-4 max-w-[70ch] text-xs leading-relaxed text-ink-muted`}
          >
            {lede}
          </p>
        )}
        {children}
      </Card>
    </section>
  );
}

/**
 * A field that says whether it holds something the server has not been told.
 *
 * The marker is an absolutely-positioned rail in the card's gutter and a
 * screen-reader suffix on the label: both are outside flow, so a field that
 * becomes edited — or stops being — does not move a pixel of the form.
 */
function FormField({
  edited = false,
  label,
  unit,
  htmlFor,
  className = "",
  children,
}: {
  edited?: boolean;
  label?: ReactNode;
  unit?: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field
      className={`relative ${className}`}
      htmlFor={htmlFor}
      label={
        label === undefined ? undefined : (
          <>
            {label}
            {unit && (
              <span className="font-normal text-ink-faint"> ({unit})</span>
            )}
            {edited && <span className="sr-only"> — edited, not saved</span>}
          </>
        )
      }
    >
      <EditedRail on={edited} />
      {children}
    </Field>
  );
}

function EditedRail({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-y-0 -left-3 w-0.5 rounded-full transition-colors duration-150 ${
        on ? "bg-accent" : "bg-transparent"
      }`}
    />
  );
}

/** One `label: value` line in the environment summary under the title. */
function EnvRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-ink-muted">{children}</dd>
    </div>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<SettingsDTO | null>(null);
  /** What the server last confirmed. Every dirty check is against this. */
  const [savedS, setSavedS] = useState<SettingsDTO | null>(null);
  const [env, setEnv] = useState<Record<string, unknown>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cal, setCal] = useState<CalibrateResponse | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);
  const [tokenCeilingsOpen, setTokenCeilingsOpen] = useState(false);
  /** Non-null only while the globs field is being edited. */
  const [copyGlobsText, setCopyGlobsText] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.settings) {
        setLoadError(
          res.status === 401
            ? "Signed out. Sign in again to load settings."
            : `The server answered ${res.status}.`,
        );
        return;
      }
      setS(json.settings);
      setSavedS(json.settings);
      setEnv(json.env ?? {});
    } catch (err) {
      setLoadError(
        `The server could not be reached — ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The globs field holds raw text while it is being typed, so the settings
  // object on its own is not what the operator is looking at. Everything —
  // the dirty check, the per-field marks and the PUT body — reads this one
  // derived value, or a pattern typed and not blurred would be dropped by a
  // Save that reported success.
  const effective = useMemo(
    () =>
      s === null
        ? null
        : copyGlobsText === null
          ? s
          : { ...s, isolationCopyGlobs: parseGlobs(copyGlobsText) },
    [s, copyGlobsText],
  );

  const changed = useMemo(() => {
    if (!effective || !savedS) return new Set<string>();
    return new Set(
      EDITABLE_PATHS.filter(
        (p) => JSON.stringify(at(effective, p)) !== JSON.stringify(at(savedS, p)),
      ),
    );
  }, [effective, savedS]);

  // One Save commits every field on the page, so the page has to say when there
  // is anything to commit — a button that is always available says nothing
  // about whether what is on screen is what is stored.
  const dirty = useMemo(
    () =>
      effective !== null &&
      savedS !== null &&
      JSON.stringify(effective) !== JSON.stringify(savedS),
    [effective, savedS],
  );

  function patch(p: Partial<SettingsDTO>) {
    setS((prev) => (prev ? { ...prev, ...p } : prev));
    setSaved(false);
    setSaveError(null);
  }

  function discard() {
    setS(savedS);
    setCopyGlobsText(null);
    setSaveError(null);
    setSaved(false);
  }

  async function save() {
    if (!effective) return;
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(effective),
      });
      const json = await res.json().catch(() => null);
      // A rejected field means nothing was saved — keep the edited form on
      // screen rather than replacing it with an undefined settings object.
      if (!res.ok || !json?.settings) {
        setSaveError(String(json?.error ?? `the server answered ${res.status}`));
        return;
      }
      setS(json.settings);
      setSavedS(json.settings);
      setCopyGlobsText(null);
      setSaved(true);
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function calibrate() {
    setCalBusy(true);
    setCalError(null);
    try {
      const res = await fetch("/api/calibrate", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        setCalError(`The scan failed — the server answered ${res.status}.`);
        return;
      }
      setCal(json);
    } catch (err) {
      setCalError(
        `The scan failed — ${err instanceof Error ? err.message : String(err)}.`,
      );
    } finally {
      setCalBusy(false);
    }
  }

  if (!s || !savedS || !effective) {
    return (
      <>
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Settings</h1>
        <Card>
          {loadError ? (
            <>
              <Notice tone="danger">
                <strong>Settings could not be loaded.</strong> {loadError}
              </Notice>
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </>
          ) : (
            <Empty>Loading settings…</Empty>
          )}
        </Card>
      </>
    );
  }

  const numOrEmpty = (v: number | null) => (v === null ? "" : String(v));
  const isEdited = (p: string) => changed.has(p);
  const guards = effective.chatDefaultGuards;
  const patchGuards = (p: Partial<RunGuardsDTO>) =>
    patch({ chatDefaultGuards: { ...guards, ...p } });
  const patchGuardBudget = (p: Partial<BudgetPolicyDTO>) =>
    patchGuards({ budget: { ...guards.budget, ...p } });
  const workspaceMounts = Array.isArray(env.workspaceMounts)
    ? (env.workspaceMounts as Array<{ id: string; label: string; path: string }>)
    : [];

  const modeNote = permissionNote(guards.permissionMode, guards.isolate);

  // Both refusals the PUT can answer with, checked here as well so the first
  // the operator hears of one is not a failed save. The server still decides.
  const noTerminus =
    guards.budget.maxIterations === null &&
    guards.budget.maxDurationMinutes === null;
  const resetTooFarAhead =
    effective.sessionResetOverrideAt !== null &&
    effective.sessionResetOverrideAt > Date.now() + FIVE_HOURS_MS;
  const blocked = noTerminus
    ? "The default guard set has neither a work-cycle limit nor a time limit."
    : resetTooFarAhead
      ? "The 5-hour reset override is more than five hours from now."
      : null;

  const applySuggestion = () => {
    if (!cal?.suggestion) return;
    patch({
      sessionCostLimit: cal.suggestion.sessionCostLimit,
      weeklyCostLimit: cal.suggestion.weeklyCostLimit,
      sessionTokenLimit: cal.suggestion.sessionTokenLimit,
      weeklyTokenLimit: cal.suggestion.weeklyTokenLimit,
    });
    // The token ceilings live behind a disclosure, and an unsaved edit the
    // operator cannot see is worse than one they did not ask for.
    setTokenCeilingsOpen(true);
  };

  const evidence = cal?.evidence ?? {};
  const ev = (k: string): number | null =>
    typeof evidence[k] === "number" ? evidence[k] : null;
  const evCount = (k: string, unit: string) => {
    const n = ev(k);
    return n === null ? "—" : `${n} ${unit}`;
  };

  return (
    <>
      <h1 className="mb-2 text-xl font-semibold tracking-tight">Settings</h1>

      {/* Presence, never content: the API answers with booleans for the admin
          key and the GitHub token, and nothing here asks for the values. */}
      <dl className="mb-5 grid max-w-[70ch] gap-x-8 gap-y-1.5 text-xs sm:grid-cols-2">
        <EnvRow label="Transcripts">
          <span className="mono">{String(env.claudeHome ?? "—")}</span>
        </EnvRow>
        <EnvRow label="Workspaces">
          {workspaceMounts.length === 0 ? (
            <span className="mono">{String(env.workspaceRoot ?? "—")}</span>
          ) : (
            workspaceMounts.map((m, i) => (
              <span key={m.id}>
                {i > 0 && <span aria-hidden> · </span>}
                {m.label} <span className="mono">{m.path}</span>
              </span>
            ))
          )}
        </EnvRow>
        <EnvRow label="Admin key">
          {env.adminKeyConfigured ? (
            <Badge tone="ok">configured</Badge>
          ) : (
            <>
              <Badge>not set</Badge>{" "}
              <span>the API account page stays empty</span>
            </>
          )}
        </EnvRow>
        <EnvRow label="GitHub token">
          {env.githubTokenConfigured ? (
            <Badge tone="ok">configured</Badge>
          ) : (
            <>
              <Badge tone="warn">not set</Badge>{" "}
              <span>runs cannot push or use gh</span>
            </>
          )}
        </EnvRow>
      </dl>

      <nav
        aria-label="Settings sections"
        className="mb-6 flex flex-wrap gap-1.5 border-b border-line pb-4"
      >
        {SECTIONS.map((sec) => (
          <a
            key={sec.id}
            href={`#${sec.id}`}
            className="inline-flex min-h-8 items-center rounded-full border border-line bg-inset px-3 text-xs font-medium text-ink-muted no-underline transition-colors duration-150 hover:border-line-strong hover:text-ink hover:no-underline"
          >
            {sec.label}
          </a>
        ))}
      </nav>

      <Section
        id="guards"
        lead
        title="Default guard set"
        lede={
          <>
            What an agent may do when the orchestrator chat proposes work
            without naming a template, and what a template the chat saves is
            created with. Runs you start yourself take their guards from the
            new-run form instead. The chat cannot change any of this.
          </>
        }
      >
        {/* Not a two-column row with the switch beside the select: a Field with
            no label starts where the other one's label does, so the two
            controls sit a label's height apart. */}
        <FormField
          label="Permission mode"
          htmlFor="cgpm"
          edited={isEdited("chatDefaultGuards.permissionMode")}
        >
          <Select
            id="cgpm"
            className="sm:max-w-72"
            value={guards.permissionMode}
            onChange={(e) => patchGuards({ permissionMode: e.target.value })}
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <Hint tone={modeNote.tone}>{modeNote.text}</Hint>
        </FormField>

        <FormField edited={isEdited("chatDefaultGuards.isolate")}>
          <Toggle
            id="cgiso"
            checked={guards.isolate}
            onChange={(v) => patchGuards({ isolate: v })}
            label={
              <>
                Work in its own checkout
                {isEdited("chatDefaultGuards.isolate") && (
                  <span className="sr-only"> — edited, not saved</span>
                )}
              </>
            }
          />
          <Hint tone={guards.isolate ? "neutral" : "warn"}>
            {guards.isolate
              ? "The run works on its own branch in a separate checkout, so another run can use the same project meanwhile — you land it from Branches once you have read it"
              : "The agent edits the folder you pick, and no other run may touch anything in that tree until it finishes"}
          </Hint>
        </FormField>

        <div className="grid gap-x-4 sm:grid-cols-3">
          <FormField
            label="Spend limit"
            unit="USD"
            htmlFor="cgcost"
            edited={isEdited("chatDefaultGuards.budget.maxRunCostUSD")}
          >
            <Input
              id="cgcost"
              type="number"
              min={0}
              step="0.5"
              className="tabular-nums"
              placeholder="No limit"
              value={numOrEmpty(guards.budget.maxRunCostUSD)}
              onChange={(e) =>
                patchGuardBudget({
                  maxRunCostUSD:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            <Hint>
              {SPEND_READ_AT[guards.budget.enforcement] ??
                SPEND_READ_AT["between-cycles"]}{" "}
              It is per run, so three at once can spend three times it
            </Hint>
          </FormField>

          <FormField
            label="Work cycles"
            htmlFor="cgcycles"
            edited={isEdited("chatDefaultGuards.budget.maxIterations")}
          >
            <Input
              id="cgcycles"
              type="number"
              min={1}
              className="tabular-nums"
              placeholder="No limit"
              aria-invalid={noTerminus || undefined}
              aria-describedby="cgcycles-hint"
              value={numOrEmpty(guards.budget.maxIterations)}
              onChange={(e) =>
                patchGuardBudget({
                  maxIterations:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            <Hint tone={noTerminus ? "danger" : "neutral"}>
              <span id="cgcycles-hint">
                {noTerminus
                  ? "Set this or a time limit — a run with neither would never have to end"
                  : "How many times the agent is sent back in before the run ends. Blank is only allowed alongside a time limit"}
              </span>
            </Hint>
          </FormField>

          <FormField
            label="Time limit"
            unit="minutes"
            htmlFor="cgmins"
            edited={isEdited("chatDefaultGuards.budget.maxDurationMinutes")}
          >
            <Input
              id="cgmins"
              type="number"
              min={1}
              className="tabular-nums"
              placeholder="No limit"
              aria-invalid={noTerminus || undefined}
              aria-describedby="cgmins-hint"
              value={numOrEmpty(guards.budget.maxDurationMinutes)}
              onChange={(e) =>
                patchGuardBudget({
                  maxDurationMinutes:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            <Hint tone={noTerminus ? "danger" : "neutral"}>
              <span id="cgmins-hint">
                {noTerminus
                  ? "Set this or a work-cycle limit — a run with neither would never have to end"
                  : "Wall clock, and the only limit that keeps moving whether or not a cycle reports what it spent"}
              </span>
            </Hint>
          </FormField>
        </div>

        <Subsection title="What one chat message may spend">
          <FormField
            label="Orchestrator chat limit"
            unit="USD per message"
            htmlFor="chatbudget"
            edited={isEdited("chatTurnBudgetUSD")}
            className={FLUSH}
          >
            <Input
              id="chatbudget"
              type="number"
              min={0}
              step="0.5"
              className="tabular-nums sm:max-w-56"
              placeholder="No limit"
              value={effective.chatTurnBudgetUSD ?? ""}
              onChange={(e) =>
                patch({
                  chatTurnBudgetUSD:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            <Hint>
              A chat is not a run and has no guards of its own, so this and a
              ten-minute timeout are the only two things that stop one message.
              It is spent on the conversation, never added to a run
            </Hint>
          </FormField>
        </Subsection>
      </Section>

      <Section
        id="limits"
        title="Subscription limits"
        lede="What this app believes your plan allows. Every percentage on the dashboard, and every window guard, is computed against these."
      >
        <Notice tone="warn">
          Anthropic publishes no numeric value for a Pro/Max limit and offers no
          endpoint to read one. Anything you enter here is an{" "}
          <strong>estimate</strong>.
        </Notice>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField
            label="5-hour ceiling"
            unit="USD"
            htmlFor="sessc"
            edited={isEdited("sessionCostLimit")}
          >
            <Input
              id="sessc"
              type="number"
              min={0}
              step="0.5"
              className="tabular-nums"
              placeholder="No ceiling"
              value={numOrEmpty(effective.sessionCostLimit)}
              onChange={(e) =>
                patch({
                  sessionCostLimit: e.target.value
                    ? Number(e.target.value)
                    : null,
                })
              }
            />
          </FormField>

          <FormField
            label="Weekly ceiling"
            unit="USD"
            htmlFor="wkc"
            edited={isEdited("weeklyCostLimit")}
          >
            <Input
              id="wkc"
              type="number"
              min={0}
              step="1"
              className="tabular-nums"
              placeholder="No ceiling"
              value={numOrEmpty(effective.weeklyCostLimit)}
              onChange={(e) =>
                patch({
                  weeklyCostLimit: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </FormField>
        </div>
        <Hint className="mb-3.5">
          Blank leaves that meter hatched rather than showing a percentage, and
          a guard written as a fraction of it is refused rather than ignored.
          Cost rather than raw tokens because a Claude Code workload is mostly
          cache reads, which bill at 0.1× and would otherwise dominate a
          token count without consuming a comparable share of your plan
        </Hint>

        <FormField
          label="Reserved headroom"
          unit="%"
          htmlFor="head"
          edited={isEdited("reservedHeadroomFraction")}
        >
          <Input
            id="head"
            type="number"
            min={0}
            max={95}
            className="tabular-nums sm:max-w-56"
            placeholder="Reserve nothing"
            value={
              effective.reservedHeadroomFraction === null
                ? ""
                : String(Math.round(effective.reservedHeadroomFraction * 100))
            }
            onChange={(e) =>
              patch({
                reservedHeadroomFraction: e.target.value
                  ? Math.min(Number(e.target.value) / 100, 0.95)
                  : null,
              })
            }
          />
          <Hint>
            Cowork, Desktop and the web app share your limits and write no local
            transcripts, so this tool cannot see them — reserving headroom
            shrinks every ceiling so guards trip early
            {effectiveCeilings(
              effective.reservedHeadroomFraction,
              effective.sessionCostLimit,
              effective.weeklyCostLimit,
            ).map((c, i) => (
              <span key={c.label}>
                {i === 0 ? " · effective " : ", "}
                {c.label} ceiling{" "}
                <strong className="text-ink tabular-nums">
                  {fmtUSD(c.effective)}
                </strong>{" "}
                <span className="tabular-nums">of {fmtUSD(c.raw)}</span>
              </span>
            ))}
          </Hint>
        </FormField>

        <details
          className="mb-3.5"
          open={tokenCeilingsOpen}
          onToggle={(e) => setTokenCeilingsOpen(e.currentTarget.open)}
        >
          {/* Padding rather than a flex box with a min height: Chrome drops the
              disclosure triangle the moment `display` stops being `list-item`,
              and a summary that looks like a sentence is not a control. */}
          <summary className="cursor-pointer py-2 text-xs text-ink-muted">
            Raw-token ceilings
            {(isEdited("sessionTokenLimit") || isEdited("weeklyTokenLimit")) && (
              <span className="ml-2 text-accent">· edited</span>
            )}
          </summary>
          <Hint className="mb-2.5">
            Used only while the matching cost ceiling above is blank
          </Hint>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField
              label="5-hour ceiling"
              unit="tokens"
              htmlFor="sess"
              edited={isEdited("sessionTokenLimit")}
            >
              <Input
                id="sess"
                type="number"
                min={0}
                className="tabular-nums"
                placeholder="Unused"
                value={numOrEmpty(effective.sessionTokenLimit)}
                onChange={(e) =>
                  patch({
                    sessionTokenLimit: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </FormField>
            <FormField
              label="Weekly ceiling"
              unit="tokens"
              htmlFor="wk"
              edited={isEdited("weeklyTokenLimit")}
            >
              <Input
                id="wk"
                type="number"
                min={0}
                className="tabular-nums"
                placeholder="Unused"
                value={numOrEmpty(effective.weeklyTokenLimit)}
                onChange={(e) =>
                  patch({
                    weeklyTokenLimit: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </FormField>
          </div>
        </details>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField
            label="Weekly reset"
            htmlFor="anchor"
            edited={isEdited("weeklyAnchor")}
          >
            <Select
              id="anchor"
              value={
                effective.weeklyAnchor
                  ? String(effective.weeklyAnchor.weekday)
                  : ""
              }
              onChange={(e) =>
                patch({
                  weeklyAnchor: e.target.value
                    ? {
                        weekday: Number(e.target.value),
                        hourUTC: effective.weeklyAnchor?.hourUTC ?? 0,
                      }
                    : null,
                })
              }
            >
              <option value="">Rolling 7 days (no fixed reset)</option>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  Resets {d}
                </option>
              ))}
            </Select>
            {effective.weeklyAnchor && (
              <Input
                type="number"
                min={0}
                max={23}
                className="mt-2 tabular-nums"
                aria-label="Reset hour, UTC"
                value={effective.weeklyAnchor.hourUTC}
                onChange={(e) =>
                  patch({
                    weeklyAnchor: {
                      weekday: effective.weeklyAnchor!.weekday,
                      hourUTC: Number(e.target.value),
                    },
                  })
                }
              />
            )}
            <Hint>
              Hour is UTC. Rolling means the weekly total decays over days
              rather than resetting, so no run can wait it out
            </Hint>
          </FormField>

          <FormField
            label="5-hour window reset"
            htmlFor="sessreset"
            edited={isEdited("sessionResetOverrideAt")}
          >
            <Input
              id="sessreset"
              type="datetime-local"
              className="tabular-nums"
              aria-invalid={resetTooFarAhead || undefined}
              aria-describedby="sessreset-hint"
              value={toLocalInput(effective.sessionResetOverrideAt)}
              onChange={(e) => {
                const at = e.target.value
                  ? new Date(e.target.value).getTime()
                  : null;
                patch({
                  sessionResetOverrideAt:
                    at !== null && Number.isFinite(at) ? at : null,
                });
              }}
            />
            <Hint
              tone={
                resetTooFarAhead
                  ? "danger"
                  : effective.sessionResetOverrideAt !== null &&
                      Date.now() < effective.sessionResetOverrideAt
                    ? "warn"
                    : "neutral"
              }
            >
              <span id="sessreset-hint">
                {resetTooFarAhead ? (
                  "No window can reset more than five hours from now — check the date"
                ) : effective.sessionResetOverrideAt === null ? (
                  "Blank is the normal state. Only needed after a tier change, which restarts the window with no trace in any transcript"
                ) : Date.now() < effective.sessionResetOverrideAt ? (
                  <>
                    In force until{" "}
                    {new Date(
                      effective.sessionResetOverrideAt,
                    ).toLocaleString()}{" "}
                    — work before it stays in history but leaves the current
                    window and the budget guard
                  </>
                ) : (
                  <>
                    Expired: that window ended{" "}
                    {new Date(
                      effective.sessionResetOverrideAt,
                    ).toLocaleString()}
                    . Clear the field to drop the split
                  </>
                )}
              </span>
            </Hint>
          </FormField>
        </div>

        <FormField edited={isEdited("includeSidechains")}>
          <Toggle
            id="side"
            checked={effective.includeSidechains}
            onChange={(v) => patch({ includeSidechains: v })}
            label={
              <>
                Count sub-agent turns in usage totals
                {isEdited("includeSidechains") && (
                  <span className="sr-only"> — edited, not saved</span>
                )}
              </>
            }
          />
          <Hint>
            Sub-agent turns bill normally, so counting them is the accurate
            default. It moves the dashboard meters and what the scan below
            measures — exclude only to compare main-thread cost
          </Hint>
        </FormField>

        <Subsection title="Where a ceiling can come from">
          <Hint className="mb-2.5">
            Nothing publishes your limit, so the least-bad evidence is your own
            history: a 5-hour block that reached a figure without being cut off
            proves the ceiling is at least that
          </Hint>
          <Button
            variant="secondary"
            onClick={() => void calibrate()}
            disabled={calBusy}
            aria-busy={calBusy || undefined}
          >
            {calBusy ? "Scanning every transcript…" : "Scan history"}
          </Button>

          {calError && (
            <Notice tone="danger" className="mt-3.5">
              {calError}
            </Notice>
          )}

          {cal && !cal.ok && (
            <Notice tone="warn" className="mt-3.5">
              {cal.reason}
            </Notice>
          )}

          {cal?.ok && cal.suggestion && (
            <div className="mt-3.5">
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>Ceiling</Th>
                      <Th num>Set now</Th>
                      <Th num>Observed peak</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <Tr>
                      <Td>
                        5-hour
                        <div className="text-xs text-ink-faint">
                          {cal.suggestion.sessionTokenLimit === null
                            ? "no completed block"
                            : `${fmtTokens(cal.suggestion.sessionTokenLimit)} raw tokens`}
                        </div>
                      </Td>
                      <Td num className="mono">
                        {effective.sessionCostLimit === null
                          ? "—"
                          : fmtUSD(effective.sessionCostLimit)}
                      </Td>
                      <Td num className="mono">
                        {cal.suggestion.sessionCostLimit === null
                          ? "—"
                          : fmtUSD(cal.suggestion.sessionCostLimit)}
                      </Td>
                    </Tr>
                    <Tr>
                      <Td>
                        Weekly
                        <div className="text-xs text-ink-faint">
                          {cal.suggestion.weeklyTokenLimit === null
                            ? "no full week yet"
                            : `${fmtTokens(cal.suggestion.weeklyTokenLimit)} raw tokens`}
                        </div>
                      </Td>
                      <Td num className="mono">
                        {effective.weeklyCostLimit === null
                          ? "—"
                          : fmtUSD(effective.weeklyCostLimit)}
                      </Td>
                      <Td num className="mono">
                        {cal.suggestion.weeklyCostLimit === null
                          ? "—"
                          : fmtUSD(cal.suggestion.weeklyCostLimit)}
                      </Td>
                    </Tr>
                  </tbody>
                </Table>
              </TableWrap>

              <dl className="mt-3.5 grid max-w-[70ch] gap-x-8 gap-y-1.5 text-xs sm:grid-cols-2">
                <EnvRow label="History">
                  <span className="tabular-nums">
                    {evCount("historyDays", "days")}
                  </span>
                </EnvRow>
                <EnvRow label="Confidence">
                  <Badge
                    tone={
                      cal.confidence === "reasonable"
                        ? "ok"
                        : cal.confidence === "moderate"
                          ? "warn"
                          : "danger"
                    }
                  >
                    {cal.confidence ?? "unknown"}
                  </Badge>
                </EnvRow>
                <EnvRow label="5-hour blocks">
                  <span className="tabular-nums">
                    {evCount("closedBlocks", "completed")}
                  </span>
                  {ev("blockCostP50") !== null && ev("blockCostP95") !== null && (
                    <span className="tabular-nums">
                      {" "}
                      · median {fmtUSD(ev("blockCostP50") as number)}, 95th{" "}
                      {fmtUSD(ev("blockCostP95") as number)}
                    </span>
                  )}
                </EnvRow>
                <EnvRow label="7-day windows">
                  <span className="tabular-nums">
                    {evCount("weeklyWindowsSampled", "sampled")}
                  </span>
                </EnvRow>
              </dl>

              <Notice tone="warn" className="mt-3.5">
                {cal.caveat}
              </Notice>

              <Button variant="secondary" onClick={applySuggestion}>
                Copy peaks into the fields above
              </Button>
              <Hint>
                Both metrics at once. Nothing is stored until you save
              </Hint>
            </div>
          )}
        </Subsection>
      </Section>

      <Section
        id="runs"
        title="Runs"
        lede="What the new-run form starts at, and how many runs may work at once."
      >
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField
            label="Default model"
            htmlFor="model"
            edited={isEdited("defaultModel")}
          >
            <Input
              id="model"
              type="text"
              placeholder="Claude Code's own default"
              value={effective.defaultModel ?? ""}
              onChange={(e) => patch({ defaultModel: e.target.value || null })}
            />
            <Hint>
              e.g. <span className="mono">claude-opus-5</span> or{" "}
              <span className="mono">claude-sonnet-5</span>
            </Hint>
          </FormField>

          <FormField
            label="Default permission mode"
            htmlFor="pm"
            edited={isEdited("defaultPermissionMode")}
          >
            <Select
              id="pm"
              value={effective.defaultPermissionMode}
              onChange={(e) => patch({ defaultPermissionMode: e.target.value })}
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <Hint>
              Pre-selected on the new-run form, where every run can change it.
              It does not reach the guard set above
            </Hint>
          </FormField>
        </div>

        <FormField
          label="Runs at the same time"
          htmlFor="conc"
          edited={isEdited("maxConcurrentRuns")}
        >
          <Input
            id="conc"
            type="number"
            min={1}
            className="tabular-nums sm:max-w-56"
            placeholder="No limit"
            value={effective.maxConcurrentRuns ?? ""}
            onChange={(e) =>
              patch({
                maxConcurrentRuns: e.target.value
                  ? Number(e.target.value)
                  : null,
              })
            }
          />
          <Hint>
            Each run carries its own spending limit, so this multiplies the
            worst case — three runs at $5 can spend $15. A run over the limit
            waits rather than being refused, and queued or parked runs do not
            count against it
          </Hint>
        </FormField>

        <Subsection title="Isolated runs">
          <FormField
            label="Files copied into a new checkout"
            htmlFor="copyglobs"
            edited={isEdited("isolationCopyGlobs")}
          >
            {/* Held as raw text while editing. Splitting on every keystroke
                drops the separator the moment it is typed, which makes a
                second pattern impossible to enter. */}
            <Input
              id="copyglobs"
              value={copyGlobsText ?? effective.isolationCopyGlobs.join(", ")}
              onChange={(e) => setCopyGlobsText(e.target.value)}
              onBlur={() => {
                if (copyGlobsText === null) return;
                patch({ isolationCopyGlobs: parseGlobs(copyGlobsText) });
                setCopyGlobsText(null);
              }}
            />
            <Hint>
              A fresh checkout holds committed work only, so a gitignored config
              file has to be copied in — prefix a pattern with{" "}
              <span className="mono">!</span> to exclude it. Dependencies are
              not copied; the agent installs them
            </Hint>
          </FormField>

          <FormField
            label="Landing a branch"
            htmlFor="landstrategy"
            edited={isEdited("landStrategy")}
            className={FLUSH}
          >
            <Select
              id="landstrategy"
              value={effective.landStrategy}
              onChange={(e) =>
                patch({ landStrategy: e.target.value as "merge" | "squash" })
              }
            >
              <option value="merge">Merge, keeping the run&rsquo;s commits</option>
              <option value="squash">Squash the run into one commit</option>
            </Select>
            <Hint>
              Merging keeps the run page&rsquo;s diff meaningful afterwards.
              Squashing rewrites the commits, so git can no longer see the merge
              and this tool tracks the branch by its tip instead
            </Hint>
          </FormField>
        </Subsection>
      </Section>

      <Section
        id="prompts"
        title="Prompts"
        lede="What this app says to Claude, over and above the task you type. Emptying one keeps the stored text rather than clearing it."
      >
        <FormField
          label="Continuation prompt"
          htmlFor="cont"
          edited={isEdited("continuationPrompt")}
        >
          <Textarea
            id="cont"
            className="min-h-[130px]"
            value={effective.continuationPrompt}
            onChange={(e) => patch({ continuationPrompt: e.target.value })}
          />
          <Hint>
            Sent at the start of every work cycle after the first. The run ends
            when the reply contains <span className="mono">DONE</span> on its
            own line, so keep that instruction
          </Hint>
        </FormField>

        <FormField
          label="Carry-on prompt"
          htmlFor="pushback"
          edited={isEdited("donePushbackPrompt")}
        >
          <Textarea
            id="pushback"
            className="min-h-[130px]"
            value={effective.donePushbackPrompt}
            onChange={(e) => patch({ donePushbackPrompt: e.target.value })}
          />
          <Hint>
            Sent when the agent reports <span className="mono">DONE</span> on a
            run set to carry on. It must not be the continuation prompt, which
            asks for <span className="mono">DONE</span> — that buys an immediate
            second one and a billed spin
          </Hint>
        </FormField>

        <FormField
          label="Isolated-run preamble"
          htmlFor="isopre"
          edited={isEdited("isolationPreamble")}
          className={FLUSH}
        >
          <Textarea
            id="isopre"
            className="min-h-[110px]"
            value={effective.isolationPreamble}
            onChange={(e) => patch({ isolationPreamble: e.target.value })}
          />
          <Hint>
            Prepended to the first prompt of an isolated run. Keep the
            instruction to commit: a worktree holds committed work only, so
            anything left uncommitted never reaches your branch
          </Hint>
        </FormField>
      </Section>

      <Section
        id="unattended"
        title="Unattended runs"
        lede="What happens while nobody is watching — mid-cycle checks, leftover processes, and a restart."
      >
        <FormField
          label="Live limit check"
          unit="seconds"
          htmlFor="livechk"
          edited={isEdited("liveGuardIntervalSeconds")}
        >
          <Input
            id="livechk"
            type="number"
            min={15}
            className="tabular-nums sm:max-w-56"
            value={effective.liveGuardIntervalSeconds}
            onChange={(e) =>
              patch({ liveGuardIntervalSeconds: Number(e.target.value) })
            }
          />
          <Hint>
            How often a run set to stop mid-cycle re-reads usage. It cannot beat
            one model turn however low this goes, because usage comes from
            transcripts written as each turn completes
          </Hint>
        </FormField>

        <FormField edited={isEdited("killProcessGroup")}>
          <Toggle
            id="killgroup"
            checked={effective.killProcessGroup}
            onChange={(v) => patch({ killProcessGroup: v })}
            label={
              <>
                Stopping a run also stops everything it started
                {isEdited("killProcessGroup") && (
                  <span className="sr-only"> — edited, not saved</span>
                )}
              </>
            }
          />
          <Hint>
            Builds, test runners and servers the agent launched otherwise hold
            the working directory open and keep writing into a folder the next
            run is about to use
          </Hint>
        </FormField>

        <FormField
          label="Restart grace"
          unit="hours"
          htmlFor="grace"
          edited={isEdited("resumeGraceHours")}
        >
          <Input
            id="grace"
            type="number"
            min={1}
            className="tabular-nums sm:max-w-56"
            value={effective.resumeGraceHours}
            onChange={(e) => patch({ resumeGraceHours: Number(e.target.value) })}
          />
          <Hint>
            A parked run older than this is closed out at boot rather than
            picked up, so a forgotten run cannot wake up days later and start
            spending
          </Hint>
        </FormField>

        <FormField edited={isEdited("telemetryForRuns")} className={FLUSH}>
          <Toggle
            id="telemetry"
            checked={effective.telemetryForRuns}
            onChange={(v) => patch({ telemetryForRuns: v })}
            label={
              <>
                Let agents report per-request cost over OpenTelemetry
                {isEdited("telemetryForRuns") && (
                  <span className="sr-only"> — edited, not saved</span>
                )}
              </>
            }
          />
          <Hint>
            The only record of what a work cycle killed mid-flight actually
            cost. Off by default because it changes the child process&rsquo;s
            behaviour, and it never feeds the meters. One exception: a run whose
            own spending limit needs it switches it on for itself
          </Hint>
        </FormField>
      </Section>

      {/* Sticky, because one Save commits every field on a page five sections
          long — the button must not be somewhere you have to hunt for after
          editing something at the top.

          The negative margin must match the shell's gutter at each breakpoint,
          or the bar is wider than the page and scrolls it sideways.

          Opaque and raised, not translucent: this bar spends most of its life
          lying across the middle of a card, and `bg-canvas/95` + blur left the
          card's border and text showing faintly through it — in dark mode,
          where canvas and surface are four hex digits apart, it read as a card
          torn in half with a button floating in the gap rather than as a bar in
          front of one. The upward shadow is what says "in front".

          Both buttons are always rendered, and the status line always occupies
          a line: a bar that gains a button the moment a field changes moves the
          only control the operator is reaching for. */}
      <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-canvas px-4 py-3 shadow-bar sm:-mx-5 sm:px-5">
        <ButtonRow>
          <Button
            onClick={() => void save()}
            disabled={busy || !dirty || blocked !== null}
            aria-busy={busy || undefined}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" onClick={discard} disabled={busy || !dirty}>
            Discard
          </Button>
          <p
            role="status"
            aria-atomic="true"
            className={`min-h-5 flex-1 basis-full text-xs leading-5 sm:basis-auto ${
              saveError
                ? "font-medium text-danger"
                : blocked
                  ? "text-danger"
                  : dirty
                    ? "text-warn"
                    : saved
                      ? "text-ok"
                      : "text-ink-faint"
            }`}
          >
            {saveError
              ? `Nothing was saved — ${saveError}`
              : blocked
                ? `Cannot save: ${blocked}`
                : busy
                  ? "Saving…"
                  : dirty
                    ? `${changed.size || "Some"} unsaved ${changed.size === 1 ? "change" : "changes"}, marked in the margin`
                    : saved
                      ? "Saved"
                      : "Everything here is saved"}
          </p>
        </ButtonRow>
      </div>
    </>
  );
}
