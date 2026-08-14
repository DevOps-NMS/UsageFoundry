"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentDTO,
  AmbientAgentDTO,
  BudgetPolicyDTO,
  RunGuardsDTO,
  SettingsDTO,
} from "@/lib/apiTypes";
import { describeAmbientAgents, fmtTokens, fmtUSD } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/Field";
import { Hint, type HintTone } from "@/components/ui/Hint";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";
import { isPlainCommandChord } from "@/components/shell/shortcuts";

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

/**
 * Anchors for the section nav; order is the page order, and the page order is
 * how often a setting is reached for rather than when it was written.
 *
 * The ceilings lead because every meter in the app is read against them and a
 * fresh install has none; the run defaults are next because they are what the
 * form most people open every day starts at; the chat's guard set follows,
 * being what the *app* starts under rather than what a person does; the
 * unattended settings and the four prompts are at the end because they are
 * typed once, if ever.
 */
const SECTIONS = [
  { id: "limits", label: "Subscription limits" },
  { id: "runs", label: "Runs" },
  { id: "guards", label: "Default guards" },
  { id: "unattended", label: "Unattended runs" },
  { id: "prompts", label: "Prompts" },
];

/**
 * Least to most permissive, rather than the order the literals happen to be
 * declared in. The list is a scale, so it should read as one.
 *
 * Same four, same order and the same words as the new-run form: this is the
 * default that form is pre-filled from, and two spellings of one choice across
 * two pages is two things to keep in step.
 */
const PERMISSION_OPTIONS: readonly SegmentedOption<string>[] = [
  { value: "plan", label: "Plan only" },
  { value: "default", label: "Ask first" },
  { value: "acceptEdits", label: "Edit files" },
  { value: "bypassPermissions", label: "Anything" },
];

/** Where an isolated run writes, in the run form's own words. */
type IsolationChoice = "worktree" | "direct";

const ISOLATION_OPTIONS: readonly SegmentedOption<IsolationChoice>[] = [
  { value: "worktree", label: "Own branch" },
  { value: "direct", label: "This folder" },
];

const ISOLATION_CONSEQUENCE: Record<IsolationChoice, string> = {
  worktree:
    "The run works on its own branch in a separate checkout, so another run can use the same project meanwhile — you land it from Branches once you have read it",
  direct:
    "The agent edits the folder you pick, and no other run may touch anything in that tree until it finishes",
};

type LandStrategy = "merge" | "squash";

const LAND_OPTIONS: readonly SegmentedOption<LandStrategy>[] = [
  { value: "merge", label: "Merge" },
  { value: "squash", label: "Squash" },
];

const LAND_CONSEQUENCE: Record<LandStrategy, string> = {
  merge:
    "The run’s own commits go onto your branch, which is what keeps the diff on its page meaningful afterwards",
  squash:
    "One commit on your branch. That rewrites the run’s commits, so git can no longer see the merge and this tool tracks the branch by its tip instead",
};

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
  "planUsageFromApi",
  "sessionCostLimit",
  "weeklyCostLimit",
  "reservedHeadroomFraction",
  "sessionTokenLimit",
  "weeklyTokenLimit",
  "weeklyAnchor",
  "sessionResetOverrideAt",
  "includeSidechains",
  "defaultModel",
  "defaultAgentId",
  "forwardSubAgentText",
  "defaultPermissionMode",
  "maxConcurrentRuns",
  "isolationCopyGlobs",
  "landStrategy",
  "continuationPrompt",
  "donePushbackPrompt",
  "isolationPreamble",
  "continuedWorkPrompt",
  "liveGuardIntervalSeconds",
  "maxCycleSilenceMinutes",
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

/**
 * The display modes in which this app owns ⌘S.
 *
 * In a tab that chord is the browser's (Save Page As…), and a page that takes
 * it is a page that broke the browser. An installed window has no such command,
 * so the chord is free and Save is the only thing it could sensibly mean.
 * `window-controls-overlay` is listed as well as `standalone` because the
 * manifest puts it first in `display_override`, and a window in that mode is
 * not guaranteed to report the other one.
 */
const STANDALONE_QUERIES = [
  "(display-mode: standalone)",
  "(display-mode: window-controls-overlay)",
];

