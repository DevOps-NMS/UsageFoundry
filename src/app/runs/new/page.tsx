"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MAX_TEMPLATE_NAME } from "@/lib/apiTypes";
import type {
  BudgetPolicyDTO,
  EnforcementModeDTO,
  FoldersResponse,
  RunDTO,
  RunTemplateDTO,
  SettingsDTO,
  UsageResponse,
  WorkspaceFolderDTO,
  WorkspaceMountDTO,
} from "@/lib/apiTypes";
import { fmtPct, fmtUSD, pctField } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button, ButtonRow } from "@/components/ui/Button";
import {
  Field,
  Input,
  LimitField,
  Select,
  Textarea,
  Toggle,
} from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";

/** Everything a template or an earlier run supplies to this form. */
interface FormSeed {
  mountId: string | null;
  folder: string | null;
  prompt: string;
  isolate: boolean;
  permissionMode: string;
  budget: BudgetPolicyDTO;
}

/**
 * Every value a template or a copied run can put on this form, in one object.
 *
 * Held separately from the controls' own state so the form can answer, per row,
 * "is this still what the template asked for, or is it mine?" — a question that
 * previously needed the template opened in another tab. `applySeed` writes the
 * resulting values here as the *baseline*; anything that differs from it now is
 * the operator's, and is offered a way back.
 */
interface FormValues {
  mountId: string;
  folder: string;
  prompt: string;
  isolate: boolean;
  permissionMode: string;
  iterationsCapped: boolean;
  maxIterations: string;
  costLimited: boolean;
  maxRunCostUSD: string;
  timeLimited: boolean;
  maxDurationMinutes: string;
  maxSessionFraction: string;
  maxWeeklyFraction: string;
  enforcement: EnforcementModeDTO;
  continueAfterDone: boolean;
}

/**
 * Where the values on the form came from. `defaults` is the form's own starting
 * point, which is not the same claim as "a template said so" — the two are
 * marked differently because only one of them is a decision somebody made.
 */
type Baseline = {
  kind: "defaults" | "template" | "run";
  values: FormValues;
};

/** A row of the form that can be reset to the baseline in one click. */
type RowId =
  | "task"
  | "where"
  | "isolate"
  | "permission"
  | "cycles"
  | "cost"
  | "time"
  | "session"
  | "weekly"
  | "enforcement"
  | "afterDone";

const ROW_FIELDS: Record<RowId, ReadonlyArray<keyof FormValues>> = {
  task: ["prompt"],
  where: ["mountId", "folder"],
  isolate: ["isolate"],
  permission: ["permissionMode"],
  cycles: ["iterationsCapped", "maxIterations"],
  cost: ["costLimited", "maxRunCostUSD"],
  time: ["timeLimited", "maxDurationMinutes"],
  session: ["maxSessionFraction"],
  weekly: ["maxWeeklyFraction"],
  enforcement: ["enforcement"],
  afterDone: ["continueAfterDone"],
};

/** What the reset button announces it is putting back. */
const ROW_LABEL: Record<RowId, string> = {
  task: "the task",
  where: "the workspace and folder",
  isolate: "isolation",
  permission: "the permission mode",
  cycles: "the work-cycle limit",
  cost: "the spending limit",
  time: "the time limit",
  session: "the 5-hour window guard",
  weekly: "the weekly window guard",
  enforcement: "when a limit is acted on",
  afterDone: "what happens after DONE",
};

/**
 * Rows whose provenance is worth marking even with no template loaded.
 *
 * The task and the folder are the operator's answer either way — marking them
 * "changed" against an empty form would put a badge on the two things this page
 * exists to collect. A guard is different: it has a default the operator may
 * never have looked at, so "this one is no longer the default" carries.
 */
const GUARD_ROWS: ReadonlySet<RowId> = new Set<RowId>([
  "isolate",
  "permission",
  "cycles",
  "cost",
  "time",
  "session",
  "weekly",
  "enforcement",
  "afterDone",
]);

const DEFAULT_VALUES: FormValues = {
  mountId: "",
  folder: "",
  prompt: "",
  isolate: true,
  // Overwritten by settings.defaultPermissionMode when it loads — and so is the
  // baseline, because a value this form filled in is not an override.
  permissionMode: "acceptEdits",
  iterationsCapped: true,
  maxIterations: "5",
  costLimited: true,
  maxRunCostUSD: "5",
  timeLimited: true,
  maxDurationMinutes: "60",
  maxSessionFraction: "",
  maxWeeklyFraction: "",
  // There is deliberately no `settings.defaultEnforcement`: a settable default
  // is a way to turn every run into a cycle-killing run by accident, and
  // between-cycles is the only mode that never throws work away.
  enforcement: "between-cycles",
  continueAfterDone: false,
};

