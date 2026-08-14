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
import { fmtPct, fmtUSD, pctField, pollFailureMessage } from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button, ButtonRow } from "@/components/ui/Button";
import {
  Field,
  Input,
  Select,
  Switch,
  Textarea,
} from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";
import { isCommitChord } from "@/components/shell/shortcuts";

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
/* The three decisions, as segmented controls                          */
/* ------------------------------------------------------------------ */

/**
 * Where an isolated run writes. Two options, so the pair fits in one control
 * and the consequence of the chosen one is spelled out beside it — as three
 * stacked radio cards these read as three more forms in a page of forms, and
 * the consequences of the options nobody picked were on screen permanently.
 */
type IsolationChoice = "worktree" | "direct";

const ISOLATION_OPTIONS: readonly SegmentedOption<IsolationChoice>[] = [
  { value: "worktree", label: "Own branch" },
  { value: "direct", label: "This folder" },
];

const ISOLATION_CONSEQUENCE: Record<IsolationChoice, string> = {
  worktree:
    "Its own checkout, started from the last commit and committing as it goes. Your uncommitted work stays where it is, and other runs can use this folder at the same time. Only the config files named in Settings are copied across — dependencies are the agent's job.",
  direct:
    "Claude edits the files you have open, uncommitted work included. No other run can use this folder, or anything under it, until this one finishes.",
};

/**
 * Least to most permissive, rather than the order the literals happen to be
 * declared in — the settings page orders the same four this way, because the
 * list is a scale and should read as one.
 */
const PERMISSION_OPTIONS: readonly SegmentedOption<string>[] = [
  { value: "plan", label: "Plan only" },
  { value: "default", label: "Ask first" },
  { value: "acceptEdits", label: "Edit files" },
  { value: "bypassPermissions", label: "Anything" },
];

const ENFORCEMENT_OPTIONS: readonly SegmentedOption<EnforcementModeDTO>[] = [
  { value: "between-cycles", label: "Between cycles" },
  { value: "live", label: "Stop mid-cycle" },
  { value: "live-resume", label: "Stop, then resume" },
];

type NoteTone = "neutral" | "warn" | "danger";

/** Complete class strings per tone, looked up rather than interpolated. */
const NOTE_TONE: Record<NoteTone, string> = {
  neutral: "",
  warn: "text-warn",
  danger: "text-danger",
};

/** A sentence inside a row's description that has to carry a tone of its own. */
function Toned({
  tone = "neutral",
  children,
}: {
  tone?: NoteTone;
  children: ReactNode;
}) {
  return <span className={NOTE_TONE[tone]}>{children}</span>;
}

/**
 * What the chosen permission mode lets an agent nobody is watching do.
 *
 * A segmented control shows the options and not their consequences, so the
 * selected one is written out under the row. A switch rather than a lookup map
 * because the value is a bare string: a mode from a build this one does not
 * know has to say so, rather than silently borrow acceptEdits' sentence.
 */
function permissionConsequence(mode: string): {
  text: ReactNode;
  tone: NoteTone;
} {
  switch (mode) {
    case "plan":
      return {
        text: (
          <>
            <span className="mono">plan</span> — reads and plans; nothing on
            disk changes
          </>
        ),
        tone: "neutral",
      };
    case "default":
      return {
        text: (
          <>
            <span className="mono">default</span> — every tool call asks first,
            and there is nobody to answer, so the run sits there until a limit
            stops it
          </>
        ),
        tone: "warn",
      };
    case "acceptEdits":
      return {
        text: (
          <>
            <span className="mono">acceptEdits</span> — file edits and read-only
            commands go ahead. Anything else is refused, and the refusal is
            listed in the run log
          </>
        ),
        tone: "neutral",
      };
    case "bypassPermissions":
      return {
        text: (
          <>
            <span className="mono">bypassPermissions</span> — any command in the
            folder, deleting files and reaching the network included. Only for
            code and a container you are willing to have modified
          </>
        ),
        tone: "danger",
      };
    default:
      return {
        text: `“${mode}” is not one of the four modes this form offers — choose one before starting`,
        tone: "danger",
      };
  }
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
 * typography exactly. The grouped rows below have no such problem: their marker
 * sits beside the control, in the row's trailing slot.
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
  return (
    // A fixed height whether or not a marker is present, so a label does not
    // shift down the moment a field is overridden.
    <div className="mb-1 flex min-h-8 items-center justify-between gap-3">
      {/* `mb-0` is load-bearing: the legacy sheet puts 5px under every bare
          <label>, which in an items-center row lifts the text off centre. */}
      <label htmlFor={htmlFor} className="mb-0">
        <span className="text-xs font-medium text-ink-muted">{children}</span>
      </label>
      {marker}
    </div>
  );
}