/**
 * Whether the app has the whole window rather than a tab.
 *
 * False on the server and on the first client paint, then corrected — the same
 * arrangement the theme and the sidebar use, and it costs nothing here because
 * what it decides is a keyboard binding and a glyph rather than any geometry.
 * The listener stays subscribed because Window Controls Overlay can be turned
 * off while the app is running.
 */
function useStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const lists = STANDALONE_QUERIES.map((q) => window.matchMedia(q));
    const read = () => setStandalone(lists.some((l) => l.matches));
    read();
    lists.forEach((l) => l.addEventListener("change", read));
    return () => lists.forEach((l) => l.removeEventListener("change", read));
  }, []);
  return standalone;
}

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
 * What a run's own spending limit can overshoot by. Every mode now carries the
 * remainder into the cycle as a ceiling of its own, so what the mode still
 * decides is when a *fresh* reading is taken — which is why these three differ
 * only in their first clause. Rendered from the stored mode rather than
 * hardcoded: nothing on this page can set it, but a guard set written by
 * another build could carry `live`, and a sentence describing the wrong mode is
 * worse than no sentence.
 */
const SPEND_READ_AT: Record<BudgetPolicyDTO["enforcement"], string> = {
  "between-cycles":
    "Read before each work cycle, and carried into the cycle as its own ceiling, so a run stops near it.",
  live: "Read on a ticker while a cycle is going, and carried into the cycle as its own ceiling, so a run stops near it.",
  "live-resume":
    "Read on a ticker while a cycle is going, and carried into the cycle as its own ceiling, so a run stops near it.",
};

/** Complete class strings per tone, looked up rather than interpolated. */
const NOTE_TONE: Record<HintTone, string> = {
  neutral: "",
  warn: "text-warn",
  danger: "text-danger",
};

/** A sentence inside a row's description that has to carry a tone of its own. */
function Toned({
  tone = "neutral",
  children,
}: {
  tone?: HintTone;
  children: ReactNode;
}) {
  return <span className={NOTE_TONE[tone]}>{children}</span>;
}