/** A positive number, or null — the same reading `normalizePolicy` gives a field. */
function positive(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "45 minutes", "2 hours" — minutes stop reading as a quantity somewhere near 90. */
function humanMinutes(n: number): string {
  if (n < 90) return `${n} ${n === 1 ? "minute" : "minutes"}`;
  const hours = n / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

/** "a, b or c" — the guard summary reads as a sentence, not as a list. */
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/** One line describing what a template will do, for the picker's hint. */
function describeTemplate(t: RunTemplateDTO): string {
  const parts: string[] = [
    t.budget.maxIterations === null
      ? "no cycle limit"
      : `${t.budget.maxIterations} ${t.budget.maxIterations === 1 ? "cycle" : "cycles"}`,
  ];
  if (t.budget.maxRunCostUSD !== null)
    parts.push(`up to ${fmtUSD(t.budget.maxRunCostUSD)}`);
  if (t.budget.maxDurationMinutes !== null)
    parts.push(`${t.budget.maxDurationMinutes} min`);
  if (t.budget.enforcement !== "between-cycles")
    parts.push(
      t.budget.enforcement === "live-resume"
        ? "stops cycles in flight, carries on next window"
        : "stops cycles in flight",
    );
  if (t.permissionMode !== "acceptEdits") parts.push(t.permissionMode);
  if (t.budget.continueAfterDone) parts.push("ignores DONE");
  parts.push(
    t.folder === null ? "asks for a folder" : t.folder || "whole workspace",
  );
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Call-site pieces                                                    */
/* ------------------------------------------------------------------ */

/**
 * A field label with room for a provenance marker on the same line.
 *
 * `Field`'s own `label` prop renders inside `<label>`, and the marker is a
 * button — nesting one inside a label makes the label's own click target
 * ambiguous. So the head is composed here instead, matching `Field`'s label
 * typography exactly.
 */
function FieldHead({
  htmlFor,
  children,
  marker,
}: {
  htmlFor?: string;
  children: ReactNode;
  marker?: ReactNode;
}) {
  const text = (
    <span className="text-xs font-medium text-ink-muted">{children}</span>
  );
  return (
    // A fixed height whether or not a marker is present, so a label does not
    // shift down the moment a field is overridden.
    <div className="mb-1 flex min-h-8 items-center justify-between gap-3">
      {/* A <label> with nothing to point at is not a label. Two of these head
          a group rather than one control, and say so by being plain text. */}
      {htmlFor ? (
        // `mb-0` is load-bearing: the legacy sheet puts 5px under every bare
        // <label>, which in an items-center row lifts the text off centre.
        <label htmlFor={htmlFor} className="mb-0">
          {text}
        </label>
      ) : (
        text
      )}
      {marker}
    </div>
  );
}

/**
 * Whether a row still holds what the template gave it.
 *
 * Silence means "the form's own default" — the alternative was a badge on every
 * field saying `DEFAULT`, which is a badge that never varies and so says
 * nothing. What varies is a template's value, and an operator's edit of one.
 */
function ProvenanceMark({
  changed,
  from,
  what,
  onReset,
}: {
  changed: boolean;
  /** "template" / "that run", or null when the baseline is the form's defaults. */
  from: string | null;
  what: string;
  onReset: () => void;
}) {
  if (changed) {
    return (
      <button
        type="button"
        onClick={onReset}
        aria-label={`Reset ${what} to ${from ? `the ${from}` : "the default"}`}
        className="inline-flex min-h-8 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full border border-accent bg-inset px-2.5 py-0 text-2xs font-semibold uppercase tracking-wide text-accent transition-colors duration-150 hover:bg-accent-dim"
      >
        Changed · reset
      </button>
    );
  }
  if (!from) return null;
  return <Badge>from {from}</Badge>;
}

/** One option of a decision, as against one row of a dropdown. */
interface Choice<T extends string> {
  value: T;
  title: string;
  /** What Claude Code calls it, where the operator will meet the name again. */
  code?: string;
  /** What choosing it means for this run. Never a restatement of the title. */
  consequence: string;
  tone?: ChoiceTone;
  badge?: ReactNode;
}

type ChoiceTone = "neutral" | "warn" | "danger";

/**
 * Complete class strings per tone, looked up rather than interpolated —
 * Tailwind scans source as text, so `border-${tone}` emits nothing at all, and
 * does it silently.
 */
const CHOICE_SELECTED: Record<ChoiceTone, string> = {
  neutral: "border-accent ring-1 ring-accent bg-inset",
  warn: "border-warn ring-1 ring-warn bg-inset",
  danger: "border-danger ring-1 ring-danger bg-inset",
};

/**
 * A decision, spelled out.
 *
 * Permission mode, isolation and enforcement decide what an unattended agent
 * may do and what happens to work in flight. As `<select>`s they read as three
 * more dropdowns in a row of dropdowns, and their consequences were only
 * visible for whichever option happened to be selected.
 */
function ChoiceGroup<T extends string>({
  name,
  label,
  value,
  onChange,
  choices,
  marker,
  className = "",
}: {
  name: string;
  label: string;
  value: T;
  onChange: (next: T) => void;
  choices: ReadonlyArray<Choice<T>>;
  marker?: ReactNode;
  className?: string;
}) {
  const labelId = `${name}-label`;
  return (
    <div className={`mb-3.5 ${className}`}>
      <div className="mb-1 flex min-h-8 items-center justify-between gap-3">
        <span id={labelId} className="text-xs font-medium text-ink-muted">
          {label}
        </span>
        {marker}
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className="grid gap-1.5">
        {choices.map((c) => {
          const selected = c.value === value;
          return (
            <label
              key={c.value}
              htmlFor={`${name}-${c.value}`}
              className={`mb-0 flex cursor-pointer items-start gap-2.5 rounded-sm border px-3 py-2.5 transition-colors duration-150 ${
                selected
                  ? CHOICE_SELECTED[c.tone ?? "neutral"]
                  : "border-line hover:bg-inset"
              }`}
            >
              <input
                type="radio"
                id={`${name}-${c.value}`}
                name={name}
                value={c.value}
                checked={selected}
                onChange={() => onChange(c.value)}
                className="mt-1 h-3.5 w-3.5 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink">
                  {c.title}
                  {c.code && (
                    <span className="mono text-ink-faint">{c.code}</span>
                  )}
                  {c.badge}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-ink-muted">
                  {c.consequence}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Nothing to say about a field is not the same as an empty `aria-describedby`. */
function describedBy(...ids: Array<string | false | null | undefined>) {
  const list = ids.filter(Boolean).join(" ");
  return list === "" ? undefined : list;
}

/**
 * Something that would stop this run from starting, said where it is wrong.
 *
 * `immediate` separates the two kinds. A range error ("150 is not a
 * percentage") is true the moment it is typed and worth saying then. An
 * emptiness error is not an error yet while the field still has the cursor in
 * it, so it waits for the operator to leave — a form that turns red under the
 * caret is a form that argues with you as you type.
 */
interface Problem {
  /** The control to put the cursor in when the operator asks what is missing. */
  focus: string;
  message: string;
  immediate: boolean;
  /** Inside the collapsible limit detail, which must never hide an error. */
  inLimits: boolean;
}

export default function NewRunPage() {
  const router = useRouter();

  const [mounts, setMounts] = useState<WorkspaceMountDTO[]>([]);
  const [allFolders, setAllFolders] = useState<WorkspaceFolderDTO[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [started, setStarted] = useState<RunDTO | null>(null);

  const [mountId, setMountId] = useState(DEFAULT_VALUES.mountId);
  const [folder, setFolder] = useState(DEFAULT_VALUES.folder);
  const [prompt, setPrompt] = useState(DEFAULT_VALUES.prompt);
  const [isolate, setIsolate] = useState(DEFAULT_VALUES.isolate);
  const [permissionMode, setPermissionMode] = useState(
    DEFAULT_VALUES.permissionMode,
  );
  const [iterationsCapped, setIterationsCapped] = useState(
    DEFAULT_VALUES.iterationsCapped,
  );
  const [maxIterations, setMaxIterations] = useState(
    DEFAULT_VALUES.maxIterations,
  );
  const [costLimited, setCostLimited] = useState(DEFAULT_VALUES.costLimited);
  const [maxRunCostUSD, setMaxRunCostUSD] = useState(
    DEFAULT_VALUES.maxRunCostUSD,
  );
  const [maxSessionFraction, setMaxSessionFraction] = useState(
    DEFAULT_VALUES.maxSessionFraction,
  );
  const [maxWeeklyFraction, setMaxWeeklyFraction] = useState(
    DEFAULT_VALUES.maxWeeklyFraction,
  );
  const [timeLimited, setTimeLimited] = useState(DEFAULT_VALUES.timeLimited);
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(
    DEFAULT_VALUES.maxDurationMinutes,
  );
  const [enforcement, setEnforcement] = useState<EnforcementModeDTO>(
    DEFAULT_VALUES.enforcement,
  );
  const [continueAfterDone, setContinueAfterDone] = useState(
    DEFAULT_VALUES.continueAfterDone,
  );

  /** What the form was last filled from, and what "reset" puts back. */
  const [baseline, setBaseline] = useState<Baseline>({
    kind: "defaults",
    values: DEFAULT_VALUES,
  });

  // Templates. `templateName` is the save box rather than a mirror of the
  // picker: typing a name that already exists is how an edit is expressed, and
  // the save button says which of the two it will do.
  const [templates, setTemplates] = useState<RunTemplateDTO[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [rememberFolder, setRememberFolder] = useState(true);
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  // Whether the two settings that decide what an unattended agent may do came
  // from a template rather than from this operator, just now. Cleared the
  // moment either control is touched — after that it is their choice, and a
  // banner saying otherwise would be wrong.
  const [carriedEnforcement, setCarriedEnforcement] = useState(false);
  const [carriedPermission, setCarriedPermission] = useState(false);

  // Validation state. `touched` is per control and set on blur; `attempted`
  // covers the whole form and is set by a Start that could not go through.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [showLimits, setShowLimits] = useState(true);

  // Set before any fetch is issued, so the loaders below can tell "nobody has
  // chosen yet" from "a seed is on its way". Without it the mount default and
  // the settings default race a seed that arrives later and win or lose
  // depending on the connection.
  const seeded = useRef(false);
  // Belt to the disabled attribute's braces: a second submit can only come from
  // a key repeat inside the same tick, which no re-render has happened for yet.
  const inFlight = useRef(false);

  useEffect(() => {
    // Read from `window` rather than `useSearchParams`, which would force this
    // page behind a Suspense boundary purely to read one optional parameter.
    // Synchronous, so the guard below is in place before anything is fetched.
    const seedRunId = new URLSearchParams(window.location.search).get("from");
    if (seedRunId) seeded.current = true;

    fetch("/api/folders", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: FoldersResponse) => {
        setMounts(d.mounts ?? []);
        setAllFolders(d.folders ?? []);
        setFoldersLoaded(true);
        // Prefer the first mount that actually has something in it, so a
        // configured-but-empty mount does not look like the whole UI is broken.
        const first =
          d.mounts?.find((m) => m.available && m.folderCount > 0) ??
          d.mounts?.find((m) => m.available) ??
          d.mounts?.[0];
        if (first && !seeded.current) {
          setMountId(first.id);
          // The baseline moves with it. This form chose the mount, not the
          // operator, so marking it "changed" would be the page reporting its
          // own default back as an override.
          setBaseline((b) =>
            b.kind === "defaults"
              ? { ...b, values: { ...b.values, mountId: first.id } }
              : b,
          );
        }
      })
      .catch(() => setFoldersLoaded(true));

    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setSettings(d.settings);
        if (d.settings?.defaultPermissionMode && !seeded.current) {
          setPermissionMode(d.settings.defaultPermissionMode);
          setBaseline((b) =>
            b.kind === "defaults"
              ? {
                  ...b,
                  values: {
                    ...b.values,
                    permissionMode: d.settings.defaultPermissionMode,
                  },
                }
              : b,
          );
        }
      })
      .catch(() => void 0);

    fetch("/api/usage")
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => void 0);

    fetch("/api/templates", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setTemplates(d.templates ?? []))
      .catch(() => void 0);

    if (seedRunId) {
      fetch(`/api/runs/${seedRunId}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const run = d?.run as RunDTO | undefined;
          if (!run) return;
          // A run stores its folder absolute; `relPath` is the same folder as
          // the picker names it. A run whose mount has since gone gives null,
          // and then the folder cannot be carried at all.
          //
          // `isolation` is what the run *did*, not what it asked for — a run
          // that requested a worktree and got none because the folder was not
          // a repository comes back as "work in the folder itself". Copying the
          // outcome is the honest reading: it is the arrangement that produced
          // the result being copied.
          applySeed(
            {
              mountId: run.mountId ?? null,
              folder: run.mountId ? (run.relPath ?? "") : null,
              prompt: run.prompt,
              isolate: run.isolation === "worktree",
              permissionMode: run.budget.permissionMode ?? "acceptEdits",
              budget: run.budget,
            },
            "run",
            `Copied from run ${run.id.slice(0, 8)}`,
          );
        })
        .catch(() => void 0);
    }
    // Runs once. `applySeed` only calls setters, all of which are stable.
  }, []);

  const activeMount = useMemo(
    () => mounts.find((m) => m.id === mountId) ?? null,
    [mounts, mountId],
  );
  const folders = useMemo(
    () => allFolders.filter((f) => f.mountId === mountId),
    [allFolders, mountId],
  );
  const selectedFolder = useMemo(
    () => folders.find((f) => f.path === folder) ?? null,
    [folders, folder],
  );
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );
  // Case-insensitive, because the unique index on the name is. Without it the
  // button would offer to create a template the server then refuses.
  const nameTaken = useMemo(() => {
    const name = templateName.trim().toLowerCase();
    return name !== "" && templates.some((t) => t.name.toLowerCase() === name);
  }, [templates, templateName]);

  // Isolation needs a repository to branch from. Offering the choice on a plain
  // folder would promise parallelism the folder cannot give.
  const canIsolate = folder !== "" && selectedFolder?.isGitRepo === true;
  const isolated = canIsolate && isolate;

  const occupant = isolated ? null : (selectedFolder?.busyRunId ?? null);
  const rootOccupant = folder === "" ? (activeMount?.busyRunId ?? null) : null;
  // A parked run has yielded the folder, so this is worth saying but is not a
  // wait — hence separate from the two above, which are.
  const parked = isolated ? null : (selectedFolder?.parkedRunId ?? null);
  const rootParked = folder === "" ? (activeMount?.parkedRunId ?? null) : null;

  const weeklyCeilingSet =
    settings?.weeklyTokenLimit != null || settings?.weeklyCostLimit != null;
  const sessionCeilingSet =
    settings?.sessionTokenLimit != null || settings?.sessionCostLimit != null;
  const weeklyRolling = settings != null && settings.weeklyAnchor == null;
  const live = enforcement !== "between-cycles";
  const resuming = enforcement === "live-resume";
  // A spending limit that has to be read while a cycle is still running. The
  // run turns on Claude Code's per-request reporting for itself in that case,
  // because nothing else knows what this run has spent before its cycle ends.
  const liveSpendGuard = live && costLimited;
  const noTerminus = !iterationsCapped && !timeLimited;
  const noMountsUsable = foldersLoaded && !mounts.some((m) => m.available);
  const guardInterval = settings?.liveGuardIntervalSeconds ?? 60;

  /**
   * What each limit will actually mean on the wire.
   *
   * Blank, zero and negative are all `null` to `normalizePolicy` — which for
   * the two dollar-and-clock limits is *no limit at all*, not the number that
   * was there before. So the summary reads them the same way rather than
   * printing whatever is in the box.
   */
  const effCycles = iterationsCapped
    ? Math.max(1, Math.floor(positive(maxIterations) ?? 1))
    : null;
  const effCost = costLimited ? positive(maxRunCostUSD) : null;
  const effMinutes = timeLimited ? positive(maxDurationMinutes) : null;
  const effSessionPct = positive(maxSessionFraction);
  const effWeeklyPct = positive(maxWeeklyFraction);

  const current: FormValues = {
    mountId,
    folder,
    prompt,
    isolate,
    permissionMode,
    iterationsCapped,
    maxIterations,
    costLimited,
    maxRunCostUSD,
    timeLimited,
    maxDurationMinutes,
    maxSessionFraction,
    maxWeeklyFraction,
    enforcement,
    continueAfterDone,
  };

  const rowChanged = (row: RowId) =>
    ROW_FIELDS[row].some((k) => current[k] !== baseline.values[k]);

  /** "template" / "that run", or null when the form is on its own defaults. */
  const baselineFrom =
    baseline.kind === "defaults"
      ? null
      : baseline.kind === "template"
        ? "template"
        : "that run";

  function restoreRow(row: RowId) {
    const b = baseline.values;
    switch (row) {
      case "task":
        setPrompt(b.prompt);
        break;
      case "where":
        setMountId(b.mountId);
        setFolder(b.folder);
        break;
      case "isolate":
        setIsolate(b.isolate);
        break;
      case "permission":
        setPermissionMode(b.permissionMode);
        setCarriedPermission(b.permissionMode === "bypassPermissions");
        break;
      case "cycles":
        setIterationsCapped(b.iterationsCapped);
        setMaxIterations(b.maxIterations);
        break;
      case "cost":
        setCostLimited(b.costLimited);
        setMaxRunCostUSD(b.maxRunCostUSD);
        break;
      case "time":
        setTimeLimited(b.timeLimited);
        setMaxDurationMinutes(b.maxDurationMinutes);
        break;
      case "session":
        setMaxSessionFraction(b.maxSessionFraction);
        break;
      case "weekly":
        setMaxWeeklyFraction(b.maxWeeklyFraction);
        break;
      case "enforcement":
        setEnforcement(b.enforcement);
        setCarriedEnforcement(b.enforcement !== "between-cycles");
        break;
      case "afterDone":
        setContinueAfterDone(b.continueAfterDone);
        break;
    }
  }

  /** The marker that sits on a field's label line, or nothing. */
  function mark(row: RowId): ReactNode {
    const changed = rowChanged(row);
    // With no template in play the only thing worth saying is that a guard is
    // no longer its default — and the task and the folder have no default to
    // depart from, so they say nothing at all.
    if (baselineFrom === null && !(changed && GUARD_ROWS.has(row))) return null;
    return (
      <ProvenanceMark
        changed={changed}
        from={baselineFrom}
        what={ROW_LABEL[row]}
        onReset={() => restoreRow(row)}
      />
    );
  }

  /* ---------------------------------------------------------------- */
  /* Validation                                                        */
  /* ---------------------------------------------------------------- */

  const problems: Problem[] = [];
  if (!mountId || (foldersLoaded && !activeMount)) {
    problems.push({
      focus: "mount",
      message: noMountsUsable
        ? "No workspace is mounted, so there is nowhere for a run to work."
        : "Choose the workspace this run should work in.",
      immediate: false,
      inLimits: false,
    });
  }
  if (prompt.trim() === "") {
    problems.push({
      focus: "prompt",
      message: "Describe what Claude should work on.",
      immediate: false,
      inLimits: false,
    });
  }
  if (iterationsCapped && positive(maxIterations) === null) {
    problems.push({
      focus: "iters",
      message: "Set at least one work cycle, or switch the cycle limit off.",
      immediate: false,
      inLimits: true,
    });
  }
  if (costLimited && effCost === null) {
    problems.push({
      focus: "cost",
      message:
        "Enter an amount above $0, or switch the spending limit off — a blank box starts a run with no spending limit at all.",
      immediate: false,
      inLimits: true,
    });
  }
  if (timeLimited && effMinutes === null) {
    problems.push({
      focus: "dur",
      message:
        "Enter a number of minutes, or switch the time limit off — a blank box starts a run with no time limit at all.",
      immediate: false,
      inLimits: true,
    });
  }
  if (noTerminus) {
    problems.push({
      // The two mode pickers are inside `LimitField` and carry no id of their
      // own, so this points at the control that reveals them.
      focus: "limits-toggle",
      message:
        "Set a time limit, or cap the work cycles. Nothing else here only moves one way, so without one of them nothing would ever end this run.",
      immediate: true,
      inLimits: true,
    });
  }
  // Above 100 is not a stricter guard, it is a hundredth of one: the form sends
  // a fraction and `normalizePolicy` divides anything over 1 by a hundred
  // again, so a typed 150 arrives as 1.5%.
  if (
    maxSessionFraction !== "" &&
    !(effSessionPct !== null && effSessionPct <= 100)
  ) {
    problems.push({
      focus: "sess",
      message: "The 5-hour guard has to be between 1 and 100 percent.",
      immediate: true,
      inLimits: true,
    });
  }
  if (
    maxWeeklyFraction !== "" &&
    !(effWeeklyPct !== null && effWeeklyPct <= 100)
  ) {
    problems.push({
      focus: "wk",
      message: "The weekly guard has to be between 1 and 100 percent.",
      immediate: true,
      inLimits: true,
    });
  }

  const visible = problems.filter(
    (p) => p.immediate || attempted || touched[p.focus],
  );
  const problemFor = (focus: string) => visible.find((p) => p.focus === focus);
  // A collapsed section must never be the reason an error is unread — so the
  // detail is pinned open while one is live, and the control that would close
  // it says so rather than becoming a button that does nothing.
  const limitsPinned = visible.some((p) => p.inLimits);
  const limitsOpen = showLimits || limitsPinned;

  const touch = (id: string) => () =>
    setTouched((t) => (t[id] ? t : { ...t, [id]: true }));

  function focusControl(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "center" });
  }

  // Switching mounts invalidates the selected subfolder — fall back to the
  // mount's own root rather than carrying a path that lives somewhere else.
  function selectMount(id: string) {
    setMountId(id);
    setFolder("");
  }

  /**
   * The budget as the wire wants it. Shared by starting a run and saving a
   * template so the two cannot describe the same form differently — a template
   * that normalises even slightly unlike the run it was saved from would start
   * something other than what was tested.
   */
  function currentBudget() {
    return {
      // null is the wire form of "no limit" for all four of these —
      // normalizePolicy maps it to an unset cap rather than to a default.
      maxIterations: iterationsCapped ? maxIterations : null,
      maxRunCostUSD: costLimited ? maxRunCostUSD : null,
      maxDurationMinutes: timeLimited ? maxDurationMinutes : null,
      // Sent as a 0–1 fraction rather than the 0–100 the field shows.
      // normalizePolicy's frac() reads a bare 1 as 100%, so a user typing
      // "1" into a field labelled (%) would otherwise get no guard at all.
      maxWeeklyFraction: maxWeeklyFraction
        ? Number(maxWeeklyFraction) / 100
        : null,
      maxSessionFraction: maxSessionFraction
        ? Number(maxSessionFraction) / 100
        : null,
      enforcement,
      continueAfterDone,
    };
  }

  /**
   * Fill the form from a template or an earlier run.
   *
   * A limit that is off keeps whatever number is already in its box, so
   * switching it back on offers a sensible figure rather than an empty field
   * that reads as zero — which is why the baseline is the *result* of applying
   * the seed rather than the seed itself.
   */
  function applySeed(seed: FormSeed, kind: "template" | "run", note: string) {
    const b = seed.budget;
    const next: FormValues = {
      // A seed with no mount leaves the picker alone: it is saying "ask me",
      // and moving the selection would be answering on the operator's behalf.
      mountId: seed.mountId ?? mountId,
      folder: seed.mountId ? (seed.folder ?? "") : folder,
      prompt: seed.prompt,
      isolate: seed.isolate,
      permissionMode: seed.permissionMode,
      iterationsCapped: b.maxIterations !== null,
      maxIterations:
        b.maxIterations !== null ? String(b.maxIterations) : maxIterations,
      costLimited: b.maxRunCostUSD !== null,
      maxRunCostUSD:
        b.maxRunCostUSD !== null ? String(b.maxRunCostUSD) : maxRunCostUSD,
      timeLimited: b.maxDurationMinutes !== null,
      maxDurationMinutes:
        b.maxDurationMinutes !== null
          ? String(b.maxDurationMinutes)
          : maxDurationMinutes,
      maxSessionFraction: pctField(b.maxSessionFraction),
      maxWeeklyFraction: pctField(b.maxWeeklyFraction),
      enforcement: b.enforcement,
      continueAfterDone: b.continueAfterDone === true,
    };

    // Left alone rather than written back when the seed names no mount: this
    // runs from a `?from=` loader whose closure holds the values as they were
    // at first render, and re-setting them would clobber anything chosen since.
    if (seed.mountId) {
      setMountId(next.mountId);
      setFolder(next.folder);
    }
    setPrompt(next.prompt);
    setIsolate(next.isolate);
    setPermissionMode(next.permissionMode);
    setIterationsCapped(next.iterationsCapped);
    setMaxIterations(next.maxIterations);
    setCostLimited(next.costLimited);
    setMaxRunCostUSD(next.maxRunCostUSD);
    setTimeLimited(next.timeLimited);
    setMaxDurationMinutes(next.maxDurationMinutes);
    setMaxSessionFraction(next.maxSessionFraction);
    setMaxWeeklyFraction(next.maxWeeklyFraction);
    setEnforcement(next.enforcement);
    setContinueAfterDone(next.continueAfterDone);
    setBaseline({ kind, values: next });

    // The limits are now somebody's stated choice rather than this form's
    // defaults, so the detail folds away — available, not shouted.
    setShowLimits(false);

    // The two that decide what an unattended agent may do. Applied, but
    // announced — see the notices beside the controls themselves.
    setCarriedEnforcement(b.enforcement !== "between-cycles");
    setCarriedPermission(seed.permissionMode === "bypassPermissions");

    setTemplateNote(note);
    setTemplateError(null);
    setStarted(null);
    setFormError(null);
  }

  function pickTemplate(id: string) {
    setTemplateId(id);
    setArmedDelete(false);
    const t = templates.find((x) => x.id === id);
    if (!t) {
      setTemplateNote(null);
      setTemplateError(null);
      setCarriedEnforcement(false);
      setCarriedPermission(false);
      return;
    }
    applySeed(t, "template", `Loaded “${t.name}”`);
    setTemplateName(t.name);
    setRememberFolder(t.folder !== null);
  }

  async function saveTemplate() {
    const name = templateName.trim();
    // Typing an existing name is how an edit is asked for. Matched
    // case-insensitively because the unique index is, so the alternative is a
    // "already exists" refusal on a name that looks like the one in the box.
    const existing = templates.find(
      (t) => t.name.toLowerCase() === name.toLowerCase(),
    );
    setSavingTemplate(true);
    setTemplateError(null);
    setTemplateNote(null);
    try {
      const res = await fetch(
        existing ? `/api/templates/${existing.id}` : "/api/templates",
        {
          method: existing ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            prompt,
            // Both or neither: a path means nothing without the mount it is
            // relative to. Off means the template asks for a folder each time.
            mountId: rememberFolder ? mountId : null,
            folder: rememberFolder ? folder : null,
            // Stored raw rather than gated through `canIsolate`, which is about
            // the folder selected right now. The run form re-gates it against
            // whatever folder the template is eventually used on.
            isolate,
            permissionMode,
            budget: currentBudget(),
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save the template");
      const saved = json.template as RunTemplateDTO;
      setTemplates((prev) =>
        [...prev.filter((t) => t.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        ),
      );
      setTemplateId(saved.id);
      setTemplateNote(
        existing ? `Updated “${saved.name}”` : `Saved “${saved.name}”`,
      );
      // What is on screen is now this template, verbatim — so it is the
      // baseline, and nothing on the form is an override of it any more.
      setBaseline({ kind: "template", values: current });
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function removeTemplate() {
    const t = templates.find((x) => x.id === templateId);
    if (!t) return;
    // Two clicks rather than a dialog: the prompt inside a template is the
    // thing this feature exists to stop people losing, and the rest of the app
    // arms nothing. This one is worth arming.
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    setArmedDelete(false);
    setTemplateError(null);
    try {
      const res = await fetch(`/api/templates/${t.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Failed to delete the template");
      }
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
      setTemplateId("");
      setTemplateNote(
        `Deleted “${t.name}”. The form still holds its settings.`,
      );
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || submitting) return;

    // Everything the server would refuse, said here instead of after a
    // round-trip. The server stays the authority; this is the same answer,
    // sooner and next to the field that caused it.
    setAttempted(true);
    if (problems.length > 0) {
      const first = problems[0];
      // After the render that opens the limit detail — a control inside a
      // display:none subtree cannot take focus.
      requestAnimationFrame(() => focusControl(first.focus));
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setFormError(null);
    setStarted(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mountId,
          folder,
          prompt,
          permissionMode,
          isolate: canIsolate ? isolate : false,
          budget: currentBudget(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to start run");
      setStarted(json.run as RunDTO);
      setPrompt("");
      setAttempted(false);
      setTouched({});
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /* The guard summary — the one line that leads the limits card       */
  /* ---------------------------------------------------------------- */

  const stopParts: string[] = [];
  if (effCycles !== null)
    stopParts.push(`${effCycles} work ${effCycles === 1 ? "cycle" : "cycles"}`);
  if (effCost !== null) stopParts.push(fmtUSD(effCost));
  if (effMinutes !== null) stopParts.push(humanMinutes(effMinutes));

  // A spending limit is not a terminus and the summary must not read as though
  // it were: this run's own spend stops accruing the moment a cycle is killed
  // before it reports, so only the cycle count and the clock only move one way.
  const hasTerminus = effCycles !== null || effMinutes !== null;
  const summaryLead = !hasTerminus
    ? "Nothing would end this run."
    : stopParts.length === 1
      ? `Stops after ${stopParts[0]}.`
      : `Stops after ${joinClauses(stopParts)} — whichever comes first.`;

  const windowLines: string[] = [];
  if (effSessionPct !== null && effSessionPct <= 100) {
    windowLines.push(
      resuming
        ? `Steps aside when your 5-hour window reaches ${effSessionPct}%, and picks up again in the next one.`
        : `Stops when your 5-hour window reaches ${effSessionPct}%.`,
    );
  }
  if (effWeeklyPct !== null && effWeeklyPct <= 100) {
    windowLines.push(`Stops when your weekly window reaches ${effWeeklyPct}%.`);
  }

  const enforcementLine =
    enforcement === "between-cycles"
      ? "Limits are read before each cycle, so the cycle already running always finishes — and the run can end up one cycle past a limit."
      : resuming
        ? `Limits are also read about every ${guardInterval}s while Claude is working, and that cycle's work is lost. A full 5-hour window parks the run instead of ending it; every other limit still ends it.`
        : `Limits are also read about every ${guardInterval}s while Claude is working, and that cycle's work is lost. Tighter than waiting for the cycle to end, but still not an exact cut-off.`;

  const folderLabel = folder || activeMount?.label || "this workspace";

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">New run</h1>
        <p className="max-w-[68ch] text-ink-muted">
          One stretch of work is a{" "}
          <strong className="font-semibold text-ink">cycle</strong>. If the
          limits below allow, Claude is sent back into the same conversation for
          another cycle — until it reports the task complete, or a limit stops
          it. Nobody is watching while it works.
        </p>
      </div>

      {noMountsUsable && (
        <Notice tone="warn">
          <strong>No workspace is mounted.</strong> Nothing can run until one
          is. Check <span className="mono">UF_WORKSPACE</span> in{" "}
          <span className="mono">.env</span> and the volumes in{" "}
          <span className="mono">docker-compose.yml</span>.
        </Notice>
      )}

      {/* Own validation, not the browser's: a native bubble points at one field
          and vanishes, where these stay next to the field and say what to do. */}
      <form onSubmit={submit} noValidate>
        <Card className="mb-4" emphasis="primary">
          <CardTitle>What to work on</CardTitle>

          {templates.length > 0 && (
            <Field>
              <FieldHead htmlFor="tpl">Start from a template</FieldHead>
              <Select
                id="tpl"
                value={templateId}
                onChange={(e) => pickTemplate(e.target.value)}
                aria-describedby="tpl-hint"
              >
                <option value="">— no template —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <Hint>
                <span id="tpl-hint">
                  {selectedTemplate
                    ? describeTemplate(selectedTemplate)
                    : "Fills in everything below; nothing starts until you press Start run"}
                </span>
              </Hint>
            </Field>
          )}

          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field>
              <FieldHead htmlFor="mount">Workspace</FieldHead>
              <Select
                id="mount"
                value={mountId}
                onChange={(e) => selectMount(e.target.value)}
                onBlur={touch("mount")}
                disabled={!foldersLoaded || mounts.length === 0}
                aria-invalid={problemFor("mount") ? true : undefined}
                aria-describedby={describedBy(
                  "mount-hint",
                  problemFor("mount") && "mount-err",
                )}
                className={problemFor("mount") ? "ring-1 ring-danger" : ""}
                required
              >
                {!foldersLoaded && <option value="">Loading…</option>}
                {mounts.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available}>
                    {m.label}
                    {m.available ? "" : "  (not mounted)"}
                  </option>
                ))}
              </Select>
              {/* The stale-mount case is separate from the no-mounts case
                  because a template or an earlier run can name a workspace that
                  has since been removed from `.env`. Reported here rather than
                  left to `POST /api/runs`, which would refuse it correctly but
                  only after the operator pressed Start. */}
              <Hint
                tone={
                  !activeMount && foldersLoaded && mounts.length > 0
                    ? "warn"
                    : "neutral"
                }
              >
                <span id="mount-hint">
                  {activeMount ? (
                    <>
                      Mounted at{" "}
                      <span className="mono">{activeMount.path}</span>
                      {activeMount.error ? ` — ${activeMount.error}` : ""}
                    </>
                  ) : !foldersLoaded ? (
                    "Reading the configured mounts…"
                  ) : mounts.length === 0 ? (
                    "No workspace mounts are configured"
                  ) : (
                    "That workspace is not configured any more"
                  )}
                </span>
              </Hint>
              {problemFor("mount") && (
                <Hint tone="danger">
                  <span id="mount-err">{problemFor("mount")?.message}</span>
                </Hint>
              )}
            </Field>

            <Field>
              <FieldHead htmlFor="folder" marker={mark("where")}>
                Folder
              </FieldHead>
              <Select
                id="folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                disabled={!activeMount}
                aria-describedby="folder-hint"
              >
                <option value="">
                  {activeMount
                    ? `${activeMount.label} — the whole workspace`
                    : "— the whole workspace"}
                </option>
                {folders.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                    {f.isGitRepo ? "  (git)" : ""}
                    {f.busyRunId
                      ? "  · busy"
                      : f.parkedRunId
                        ? "  · parked"
                        : ""}
                    {f.queuedCount ? `  · ${f.queuedCount} waiting` : ""}
                  </option>
                ))}
              </Select>
              <Hint>
                <span id="folder-hint">
                  {folder === ""
                    ? "The whole tree, and every folder inside it"
                    : selectedFolder?.isGitRepo
                      ? "A git repository, so Claude can work on its own branch"
                      : "Not a git repository, so Claude works in it directly"}
                </span>
              </Hint>
            </Field>
          </div>

          {/* Whose folder it is, and who is waiting for it. Below the grid
              rather than inside a column, because these run to two lines and a
              two-column row with one tall cell reads as a broken layout. */}
          {folder === "" && folders.length > 0 && (
            <Hint className="mb-3.5">
              A run on the whole workspace takes the entire tree — no run in any
              folder inside it can start until this one finishes
            </Hint>
          )}
          {rootOccupant && (
            <Hint tone="warn" className="mb-3.5">
              A run is already working somewhere in this workspace, so this one
              waits for it
            </Hint>
          )}
          {!rootOccupant && rootParked && (
            <Hint className="mb-3.5">
              A parked run is waiting somewhere in this workspace. Yours starts
              now; it takes its folder back when yours finishes
            </Hint>
          )}
          {occupant && (
            <Hint tone="warn" className="mb-3.5">
              This folder is in use.{" "}
              <Link href={`/runs/${occupant}`}>See the run holding it</Link> —
              yours starts when it finishes
            </Hint>
          )}
          {!occupant && parked && (
            <Hint className="mb-3.5">
              A <Link href={`/runs/${parked}`}>parked run</Link> is waiting for
              this folder. Yours starts now; it takes the folder back when yours
              finishes
            </Hint>
          )}

          <Field className="mb-0">
            <FieldHead htmlFor="prompt" marker={mark("task")}>
              Task
            </FieldHead>
            <Textarea
              id="prompt"
              rows={9}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={touch("prompt")}
              placeholder={
                "Add integration tests for the payments module and make them pass.\n\nThe suite runs with `npm test`. Do not change the public API."
              }
              aria-invalid={problemFor("prompt") ? true : undefined}
              aria-describedby={describedBy(
                "prompt-hint",
                problemFor("prompt") && "prompt-err",
              )}
              className={problemFor("prompt") ? "ring-1 ring-danger" : ""}
              required
            />
            <Hint>
              <span id="prompt-hint">
                {prompt.trim() === ""
                  ? "Say what to change and how Claude will know it worked — this text is sent verbatim as the first turn"
                  : "Sent verbatim as the first turn; the run ends when Claude replies DONE"}
              </span>
            </Hint>
            {problemFor("prompt") && (
              <Hint tone="danger">
                <span id="prompt-err">{problemFor("prompt")?.message}</span>
              </Hint>
            )}
          </Field>
        </Card>

        <Card className="mb-4">
          <CardTitle>What the agent may do</CardTitle>

          {canIsolate ? (
            <ChoiceGroup
              name="isolation"
              label="Where Claude writes"
              value={isolate ? "worktree" : "direct"}
              onChange={(v) => setIsolate(v === "worktree")}
              marker={mark("isolate")}
              choices={[
                {
                  value: "worktree",
                  title: "Its own checkout, on a new branch",
                  consequence:
                    "Starts from the last commit and commits as it goes. Your uncommitted work stays where it is, and other runs can use this folder at the same time. Only the config files named in Settings are copied across — dependencies are the agent's job.",
                },
                {
                  value: "direct",
                  title: "This folder, as it stands",
                  consequence:
                    "Claude edits the files you have open, uncommitted work included. No other run can use this folder, or anything under it, until this one finishes.",
                },
              ]}
            />
          ) : (
            <Field>
              <FieldHead>Where Claude writes</FieldHead>
              <Hint>
                {folder === ""
                  ? "A run on the whole workspace always works in place, and holds the entire tree until it finishes"
                  : "This folder is not a git repository, so there is no branch to work on — Claude edits it in place and no other run can use it meanwhile"}
              </Hint>
            </Field>
          )}

          {/* Applying a template must not be the same as choosing. This setting
              decides what an unattended agent is allowed to do, so it is
              applied, named, and offered back. */}
          {carriedPermission && (
            <Notice tone="danger">
              <strong>
                The template carries{" "}
                <span className="mono">bypassPermissions</span>.
              </strong>{" "}
              Claude can run any command in the folder without asking. Worth
              choosing again rather than inheriting.
              <ButtonRow className="mt-2.5">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setPermissionMode("acceptEdits");
                    setCarriedPermission(false);
                  }}
                >
                  Only let it edit files
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setCarriedPermission(false)}
                >
                  Keep it
                </Button>
              </ButtonRow>
            </Notice>
          )}

          <ChoiceGroup
            name="perm"
            label="What it may do without asking"
            value={permissionMode}
            onChange={(v) => {
              setPermissionMode(v);
              // Chosen here, so it is no longer inherited — the banner above
              // would be describing a decision that is now the operator's.
              setCarriedPermission(false);
            }}
            marker={mark("permission")}
            className="mb-2"
            choices={[
              {
                value: "acceptEdits",
                title: "Edit files, ask for anything else",
                code: "acceptEdits",
                consequence:
                  "File edits and read-only commands go ahead. Anything else is refused, and the refusal is listed in the run log.",
              },
              {
                value: "plan",
                title: "Read and plan only",
                code: "plan",
                consequence: "Nothing on disk changes.",
              },
              {
                value: "default",
                title: "Ask before everything",
                code: "default",
                tone: "warn",
                badge: <Badge tone="warn">stalls</Badge>,
                consequence:
                  "There is nobody to answer the prompt, so the run sits there until a limit stops it.",
              },
              {
                value: "bypassPermissions",
                title: "Anything, without asking",
                code: "bypassPermissions",
                tone: "danger",
                badge: <Badge tone="danger">risky</Badge>,
                consequence:
                  "Any command in the folder — deleting files, reaching the network. Only for code and a container you are willing to have modified.",
              },
            ]}
          />

          {isolated && (
            <Hint>
              An isolated run is also allowed{" "}
              <span className="mono">git add</span> and{" "}
              <span className="mono">git commit</span>, whatever is chosen above
              — that is how its work reaches its branch
            </Hint>
          )}
          {permissionMode === "bypassPermissions" && (
            <Hint>
              <span className="mono">pkill</span> and{" "}
              <span className="mono">killall</span> stay refused in every mode,
              because a name match reaches this server as readily as the
              agent&rsquo;s own processes
            </Hint>
          )}
        </Card>

        <Card className="mb-4">
          <CardTitle>When it stops</CardTitle>

          {/* Applied, but announced — for the same reason as bypassPermissions
              above. There is no global default for this setting precisely so
              that no single edit turns every run into a cycle-killing one, and
              a template is the second way to inherit that choice. */}
          {carriedEnforcement && (
            <Notice tone="warn">
              <strong>The template cuts cycles short.</strong>{" "}
              {resuming
                ? "“Stop the cycle, carry on next window”"
                : "“Stop the cycle in flight”"}{" "}
              reads your limits mid-cycle and kills the agent when one trips, so
              that cycle&rsquo;s work is thrown away.
              <ButtonRow className="mt-2.5">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setEnforcement("between-cycles");
                    setCarriedEnforcement(false);
                  }}
                >
                  Let the cycle finish instead
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setCarriedEnforcement(false)}
                >
                  Keep it
                </Button>
              </ButtonRow>
            </Notice>
          )}

          <p
            className={`text-sm tabular-nums ${
              hasTerminus ? "text-ink" : "text-danger"
            }`}
          >
            {summaryLead}
          </p>
          {windowLines.map((line) => (
            <p key={line} className="mt-1 text-sm tabular-nums text-ink">
              {line}
            </p>
          ))}
          {!hasTerminus && (
            <p className="mt-1 max-w-[68ch] text-xs leading-snug text-danger">
              Nothing here only moves one way: this run&rsquo;s own spend stops
              accruing the moment a cycle is killed, and both window percentages
              can fall. Set a time limit, or cap the work cycles.
            </p>
          )}
          <p className="mt-1.5 max-w-[68ch] text-xs leading-snug text-ink-muted">
            {enforcementLine}
          </p>

          <button
            type="button"
            id="limits-toggle"
            onClick={() => {
              if (!limitsPinned) setShowLimits((v) => !v);
            }}
            aria-expanded={limitsOpen}
            aria-disabled={limitsPinned || undefined}
            aria-controls="limit-detail"
            // aria-disabled rather than disabled: this is the focus target the
            // error summary jumps to, and a disabled button cannot take focus.
            className={`mt-3 inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-line-strong bg-inset px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
              limitsPinned
                ? "cursor-default text-ink-muted"
                : "cursor-pointer text-ink hover:border-ink-faint"
            }`}
          >
            <span aria-hidden="true" className="text-ink-faint">
              {limitsOpen ? "▾" : "▸"}
            </span>
            {limitsPinned
              ? "Open until the limits are settled"
              : limitsOpen
                ? "Hide the limits"
                : "Change these limits"}
          </button>

          <div
            id="limit-detail"
            className={limitsOpen ? "mt-4 border-t border-line pt-4" : "hidden"}
          >
            <Field>
              <FieldHead
                htmlFor={iterationsCapped ? "iters" : undefined}
                marker={mark("cycles")}
              >
                Work cycles
              </FieldHead>
              {/* `LimitField` takes no onBlur of its own; React's onBlur is
                  focusout, which bubbles, so the wrapper catches the mode
                  picker and the value alike. */}
              <div onBlur={touch("iters")}>
                <LimitField
                  id="iters"
                  modeLabel="Work cycle limit mode"
                  enabled={iterationsCapped}
                  onEnabledChange={setIterationsCapped}
                  value={maxIterations}
                  onValueChange={setMaxIterations}
                  unit="cycles"
                  offLabel="No cycle limit"
                />
              </div>
              <Hint>
                {iterationsCapped
                  ? "Each cycle picks up the same conversation where the last one left off; 1 means one pass and then stop"
                  : "Needs the time limit below — the clock is the only limit that keeps advancing whether or not Claude reports what it spent"}
              </Hint>
              {problemFor("iters") && (
                <Hint tone="danger">{problemFor("iters")?.message}</Hint>
              )}
            </Field>

            <Field>
              <FieldHead
                htmlFor={costLimited ? "cost" : undefined}
                marker={mark("cost")}
              >
                Spending limit for this run
              </FieldHead>
              {/* `LimitField` takes no onBlur of its own; React's onBlur is
                  focusout, which bubbles, so the wrapper catches the mode
                  picker and the value alike. */}
              <div onBlur={touch("cost")}>
                <LimitField
                  id="cost"
                  modeLabel="Spending limit mode"
                  enabled={costLimited}
                  onEnabledChange={setCostLimited}
                  value={maxRunCostUSD}
                  onValueChange={setMaxRunCostUSD}
                  unit="USD"
                  offLabel="No spending limit"
                  min={0}
                  step="0.5"
                />
              </div>
              <Hint>
                {!costLimited
                  ? "This run is not capped in dollars — only the cycle count, the clock and the two window guards below stop it"
                  : live
                    ? "Read mid-cycle too, so the run stops near this figure rather than a whole cycle past it"
                    : "No new cycle starts once this much is spent, so the final figure can be up to one cycle higher"}
              </Hint>
              {liveSpendGuard && (
                <Hint>
                  This run switches on Claude Code&rsquo;s own per-request
                  reporting so the figure can be read mid-cycle; those records
                  land a second or two behind the spend, and what a cut-short
                  cycle cost is worked back out of your transcripts afterwards
                </Hint>
              )}
              {problemFor("cost") && (
                <Hint tone="danger">{problemFor("cost")?.message}</Hint>
              )}
            </Field>

            <Field>
              <FieldHead
                htmlFor={timeLimited ? "dur" : undefined}
                marker={mark("time")}
              >
                Time limit
              </FieldHead>
              {/* `LimitField` takes no onBlur of its own; React's onBlur is
                  focusout, which bubbles, so the wrapper catches the mode
                  picker and the value alike. */}
              <div onBlur={touch("dur")}>
                <LimitField
                  id="dur"
                  modeLabel="Time limit mode"
                  enabled={timeLimited}
                  onEnabledChange={setTimeLimited}
                  value={maxDurationMinutes}
                  onValueChange={setMaxDurationMinutes}
                  unit="minutes"
                  offLabel="No time limit"
                />
              </div>
              <Hint>
                {!timeLimited
                  ? "The run continues until Claude reports the task complete, or another limit stops it"
                  : live
                    ? "Measured from the start and including any time parked; a cycle can be cut off part-way"
                    : "Measured from the start and including any time parked; a cycle already underway is never cut off mid-edit"}
              </Hint>
              {timeLimited && resuming && (effMinutes ?? 0) > 720 && (
                <Hint tone="warn">
                  That is about {((effMinutes ?? 0) / 60).toFixed(0)} hours of
                  unattended agent, most of it likely spent waiting
                </Hint>
              )}
              {problemFor("dur") && (
                <Hint tone="danger">{problemFor("dur")?.message}</Hint>
              )}
            </Field>

            <div className="grid gap-x-4 sm:grid-cols-2">
              <Field>
                <FieldHead htmlFor="sess" marker={mark("session")}>
                  {resuming
                    ? "Step aside at 5-hour usage"
                    : "Stop at 5-hour usage"}
                </FieldHead>
                <div className="flex items-center gap-2">
                  <Input
                    id="sess"
                    type="number"
                    min={1}
                    max={100}
                    placeholder="off"
                    value={maxSessionFraction}
                    onChange={(e) => setMaxSessionFraction(e.target.value)}
                    onBlur={touch("sess")}
                    aria-invalid={problemFor("sess") ? true : undefined}
                    aria-describedby={describedBy(
                      "sess-hint",
                      problemFor("sess") && "sess-err",
                    )}
                    className={`min-w-0 flex-1 tabular-nums ${
                      problemFor("sess") ? "ring-1 ring-danger" : ""
                    }`}
                  />
                  <span className="whitespace-nowrap text-xs text-ink-muted">
                    %
                  </span>
                </div>
                {problemFor("sess") ? (
                  <Hint tone="danger">
                    <span id="sess-err">{problemFor("sess")?.message}</span>
                  </Hint>
                ) : maxSessionFraction && !sessionCeilingSet ? (
                  <Hint tone="warn">
                    <span id="sess-hint">
                      No 5-hour ceiling is set, so this guard has nothing to
                      measure against and the run is refused before its first
                      cycle — <Link href="/settings">set one</Link>
                    </span>
                  </Hint>
                ) : (
                  <Hint>
                    <span id="sess-hint">
                      {resuming
                        ? "Measures your whole subscription, not this run's share; the run waits and picks up in the next window"
                        : "Measures your whole subscription, not this run's share"}
                      {usage
                        ? usage.snapshot.session.fraction != null
                          ? ` · now at ${fmtPct(usage.snapshot.session.fraction)}`
                          : " · no ceiling set, so there is no percentage to show"
                        : ""}
                    </span>
                  </Hint>
                )}
              </Field>

              <Field>
                <FieldHead htmlFor="wk" marker={mark("weekly")}>
                  Stop at weekly usage
                </FieldHead>
                <div className="flex items-center gap-2">
                  <Input
                    id="wk"
                    type="number"
                    min={1}
                    max={100}
                    placeholder="off"
                    value={maxWeeklyFraction}
                    onChange={(e) => setMaxWeeklyFraction(e.target.value)}
                    onBlur={touch("wk")}
                    aria-invalid={problemFor("wk") ? true : undefined}
                    aria-describedby={describedBy(
                      "wk-hint",
                      problemFor("wk") && "wk-err",
                    )}
                    className={`min-w-0 flex-1 tabular-nums ${
                      problemFor("wk") ? "ring-1 ring-danger" : ""
                    }`}
                  />
                  <span className="whitespace-nowrap text-xs text-ink-muted">
                    %
                  </span>
                </div>
                {problemFor("wk") ? (
                  <Hint tone="danger">
                    <span id="wk-err">{problemFor("wk")?.message}</span>
                  </Hint>
                ) : maxWeeklyFraction && !weeklyCeilingSet ? (
                  <Hint tone="warn">
                    <span id="wk-hint">
                      No weekly ceiling is set, so this guard has nothing to
                      measure against and the run is refused before its first
                      cycle — <Link href="/settings">set one</Link>
                    </span>
                  </Hint>
                ) : (
                  <Hint>
                    <span id="wk-hint">
                      Always ends the run — a weekly window has no reset instant
                      to wait for
                      {usage
                        ? usage.snapshot.weekly.fraction != null
                          ? ` · now at ${fmtPct(usage.snapshot.weekly.fraction)}`
                          : " · no ceiling set, so there is no percentage to show"
                        : ""}
                    </span>
                  </Hint>
                )}
              </Field>
            </div>

            <ChoiceGroup
              name="enf"
              label="When a limit is reached"
              value={enforcement}
              onChange={(v) => {
                setEnforcement(v);
                setCarriedEnforcement(false);
              }}
              marker={mark("enforcement")}
              choices={[
                {
                  value: "between-cycles",
                  title: "Let the cycle finish, then stop",
                  consequence:
                    "Limits are read before each cycle only. The run can end up one cycle past a limit, and no work is thrown away.",
                },
                {
                  value: "live",
                  title: "Stop the cycle in flight",
                  tone: "warn",
                  consequence: `Limits are also read about every ${guardInterval}s while Claude is working. The cycle is killed and its work is lost — tighter, but still not an exact cut-off.`,
                },
                {
                  value: "live-resume",
                  title: "Stop the cycle, carry on next window",
                  tone: "warn",
                  consequence:
                    "As above, except a full 5-hour window parks the run until the window refills. It is the only limit that can be waited out; every other one still ends the run.",
                },
              ]}
            />

            {live && !costLimited && settings?.telemetryForRuns === false && (
              <Hint tone="warn" className="mb-3.5">
                Consider turning on{" "}
                <Link href="/settings">agent self-reporting</Link> — it is the
                only independent record of what a cut-short cycle cost
              </Hint>
            )}
            {resuming && !maxSessionFraction && (
              <Hint className="mb-3.5">
                With no 5-hour percentage the run carries on until Claude itself
                refuses a cycle, then waits for the allowance to refill
              </Hint>
            )}

            <Field className="mb-0">
              <FieldHead marker={mark("afterDone")}>
                When Claude says the task is done
              </FieldHead>
              <Toggle
                id="after-done"
                checked={continueAfterDone}
                onChange={setContinueAfterDone}
                label="Send it back in until a limit stops it"
              />
              <Hint>
                {continueAfterDone
                  ? "Claude is asked to verify and tighten rather than invent work, and the run can then only end at a limit"
                  : "The run ends as soon as Claude replies DONE"}
              </Hint>
              {continueAfterDone && !isolated && (
                <Hint tone="warn">
                  This run edits your folder directly and will keep editing it
                  after it believes the task is finished
                </Hint>
              )}
            </Field>
          </div>
        </Card>

        <Card className="mb-4" emphasis="quiet">
          <CardTitle>Save for next time</CardTitle>

          <Field>
            <FieldHead htmlFor="tpl-name">Template name</FieldHead>
            <div className="flex items-center gap-2">
              <Input
                id="tpl-name"
                className="min-w-0 flex-1"
                value={templateName}
                onChange={(e) => {
                  setTemplateName(e.target.value);
                  setArmedDelete(false);
                }}
                placeholder="Update dependencies and fix what breaks"
                maxLength={MAX_TEMPLATE_NAME}
                aria-describedby="tpl-name-hint"
              />
              <Button
                type="button"
                variant="secondary"
                className="shrink-0"
                onClick={saveTemplate}
                disabled={savingTemplate || !templateName.trim() || !prompt}
              >
                {savingTemplate ? "Saving…" : nameTaken ? "Update" : "Save"}
              </Button>
              {templateId && (
                <Button
                  type="button"
                  variant={armedDelete ? "danger" : "ghost"}
                  className="shrink-0"
                  onClick={removeTemplate}
                >
                  {armedDelete ? "Really delete" : "Delete"}
                </Button>
              )}
            </div>
            <Hint>
              <span id="tpl-name-hint">
                {!prompt
                  ? "Write the task above first — the prompt is the part worth saving"
                  : nameTaken
                    ? `Replaces the template already called “${templateName.trim()}”`
                    : "Keeps the task, the limits and how it behaves. Not the model — that stays a single global setting"}
              </span>
            </Hint>
          </Field>

          <Field className="mb-0">
            <Toggle
              id="tpl-folder"
              checked={rememberFolder}
              onChange={setRememberFolder}
              label="Remember the workspace and folder chosen above"
            />
            <Hint>
              {rememberFolder
                ? "The template pre-selects that folder. Right for a task about one project"
                : "The template asks for a folder each time. Right for a task that applies to any project"}
            </Hint>
          </Field>

          {templateNote && (
            <Hint>
              <span role="status">{templateNote}</span>
            </Hint>
          )}
          {templateError && (
            <Hint tone="danger">
              <span role="alert">{templateError}</span>
            </Hint>
          )}
        </Card>

        {resuming && weeklyRolling && (
          <Notice tone="warn">
            Your weekly window is set to <strong>rolling 7 days</strong>, so it
            has no reset instant. That does not stop this mode — the run waits
            on the 5-hour window, which always rolls over — but a weekly
            percentage will only fall as old usage ages out, over days. Set your
            reset day in <Link href="/settings">Settings</Link> if you know it.
          </Notice>
        )}

        {resuming && !isolated && (
          <Notice tone="warn">
            A waiting run keeps hold of its checkout. Nothing else can run in{" "}
            <span className="mono">{folderLabel}</span> while it waits, which
            can be up to five hours at a stretch.
          </Notice>
        )}

        {permissionMode === "bypassPermissions" &&
          (resuming || continueAfterDone) && (
            <Notice tone="danger">
              <strong>Read this before starting.</strong> This run can run any
              command without asking
              {resuming && ", will keep going across several 5-hour windows"}
              {continueAfterDone &&
                ", will not stop when it believes the work is finished"}
              , and nobody will be watching it.{" "}
              {effMinutes !== null
                ? `It ends by itself after ${humanMinutes(effMinutes)}.`
                : "Nothing here bounds it in wall-clock time."}
            </Notice>
          )}

        {formError && (
          <div role="alert">
            <Notice tone="danger">
              <strong>The run was not started.</strong> {formError}
            </Notice>
          </div>
        )}

        {started && (
          <div role="status">
            <Notice tone={started.status === "queued" ? "warn" : "info"}>
              {started.status === "queued" ? (
                <>
                  Queued behind {started.queuePosition ?? 0} other run
                  {(started.queuePosition ?? 0) === 1 ? "" : "s"} for that
                  folder — it starts on its own.{" "}
                </>
              ) : (
                <>Started. </>
              )}
              <Link href={`/runs/${started.id}`}>Open it</Link>, or start
              another.
            </Notice>
          </div>
        )}

        {attempted && visible.length > 0 && (
          <div role="alert">
            <Notice tone="danger">
              <strong>
                {visible.length === 1
                  ? "One thing to fix first."
                  : `${visible.length} things to fix first.`}
              </strong>
              <ul className="mt-1 grid">
                {visible.map((p) => (
                  <li key={p.focus}>
                    <button
                      type="button"
                      onClick={() => focusControl(p.focus)}
                      className="inline-flex min-h-8 cursor-pointer items-center border-0 bg-transparent p-0 text-left text-sm font-normal text-accent hover:underline"
                    >
                      {p.message}
                    </button>
                  </li>
                ))}
              </ul>
            </Notice>
          </div>
        )}

        {/* Sticky for the same reason the settings page's Save is: this is the
            one button on a page long enough to scroll, and it must not be
            somewhere you have to hunt for. Opaque and raised, because it spends
            most of its life lying across a card. */}
        <div className="sticky bottom-0 z-10 border-t border-line bg-canvas py-3 shadow-bar">
          <ButtonRow>
            <Button type="submit" disabled={submitting} aria-busy={submitting}>
              {/* Both labels occupy one grid cell, so the button is as wide as
                  the longer of them in either state and nothing moves when it
                  starts. */}
              <span className="grid place-items-center">
                <span
                  className={`col-start-1 row-start-1 ${submitting ? "invisible" : ""}`}
                >
                  Start run
                </span>
                <span
                  className={`col-start-1 row-start-1 ${submitting ? "" : "invisible"}`}
                >
                  Starting…
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push("/runs")}
            >
              Back to runs
            </Button>
            <span className="text-xs text-ink-faint">
              {submitting
                ? "Asking the orchestrator for a slot…"
                : occupant || rootOccupant
                  ? `Queues behind the run already working in ${folderLabel}`
                  : `Starts an unattended agent in ${folderLabel}`}
            </span>
          </ButtonRow>
        </div>
      </form>
    </div>
  );
}