/**
 * The way back to what the template — or this form's own default — asked for.
 *
 * Only ever rendered for a row that differs from the baseline. There was a
 * companion `from template` badge on every unchanged row, and it is gone: one
 * form has one baseline, so that badge said the same thing on every row it
 * appeared on, which is the repeated hint a group footnote exists to replace.
 * What varies — and so what is worth a marker — is an operator's edit of one.
 */
function ResetToBaseline({
  from,
  what,
  onReset,
}: {
  /** "template" / "that run", or null when the baseline is the form's defaults. */
  from: string | null;
  what: string;
  onReset: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="compact"
      onClick={onReset}
      aria-label={`Reset ${what} to ${from ? `the ${from}` : "the default"}`}
    >
      Reset
    </Button>
  );
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
  // Why the picker below may not be showing the operator's own default. Set
  // once, by the read that failed, and never cleared: nothing retries it.
  const [settingsError, setSettingsError] = useState<string | null>(null);
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

  // Set before any fetch is issued, so the loaders below can tell "nobody has
  // chosen yet" from "a seed is on its way". Without it the mount default and
  // the settings default race a seed that arrives later and win or lose
  // depending on the connection.
  const seeded = useRef(false);
  // Whether anything other than this form's own default has answered the
  // permission question yet — a manual pick or an applied seed. `seeded` covers
  // only the `?from=` case, so without this the settings read landing a moment
  // later replaced a choice the operator had already made. A ref rather than
  // state because the loader below closes over the first render: a `useState`
  // value read in there is `false` for ever.
  const permissionTouched = useRef(false);
  // Belt to the disabled attribute's braces: a second submit can only come from
  // a key repeat inside the same tick, which no re-render has happened for yet.
  const inFlight = useRef(false);
  // What ⌘↩ submits. The shell's one keyboard listener deliberately binds
  // nothing to that chord — see `isCommitChord` — so a page's own commit
  // shortcut keeps working while the task textarea holds focus, which is where
  // Return is a newline and the operator is standing when they finish.
  const formRef = useRef<HTMLFormElement>(null);

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

    // Through `jsonRequest` rather than a raw `fetch`, because this is the one
    // read on the page whose failure decides what an unattended agent may do,
    // and it had two silent paths: a non-2xx answer carries a JSON body
    // (`middleware.ts` answers 401 with one), so `r.json()` resolved, the guard
    // below found no `defaultPermissionMode` and simply skipped; and a rejected
    // fetch went to a `.catch` that did nothing. Either way the picker was left
    // on this form's own `acceptEdits` — the *more* permissive value — with
    // nothing on the page saying so. Read-time narrowing of this setting must
    // never widen what is permitted, the rule `rowToTemplate` and `chatGuards`
    // already apply to the same value. Folding both onto one branch is what
    // makes the failure sayable at all.
    void (async () => {
      const res = await jsonRequest<{ settings?: SettingsDTO }>("/api/settings");
      const loaded = res.ok ? res.data.settings : undefined;
      if (!loaded) {
        // A 200 with no `settings` in it is the same failure by a third door:
        // `setSettings(undefined)` reads as "no ceiling configured" everywhere
        // else on this form as well.
        setSettingsError(
          res.ok
            ? pollFailureMessage(200, "no settings in the answer")
            : pollFailureMessage(res.status, res.error),
        );
        return;
      }
      setSettings(loaded);
      // Only while nothing else has answered the question. This lands after an
      // arbitrary delay, so a global default arriving late must not overwrite a
      // template's mode or a pick the operator has already made.
      if (
        loaded.defaultPermissionMode &&
        !seeded.current &&
        !permissionTouched.current
      ) {
        setPermissionMode(loaded.defaultPermissionMode);
        setBaseline((b) =>
          b.kind === "defaults"
            ? {
                ...b,
                values: {
                  ...b.values,
                  permissionMode: loaded.defaultPermissionMode,
                },
              }
            : b,
        );
      }
    })();

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

  /** The way back to the baseline, beside the control that departed from it. */
  function mark(row: RowId): ReactNode {
    // With no template in play the only thing worth saying is that a guard is
    // no longer its default — and the task and the folder have no default to
    // depart from, so they say nothing at all.
    if (!rowChanged(row)) return null;
    if (baselineFrom === null && !GUARD_ROWS.has(row)) return null;
    return (
      <ResetToBaseline
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
    });
  }
  if (prompt.trim() === "") {
    problems.push({
      focus: "prompt",
      message: "Describe what Claude should work on.",
      immediate: false,
    });
  }
  if (iterationsCapped && positive(maxIterations) === null) {
    problems.push({
      focus: "iters",
      message: "Set at least one work cycle, or switch the cycle limit off.",
      immediate: false,
    });
  }
  if (costLimited && effCost === null) {
    problems.push({
      focus: "cost",
      message:
        "Enter an amount above $0, or switch the spending limit off — a blank box starts a run with no spending limit at all.",
      immediate: false,
    });
  }
  if (timeLimited && effMinutes === null) {
    problems.push({
      focus: "dur",
      message:
        "Enter a number of minutes, or switch the time limit off — a blank box starts a run with no time limit at all.",
      immediate: false,
    });
  }
  if (noTerminus) {
    problems.push({
      // Neither limit has a value box while it is switched off, so this points
      // at the switch that brings one back — which is stable in both states,
      // where the number input only exists in one of them.
      focus: "cycles-on",
      message:
        "Set a time limit, or cap the work cycles. Nothing else here only moves one way, so without one of them nothing would ever end this run.",
      immediate: true,
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
    });
  }

  const visible = problems.filter(
    (p) => p.immediate || attempted || touched[p.focus],
  );
  const problemFor = (focus: string) => visible.find((p) => p.focus === focus);

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

    // The two that decide what an unattended agent may do. Applied, but
    // announced — see the notices beside the controls themselves.
    setCarriedEnforcement(b.enforcement !== "between-cycles");
    setCarriedPermission(seed.permissionMode === "bypassPermissions");
    // A template's mode is narrowed on save, on read and again by POST
    // /api/runs; a global default landing on top of it a moment later would
    // undo all three.
    permissionTouched.current = true;

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

  /**
   * ⌘↩ from anywhere in the pane, including the task textarea.
   *
   * `requestSubmit` rather than calling `submit` directly, so the chord and the
   * button go through one code path — including the `noValidate` form's own
   * submit event, which is where every guard below hangs.
   */
  function onFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (!isCommitChord(e)) return;
    e.preventDefault();
    formRef.current?.requestSubmit();
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
      // After the render that draws the error beside the field, so the control
      // it names is the one the operator lands on.
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

  // Both live modes say "tighter, not exact" in as many words: a mid-cycle
  // check is bounded by one model turn plus one interval plus the kill, and
  // copy that implies a hard cut-off would be describing a guard this app
  // cannot offer.
  const enforcementLine =
    enforcement === "between-cycles"
      ? "Limits are read before each cycle, so the cycle already running always finishes — and the run can end up one cycle past a limit."
      : resuming
        ? `Limits are also read about every ${guardInterval}s while Claude is working, and that cycle's work is lost — tighter than waiting for the cycle to end, but still not an exact cut-off. A full 5-hour window parks the run instead of ending it; every other limit still ends it.`
        : `Limits are also read about every ${guardInterval}s while Claude is working, and that cycle's work is lost. Tighter than waiting for the cycle to end, but still not an exact cut-off.`;

  const folderLabel = folder || activeMount?.label || "this workspace";
  const permission = permissionConsequence(permissionMode);

  return (
    <>
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

      {/* The read that decides what an agent may do, and it failed. Said here
          rather than swallowed, because the value left in the picker is this
          form's own default and it is the more permissive of the two. */}
      {settingsError && (
        <Notice tone="warn">
          <strong>Your settings could not be read.</strong> {settingsError} What
          it may do without asking, below, is this form&rsquo;s built-in default
          rather than your{" "}
          <span className="mono">defaultPermissionMode</span> — check it before
          starting.
        </Notice>
      )}

      {/* Own validation, not the browser's: a native bubble points at one field
          and vanishes, where these stay next to the field and say what to do. */}
      <form ref={formRef} onSubmit={submit} onKeyDown={onFormKeyDown} noValidate>
        <Card className="mb-4" emphasis="primary">
          <CardTitle>What to work on</CardTitle>

          <ListGroup
            className="mb-4"
            footnote={
              folder === "" && folders.length > 0
                ? "A run on the whole workspace takes the entire tree — no run in any folder inside it can start until this one finishes"
                : undefined
            }
          >
            {templates.length > 0 && (
              <ListRow
                htmlFor="tpl"
                label="Template"
                description={
                  selectedTemplate
                    ? describeTemplate(selectedTemplate)
                    : "Fills in everything below; nothing starts until you press Start run"
                }
              >
                {/* The width is on a wrapper, never on the control: `Select`
                    already states `w-full`, and two width utilities on one
                    element resolve by stylesheet order, not class order. */}
                <div className="w-64">
                  <Select
                    id="tpl"
                    value={templateId}
                    onChange={(e) => pickTemplate(e.target.value)}
                  >
                    <option value="">— no template —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </ListRow>
            )}

            {/* The stale-mount case is separate from the no-mounts case because
                a template or an earlier run can name a workspace that has since
                been removed from `.env`. Reported here rather than left to
                `POST /api/runs`, which would refuse it correctly but only after
                the operator pressed Start. */}
            <ListRow
              htmlFor="mount"
              label="Workspace"
              description={
                <>
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
                    <Toned tone="warn">
                      That workspace is not configured any more
                    </Toned>
                  )}
                  {problemFor("mount") && (
                    <Toned tone="danger">
                      <span className="mt-0.5 block">
                        {problemFor("mount")?.message}
                      </span>
                    </Toned>
                  )}
                </>
              }
            >
              <div className="w-64">
                <Select
                  id="mount"
                  value={mountId}
                  onChange={(e) => selectMount(e.target.value)}
                  onBlur={touch("mount")}
                  disabled={!foldersLoaded || mounts.length === 0}
                  aria-invalid={problemFor("mount") ? true : undefined}
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
              </div>
            </ListRow>

            <ListRow
              htmlFor="folder"
              label="Folder"
              description={
                folder === ""
                  ? "The whole tree, and every folder inside it"
                  : selectedFolder?.isGitRepo
                    ? "A git repository, so Claude can work on its own branch"
                    : "Not a git repository, so Claude works in it directly"
              }
            >
              {mark("where")}
              <div className="w-64">
                <Select
                  id="folder"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  disabled={!activeMount}
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
              </div>
            </ListRow>
          </ListGroup>

          {/* Whose folder it is, and who is waiting for it. Under the group
              rather than in a row, because each of these is a condition of the
              moment rather than a description of a control. */}
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

          {/* Not a row: a nine-line text region has nothing to align a right
              edge against, and its label belongs above it. */}
          <Field
            className="last:mb-0"
            htmlFor="prompt"
            hint={
              prompt.trim() === ""
                ? "Say what to change and how Claude will know it worked — this text is sent verbatim as the first turn"
                : "Sent verbatim as the first turn; the run ends when Claude replies DONE"
            }
            error={problemFor("prompt")?.message}
          >
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
              required
            />
          </Field>
        </Card>

        <Card className="mb-4">
          <CardTitle>What the agent may do</CardTitle>

          {/* Applying a template must not be the same as choosing. This setting
              decides what an unattended agent is allowed to do, so it is
              applied, named, and offered back — above the group that holds it,
              where it cannot be scrolled past. */}
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

          {/* Two standing facts about the group rather than a hint under each
              control, and each is here only while it applies — a footnote that
              is true whatever the rows say is a footnote the eye stops
              reading. */}
          <ListGroup
            footnote={
              isolated || permissionMode === "bypassPermissions" ? (
                <>
                  {isolated && (
                    <>
                      An isolated run is also allowed{" "}
                      <span className="mono">git add</span> and{" "}
                      <span className="mono">git commit</span>, whatever is
                      chosen above — that is how its work reaches its branch.
                      {permissionMode === "bypassPermissions" ? " " : ""}
                    </>
                  )}
                  {permissionMode === "bypassPermissions" && (
                    <>
                      <span className="mono">pkill</span> and{" "}
                      <span className="mono">killall</span> stay refused even
                      here, because a name match reaches this server as readily
                      as the agent&rsquo;s own processes.
                    </>
                  )}
                </>
              ) : undefined
            }
          >
            <ListRow
              label="Where Claude writes"
              description={
                canIsolate ? (
                  ISOLATION_CONSEQUENCE[isolate ? "worktree" : "direct"]
                ) : folder === "" ? (
                  "A run on the whole workspace always works in place, and holds the entire tree until it finishes"
                ) : (
                  "This folder is not a git repository, so there is no branch to work on — Claude edits it in place and no other run can use it meanwhile"
                )
              }
            >
              {canIsolate ? (
                <>
                  {mark("isolate")}
                  <SegmentedControl
                    options={ISOLATION_OPTIONS}
                    value={isolate ? "worktree" : "direct"}
                    onChange={(v) => setIsolate(v === "worktree")}
                    label="Where Claude writes"
                  />
                </>
              ) : (
                <span className="text-sm font-medium text-ink">
                  In the folder itself
                </span>
              )}
            </ListRow>

            <ListRow
              label={
                <>
                  What it may do without asking{" "}
                  {permissionMode === "bypassPermissions" && (
                    <Badge tone="danger">risky</Badge>
                  )}
                  {permissionMode === "default" && (
                    <Badge tone="warn">stalls</Badge>
                  )}
                </>
              }
              description={<Toned tone={permission.tone}>{permission.text}</Toned>}
            >
              {mark("permission")}
              <SegmentedControl
                options={PERMISSION_OPTIONS}
                value={permissionMode}
                onChange={(v) => {
                  setPermissionMode(v);
                  // Chosen here, so it is no longer inherited — the banner
                  // above would be describing a decision that is now the
                  // operator's.
                  setCarriedPermission(false);
                  // And a settings read still in flight must not answer a
                  // question the operator has just answered themselves.
                  permissionTouched.current = true;
                }}
                label="What the agent may do without asking"
              />
            </ListRow>
          </ListGroup>
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
                ? "“Stop, then resume”"
                : "“Stop mid-cycle”"}{" "}
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

          {/* The one line that leads the card: what is on the controls below,
              read back as the sentence it amounts to. Nothing here is behind a
              disclosure — a guard an unattended agent is about to run under is
              what most people came to this page to set. */}
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

          <ListGroup
            className="mt-4"
            label="Stop conditions"
            footnote={
              liveSpendGuard
                ? "This run switches on Claude Code's own per-request reporting so the spend can be read mid-cycle; those records land a second or two behind, and what a cut-short cycle cost is worked back out of your transcripts afterwards"
                : undefined
            }
          >
            <ListRow
              htmlFor={iterationsCapped ? "iters" : undefined}
              label="Work cycles"
              description={
                <>
                  {iterationsCapped
                    ? "Each cycle picks up the same conversation where the last one left off; 1 means one pass and then stop"
                    : "Needs the time limit below — the clock is the only limit that keeps advancing whether or not Claude reports what it spent"}
                  {problemFor("iters") && (
                    <Toned tone="danger">
                      <span className="mt-0.5 block">
                        {problemFor("iters")?.message}
                      </span>
                    </Toned>
                  )}
                </>
              }
            >
              {mark("cycles")}
              {/* React's onBlur is focusout, which bubbles, so one wrapper
                  catches the switch and the value alike. */}
              <div
                className="flex items-center gap-2"
                onBlur={touch("iters")}
              >
                {iterationsCapped && (
                  <div className="w-32">
                    <Input
                      id="iters"
                      type="number"
                      min={1}
                      className="tabular-nums"
                      unit="cycles"
                      value={maxIterations}
                      onChange={(e) => setMaxIterations(e.target.value)}
                      aria-invalid={problemFor("iters") ? true : undefined}
                    />
                  </div>
                )}
                <Switch
                  id="cycles-on"
                  checked={iterationsCapped}
                  onChange={setIterationsCapped}
                  label="Cap the work cycles"
                />
              </div>
            </ListRow>

            <ListRow
              htmlFor={costLimited ? "cost" : undefined}
              label="Spending limit for this run"
              description={
                <>
                  {!costLimited
                    ? "This run is not capped in dollars — only the cycle count, the clock and the two window guards below stop it"
                    : live
                      ? "Read mid-cycle too, so the run stops near this figure rather than a whole cycle past it"
                      : "No new cycle starts once this much is spent, so the final figure can be up to one cycle higher"}
                  {problemFor("cost") && (
                    <Toned tone="danger">
                      <span className="mt-0.5 block">
                        {problemFor("cost")?.message}
                      </span>
                    </Toned>
                  )}
                </>
              }
            >
              {mark("cost")}
              <div className="flex items-center gap-2" onBlur={touch("cost")}>
                {costLimited && (
                  <div className="w-32">
                    <Input
                      id="cost"
                      type="number"
                      min={0}
                      step="0.5"
                      className="tabular-nums"
                      unit="USD"
                      value={maxRunCostUSD}
                      onChange={(e) => setMaxRunCostUSD(e.target.value)}
                      aria-invalid={problemFor("cost") ? true : undefined}
                    />
                  </div>
                )}
                <Switch
                  id="cost-on"
                  checked={costLimited}
                  onChange={setCostLimited}
                  label="Cap what this run may spend"
                />
              </div>
            </ListRow>

            <ListRow
              htmlFor={timeLimited ? "dur" : undefined}
              label="Time limit"
              description={
                <>
                  {!timeLimited
                    ? "The run continues until Claude reports the task complete, or another limit stops it"
                    : live
                      ? "Measured from the start and including any time parked; a cycle can be cut off part-way"
                      : "Measured from the start and including any time parked; a cycle already underway is never cut off mid-edit"}
                  {timeLimited && resuming && (effMinutes ?? 0) > 720 && (
                    <Toned tone="warn">
                      <span className="mt-0.5 block">
                        That is about {((effMinutes ?? 0) / 60).toFixed(0)} hours
                        of unattended agent, most of it likely spent waiting
                      </span>
                    </Toned>
                  )}
                  {problemFor("dur") && (
                    <Toned tone="danger">
                      <span className="mt-0.5 block">
                        {problemFor("dur")?.message}
                      </span>
                    </Toned>
                  )}
                </>
              }
            >
              {mark("time")}
              <div className="flex items-center gap-2" onBlur={touch("dur")}>
                {timeLimited && (
                  <div className="w-36">
                    <Input
                      id="dur"
                      type="number"
                      min={1}
                      className="tabular-nums"
                      unit="minutes"
                      value={maxDurationMinutes}
                      onChange={(e) => setMaxDurationMinutes(e.target.value)}
                      aria-invalid={problemFor("dur") ? true : undefined}
                    />
                  </div>
                )}
                <Switch
                  id="time-on"
                  checked={timeLimited}
                  onChange={setTimeLimited}
                  label="Cap how long this run may take"
                />
              </div>
            </ListRow>
          </ListGroup>

          <ListGroup
            className="mt-4"
            label="Window guards"
            footnote="Both measure your whole subscription, not this run's share"
          >
            <ListRow
              htmlFor="sess"
              label={
                resuming ? "Step aside at 5-hour usage" : "Stop at 5-hour usage"
              }
              description={
                problemFor("sess") ? (
                  <Toned tone="danger">{problemFor("sess")?.message}</Toned>
                ) : maxSessionFraction && !sessionCeilingSet ? (
                  <Toned tone="warn">
                    No 5-hour ceiling is set, so this guard has nothing to
                    measure against and the run is refused before its first
                    cycle — <Link href="/settings">set one</Link>
                  </Toned>
                ) : (
                  <>
                    {resuming
                      ? "The run waits and picks up in the next window"
                      : "The run ends when the window reaches this"}
                    {usage
                      ? usage.snapshot.session.fraction != null
                        ? ` · now at ${fmtPct(usage.snapshot.session.fraction)}`
                        : " · no ceiling set, so there is no percentage to show"
                      : ""}
                  </>
                )
              }
            >
              {mark("session")}
              <div className="w-24">
                <Input
                  id="sess"
                  type="number"
                  min={1}
                  max={100}
                  placeholder="off"
                  className="tabular-nums"
                  unit="%"
                  value={maxSessionFraction}
                  onChange={(e) => setMaxSessionFraction(e.target.value)}
                  onBlur={touch("sess")}
                  aria-invalid={problemFor("sess") ? true : undefined}
                />
              </div>
            </ListRow>

            <ListRow
              htmlFor="wk"
              label="Stop at weekly usage"
              description={
                problemFor("wk") ? (
                  <Toned tone="danger">{problemFor("wk")?.message}</Toned>
                ) : maxWeeklyFraction && !weeklyCeilingSet ? (
                  <Toned tone="warn">
                    No weekly ceiling is set, so this guard has nothing to
                    measure against and the run is refused before its first
                    cycle — <Link href="/settings">set one</Link>
                  </Toned>
                ) : (
                  <>
                    Always ends the run — a weekly window has no reset instant to
                    wait for
                    {usage
                      ? usage.snapshot.weekly.fraction != null
                        ? ` · now at ${fmtPct(usage.snapshot.weekly.fraction)}`
                        : " · no ceiling set, so there is no percentage to show"
                      : ""}
                  </>
                )
              }
            >
              {mark("weekly")}
              <div className="w-24">
                <Input
                  id="wk"
                  type="number"
                  min={1}
                  max={100}
                  placeholder="off"
                  className="tabular-nums"
                  unit="%"
                  value={maxWeeklyFraction}
                  onChange={(e) => setMaxWeeklyFraction(e.target.value)}
                  onBlur={touch("wk")}
                  aria-invalid={problemFor("wk") ? true : undefined}
                />
              </div>
            </ListRow>
          </ListGroup>

          <ListGroup
            className="mt-4"
            label="How the run ends"
            footnote={enforcementLine}
          >
            <ListRow label="When a limit is reached">
              {mark("enforcement")}
              <SegmentedControl
                options={ENFORCEMENT_OPTIONS}
                value={enforcement}
                onChange={(v) => {
                  setEnforcement(v);
                  setCarriedEnforcement(false);
                }}
                label="When a limit is reached"
              />
            </ListRow>

            <ListRow
              htmlFor="after-done"
              label="Keep going after DONE"
              description={
                continueAfterDone
                  ? "Claude is asked to verify and tighten rather than invent work, and the run can then only end at a limit"
                  : "The run ends as soon as Claude replies DONE"
              }
            >
              {mark("afterDone")}
              <Switch
                id="after-done"
                checked={continueAfterDone}
                onChange={setContinueAfterDone}
              />
            </ListRow>
          </ListGroup>

          {live && !costLimited && settings?.telemetryForRuns === false && (
            <Hint tone="warn" className="mt-2">
              Consider turning on{" "}
              <Link href="/settings">agent self-reporting</Link> — it is the
              only independent record of what a cut-short cycle cost
            </Hint>
          )}
          {resuming && !maxSessionFraction && (
            <Hint className="mt-2">
              With no 5-hour percentage the run carries on until Claude itself
              refuses a cycle, then waits for the allowance to refill
            </Hint>
          )}
          {continueAfterDone && !isolated && (
            <Hint tone="warn" className="mt-2">
              This run edits your folder directly and will keep editing it after
              it believes the task is finished
            </Hint>
          )}
        </Card>

        <Card className="mb-4" emphasis="quiet">
          <CardTitle>Save for next time</CardTitle>

          <ListGroup>
            <ListRow
              htmlFor="tpl-name"
              label="Template name"
              description={
                !prompt
                  ? "Write the task above first — the prompt is the part worth saving"
                  : nameTaken
                    ? `Replaces the template already called “${templateName.trim()}”`
                    : "Keeps the task, the limits and how it behaves. Not the model — that stays a single global setting"
              }
            >
              <div className="w-56">
                <Input
                  id="tpl-name"
                  value={templateName}
                  onChange={(e) => {
                    setTemplateName(e.target.value);
                    setArmedDelete(false);
                  }}
                  placeholder="Update dependencies and fix what breaks"
                  maxLength={MAX_TEMPLATE_NAME}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={saveTemplate}
                busy={savingTemplate}
                disabled={!templateName.trim() || !prompt}
              >
                {nameTaken ? "Update" : "Save"}
              </Button>
              {templateId && (
                <Button
                  type="button"
                  variant={armedDelete ? "danger" : "ghost"}
                  onClick={removeTemplate}
                >
                  {armedDelete ? "Really delete" : "Delete"}
                </Button>
              )}
            </ListRow>

            <ListRow
              htmlFor="tpl-folder"
              label="Remember the workspace and folder"
              description={
                rememberFolder
                  ? "The template pre-selects that folder. Right for a task about one project"
                  : "The template asks for a folder each time. Right for a task that applies to any project"
              }
            >
              <Switch
                id="tpl-folder"
                checked={rememberFolder}
                onChange={setRememberFolder}
              />
            </ListRow>
          </ListGroup>

          {templateNote && (
            <Hint className="mt-2">
              <span role="status">{templateNote}</span>
            </Hint>
          )}
          {templateError && (
            <Hint tone="danger" className="mt-2">
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

        {/* The pane's footer, not a form's button row: the default action at
            the trailing edge with Cancel to its left, which is where a Mac
            window puts them. Sticky because this page is longer than the pane,
            and the negative margin has to match the shell's own gutter at each
            breakpoint or the bar is wider than the page and scrolls it
            sideways. Opaque and raised, because it spends most of its life
            lying across a card. */}
        <div className="sticky bottom-0 z-10 -mx-4 -mb-12 border-t border-line bg-canvas px-4 py-3 shadow-bar sm:-mx-5 sm:px-5">
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <p
              role="status"
              aria-atomic="true"
              className="mr-auto min-h-5 basis-full text-xs leading-5 text-ink-faint sm:basis-auto"
            >
              {submitting
                ? "Asking the orchestrator for a slot…"
                : occupant || rootOccupant
                  ? `Queues behind the run already working in ${folderLabel}`
                  : `Starts an unattended agent in ${folderLabel}`}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.push("/runs")}
            >
              Cancel
            </Button>
            <Button type="submit" busy={submitting} aria-keyshortcuts="Meta+Enter">
              Start run
              <span aria-hidden="true" className="text-xs opacity-70">
                ⌘↩
              </span>
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