/**
 * What the selected permission mode lets an agent nobody is watching do.
 *
 * A switch rather than a lookup map, and the unknown case is named rather than
 * falling through to `acceptEdits`: the control beside this shows the four
 * modes this app offers, so a fifth arriving from another build selects none of
 * them and the sentence under it has to be the one that says why.
 */
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
    case "acceptEdits":
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
    default:
      return {
        text: `“${mode}” is not one of the four modes this app offers — choose one, or the chat's runs are held to whichever it turns out to be`,
        tone: "danger",
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
 * One row of a grouped list, plus the two marks that say it holds something the
 * server has not been told.
 *
 * This is the reference conversion factored, not a second pattern: it emits the
 * same `ListRow` + `EditedRail` + screen-reader suffix the "Unattended runs"
 * group was written with, and it exists because twenty-four rows repeat it
 * verbatim. Both marks stay outside flow — an absolutely-positioned rail in the
 * card's gutter and an `sr-only` suffix on the label — so a row that becomes
 * edited, or stops being, does not move a pixel of the pane.
 */
function SettingRow({
  edited = false,
  label,
  description,
  htmlFor,
  children,
}: {
  edited?: boolean;
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <ListRow
      htmlFor={htmlFor}
      label={
        <>
          {label}
          {edited && <span className="sr-only"> — edited, not saved</span>}
        </>
      }
      description={description}
    >
      <EditedRail on={edited} />
      {children}
    </ListRow>
  );
}

/**
 * A field whose control is a nine-line text region, which has nothing to align
 * a right edge against — so its label goes above it and the row treatment does
 * not apply. The same exception the new-run form's task field makes.
 */
function FormField({
  edited = false,
  label,
  htmlFor,
  className = "",
  children,
}: {
  edited?: boolean;
  label?: ReactNode;
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
  /** Non-null only while the globs field is being edited. */
  const [copyGlobsText, setCopyGlobsText] = useState<string | null>(null);
  // The registry, and the definitions this app did not write. Both are needed
  // for one row: the picker offers the first, and the sentence beside it has to
  // declare the second, because `--agents` merges with what the CLI finds on
  // disk rather than replacing it — so the registry is a part of the set a run
  // can delegate to and never the whole of it.
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [ambientAgents, setAmbientAgents] = useState<AmbientAgentDTO[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const standalone = useStandalone();

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

  useEffect(() => {
    // A failed read leaves the picker holding only the stored value, which is
    // what `agentsLoaded` guards: without it a list that never arrived would
    // report the saved default as an agent that no longer exists.
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setAgents(d.agents ?? []);
        setAmbientAgents(d.ambient ?? []);
        setAgentsLoaded(true);
      })
      .catch(() => void 0);
  }, []);

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

  const save = useCallback(async () => {
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
  }, [effective]);

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

  // Both refusals the PUT can answer with, checked here as well so the first
  // the operator hears of one is not a failed save. The server still decides.
  //
  // Computed above the loading branch because ⌘S is bound from an effect, and
  // a chord that saves what the button beside it refuses to save would be a
  // second, quieter route past the same two checks.
  const noTerminus =
    effective !== null &&
    effective.chatDefaultGuards.budget.maxIterations === null &&
    effective.chatDefaultGuards.budget.maxDurationMinutes === null;
  const resetTooFarAhead =
    effective !== null &&
    effective.sessionResetOverrideAt !== null &&
    effective.sessionResetOverrideAt > Date.now() + FIVE_HOURS_MS;
  const blocked = noTerminus
    ? "The default guard set has neither a work-cycle limit nor a time limit."
    : resetTooFarAhead
      ? "The 5-hour reset override is more than five hours from now."
      : null;

  /**
   * ⌘S, and only where this app owns it.
   *
   * Deliberately not routed through the shell's one listener: that layer refuses
   * every chord over a text field, and half of what this page holds is text —
   * a save shortcut that stops working in the prompt you are editing is the
   * failure it would exist to prevent. ⌘S types no character, so the reason
   * that rule exists does not apply to it.
   */
  useEffect(() => {
    if (!standalone) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!isPlainCommandChord(e) || e.key.toLowerCase() !== "s") return;
      // Prevented whether or not this save goes through: in an installed window
      // the chord is ours, and letting it fall through to the platform's own
      // "save this page" on a form that simply has nothing to commit is worse
      // than doing nothing.
      e.preventDefault();
      if (busy || !dirty || blocked !== null) return;
      void save();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [standalone, busy, dirty, blocked, save]);

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

  const applySuggestion = () => {
    if (!cal?.suggestion) return;
    patch({
      sessionCostLimit: cal.suggestion.sessionCostLimit,
      weeklyCostLimit: cal.suggestion.weeklyCostLimit,
      sessionTokenLimit: cal.suggestion.sessionTokenLimit,
      weeklyTokenLimit: cal.suggestion.weeklyTokenLimit,
    });
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

      {/* Plain anchors rather than `ButtonLink`: the pane is its own scroll
          region and the browser's native hash handling is what scrolls it, so
          this stays out of the router. Bezeled rather than the recessed chips
          it was — `--bg-inset` is the well a text field sits in, and a control
          drawn in it reads as the same object at a glance. */}
      <nav
        aria-label="Settings sections"
        className="mb-6 flex flex-wrap gap-1.5 border-b border-line pb-4"
      >
        {SECTIONS.map((sec) => (
          <a
            key={sec.id}
            href={`#${sec.id}`}
            className="ui-transition inline-flex min-h-[var(--control-h)] items-center rounded-sm border border-line bg-bezel px-2.5 text-xs font-medium text-ink-muted no-underline shadow-e1 hover:border-line-strong hover:bg-bezel-hover hover:text-ink hover:no-underline"
          >
            {sec.label}
          </a>
        ))}
      </nav>

      <Section
        id="limits"
        lead
        title="Subscription limits"
        lede="Where the percentages on the dashboard, and every window guard, come from."
      >
        <ListGroup className="mb-4">
          <SettingRow
            htmlFor="planusage"
            edited={isEdited("planUsageFromApi")}
            label="Read plan usage from Anthropic"
            description={
              <>
                The figure <span className="mono">/usage</span> shows, for the
                whole account rather than Claude Code alone, read with the
                credential the CLI already keeps here. The one percentage on the
                dashboard that is measured rather than estimated — the ceilings
                below are what it falls back to
              </>
            }
          >
            <Switch
              id="planusage"
              checked={effective.planUsageFromApi}
              onChange={(v) => patch({ planUsageFromApi: v })}
            />
          </SettingRow>

          <SettingRow
            htmlFor="side"
            edited={isEdited("includeSidechains")}
            label="Count sub-agent turns in usage totals"
            description="Sub-agent turns bill normally, so counting them is the accurate default. It moves the dashboard meters and what the scan below measures — exclude only to compare main-thread cost"
          >
            <Switch
              id="side"
              checked={effective.includeSidechains}
              onChange={(v) => patch({ includeSidechains: v })}
            />
          </SettingRow>
        </ListGroup>

        {/* Permanently on screen, so the tint rather than full alarm strength —
            a standing banner drawn as loudly as a conditional one is a banner
            the eye learns to skip, and it takes the real warnings with it. */}
        <Notice tone="warn" quiet>
          Anthropic publishes no numeric value for a Pro/Max limit, so anything
          you enter below is an <strong>estimate</strong>. It is what the meters
          and guards fall back to when the reading above is off or unavailable.
        </Notice>

        <ListGroup
          label="Cost ceilings"
          footnote={
            <>
              Blank leaves that meter hatched rather than showing a percentage,
              and a guard written as a fraction of it is refused rather than
              ignored. Cost rather than raw tokens because a Claude Code
              workload is mostly cache reads, which bill at 0.1× and would
              otherwise dominate a token count without consuming a comparable
              share of your plan
            </>
          }
        >
          <SettingRow
            htmlFor="sessc"
            edited={isEdited("sessionCostLimit")}
            label="5-hour ceiling"
          >
            {/* The width is on a wrapper, never on the control: `Input` already
                states `w-full`, and two width utilities on one element resolve
                by stylesheet order rather than class order. */}
            <div className="w-36">
              <Input
                id="sessc"
                type="number"
                min={0}
                step="0.5"
                className="tabular-nums"
                unit="USD"
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
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="wkc"
            edited={isEdited("weeklyCostLimit")}
            label="Weekly ceiling"
          >
            <div className="w-36">
              <Input
                id="wkc"
                type="number"
                min={0}
                step="1"
                className="tabular-nums"
                unit="USD"
                placeholder="No ceiling"
                value={numOrEmpty(effective.weeklyCostLimit)}
                onChange={(e) =>
                  patch({
                    weeklyCostLimit: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="head"
            edited={isEdited("reservedHeadroomFraction")}
            label="Reserved headroom"
            description={
              <>
                {effective.planUsageFromApi
                  ? "Applies to the estimated ceilings only. The reading above already counts Cowork, Desktop and the web app, so nothing is held back from it — subtracting a reserve there would take the same allowance off twice"
                  : "Cowork, Desktop and the web app share your limits and write no local transcripts, so this tool cannot see them — reserving headroom shrinks every ceiling so guards trip early"}
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
              </>
            }
          >
            <div className="w-28">
              <Input
                id="head"
                type="number"
                min={0}
                max={95}
                className="tabular-nums"
                unit="%"
                placeholder="None"
                value={
                  effective.reservedHeadroomFraction === null
                    ? ""
                    : String(
                        Math.round(effective.reservedHeadroomFraction * 100),
                      )
                }
                onChange={(e) =>
                  patch({
                    reservedHeadroomFraction: e.target.value
                      ? Math.min(Number(e.target.value) / 100, 0.95)
                      : null,
                  })
                }
              />
            </div>
          </SettingRow>
        </ListGroup>

        {/* On screen rather than behind the disclosure this used to be: the two
            fields are what a scan writes into, and an unsaved edit the operator
            cannot see is worse than one they did not ask for. */}
        <ListGroup
          className="mt-4"
          label="Raw-token ceilings"
          footnote="Used only while the matching cost ceiling above is blank"
        >
          <SettingRow
            htmlFor="sess"
            edited={isEdited("sessionTokenLimit")}
            label="5-hour ceiling"
          >
            <div className="w-40">
              <Input
                id="sess"
                type="number"
                min={0}
                className="tabular-nums"
                unit="tokens"
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
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="wk"
            edited={isEdited("weeklyTokenLimit")}
            label="Weekly ceiling"
          >
            <div className="w-40">
              <Input
                id="wk"
                type="number"
                min={0}
                className="tabular-nums"
                unit="tokens"
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
            </div>
          </SettingRow>
        </ListGroup>

        <ListGroup className="mt-4" label="When a window turns over">
          <SettingRow
            htmlFor="anchor"
            edited={isEdited("weeklyAnchor")}
            label="Weekly reset"
            description="Rolling means the weekly total decays over days rather than resetting, so no run can wait it out"
          >
            <div className="w-52">
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
                <option value="">Rolling 7 days</option>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    Resets {d}
                  </option>
                ))}
              </Select>
            </div>
            {effective.weeklyAnchor && (
              <div className="w-28">
                <Input
                  type="number"
                  min={0}
                  max={23}
                  className="tabular-nums"
                  unit="UTC"
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
              </div>
            )}
          </SettingRow>

          <SettingRow
            htmlFor="sessreset"
            edited={isEdited("sessionResetOverrideAt")}
            label="5-hour window reset"
            description={
              <Toned
                tone={
                  resetTooFarAhead
                    ? "danger"
                    : effective.sessionResetOverrideAt !== null &&
                        Date.now() < effective.sessionResetOverrideAt
                      ? "warn"
                      : "neutral"
                }
              >
                {resetTooFarAhead ? (
                  "No window can reset more than five hours from now — check the date"
                ) : effective.planUsageFromApi ? (
                  "Not needed while the reading above is on: Anthropic names the reset instant itself, and that wins over anything typed here"
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
                    {new Date(effective.sessionResetOverrideAt).toLocaleString()}
                    . Clear the field to drop the split
                  </>
                )}
              </Toned>
            }
          >
            <div className="w-56">
              <Input
                id="sessreset"
                type="datetime-local"
                className="tabular-nums"
                aria-invalid={resetTooFarAhead || undefined}
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
            </div>
          </SettingRow>
        </ListGroup>

        <ListGroup
          className="mt-4"
          label="Where a ceiling can come from"
          footnote="Nothing publishes your limit, so the least-bad evidence is your own history: a 5-hour block that reached a figure without being cut off proves the ceiling is at least that"
        >
          <SettingRow
            label="Estimate from your own history"
            description={
              calBusy
                ? "Reading every transcript on this disk…"
                : "Reports the highest 5-hour block and 7-day window it can find. Nothing is stored until you save"
            }
          >
            <Button
              variant="secondary"
              onClick={() => void calibrate()}
              busy={calBusy}
            >
              Scan history
            </Button>
          </SettingRow>
        </ListGroup>

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
            <Hint>Both metrics at once. Nothing is stored until you save</Hint>
          </div>
        )}
      </Section>

      <Section
        id="runs"
        title="Runs"
        lede="What the new-run form starts at, and how many runs may work at once."
      >
        <ListGroup>
          <SettingRow
            htmlFor="model"
            edited={isEdited("defaultModel")}
            label="Default model"
            description={
              <>
                e.g. <span className="mono">claude-opus-5</span> or{" "}
                <span className="mono">claude-sonnet-5</span>
              </>
            }
          >
            <div className="w-64">
              <Input
                id="model"
                type="text"
                placeholder="Claude Code's own default"
                value={effective.defaultModel ?? ""}
                onChange={(e) => patch({ defaultModel: e.target.value || null })}
              />
            </div>
          </SettingRow>

          {/* Beside the model and deliberately not among the guards below. An
              agent carries a description and a prompt — the registry refuses a
              tool list at the door and has no column for a permission mode — so
              this decides who does part of the work and never what a run is
              allowed to do. It is an id, so an operator who fixes their
              reviewer's prompt gets the fixed one on the next run. */}
          <SettingRow
            htmlFor="agent"
            edited={isEdited("defaultAgentId")}
            label="Default specialist"
            description={
              describeAmbientAgents(ambientAgents) ??
              "Pre-selected on the new-run form, which can change it or clear it"
            }
          >
            <div className="w-64">
              <Select
                id="agent"
                value={effective.defaultAgentId ?? ""}
                onChange={(e) =>
                  patch({ defaultAgentId: e.target.value || null })
                }
              >
                <option value="">No specialist</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.usable}>
                    {a.name}
                    {a.usable ? "" : " — incomplete"}
                  </option>
                ))}
                {/* A default whose agent has been deleted since it was saved.
                    Kept as an option rather than silently reverting the picker
                    to "No specialist", which would look like the setting had
                    never been made — and Save then refuses it by name. */}
                {agentsLoaded &&
                  effective.defaultAgentId !== null &&
                  !agents.some((a) => a.id === effective.defaultAgentId) && (
                    <option value={effective.defaultAgentId}>
                      Agent no longer in the registry
                    </option>
                  )}
              </Select>
            </div>
          </SettingRow>

          <SettingRow
            edited={isEdited("forwardSubAgentText")}
            label="Sub-agent output in the run log"
            description="Without it a delegation is a Task call followed by silence until it returns. A sub-agent's words are set apart from the run's own, and never become its report"
          >
            <Switch
              checked={effective.forwardSubAgentText}
              onChange={(v) => patch({ forwardSubAgentText: v })}
              label="Sub-agent output in the run log"
            />
          </SettingRow>

          <SettingRow
            edited={isEdited("defaultPermissionMode")}
            label="What a new run may do without asking"
            description="Pre-selected on the new-run form, where every run can change it. It does not reach the guard set below"
          >
            <SegmentedControl
              options={PERMISSION_OPTIONS}
              value={effective.defaultPermissionMode}
              onChange={(v) => patch({ defaultPermissionMode: v })}
              label="What a new run may do without asking"
            />
          </SettingRow>

          <SettingRow
            htmlFor="conc"
            edited={isEdited("maxConcurrentRuns")}
            label="Runs at the same time"
            description="Each run carries its own spending limit, so this multiplies the worst case — three runs at $5 can spend $15. A run over the limit waits rather than being refused, and queued or parked runs do not count against it"
          >
            <div className="w-32">
              <Input
                id="conc"
                type="number"
                min={1}
                className="tabular-nums"
                unit="runs"
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
            </div>
          </SettingRow>
        </ListGroup>

        <ListGroup className="mt-4" label="Isolated runs">
          <SettingRow
            htmlFor="copyglobs"
            edited={isEdited("isolationCopyGlobs")}
            label="Files copied into a new checkout"
            description={
              <>
                A fresh checkout holds committed work only, so a gitignored
                config file has to be copied in — prefix a pattern with{" "}
                <span className="mono">!</span> to exclude it. Dependencies are
                not copied; the agent installs them
              </>
            }
          >
            {/* Held as raw text while editing. Splitting on every keystroke
                drops the separator the moment it is typed, which makes a
                second pattern impossible to enter. */}
            <div className="w-72">
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
            </div>
          </SettingRow>

          <SettingRow
            edited={isEdited("landStrategy")}
            label="Landing a branch"
            description={LAND_CONSEQUENCE[effective.landStrategy]}
          >
            <SegmentedControl
              options={LAND_OPTIONS}
              value={effective.landStrategy}
              onChange={(v) => patch({ landStrategy: v })}
              label="Landing a branch"
            />
          </SettingRow>
        </ListGroup>
      </Section>

      <Section
        id="guards"
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
        <ListGroup>
          <SettingRow
            edited={isEdited("chatDefaultGuards.permissionMode")}
            label="What it may do without asking"
            description={<Toned tone={modeNote.tone}>{modeNote.text}</Toned>}
          >
            <SegmentedControl
              options={PERMISSION_OPTIONS}
              value={guards.permissionMode}
              onChange={(v) => patchGuards({ permissionMode: v })}
              label="What the chat's runs may do without asking"
            />
          </SettingRow>

          <SettingRow
            edited={isEdited("chatDefaultGuards.isolate")}
            label="Where Claude writes"
            description={
              <Toned tone={guards.isolate ? "neutral" : "warn"}>
                {ISOLATION_CONSEQUENCE[guards.isolate ? "worktree" : "direct"]}
              </Toned>
            }
          >
            <SegmentedControl
              options={ISOLATION_OPTIONS}
              value={guards.isolate ? "worktree" : "direct"}
              onChange={(v) => patchGuards({ isolate: v === "worktree" })}
              label="Where Claude writes"
            />
          </SettingRow>
        </ListGroup>

        <ListGroup className="mt-4" label="Stop conditions">
          <SettingRow
            htmlFor="cgcost"
            edited={isEdited("chatDefaultGuards.budget.maxRunCostUSD")}
            label="Spend limit"
            description={
              <>
                {SPEND_READ_AT[guards.budget.enforcement] ??
                  SPEND_READ_AT["between-cycles"]}{" "}
                It is per run, so three at once can spend three times it
              </>
            }
          >
            <div className="w-36">
              <Input
                id="cgcost"
                type="number"
                min={0}
                step="0.5"
                className="tabular-nums"
                unit="USD"
                placeholder="No limit"
                value={numOrEmpty(guards.budget.maxRunCostUSD)}
                onChange={(e) =>
                  patchGuardBudget({
                    maxRunCostUSD:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="cgcycles"
            edited={isEdited("chatDefaultGuards.budget.maxIterations")}
            label="Work cycles"
            description={
              <Toned tone={noTerminus ? "danger" : "neutral"}>
                {noTerminus
                  ? "Set this or a time limit — a run with neither would never have to end"
                  : "How many times the agent is sent back in before the run ends. Blank is only allowed alongside a time limit"}
              </Toned>
            }
          >
            <div className="w-36">
              <Input
                id="cgcycles"
                type="number"
                min={1}
                className="tabular-nums"
                unit="cycles"
                placeholder="No limit"
                aria-invalid={noTerminus || undefined}
                value={numOrEmpty(guards.budget.maxIterations)}
                onChange={(e) =>
                  patchGuardBudget({
                    maxIterations:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="cgmins"
            edited={isEdited("chatDefaultGuards.budget.maxDurationMinutes")}
            label="Time limit"
            description={
              <Toned tone={noTerminus ? "danger" : "neutral"}>
                {noTerminus
                  ? "Set this or a work-cycle limit — a run with neither would never have to end"
                  : "Wall clock, and the only limit that keeps moving whether or not a cycle reports what it spent"}
              </Toned>
            }
          >
            <div className="w-40">
              <Input
                id="cgmins"
                type="number"
                min={1}
                className="tabular-nums"
                unit="minutes"
                placeholder="No limit"
                aria-invalid={noTerminus || undefined}
                value={numOrEmpty(guards.budget.maxDurationMinutes)}
                onChange={(e) =>
                  patchGuardBudget({
                    maxDurationMinutes:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </SettingRow>
        </ListGroup>

        <ListGroup className="mt-4" label="What one chat message may spend">
          <SettingRow
            htmlFor="chatbudget"
            edited={isEdited("chatTurnBudgetUSD")}
            label="Orchestrator chat limit"
            description="A chat is not a run and has no guards of its own, so this and a ten-minute timeout are the only two things that stop one message. It is spent on the conversation, never added to a run"
          >
            <div className="w-36">
              <Input
                id="chatbudget"
                type="number"
                min={0}
                step="0.5"
                className="tabular-nums"
                unit="USD"
                placeholder="No limit"
                value={effective.chatTurnBudgetUSD ?? ""}
                onChange={(e) =>
                  patch({
                    chatTurnBudgetUSD:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </SettingRow>
        </ListGroup>
      </Section>

      <Section
        id="unattended"
        title="Unattended runs"
        lede="What happens while nobody is watching — mid-cycle checks, leftover processes, and a restart."
      >
        {/* This was the kit's reference conversion and the rest of the page now
            follows it. The edited rail still lands in the card's gutter:
            `SettingRow` is the positioned ancestor and the group does not clip
            its overflow, which is why it can. */}
        <ListGroup>
          <SettingRow
            htmlFor="livechk"
            edited={isEdited("liveGuardIntervalSeconds")}
            label="Live limit check"
            description="How often a run set to stop mid-cycle re-reads usage. It cannot beat one model turn however low this goes, because usage comes from transcripts written as each turn completes"
          >
            <div className="w-36">
              <Input
                id="livechk"
                type="number"
                min={15}
                className="tabular-nums"
                unit="seconds"
                value={effective.liveGuardIntervalSeconds}
                onChange={(e) =>
                  patch({ liveGuardIntervalSeconds: Number(e.target.value) })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="silence"
            edited={isEdited("maxCycleSilenceMinutes")}
            label="Silent cycle limit"
            description="A work cycle that has printed nothing for this long is ended, so a wedged agent gives its folder and its slot back without a restart. Counted from the last line Claude Code printed, not from the start of the cycle, and one tool call can be silent for a long time"
          >
            <div className="w-36">
              <Input
                id="silence"
                type="number"
                min={5}
                className="tabular-nums"
                unit="minutes"
                value={effective.maxCycleSilenceMinutes}
                onChange={(e) =>
                  patch({ maxCycleSilenceMinutes: Number(e.target.value) })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="killgroup"
            edited={isEdited("killProcessGroup")}
            label="Stopping a run also stops everything it started"
            description="Builds, test runners and servers the agent launched otherwise hold the working directory open and keep writing into a folder the next run is about to use"
          >
            <Switch
              id="killgroup"
              checked={effective.killProcessGroup}
              onChange={(v) => patch({ killProcessGroup: v })}
            />
          </SettingRow>

          <SettingRow
            htmlFor="grace"
            edited={isEdited("resumeGraceHours")}
            label="Restart grace"
            description="A parked run older than this is closed out at boot rather than picked up, so a forgotten run cannot wake up days later and start spending"
          >
            <div className="w-32">
              <Input
                id="grace"
                type="number"
                min={1}
                className="tabular-nums"
                unit="hours"
                value={effective.resumeGraceHours}
                onChange={(e) =>
                  patch({ resumeGraceHours: Number(e.target.value) })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="telemetry"
            edited={isEdited("telemetryForRuns")}
            label="Let agents report per-request cost over OpenTelemetry"
            description={
              <>
                The only record of what a work cycle killed mid-flight actually
                cost. Off by default because it changes the child
                process&rsquo;s behaviour, and it never feeds the meters. One
                exception: a run whose own spending limit needs it switches it
                on for itself
              </>
            }
          >
            <Switch
              id="telemetry"
              checked={effective.telemetryForRuns}
              onChange={(v) => patch({ telemetryForRuns: v })}
            />
          </SettingRow>
        </ListGroup>
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

        <FormField
          label="Continued-branch preamble"
          htmlFor="contwork"
          edited={isEdited("continuedWorkPrompt")}
          className={FLUSH}
        >
          <Textarea
            id="contwork"
            className="min-h-[110px]"
            value={effective.continuedWorkPrompt}
            onChange={(e) => patch({ continuedWorkPrompt: e.target.value })}
          />
          <Hint>
            Sent when a run picks up the branch the run before it was working
            on. The branch, that run and the commands to read it are added
            around this — what you write here is what to <em>do</em> with what
            is already there
          </Hint>
        </FormField>
      </Section>

      {/* The pane's footer, not a form's button row: the default action at the
          trailing edge with Discard to its left, which is where a Mac window
          puts them. Sticky, because one Save commits every field on a page five
          sections long and the button must not be somewhere you have to hunt
          for after editing something at the top.

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
      {/* -mb-12 pairs with the pane's own pb-12 exactly as -mx-4 pairs with its
          px-4: a sticky bar is never pushed *past* where it sits in flow, so
          that bottom padding stayed underneath it as a band of nothing between
          the bar and the foot of the window. */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-12 border-t border-line bg-canvas px-4 py-3 shadow-bar sm:-mx-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <p
            role="status"
            aria-atomic="true"
            className={`mr-auto min-h-5 basis-full text-xs leading-5 sm:basis-auto ${
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
          <Button variant="secondary" onClick={discard} disabled={busy || !dirty}>
            Discard
          </Button>
          {/* The chord is only offered where this app owns it — see
              STANDALONE_QUERIES. In a tab there is no glyph and no binding,
              because ⌘S is the browser's there. */}
          <Button
            onClick={() => void save()}
            busy={busy}
            disabled={!dirty || blocked !== null}
            aria-keyshortcuts={standalone ? "Meta+S" : undefined}
          >
            Save
            {standalone && (
              <span aria-hidden="true" className="text-xs opacity-70">
                ⌘S
              </span>
            )}
          </Button>
        </div>
      </div>
    </>
  );
}
