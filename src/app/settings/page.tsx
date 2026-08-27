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
  ClaudeAuthDTO,
  ClaudeAuthStateDTO,
  KnowledgeStatusDTO,
  PluginsReportDTO,
  PruneTier,
  RunGuardsDTO,
  SandboxDTO,
  SandboxStateDTO,
  SettingsDTO,
  StorageReportDTO,
} from "@/lib/apiTypes";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import {
  describeAmbientAgents,
  fmtBytes,
  fmtTokens,
  fmtUSD,
  type BadgeTone,
} from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/Field";
import { Hint, type HintTone } from "@/components/ui/Hint";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
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
 * Mirrors `readGuard.CLI_MAX_READ_TOKENS`, which the route clamps to.
 *
 * Copied rather than imported for the reason `FIVE_HOURS_MS` above is: this
 * file is `"use client"`, and `readGuard.ts` reaches `node:fs` and the
 * database. What it says is a fact about Claude Code rather than about this
 * app — the CLI's own file-reading limit, past which a whole read is refused
 * with the same advice — so the number moving is the CLI's business and the
 * route is where the two would be reconciled.
 */
const CLI_MAX_READ_TOKENS = 25_000;

/**
 * Anchors for the section nav; order is the page order, and the page order is
 * how often a setting is reached for rather than when it was written.
 *
 * The ceilings lead because every meter in the app is read against them and a
 * fresh install has none; the run defaults are next because they are what the
 * form most people open every day starts at; the chat's guard set follows,
 * being what the *app* starts under rather than what a person does; the
 * unattended settings and the four prompts are at the end because they are
 * typed once, if ever. Token use sits with them and for the same reason, one
 * step further out: both of its switches are experiments an operator turns on
 * deliberately, and neither is something a working install ever needs to visit.
 */
const SECTIONS = [
  { id: "limits", label: "Subscription limits" },
  { id: "runs", label: "Runs" },
  // The heading's own words. A chip that lands on a heading it does not name
  // reads as a section that is missing and one that arrived unannounced.
  { id: "guards", label: "Default guard set" },
  { id: "unattended", label: "Unattended runs" },
  { id: "tokens", label: "Token use" },
  { id: "plugins", label: "Plugins" },
  { id: "knowledge", label: "Knowledge base" },
  { id: "storage", label: "Storage" },
  { id: "prompts", label: "Prompts" },
];

type ChipState = "current" | "plain";

/**
 * Whether a chip is the section you are standing in.
 *
 * The selected pair is `QuickOpen`'s, which is the app's existing answer for a
 * row that is the one a keypress would act on, rather than a second treatment
 * invented here.
 *
 * Both entries carry the whole of what differs — border, fill and label — for
 * the reason `conventions.md` states rather than as a style: a shared string
 * holding `bg-bezel` with `bg-tint` added per state is two `background-color`
 * utilities on one element, and the winner is Tailwind's own sort order rather
 * than anything written down here. The hover states belong to `plain` for the
 * same reason and a second one: a chip that is already selected has nothing to
 * answer the pointer with.
 */
const CHIP: Record<ChipState, string> = {
  current: "border-tint bg-tint text-tint-fg",
  plain:
    "border-line bg-bezel text-ink-muted hover:border-line-strong hover:bg-bezel-hover hover:text-ink",
};

/**
 * Which section anchor the location is standing on.
 *
 * `hashchange` and the press together: a press that lands on the hash already
 * in the bar fires no event, and the event is what carries a Back, a typed URL
 * and a link from somewhere else. Empty on the server and on the first paint,
 * then corrected — the same arrangement `useStandalone` uses, and it costs
 * nothing because what it decides is which chip is filled.
 *
 * Deliberately not an `IntersectionObserver` scroll-spy: the pane is its own
 * scroll region, so the observer would need a `root` that is not the viewport,
 * which is a second mechanism with a second failure mode for a marginal gain.
 */
function useSectionHash(): [string, (id: string) => void] {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash.replace(/^#/, ""));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return [hash, setHash];
}

/**
 * One field the search found, and where it is.
 *
 * `el` is the marked name itself rather than a selector for it: the list is
 * rebuilt from the DOM on every keystroke and on every edit, so no entry here
 * outlives the paint it was read from.
 */
interface FieldHit {
  /** The field's name, exactly as the page draws it. */
  name: string;
  sectionId: string;
  sectionLabel: string;
  /** The control the field's label points at, where it named one. */
  controlId: string | null;
  el: HTMLElement;
}

/**
 * How many matches are drawn. A one-letter query matches most of the page, and
 * a result list longer than the nav it sits above is a second problem.
 *
 * The count of what was left out is stated beside them — a capped list that
 * does not say it is capped reads as the whole answer.
 */
const MAX_FIELD_HITS = 8;

/**
 * Every field whose name or help text contains `query`, in page order.
 *
 * Reads the rendered page rather than a declared index, for the reason
 * `SettingName` records. Nine sections are anchors on one long page, so all of
 * them are in the DOM at once and a walk over it is the whole corpus.
 */
function findFields(query: string): FieldHit[] {
  const hits: FieldHit[] = [];
  for (const sec of SECTIONS) {
    const root = document.getElementById(sec.id);
    if (!root) continue;
    for (const el of root.querySelectorAll<HTMLElement>("[data-setting-name]")) {
      const name = (el.textContent ?? "").trim();
      // The block holding the name *and* whatever explains it — a row's
      // description, a field's hint, a fold's body. Two levels up from the mark
      // in all three wrappers, because the name sits inside the `<label>` or
      // `<summary>` the primitive draws and the help text is that element's
      // sibling. A change to either primitive's shape costs the help text and
      // never the name, which is the direction that degrades quietly rather
      // than wrongly.
      const block = el.parentElement?.parentElement ?? el;
      const haystack = `${name}\n${block.textContent ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) continue;
      hits.push({
        name,
        sectionId: sec.id,
        sectionLabel: sec.label,
        controlId: el.closest("label")?.getAttribute("for") ?? null,
        el,
      });
    }
  }
  return hits;
}

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

const PRUNE_TIER_OPTIONS: readonly SegmentedOption<PruneTier>[] = [
  { value: "standard", label: "Standard" },
  { value: "aggressive", label: "Aggressive" },
];

/**
 * Measured on one real 2.0 MB transcript on this install, so the figures are an
 * example rather than a promise — which is what the copy says.
 */
const PRUNE_TIER_CONSEQUENCE: Record<PruneTier, string> = {
  standard:
    "Trims long tool output, old file reads superseded by later edits, thinking blocks and repeated system reminders. On one real transcript this removed 28% of what the agent was carrying",
  aggressive:
    "Everything Standard does, plus collapsing repeated errors and polling, deduplicating large documents, trimming any block over 32KB and dropping older images. Removes more, and more of what it removes is content the agent might have re-read",
};

type PruneEngine = "legacy" | "winnow";

const PRUNE_ENGINE_OPTIONS: readonly SegmentedOption<PruneEngine>[] = [
  { value: "legacy", label: "Edit in place" },
  { value: "winnow", label: "Fork" },
];

/**
 * The two engines, described by what they do to the conversation rather than by
 * their names — an operator choosing here does not care which module runs.
 *
 * The Fork row says three things it would be dishonest to leave to a tooltip:
 * that nothing has proved a forked session resumes, that the app rolls back if
 * one does not, and that it does nothing at all until the setting below it is
 * lowered. The last is the one that would otherwise read as the feature being
 * broken.
 */
const PRUNE_ENGINE_CONSEQUENCE: Record<PruneEngine, string> = {
  legacy:
    "Rewrites the conversation where it stands, keeping the same session. This is what this app has always done and what every figure on the savings card was measured against",
  winnow:
    "Writes a new conversation with the removed output replaced by recoverable pointers, and moves the run onto it. The original is never touched and stays the way back. Nothing has yet proved a forked conversation resumes, so if one does not, the run returns to the conversation it had and the failure is recorded — that check is also how the evidence gets collected. Does nothing until you lower the quiet period below",
};

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
  "installDailyCostLimitUSD",
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
  "maxConcurrentAssists",
  "isolationCopyGlobs",
  "isolationCopyGlobsByRepo",
  "landStrategy",
  "resolveVerifyTools",
  "continuationPrompt",
  "donePushbackPrompt",
  "isolationPreamble",
  "continuedWorkPrompt",
  "liveGuardIntervalSeconds",
  "maxCycleSilenceMinutes",
  "killProcessGroup",
  "resumeGraceHours",
  "telemetryForRuns",
  "readGuard",
  "readGuardMaxTokens",
  "contextPruning",
  "contextPruningStrictness",
  "contextPruningEngine",
  "contextPruningForkMinColdAge",
  "freshStartContextTokens",
  "knowledgeBaseMountId",
  "knowledgeBaseSubpath",
  "eventRetentionDays",
  "checkoutRetentionDays",
  "transcriptRetentionDays",
] as const;

/**
 * What each fold holds, in the dotted spelling `GET /api/settings` answers
 * `nonDefaultKeys` with.
 *
 * A fold whose contents differ from their defaults opens by default and says
 * how many do, and that rule is the whole of what makes folding a control set
 * once per install safe rather than a way to hide a surprise. These lists are
 * what it is computed from, so a path missing from one is a setting that can
 * sit behind a closed summary at a value nobody on this install chose — which
 * is silent, because the fold looks exactly the same either way.
 *
 * The seventh fold — the calibration tool — holds no stored setting at all and
 * so takes neither, which is why it has no list here.
 */
const WINDOW_TURNOVER_KEYS = ["weeklyAnchor", "sessionResetOverrideAt"];
const ISOLATED_RUN_KEYS = [
  "isolationCopyGlobs",
  "isolationCopyGlobsByRepo",
  "landStrategy",
  "resolveVerifyTools",
];

/**
 * A fold's summary stands exactly where the group label or field label it
 * replaced stood, so it is drawn as that label: the triangle beside it is what
 * says it opens, and the hit target and the interaction states are
 * `Disclosure`'s own. Both of those labels are this one string in the kit
 * (`List`'s and `Field`'s), so a fold cannot read as a different rank of thing
 * from the groups it sits among.
 */
const FOLD_SUMMARY = "text-xs font-medium text-ink-muted";

/** The gap between a summary and the box under it, stated once. */
const FOLD_BODY = "mt-2";

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
 * remainder into the cycle as a cap of its own, so what the mode still decides
 * is when a *fresh* reading is taken — which is why these three differ only in
 * their first clause. "Cap" and not "ceiling", here and in the three strings:
 * a ceiling is a number set further up this same page that a *window*
 * percentage is measured against, and this is a limit on one run. Everything
 * else on this page that says "ceiling" means the windows, which is exactly why
 * the word may not also mean this one — the run form settled on "cap" for the
 * same sentence. Rendered from the stored mode rather than hardcoded: nothing
 * on this page can set it, but a guard set written by another build could carry
 * `live`, and a sentence describing the wrong mode is worse than no sentence.
 */
const SPEND_READ_AT: Record<BudgetPolicyDTO["enforcement"], string> = {
  "between-cycles":
    "Read before each work cycle, and carried into the cycle as its own cap, so a run stops near it.",
  live: "Read on a ticker while a cycle is going, and carried into the cycle as its own cap, so a run stops near it.",
  "live-resume":
    "Read on a ticker while a cycle is going, and carried into the cycle as its own cap, so a run stops near it.",
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

/**
 * One `folder: pattern, pattern` line per repository.
 *
 * A line with a folder and nothing after the colon is kept as an empty list,
 * because "copy nothing into this repository's checkouts" is the one thing the
 * global list cannot express and the reason this field exists.
 */
function parseGlobsByRepo(text: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const folder = line.slice(0, colon).trim().replace(/\/+$/, "");
    if (!folder) continue;
    map[folder] = parseGlobs(line.slice(colon + 1));
  }
  return map;
}

/**
 * How wide the GitHub credential is, in words, beside the badge saying there is
 * one.
 *
 * The header could already say a token exists and nothing said what it reached.
 * At one repository those are the same sentence; at fifteen they are not, and
 * the difference is what an unattended agent can do to the other fourteen.
 */
function githubScopeNote(summary: unknown): string {
  const s = (summary ?? {}) as { install?: unknown; repositories?: unknown };
  const repositories = Array.isArray(s.repositories) ? (s.repositories as string[]) : [];
  if (repositories.length === 0) return "one token, every repository";
  const scoped = `${repositories.length} folder${repositories.length === 1 ? "" : "s"} scoped`;
  return s.install ? `${scoped}, the rest share one token` : `${scoped}, the rest get none`;
}

function formatGlobsByRepo(map: Record<string, string[]>): string {
  return Object.entries(map)
    .map(([folder, globs]) => `${folder}: ${globs.join(", ")}`)
    .join("\n");
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
 * A field's name, marked so the search can find it without a second list.
 *
 * The alternative was an index of every field declared beside `SECTIONS` —
 * sixty entries duplicating label and help text that is already at the call
 * site, with nothing keeping the two in step. A search that names a field this
 * page no longer has is worse than no search: it sends the reader looking for a
 * control that is not there, and it looks exactly like a search that works.
 *
 * So the corpus *is* the page. A field is searchable because it rendered, and
 * the words it is found by are the words on screen, interpolated values and
 * all. The three wrappers below are where every stored setting on this page
 * gets its name, so marking them is complete by construction; the read-only
 * rows in the storage and knowledge reports go through `ListRow` directly and
 * are deliberately not settings.
 *
 * The unsaved suffix stays outside the mark, so a result reads as the field
 * rather than as its state.
 */
function SettingName({
  label,
  edited,
}: {
  label: ReactNode;
  edited: boolean;
}) {
  return (
    <>
      <span data-setting-name="">{label}</span>
      {edited && <span className="sr-only"> — edited, not saved</span>}
    </>
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
      label={<SettingName label={label} edited={edited} />}
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
          <SettingName label={label} edited={edited} />
        )
      }
    >
      <EditedRail on={edited} />
      {children}
    </Field>
  );
}

/**
 * One prompt behind its own fold.
 *
 * Four independent folds and deliberately not an accordion: opening one must
 * not close another, which would be a second state machine nothing else in this
 * app has, and a lost scroll position each time.
 *
 * The summary carries the label, so the field inside renders none — a
 * `<summary>` is the disclosure's own control and cannot also be the `<label>`
 * for the box under it, so the textarea takes the same words as its accessible
 * name. The unsaved-edit suffix goes on the summary rather than on the field,
 * which is what lets a screen reader tell from a **closed** fold that something
 * inside it is unsaved; the rail in the gutter says the same thing to everyone
 * else, once the fold is open.
 *
 * Factored for the reason `SettingRow` is: four call sites repeat it verbatim,
 * and the label is stated once here rather than twice at each of them.
 */
function PromptFold({
  label,
  id,
  edited,
  count,
  defaultOpen,
  value,
  onChange,
  className = "",
  hint,
}: {
  label: string;
  id: string;
  /** Differs from what the server last confirmed. */
  edited: boolean;
  /** How many of this fold's settings differ from what the build ships. */
  count: number | undefined;
  defaultOpen: boolean;
  value: string;
  onChange: (next: string) => void;
  /** The textarea's own height. The four differ, and always have. */
  className?: string;
  hint: ReactNode;
}) {
  return (
    <Disclosure
      className="mb-3.5 last:mb-0"
      summaryClassName={FOLD_SUMMARY}
      summary={<SettingName label={label} edited={edited} />}
      count={count}
      defaultOpen={defaultOpen}
    >
      <FormField edited={edited} className={`${FOLD_BODY} ${FLUSH}`}>
        <Textarea
          id={id}
          aria-label={label}
          className={className}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <Hint>{hint}</Hint>
      </FormField>
    </Disclosure>
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

/** How long ago, in the coarsest unit that still says something. */
function ago(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * What each store holds right now.
 *
 * Rows in a grouped list rather than `Stat` cards: the question an operator
 * brings to this is "which of these is filling my disk", which is a comparison
 * down a column rather than three headline figures. A failed read says so —
 * a store that could not be measured and a store with nothing in it must not
 * read alike, which is the same rule the hatched meter follows.
 */
function StorageFigures({
  report,
  error,
}: {
  report: StorageReportDTO | null;
  error: string | null;
}) {
  if (error !== null) {
    return (
      <Notice tone="warn">
        <strong>Sizes could not be read.</strong> {error}. The horizons below
        still apply — this is a measurement, not a setting.
      </Notice>
    );
  }
  if (!report) return <Empty>Measuring…</Empty>;

  const { database, checkouts, transcripts, lastSweep } = report;
  return (
    <ListGroup
      label="On disk now"
      footnote={
        <>
          Removing rows lets SQLite reuse the pages; the file itself only
          shrinks after a <span className="mono">VACUUM</span>, which{" "}
          <span className="mono">README.md</span> gives beside the backup
          procedure
          {lastSweep && (
            <>
              . Last swept {ago(lastSweep.at)} — {lastSweep.events.toLocaleString()}{" "}
              log rows, {lastSweep.telemetry.toLocaleString()} telemetry rows,{" "}
              {/* Conditional rather than defaulted to 0: a sweep recorded
                  before this store was swept knew nothing about it, which is
                  not the same claim as having found none. */}
              {lastSweep.samples !== undefined && (
                <>{lastSweep.samples.toLocaleString()} context samples, </>
              )}
              {lastSweep.checkouts} checkout
              {lastSweep.checkouts === 1 ? "" : "s"} and{" "}
              {lastSweep.transcripts.toLocaleString()} transcript
              {lastSweep.transcripts === 1 ? "" : "s"} (
              {fmtBytes(lastSweep.transcriptBytes)}) discarded
            </>
          )}
        </>
      }
    >
      <ListRow
        label="Database"
        description={`${database.path} — ${database.runEvents.toLocaleString()} log rows, ${database.telemetryRows.toLocaleString()} telemetry rows`}
      >
        <span className="tabular-nums text-sm">
          {fmtBytes(database.bytes + database.walBytes)}
        </span>
      </ListRow>

      {checkouts.map((store) => (
        <ListRow
          key={store.path}
          label={`Checkouts — ${store.label}`}
          description={`${store.path} — ${store.count} checkout${store.count === 1 ? "" : "s"}`}
        >
          <span className="tabular-nums text-sm">
            {/* "at least", because the walk is bounded: a store of installed
                dependency trees is millions of files, and a figure that stopped
                counting has to say so rather than read as the total. */}
            {store.partial ? "≥ " : ""}
            {fmtBytes(store.bytes)}
          </span>
        </ListRow>
      ))}

      <ListRow
        label="Transcripts"
        description={`${transcripts.path} — ${transcripts.files.toLocaleString()} session${transcripts.files === 1 ? "" : "s"}`}
      >
        <span className="tabular-nums text-sm">
          {transcripts.partial ? "≥ " : ""}
          {fmtBytes(transcripts.bytes)}
        </span>
      </ListRow>
    </ListGroup>
  );
}

/**
 * What the last scan of the vault found.
 *
 * `StorageFigures`' rule, and for a sharper reason: a knowledge base that
 * cannot be read has no notes, no orphans and no broken links, and rendering
 * that as three zeroes says "your vault is in perfect health" about a directory
 * this container cannot open. So an unavailable vault gets a sentence and no
 * figures at all, and the counts are `null` on the wire precisely so this
 * cannot be got wrong by accident.
 */
function KnowledgeFigures({
  report,
  error,
}: {
  report: KnowledgeStatusDTO | null;
  error: string | null;
}) {
  if (error !== null) {
    return (
      <Notice tone="warn">
        <strong>The knowledge base could not be read.</strong> {error}
      </Notice>
    );
  }
  if (!report) return <Empty>Scanning…</Empty>;
  if (!report.configured) {
    return (
      <Empty>
        No knowledge base yet. Pick one of your mounted folders below and this
        fills in with what is in it.
      </Empty>
    );
  }
  if (!report.available) {
    return (
      <Notice tone="warn">
        <strong>Nothing was scanned.</strong> {report.error} No figures are shown
        rather than zeroes, because an unreadable vault and an empty one are not
        the same thing.
      </Notice>
    );
  }

  const where = report.subpath
    ? `${report.mountLabel} / ${report.subpath}`
    : report.mountLabel;

  return (
    <ListGroup
      label="Found in the vault"
      footnote={
        <>
          Read only — nothing in this app writes into the vault. Rescanned when
          a file&rsquo;s size or timestamp moves
          {report.scannedAt !== null && <> — last scan {ago(report.scannedAt)}</>}
        </>
      }
    >
      <ListRow
        label="Vault"
        description="One of the folders this container already mounts. Choosing it here adds no access an agent did not have"
      >
        <span className="text-sm">{where}</span>
      </ListRow>

      <ListRow
        label="Notes"
        description="Markdown files, excluding the vault's own configuration folders"
      >
        <span className="tabular-nums text-sm">
          {/* "at least", for `StorageFigures`' reason: a walk that stopped at
              its cap must not read as a total. */}
          {report.truncated ? "≥ " : ""}
          {(report.noteCount ?? 0).toLocaleString()}
        </span>
      </ListRow>

      <ListRow
        label="Orphans"
        description="Notes with no link to another note and none from one. Tags do not count as a connection"
      >
        <span className="tabular-nums text-sm">
          {(report.orphanCount ?? 0).toLocaleString()}
        </span>
      </ListRow>

      <ListRow
        label="Broken links"
        description="Links naming a note that does not exist. Kept in the graph rather than dropped — in a vault they are usually intentions rather than mistakes"
      >
        <span className="tabular-nums text-sm">
          {(report.brokenLinkCount ?? 0).toLocaleString()}
        </span>
      </ListRow>

      <ListRow label="Tags" description="Distinct tags, from frontmatter and from the body">
        <span className="tabular-nums text-sm">
          {(report.tagCount ?? 0).toLocaleString()}
        </span>
      </ListRow>

      {report.truncated && (
        <ListRow
          label="The scan stopped early"
          description="This vault is larger than the walk's cap, so every figure above is a floor rather than a total. Narrowing the folder below is the fix"
        >
          <Badge tone="warn">Truncated</Badge>
        </ListRow>
      )}
    </ListGroup>
  );
}

/** One `label: value` line in the environment summary under the title. */
/**
 * The one way to end a session from inside the app.
 *
 * It exists because a session now *is* something: the cookie used to be
 * `UF_AUTH_TOKEN` itself, so there was nothing to end short of changing the
 * environment and restarting the container — which kills every run in flight.
 * "All" is here rather than only "this browser" because the case that matters
 * is a cookie that got out, and the browser holding it is not this one.
 */
function SignOut({ sessions }: { sessions: number }) {
  const [busy, setBusy] = useState(false);

  async function signOut(all: boolean) {
    setBusy(true);
    try {
      await fetch("/api/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all }),
      });
    } finally {
      // Whatever happened, the credential this page was loaded with may no
      // longer be good, and the gate is the authority on that.
      window.location.href = "/login";
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone="ok">{sessions === 1 ? "1 session" : `${sessions} sessions`}</Badge>
      <Button variant="secondary" busy={busy} onClick={() => void signOut(false)}>
        Sign out
      </Button>
      <Button variant="secondary" busy={busy} onClick={() => void signOut(true)}>
        Sign out everywhere
      </Button>
    </span>
  );
}

/**
 * Failed sign-ins, and the row is absent while there have been none.
 *
 * It is here because the limiter's record has to be readable by a person: a
 * burst against the one unauthenticated route in this app used to leave no
 * trace at all — no counter, no log line, nothing to find afterwards. A row
 * that said "0" every day is a row nobody would still be reading on the day it
 * said something else.
 */
function FailedSignIns({ summary }: { summary: unknown }) {
  if (typeof summary !== "object" || summary === null) return null;
  const s = summary as {
    failures?: number;
    firstAt?: number | null;
    lastAt?: number | null;
    lockedSources?: number;
    lockedGlobally?: boolean;
  };
  const failures = Number(s.failures ?? 0);
  if (failures === 0) return null;

  const when = (t: number | null | undefined) =>
    typeof t === "number" ? new Date(t).toLocaleString() : "—";

  return (
    <EnvRow label="Failed sign-ins">
      <Badge tone={s.lockedGlobally ? "danger" : "warn"}>{failures}</Badge>{" "}
      <span>
        {when(s.firstAt)} → {when(s.lastAt)}
        {Number(s.lockedSources ?? 0) > 0 &&
          ` · ${s.lockedSources} source(s) locked out`}
        {s.lockedGlobally && " · sign-in locked install-wide"}
      </span>
    </EnvRow>
  );
}

/**
 * The container's own Claude Code login, and the two buttons that move it.
 *
 * This is the step every install has to take before a single run can work, and
 * until now the only way to take it was `docker compose exec -it usagefoundry
 * claude` and `/login` — a terminal on the host, for an app whose whole point
 * is not needing one. Signing *out* had no procedure at all short of deleting a
 * file inside the mounted directory.
 *
 * It sits beside "Sign-in" rather than replacing it because the two are
 * different credentials that fail in different directions: that row is this
 * app's own session, and losing it locks you out of the page. This one is the
 * account the agents bill against, and losing it leaves the page working
 * perfectly while every run ends on `Not logged in`.
 *
 * The pending sign-in is server state, not component state — the child holding
 * the PKCE verifier outlives this tab. That is why a reload offers to *finish*
 * a sign-in rather than silently starting a second one whose link would
 * invalidate the code already sitting in somebody's clipboard.
 */
function ClaudeAccount() {
  const [state, setState] = useState<ClaudeAuthStateDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The link being shown. Non-null is the sign-in sheet being open. */
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [confirmOut, setConfirmOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await jsonRequest<ClaudeAuthStateDTO>("/api/claude-auth");
    if (!res.ok) {
      setLoadError(
        actionFailureMessage(res, "Could not read the Claude sign-in."),
      );
      return;
    }
    setLoadError(null);
    setState(res.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function begin() {
    setBusy(true);
    setFlowError(null);
    const res = await jsonRequest<{ url: string }>("/api/claude-auth/login", {
      method: "POST",
      body: {},
    });
    setBusy(false);
    if (!res.ok) {
      setLoadError(actionFailureMessage(res, "Could not start the sign-in."));
      return;
    }
    setCode("");
    setLinkUrl(res.data.url);
  }

  async function finish() {
    setBusy(true);
    setFlowError(null);
    const res = await jsonRequest<{ auth: ClaudeAuthDTO }>(
      "/api/claude-auth/login/code",
      { method: "POST", body: { code } },
    );
    if (res.ok) {
      setBusy(false);
      setLinkUrl(null);
      setCode("");
      setState({ auth: res.data.auth, error: null, pending: null });
      return;
    }

    // A refused code leaves two very different situations, and the difference
    // decides whether this sheet should stay open: the CLI rejects a truncated
    // paste locally and keeps the same prompt — and the same link — alive,
    // whereas a spent or expired one ends the child. Re-reading the server's
    // own state is what tells them apart; inferring it from the message would
    // put the operator in front of a dead link that still looks usable.
    const message = actionFailureMessage(res, "That code was not accepted.");
    const fresh = await jsonRequest<ClaudeAuthStateDTO>("/api/claude-auth");
    setBusy(false);
    if (fresh.ok) {
      setState(fresh.data);
      if (!fresh.data.pending) {
        setLinkUrl(null);
        setCode("");
        setLoadError(message);
        return;
      }
    }
    setFlowError(message);
  }

  /** Closing the sheet abandons the child too, or it waits ten minutes alone. */
  async function abandon() {
    setLinkUrl(null);
    setCode("");
    setFlowError(null);
    await jsonRequest("/api/claude-auth/login", { method: "DELETE" });
    void load();
  }

  async function out() {
    setBusy(true);
    const res = await jsonRequest<{ auth: ClaudeAuthDTO }>(
      "/api/claude-auth/logout",
      { method: "POST", body: {} },
    );
    setBusy(false);
    setConfirmOut(false);
    if (!res.ok) {
      setLoadError(actionFailureMessage(res, "Could not sign out."));
      return;
    }
    setState({ auth: res.data.auth, error: null, pending: null });
  }

  const auth = state?.auth ?? null;
  const pending = state?.pending ?? null;

  return (
    <EnvRow label="Claude account">
      {state === null && loadError === null ? (
        <span>reading…</span>
      ) : loadError ? (
        <>
          <Badge tone="danger">unavailable</Badge> <span>{loadError}</span>{" "}
          <Button variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </>
      ) : auth === null ? (
        // The CLI answered something we cannot read. Distinct from signed
        // out, and not fixed by signing in — so no Sign in button here.
        <>
          <Badge tone="danger">unreadable</Badge>{" "}
          <span>{state?.error ?? "the CLI did not answer"}</span>
        </>
      ) : (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {auth.loggedIn ? (
            <>
              <Badge tone="ok">signed in</Badge>
              <span>
                {[auth.email, auth.organization, auth.plan]
                  .filter(Boolean)
                  .join(" · ") || auth.method || "no identity reported"}
              </span>
            </>
          ) : (
            <>
              <Badge tone="danger">signed out</Badge>
              <span>runs fail until this is signed in</span>
            </>
          )}
          {/* Stated wherever it is true, because it silently outranks
              everything to its left: with a key set, that key is what a work
              cycle bills, and the subscription beside it is decoration. */}
          {auth.apiKeySource && (
            <>
              <Badge tone="warn">{auth.apiKeySource}</Badge>
              <span>this key is what runs bill, not the subscription</span>
            </>
          )}
          {pending ? (
            <Button
              variant="secondary"
              onClick={() => {
                setFlowError(null);
                setCode("");
                setLinkUrl(pending.url);
              }}
            >
              Finish sign-in
            </Button>
          ) : auth.loggedIn ? (
            <Button variant="secondary" onClick={() => setConfirmOut(true)}>
              Sign out
            </Button>
          ) : (
            <Button variant="secondary" busy={busy} onClick={() => void begin()}>
              Sign in
            </Button>
          )}
        </span>
      )}

      {/* Inside the row rather than beside it. `EnvRow` renders a `<dd>`, which
          takes flow content and so takes a `<dialog>`; as siblings these two
          would be direct children of the `<dl>` above, which may hold only
          `dt`, `dd` and `div`. Nothing moves visually — a closed `<dialog>` is
          `display: none` and an open one is in the top layer — which is exactly
          why the wrong version would never have announced itself. */}
      <Sheet
        open={linkUrl !== null}
        onDismiss={() => void abandon()}
        title="Sign in to Claude"
        confirmLabel="Finish"
        confirmDisabled={code.trim() === ""}
        busy={busy}
        onConfirm={() => void finish()}
      >
        <p>
          Open this page, approve access, then paste the code it gives you
          back. The link works from any device.
        </p>
        <p className="mt-3">
          <a href={linkUrl ?? "#"} target="_blank" rel="noopener noreferrer">
            Open the Anthropic sign-in page
          </a>
        </p>
        {/* The full URL as text as well as a link: the browser showing this
            page is often not the one signed in to Anthropic, and on a remote
            container it may not be able to reach the page at all. */}
        <p className="mono mt-2 break-all text-xs text-ink-faint">{linkUrl}</p>
        <Field
          className="mt-4"
          label="Code"
          htmlFor="claude-auth-code"
          error={flowError}
        >
          <Input
            id="claude-auth-code"
            value={code}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
      </Sheet>

      <Sheet
        open={confirmOut}
        onDismiss={() => setConfirmOut(false)}
        title="Sign out of Claude?"
        confirmLabel="Sign out"
        confirmVariant="danger"
        busy={busy}
        onConfirm={() => void out()}
      >
        <p>
          Every run still working will end on{" "}
          <span className="mono">Not logged in</span>, and no new run can start
          until this is signed in again. This does not end your session on this
          page.
        </p>
      </Sheet>
    </EnvRow>
  );
}

/**
 * What confines a tool call, in the manner of the two rows above it: presence
 * rather than content, and the one fact that changes what an agent can reach.
 *
 * Four readings and not a switch, because two of them are the ways a sandbox
 * lies about itself. `empty` is the loudest of the four and is the only one
 * drawn as a fault: a policy switched on that names nothing runs every command
 * unwrapped, so it is an install that believes it is confined and is not.
 * `unknown` is a policy file this app could not read, and it is deliberately
 * neutral rather than reassuring — the same call the meters make against a
 * window with no figure in it, where a confident zero is the failure.
 *
 * The sentence is the server's, not this page's. It is the same one the boot
 * line prints, and a second copy written here is a second thing to keep honest.
 */
function SandboxRow({ sandbox }: { sandbox: unknown }) {
  const read =
    typeof sandbox === "object" && sandbox !== null
      ? (sandbox as Partial<SandboxDTO>)
      : null;
  // A payload with no sandbox key at all is a server older than this row, and
  // saying nothing beats inventing a reading for it.
  if (!read?.state) return null;

  const state = read.state;
  const TONE: Record<SandboxStateDTO, BadgeTone> = {
    none: "warn",
    on: "ok",
    empty: "danger",
    unknown: "neutral",
  };
  const WORD: Record<SandboxStateDTO, string> = {
    none: "none",
    on: "on",
    empty: "enabled but empty",
    unknown: "unknown",
  };

  return (
    <EnvRow label="Sandbox">
      <Badge tone={TONE[state]}>{WORD[state]}</Badge>{" "}
      <span>{read.detail}</span>
    </EnvRow>
  );
}

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
  /**
   * Which settings this install has moved off the value the build ships, and
   * which of them had when the page loaded. Two states rather than one, and
   * that is the whole point of the second.
   *
   * `Disclosure` is uncontrolled so that a fold cannot close under the reader,
   * and a fold snapping shut in the same frame as a successful Save — because
   * the value it holds has just become the default again — is that failure in
   * its most confusing form. So the open state is decided once, from the first
   * answer, and the badge follows the latest one. The badge may change; the
   * fold may not.
   */
  const [movedKeys, setMovedKeys] = useState<string[]>([]);
  const [movedAtLoad, setMovedAtLoad] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cal, setCal] = useState<CalibrateResponse | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);
  /** Non-null only while the globs field is being edited. */
  const [copyGlobsText, setCopyGlobsText] = useState<string | null>(null);
  const [verifyToolsText, setVerifyToolsText] = useState<string | null>(null);
  /** The same, for the per-repository overrides beneath it. */
  const [copyGlobsByRepoText, setCopyGlobsByRepoText] = useState<string | null>(null);
  // The registry, and the definitions this app did not write. Both are needed
  // for one row: the picker offers the first, and the sentence beside it has to
  // declare the second, because `--agents` merges with what the CLI finds on
  // disk rather than replacing it and `--agent` resolves against the merged
  // set — so the registry is a part of what is in play and never the whole of
  // it, whichever of them a run is started as.
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [ambientAgents, setAmbientAgents] = useState<AmbientAgentDTO[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  // What the append-only stores currently hold. Its own read because it walks
  // directories, and its own failure state because a missing figure must read
  // as "not measured" rather than as a store with nothing in it.
  const [storage, setStorage] = useState<StorageReportDTO | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  // Plugins are not part of the settings form: they are switched on one at a
  // time against their own route, so nothing here goes through `patch()` and
  // Save never touches them. See `PluginDTO` for why that separation exists.
  const [plugins, setPlugins] = useState<PluginsReportDTO | null>(null);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  // The vault scan, on its own read for `storage`'s reason: it walks a
  // directory tree, and a figure that could not be measured has to read as
  // absent rather than as zero.
  const [knowledge, setKnowledge] = useState<KnowledgeStatusDTO | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  // The vault skill is a switch of the plugins' kind rather than a settings
  // field: its own row on its own route, saved as it is pressed. Its error is
  // separate from `knowledgeError` because they are two different failures —
  // one is a vault that could not be read, the other a switch that was refused.
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const standalone = useStandalone();
  const [sectionHash, setSectionHash] = useSectionHash();

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
      const moved: string[] = Array.isArray(json.nonDefaultKeys)
        ? json.nonDefaultKeys
        : [];
      setMovedKeys(moved);
      // Only the first answer decides which folds open, and `load` is called
      // again by Try again — a retry after a failed load is still this page's
      // first sight of the settings, and nothing has been rendered from the
      // one before it.
      setMovedAtLoad((prev) => prev ?? moved);
    } catch (err) {
      setLoadError(
        `The server could not be reached — ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadPlugins = useCallback(async () => {
    const res = await jsonRequest<PluginsReportDTO>("/api/plugins");
    if (!res.ok) {
      setPluginsError(actionFailureMessage(res, "The plugin list could not be read."));
      return;
    }
    setPluginsError(null);
    setPlugins(res.data);
  }, []);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const togglePlugin = useCallback(
    async (dir: string, enabled: boolean) => {
      setPluginBusy(dir);
      const res = await jsonRequest<PluginsReportDTO>("/api/plugins", {
        method: "POST",
        body: { path: dir, enabled },
      });
      setPluginBusy(null);
      if (!res.ok) {
        // The refusal names the directory, so it is shown rather than folded
        // into a generic failure: "outside a workspace mount" and "no
        // plugin.json" are two different things for the operator to fix.
        setPluginsError(
          actionFailureMessage(res, `${enabled ? "Enabling" : "Disabling"} the plugin failed.`),
        );
        return;
      }
      setPluginsError(null);
      // Answered with the whole list rather than the one row, so a second tab's
      // change shows up here on the next press instead of being overwritten.
      setPlugins(res.data);
    },
    [],
  );

  const loadKnowledge = useCallback(async () => {
    const res = await jsonRequest<KnowledgeStatusDTO>("/api/knowledge/status");
    if (!res.ok) {
      setKnowledgeError(actionFailureMessage(res, "The knowledge base could not be read."));
      return;
    }
    setKnowledgeError(null);
    setKnowledge(res.data);
  }, []);

  useEffect(() => {
    void loadKnowledge();
  }, [loadKnowledge]);

  const toggleSkill = useCallback(async (enabled: boolean) => {
    setSkillBusy(true);
    const res = await jsonRequest<{ skillEnabled: boolean }>("/api/knowledge/skill", {
      method: "POST",
      body: { enabled },
    });
    setSkillBusy(false);
    if (!res.ok) {
      setSkillError(
        actionFailureMessage(res, `${enabled ? "Enabling" : "Disabling"} the skill failed.`),
      );
      return;
    }
    setSkillError(null);
    // Patched in place rather than by reloading the status, which would walk
    // the whole vault again to answer a question about one boolean.
    setKnowledge((prev) => (prev ? { ...prev, skillEnabled: res.data.skillEnabled } : prev));
  }, []);

  useEffect(() => {
    fetch("/api/storage", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`the server answered ${r.status}`);
        setStorage((await r.json()) as StorageReportDTO);
      })
      .catch((err: unknown) =>
        setStorageError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

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
  const effective = useMemo(() => {
    if (s === null) return null;
    let out = s;
    if (copyGlobsText !== null) {
      out = { ...out, isolationCopyGlobs: parseGlobs(copyGlobsText) };
    }
    if (copyGlobsByRepoText !== null) {
      out = { ...out, isolationCopyGlobsByRepo: parseGlobsByRepo(copyGlobsByRepoText) };
    }
    if (verifyToolsText !== null) {
      out = { ...out, resolveVerifyTools: parseGlobs(verifyToolsText) };
    }
    return out;
  }, [s, copyGlobsText, copyGlobsByRepoText, verifyToolsText]);

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

  /**
   * The one thing standing between an unsaved page and a closed tab.
   *
   * Registered only while there is something to lose, and torn down the moment
   * there is not: a listener that outlives the dirty state prompts on a page
   * with nothing on it, which teaches the operator to dismiss the dialog
   * without reading it — and the next one they dismiss is the real one.
   *
   * `preventDefault` is the specified way to ask for the dialog and
   * `returnValue` is what the engines that predate it read; both, because
   * either alone is silently a no-op in a browser somebody uses. Neither can
   * choose the wording — the browser writes it — and neither fires on a
   * *client-side* navigation, so a press on the sidebar still leaves the same
   * way it always did. The per-field rails and the bar's own unsaved count are
   * what cover that; blocking the router would mean the shell holding this
   * page's state, which is a bigger change than the one this closes.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Rebuilt on every keystroke *and* on every edit, not indexed once: several
  // descriptions interpolate the value beside them, and a handful of rows only
  // exist while the switch above them is on — so a corpus read at mount would
  // answer for a page that has since changed. Sixty `textContent` reads is
  // nothing beside the fetch this page already does on load.
  const [fieldQuery, setFieldQuery] = useState("");
  const [fieldHits, setFieldHits] = useState<FieldHit[]>([]);
  useEffect(() => {
    const query = fieldQuery.trim().toLowerCase();
    if (query === "") {
      // The same empty array back rather than a fresh one: `effective` changes
      // on every keystroke in every field on this page, and a new identity here
      // would re-render the whole of it a second time for a search nobody is
      // running.
      setFieldHits((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    setFieldHits(findFields(query));
  }, [fieldQuery, effective]);

  /**
   * Take the reader to the field, which is the whole point of the search.
   *
   * Focus first with `preventScroll`, then place it: focusing a control scrolls
   * it into view by itself, and the two would fight over where it lands. The
   * ring the focus draws is the app's one focus treatment and so the only
   * highlight this needs. The chip is set directly rather than by moving the
   * hash, because navigating to the section anchor would scroll to the section
   * heading — undoing the scroll that just landed on the field.
   */
  const goToField = useCallback(
    (hit: FieldHit) => {
      // The four prompts are behind folds, and `textContent` reads a closed one
      // — so a match can be somewhere the reader cannot see. Set open rather
      // than leaving them at the summary: `Disclosure` passes `open` only when
      // a caller controls it, and these four pass `defaultOpen`, so React
      // writes the attribute when that prop changes and never again. Nothing
      // reads the DOM back, so this cannot disagree with any state.
      const fold = hit.el.closest("details");
      if (fold && !fold.open) fold.open = true;
      const control = hit.controlId
        ? document.getElementById(hit.controlId)
        : null;
      control?.focus({ preventScroll: true });
      hit.el.scrollIntoView({ block: "center" });
      setSectionHash(hit.sectionId);
    },
    [setSectionHash],
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
      // The badge, never the open state: a Save that returns a setting to its
      // shipped value drops the count and leaves the fold where the reader
      // put it.
      if (Array.isArray(json.nonDefaultKeys)) setMovedKeys(json.nonDefaultKeys);
      setCopyGlobsText(null);
      setSaved(true);
      setSaveError(null);
      // The figures are a reading of whatever mount is now named, so a Save
      // that repointed the vault must not leave the previous one's counts on
      // screen under the new folder's name.
      void loadKnowledge();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [effective, loadKnowledge]);

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
  // Each refusal names where its control is, because one of them is now behind
  // a fold and a sentence about a control the reader cannot see is a sentence
  // they cannot act on. Copy rather than a fold that opens itself: `Disclosure`
  // is uncontrolled on purpose, and a fold springing open in answer to what was
  // typed in it is the "nothing switches on its own" failure. In practice a
  // stored override that trips this is not the shipped default, so the fold is
  // already open on load; this covers the operator who typed it and closed it.
  const blocked = noTerminus
    ? "The default guard set has neither a work-cycle limit nor a time limit."
    : resetTooFarAhead
      ? "The 5-hour reset override is more than five hours from now — Subscription limits, under “When a window turns over”."
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
  /**
   * How many of a fold's settings this install has moved off the shipped
   * default, and whether it had any when the page loaded.
   *
   * Deliberately a different question from `isEdited`, which is "differs from
   * what the server last confirmed" and draws the rail in the gutter. One says
   * you have typed something you have not saved; this one says the stored value
   * is not the one that shipped. A fold needs the second — a control at a
   * number nobody chose is what makes hiding it a risk — and the rail inside it
   * still says the first.
   *
   * `undefined` rather than 0, per `Disclosure`: `(0)` says there is nothing
   * behind the fold, and there is — a prompt, or three window fields.
   */
  const movedCount = (paths: readonly string[]) => {
    const n = paths.filter((p) => movedKeys.includes(p)).length;
    return n === 0 ? undefined : n;
  };
  const openAtLoad = (paths: readonly string[]) =>
    paths.some((p) => movedAtLoad?.includes(p) ?? false);
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
          key and the GitHub token, and nothing here asks for the values.

          The measure is stated per *column* rather than for the box: 70ch is
          one readable line, and at `sm` this is two columns each carrying a
          96px label beside its value, so the same figure left 152px for the
          value and broke "the API / account page stays / empty" over three
          lines with 1700px of empty pane beside it. */}
      <dl className="mb-5 grid max-w-[70ch] gap-x-8 gap-y-1.5 text-xs sm:max-w-[104ch] sm:grid-cols-2">
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
            <>
              <Badge tone="ok">configured</Badge>{" "}
              {/* How wide it is, which is the fact that changes with the number
                  of repositories: one install-wide token authenticates an
                  unattended agent against every repository it reaches, not
                  only the one it was started in. */}
              <span>{githubScopeNote(env.githubTokens)}</span>
            </>
          ) : (
            <>
              <Badge tone="warn">not set</Badge>{" "}
              <span>runs cannot push or use gh</span>
            </>
          )}
        </EnvRow>
        <SandboxRow sandbox={env.sandbox} />
        <EnvRow label="Sign-in">
          {env.authEnabled ? (
            <SignOut sessions={Number(env.activeSessions ?? 0)} />
          ) : (
            <>
              <Badge tone="danger">no token</Badge>{" "}
              <span>every route is open</span>
            </>
          )}
        </EnvRow>
        <ClaudeAccount />
        <FailedSignIns summary={env.signIn} />
      </dl>

      {/* Above the chips because it answers the same question they do — where
          is the thing I want — and because the chips only answer it for
          somebody who remembers which of nine sections holds a field. Nothing
          here collapses, reorders or hides a section: the search is a route to
          a field, not a second arrangement of the page. */}
      <div className="mb-4 max-w-[32rem]">
        <Field
          label="Find a setting"
          htmlFor="settings-search"
          hint="Matches names and descriptions, never the values in them"
        >
          <Input
            id="settings-search"
            type="search"
            placeholder="weekly, plugin, retention…"
            value={fieldQuery}
            onChange={(e) => setFieldQuery(e.target.value)}
          />
        </Field>

        {/* The results appear under the field without anything moving focus,
            so a reader who cannot see them has no signal that typing did
            anything. Same sr-only shape as the runs history's own filter. */}
        <p className="sr-only" aria-live="polite">
          {fieldQuery.trim() === ""
            ? ""
            : `${fieldHits.length} field${fieldHits.length === 1 ? "" : "s"} match`}
        </p>

        {fieldQuery.trim() !== "" &&
          (fieldHits.length === 0 ? (
            <p className="px-1 text-xs text-ink-faint">
              No field’s name or description matches that.
            </p>
          ) : (
            <ListGroup
              footnote={
                fieldHits.length > MAX_FIELD_HITS
                  ? `${MAX_FIELD_HITS} of ${fieldHits.length} matches — add a word to narrow it`
                  : undefined
              }
            >
              {fieldHits.slice(0, MAX_FIELD_HITS).map((hit) => (
                <button
                  key={`${hit.sectionId}-${hit.name}`}
                  type="button"
                  onClick={() => goToField(hit)}
                  // The row is the control, so it takes the 44px target below
                  // the breakpoint that every other tappable row in this app
                  // does. Not a `ListRow`: that one is deliberately inert and
                  // has no interaction states, and a result that cannot be
                  // pressed is not a result. Its ends are rounded here rather
                  // than clipped by the box, because `ListGroup` deliberately
                  // does not hide its overflow and a pressed row's fill would
                  // otherwise square off the corner it sits in.
                  className="ui-transition flex w-full min-h-[var(--control-h-lg)] max-md:min-h-11 items-center justify-between gap-3 px-3.5 py-2 text-left text-sm text-ink first:rounded-t-lg last:rounded-b-lg hover:bg-fill-hover active:bg-fill-active"
                >
                  <span className="min-w-0 truncate">{hit.name}</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {hit.sectionLabel}
                  </span>
                </button>
              ))}
            </ListGroup>
          ))}
      </div>

      {/* Plain anchors rather than `ButtonLink`: the pane is its own scroll
          region and the browser's native hash handling is what scrolls it, so
          this stays out of the router. Bezeled rather than the recessed chips
          it was — `--bg-inset` is the well a text field sits in, and a control
          drawn in it reads as the same object at a glance. */}
      <nav
        aria-label="Settings sections"
        className="mb-6 flex flex-wrap gap-1.5 border-b border-line pb-4"
      >
        {SECTIONS.map((sec) => {
          // An empty hash is the top of the pane, and the top of the pane is
          // the first section — so that is the chip standing. Without this the
          // opening state of the page, which includes the server render and
          // every arrival that did not come through a chip, is the one state in
          // which *no* chip is current: a map that says you are nowhere.
          // Resolved here rather than seeded into `useSectionHash` so the hook
          // keeps reporting the location rather than a guess about it, and so
          // the server and the first paint read the same empty string and pick
          // the same chip — a hydration mismatch here would be a louder bug
          // than the missing fill it fixes.
          const current = sec.id === (sectionHash || SECTIONS[0].id);
          return (
            <a
              key={sec.id}
              href={`#${sec.id}`}
              onClick={() => setSectionHash(sec.id)}
              aria-current={current ? "true" : undefined}
              className={`ui-transition inline-flex min-h-[var(--control-h)] max-md:min-h-11 items-center rounded-sm border px-2.5 text-xs font-medium no-underline shadow-e1 hover:no-underline ${
                CHIP[current ? "current" : "plain"]
              }`}
            >
              {sec.label}
            </a>
          );
        })}
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
            // The group label was the only thing telling these two apart from
            // the cost ceilings above, and a group label is not on screen from
            // inside the field it names.
            label="5-hour token ceiling"
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
            label="Weekly token ceiling"
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

        {/* Folded: three hand-corrections for a boundary that could not be
            observed, typed once if ever. The group's own label is gone rather
            than repeated under a summary that is the same three words — the
            summary is where that label now is. */}
        <Disclosure
          className="mt-4"
          summaryClassName={FOLD_SUMMARY}
          summary="When a window turns over"
          count={movedCount(WINDOW_TURNOVER_KEYS)}
          defaultOpen={openAtLoad(WINDOW_TURNOVER_KEYS)}
        >
          <ListGroup className={FOLD_BODY}>
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
        </Disclosure>

        {/* Folded as evidence rather than as settings: this holds a tool and
            what it found, and not one stored key — so it takes neither the
            open-by-default rule nor a count, which would be permanently 0 and
            say there is nothing behind it.

            The group keeps its own label, unlike the two folds that are
            settings: `Where a ceiling can come from` says something the
            summary does not, and deleting redundancy is not deleting a
            second fact. */}
        <Disclosure
          className="mt-4"
          summaryClassName={FOLD_SUMMARY}
          summary="Estimate a ceiling from your own history"
        >
          <ListGroup
            className={FOLD_BODY}
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

              <dl className="mt-3.5 grid max-w-[70ch] gap-x-8 gap-y-1.5 text-xs sm:max-w-[104ch] sm:grid-cols-2">
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
        </Disclosure>
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
              this decides who a run *is* and never what it is allowed to do.
              Beside the model for a second reason since `--agent`: a saved
              agent's model is the session's, reached only where the field above
              is blank. It is an id, so an operator who fixes their reviewer's
              prompt gets the fixed one on the next run. */}
          <SettingRow
            htmlFor="agent"
            edited={isEdited("defaultAgentId")}
            label="Default agent"
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
                <option value="">No agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.usable}>
                    {a.name}
                    {a.usable ? "" : " — incomplete"}
                  </option>
                ))}
                {/* A default whose agent has been deleted since it was saved.
                    Kept as an option rather than silently reverting the picker
                    to "No agent", which would look like the setting had never
                    been made — and Save then refuses it by name. */}
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
            description="Work cycles only — reviews, chat turns and workflow blocks have their own budget below. Each run carries its own spending limit, so this multiplies the worst case: three runs at $5 can spend $15. A run over the limit waits rather than being refused, and queued or parked runs do not count against it"
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

          <SettingRow
            htmlFor="concassist"
            edited={isEdited("maxConcurrentAssists")}
            label="Other Claude processes at the same time"
            description="A review, a merge-conflict resolution, an orchestrator chat turn and a workflow orchestrator block's deciding turn share this one budget. The first three are refused while it is full, and say so; a workflow block waits for a slot instead. Together with the limit above, this is the most Claude processes the container will ever carry"
          >
            <div className="w-32">
              <Input
                id="concassist"
                type="number"
                min={1}
                className="tabular-nums"
                unit="at once"
                placeholder="No limit"
                value={effective.maxConcurrentAssists ?? ""}
                onChange={(e) =>
                  patch({
                    maxConcurrentAssists: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </div>
          </SettingRow>
        </ListGroup>

        {/* Folded: four settings decided once per repository. The group's label
            is gone rather than repeated under a summary that is the same two
            words. */}
        <Disclosure
          className="mt-4"
          summaryClassName={FOLD_SUMMARY}
          summary="Isolated runs"
          count={movedCount(ISOLATED_RUN_KEYS)}
          defaultOpen={openAtLoad(ISOLATED_RUN_KEYS)}
        >
          <ListGroup className={FOLD_BODY}>
            <SettingRow
              htmlFor="copyglobs"
              edited={isEdited("isolationCopyGlobs")}
              label="Files copied into a new checkout"
              description={
                <>
                  A fresh checkout holds committed work only, so a gitignored
                  config file has to be copied in — prefix a pattern with{" "}
                  <span className="mono">!</span> to exclude it, and write a path
                  (<span className="mono">apps/web/.env</span>) to reach one below
                  the repository root. Dependencies are not copied; the agent
                  installs them
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
              htmlFor="copyglobsbyrepo"
              edited={isEdited("isolationCopyGlobsByRepo")}
              label="Per-repository overrides"
              description={
                <>
                  One <span className="mono">folder: patterns</span> line per
                  repository, replacing the list above for that folder and
                  everything under it. The folder is written as the picker shows
                  it (<span className="mono">acme/web</span>) or absolute. A line
                  with no patterns copies nothing
                </>
              }
            >
              <div className="w-72">
                <Textarea
                  id="copyglobsbyrepo"
                  rows={3}
                  placeholder={"acme/web: apps/web/.env.local\nacme/api: local.settings.json"}
                  value={
                    copyGlobsByRepoText ??
                    formatGlobsByRepo(effective.isolationCopyGlobsByRepo)
                  }
                  onChange={(e) => setCopyGlobsByRepoText(e.target.value)}
                  onBlur={() => {
                    if (copyGlobsByRepoText === null) return;
                    patch({
                      isolationCopyGlobsByRepo: parseGlobsByRepo(copyGlobsByRepoText),
                    });
                    setCopyGlobsByRepoText(null);
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

            <SettingRow
              htmlFor="verifytools"
              edited={isEdited("resolveVerifyTools")}
              label="Checks a conflict resolution may run"
              description={
                <>
                  When Claude resolves a merge conflict it can edit the files and
                  run nothing, so the merge is judged by reading it. Name the
                  commands it may run and it will check its own work — write them
                  as tool patterns (
                  <span className="mono">Bash(npm run typecheck:*)</span>). Left
                  blank it runs none, which is the safe answer for a repository
                  whose checks need a dependency tree the resolver does not have
                </>
              }
            >
              {/* Raw text while editing, for the reason the globs field is. */}
              <div className="w-72">
                <Input
                  id="verifytools"
                  value={verifyToolsText ?? effective.resolveVerifyTools.join(", ")}
                  onChange={(e) => setVerifyToolsText(e.target.value)}
                  onBlur={() => {
                    if (verifyToolsText === null) return;
                    patch({ resolveVerifyTools: parseGlobs(verifyToolsText) });
                    setVerifyToolsText(null);
                  }}
                />
              </div>
            </SettingRow>
          </ListGroup>
        </Disclosure>
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

        {/* One group of two rather than two groups of one, each labelled with a
            longer spelling of the row inside it. `limits` and not `ceilings`:
            both rows are a dollar cap on a unit of work — a chat turn and this
            install — which is what a limit is here, where a ceiling is an
            estimate of a subscription window and a guard is a threshold on one. */}
        <ListGroup className="mt-4" label="Spending limits">
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

          <SettingRow
            htmlFor="installbudget"
            edited={isEdited("installDailyCostLimitUSD")}
            label="Install limit, rolling 24 hours"
            description="Every other limit here bounds one run, one workflow or one chat turn — this is the only one that bounds the total. Once it is reached, no new run, workflow, orchestrator turn or chat message starts until spend ages out of the window. A run still going, or one that finished inside it, counts its whole spend"
          >
            <div className="w-36">
              <Input
                id="installbudget"
                type="number"
                min={0}
                step="10"
                className="tabular-nums"
                unit="USD"
                placeholder="No limit"
                value={effective.installDailyCostLimitUSD ?? ""}
                onChange={(e) =>
                  patch({
                    installDailyCostLimitUSD:
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

      {/* Three ways of spending fewer tokens on the same work, all of which
          change what an agent *does* rather than what it is told. Two of them
          are unmeasured optimisations and ship off on that ground. The first is
          not in that category and its copy has to say so: it replaced
          `--autocompact`, so it is the only thing bounding a long cycle, and an
          operator reading this row as "an optimisation I can ignore" would be
          leaving a cycle able to run to the model's whole window. */}
      <Section
        id="tokens"
        title="Token use"
        lede="Most of what a run costs is carrying what it has already read, not writing anything new. These three try to carry less — the first also decides what happens when a single work cycle gets long, so read that one before leaving it off."
      >
        <ListGroup>
          <SettingRow
            htmlFor="ctxprune"
            edited={isEdited("contextPruning")}
            label="Prune the conversation between work cycles"
            description="Each work cycle carries the last one's whole conversation, and most of that is tool output nobody will read again. This removes it at the moment between cycles, where it is free — the next cycle was going to re-send everything anyway. It also ends a cycle early once its conversation gets long, prunes it, and carries on. That early ending is now the only thing stopping a single long cycle from growing without limit, so switching this off leaves nothing doing that job"
          >
            <Switch
              id="ctxprune"
              checked={effective.contextPruning}
              onChange={(v) => patch({ contextPruning: v })}
            />
          </SettingRow>

          <SettingRow
            edited={isEdited("contextPruningStrictness")}
            label="How much it takes out"
            description={PRUNE_TIER_CONSEQUENCE[effective.contextPruningStrictness]}
          >
            <SegmentedControl
              options={PRUNE_TIER_OPTIONS}
              value={effective.contextPruningStrictness}
              onChange={(v) => patch({ contextPruningStrictness: v })}
              label="How much it takes out"
            />
          </SettingRow>

          <SettingRow
            edited={isEdited("contextPruningEngine")}
            label="How it takes it out"
            description={PRUNE_ENGINE_CONSEQUENCE[effective.contextPruningEngine]}
          >
            <SegmentedControl
              options={PRUNE_ENGINE_OPTIONS}
              value={effective.contextPruningEngine}
              onChange={(v) => patch({ contextPruningEngine: v })}
              label="How it takes it out"
            />
          </SettingRow>

          {/* Only under Fork. The number is meaningless to the other engine,
              and a control that does nothing where it sits is worse than one
              that is not there — an operator would set it and wait. */}
          {effective.contextPruningEngine === "winnow" && (
            <SettingRow
              htmlFor="forkcoldage"
              edited={isEdited("contextPruningForkMinColdAge")}
              label="Quiet period a conversation needs before forking it"
              description={
                <>
                  The tool will not cut a conversation whose last request is
                  newer than this, because the answer may still be cached and
                  the cut would then cost more than it saves. Read on before
                  setting it, because it does not behave like a dial: a fork can
                  only happen in the moment between two work cycles, and there
                  the last request is always a fraction of a second old. So{" "}
                  <strong>
                    0 forks and every other value never forks
                  </strong>{" "}
                  — blank included, which falls back to the tool&rsquo;s own
                  hour. It ships at 0 on the argument that the handover is the
                  one moment the edit is free, because the next cycle rewrites
                  the conversation anyway. That is argued and not yet measured
                  here, and raising this is how you disagree — but raise it
                  meaning &ldquo;off&rdquo;, not meaning &ldquo;later&rdquo;.
                  Whatever is in force is recorded against every fork, so the
                  bet is on the record rather than in someone&rsquo;s memory
                </>
              }
            >
              <div className="w-36">
                <Input
                  id="forkcoldage"
                  type="number"
                  min={0}
                  className="tabular-nums"
                  unit="seconds"
                  placeholder="3600"
                  value={effective.contextPruningForkMinColdAge ?? ""}
                  onChange={(e) =>
                    patch({
                      contextPruningForkMinColdAge: e.target.value
                        ? Number(e.target.value)
                        : null,
                    })
                  }
                />
              </div>
            </SettingRow>
          )}

          <SettingRow
            htmlFor="readguard"
            edited={isEdited("readGuard")}
            label="Refuse a file the agent has already read"
            description="A file read once is charged again on every later turn of the same work cycle, so reading it twice is paid for twice over. This stops a second identical read of a file nothing has changed since, and tells the agent to use what it has. It can always read a part of the file — offset and limit are never refused — so nothing it needs goes out of reach"
          >
            <Switch
              id="readguard"
              checked={effective.readGuard}
              onChange={(v) => patch({ readGuard: v })}
            />
          </SettingRow>

          <SettingRow
            htmlFor="readcap"
            edited={isEdited("readGuardMaxTokens")}
            label="Largest file an agent may read whole"
            description={
              <>
                Past this, the agent is told to search the file or read the part
                it wants instead. Only applies while the setting above is on,
                and only below about {CLI_MAX_READ_TOKENS / 1000}k — Claude Code
                already refuses a whole read past that on its own, so a larger
                number here changes nothing. Blank leaves file size alone and
                keeps only the repeat check
              </>
            }
          >
            <div className="w-36">
              <Input
                id="readcap"
                type="number"
                min={500}
                max={CLI_MAX_READ_TOKENS - 1}
                className="tabular-nums"
                unit="tokens"
                placeholder="No limit"
                value={effective.readGuardMaxTokens ?? ""}
                onChange={(e) =>
                  patch({
                    readGuardMaxTokens: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="freshstart"
            edited={isEdited("freshStartContextTokens")}
            label="Start a work cycle over once the conversation gets this long"
            description="Normally each work cycle carries on the last one's conversation, so a long run pays for everything said so far on every turn it takes. Past this, the next cycle starts a new conversation: it is sent the task again and pointed at the work already on disk. The saving is real and so is the cost — the agent has to work out again what it had just decided, and this app cannot tell you which was bigger. Blank keeps today's behaviour"
          >
            <div className="w-36">
              <Input
                id="freshstart"
                type="number"
                min={20000}
                step={10000}
                className="tabular-nums"
                unit="tokens"
                placeholder="Never"
                value={effective.freshStartContextTokens ?? ""}
                onChange={(e) =>
                  patch({
                    freshStartContextTokens: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </div>
          </SettingRow>
        </ListGroup>
      </Section>

      <Section
        id="plugins"
        title="Plugins"
        lede="Claude Code plugins found in your mounted folders. Switching one on adds it to every work cycle this app starts, from the next cycle onward — including runs already in flight. These are saved as you press them, not on Save."
      >
        {pluginsError && (
          <Notice tone="danger" className="mb-4">
            {pluginsError}
          </Notice>
        )}

        {plugins && plugins.problems.length > 0 && (
          <Notice tone="warn" className="mb-4">
            <ul className="list-disc pl-4">
              {plugins.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        )}

        {plugins === null && !pluginsError ? (
          <Empty>Looking for plugins in the mounted folders…</Empty>
        ) : plugins && plugins.plugins.length === 0 ? (
          <Empty>
            No plugins in the mounted folders. A plugin is any directory holding a{" "}
            <code>.claude-plugin/plugin.json</code>; clone one into a mounted folder and it
            appears here.
          </Empty>
        ) : (
          <ListGroup
            label="Found in your mounts"
            footnote="A plugin's hooks run inside the container with the same access an agent has. Enable ones you would run yourself"
          >
            {plugins?.plugins.map((p) => (
              <SettingRow
                key={p.path}
                htmlFor={`plugin-${p.path}`}
                label={
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    {p.name}
                    {p.version && <Badge tone="neutral">{p.version}</Badge>}
                    {p.components.map((c) => (
                      <Badge key={c} tone="neutral">
                        {c}
                      </Badge>
                    ))}
                  </span>
                }
                description={
                  <>
                    {p.description && <span className="block">{p.description}</span>}
                    <span className="block font-mono text-2xs text-ink-muted">
                      {p.mountLabel} / {p.relPath}
                    </span>
                  </>
                }
              >
                <Switch
                  id={`plugin-${p.path}`}
                  checked={p.enabled}
                  disabled={pluginBusy === p.path}
                  onChange={(v) => void togglePlugin(p.path, v)}
                />
              </SettingRow>
            ))}
          </ListGroup>
        )}
      </Section>

      <Section
        id="knowledge"
        title="Knowledge base"
        lede="A folder of markdown notes, read as a graph of the links between them. It is one of the folders already mounted below — naming it here lets this app read it, and nothing here writes to it."
      >
        <KnowledgeFigures report={knowledge} error={knowledgeError} />

        <ListGroup
          className="mt-4"
          label="Where the vault is"
          footnote="Mounted folders come from your .env and are fixed when the container starts, so this picks one rather than adding one"
        >
          <SettingRow
            htmlFor="kbmount"
            edited={isEdited("knowledgeBaseMountId")}
            label="Folder"
            description="Which mounted folder holds the notes"
          >
            <div className="w-64">
              <Select
                id="kbmount"
                value={effective.knowledgeBaseMountId ?? ""}
                onChange={(e) =>
                  patch({ knowledgeBaseMountId: e.target.value || null })
                }
              >
                <option value="">No knowledge base</option>
                {workspaceMounts.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {/* A mount that has gone since this was saved. Kept as an
                    option rather than reverting the picker to "No knowledge
                    base", which would read as a setting nobody ever made —
                    and Save then refuses it by id. */}
                {effective.knowledgeBaseMountId !== null &&
                  !workspaceMounts.some((m) => m.id === effective.knowledgeBaseMountId) && (
                    <option value={effective.knowledgeBaseMountId}>
                      Folder no longer mounted
                    </option>
                  )}
              </Select>
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="kbsub"
            edited={isEdited("knowledgeBaseSubpath")}
            label="Folder inside it"
            description="Leave blank for the whole folder. A vault is usually one directory in a mount, and walking its parent files every unrelated note beside it as an orphan"
          >
            <div className="w-64">
              <Input
                id="kbsub"
                placeholder="Knowledge Vault"
                value={effective.knowledgeBaseSubpath}
                onChange={(e) => patch({ knowledgeBaseSubpath: e.target.value })}
              />
            </div>
          </SettingRow>
        </ListGroup>

        {skillError && (
          <Notice tone="danger" className="mt-4">
            {skillError}
          </Notice>
        )}

        <ListGroup
          className="mt-4"
          label="What runs may do with it"
          footnote="The skill is handed to each work cycle as it starts, so switching it reaches runs already in flight. Saved as you press it, not on Save"
        >
          <SettingRow
            htmlFor="kbskill"
            label="Vault lookup skill"
            description={
              <>
                <span className="block">
                  Every run this app starts can search these notes instead of answering
                  from its own knowledge, and quotes each claim&rsquo;s confidence grade
                  and note. Nothing gains write access to the vault.
                </span>
                <span className="block text-2xs text-ink-muted">
                  {!knowledge?.configured
                    ? "Pick a folder above first — there is nothing for the skill to look in"
                    : knowledge.skillSearchScript
                      ? `Ranked search: ${knowledge.skillSearchScript}`
                      : "No ranked search in this vault, so the skill greps — and says so in its answers"}
                </span>
              </>
            }
          >
            <Switch
              id="kbskill"
              checked={knowledge?.skillEnabled ?? false}
              // Refused at the door as well as here: a switch reading as on
              // with no vault behind it would hand every cycle nothing at all,
              // silently.
              disabled={skillBusy || knowledge === null || !knowledge.configured}
              onChange={(v) => void toggleSkill(v)}
            />
          </SettingRow>
        </ListGroup>
      </Section>

      <Section
        id="storage"
        title="Storage"
        lede="Three stores grow with the work rather than with these settings. A run's own record — its spend, its cycles, how it ended — is never discarded; what a horizon below bounds is the evidence behind it."
      >
        <StorageFigures report={storage} error={storageError} />

        <ListGroup
          className="mt-4"
          label="Retention"
          footnote="Blank keeps everything for ever. A run that has not finished is never swept, whatever the horizon says"
        >
          <SettingRow
            htmlFor="evret"
            edited={isEdited("eventRetentionDays")}
            label="Keep a finished run's log for"
            description="Every tool call, every reply and every line of an agent's build output is a row. The run itself stays on the list with its spend and its stop reason — this discards the log behind it"
          >
            <div className="w-32">
              <Input
                id="evret"
                type="number"
                min={1}
                className="tabular-nums"
                unit="days"
                value={numOrEmpty(effective.eventRetentionDays)}
                onChange={(e) =>
                  patch({
                    eventRetentionDays:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="coret"
            edited={isEdited("checkoutRetentionDays")}
            label="Reclaim an idle checkout after"
            description="A finished run's worktree, once its branch is landed or has no commits of its own. The branch and its commits stay; what goes is the directory, which git rebuilds in seconds — with the installed dependencies that are most of its size"
          >
            <div className="w-32">
              <Input
                id="coret"
                type="number"
                min={1}
                className="tabular-nums"
                unit="days"
                value={numOrEmpty(effective.checkoutRetentionDays)}
                onChange={(e) =>
                  patch({
                    checkoutRetentionDays:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </SettingRow>

          <SettingRow
            htmlFor="trret"
            edited={isEdited("transcriptRetentionDays")}
            label="Keep session transcripts for"
            description="Claude Code writes one per session into your home directory, and nothing else prunes them. Pruning one ends any chance of resuming that conversation, and shortens the calendar history on the dashboard — which says which of its buckets are affected"
          >
            <div className="w-32">
              <Input
                id="trret"
                type="number"
                min={1}
                className="tabular-nums"
                unit="days"
                value={numOrEmpty(effective.transcriptRetentionDays)}
                onChange={(e) =>
                  patch({
                    transcriptRetentionDays:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </SettingRow>
        </ListGroup>
      </Section>

      <Section
        id="prompts"
        title="Prompts"
        lede="What this app says to Claude, over and above the task you type. Emptying one keeps the stored text rather than clearing it."
      >
        <PromptFold
          label="Continuation prompt"
          id="cont"
          edited={isEdited("continuationPrompt")}
          count={movedCount(["continuationPrompt"])}
          defaultOpen={openAtLoad(["continuationPrompt"])}
          className="min-h-[130px]"
          value={effective.continuationPrompt}
          onChange={(v) => patch({ continuationPrompt: v })}
          hint={
            <>
              Sent at the start of every work cycle after the first. The run ends
              when the reply contains <span className="mono">DONE</span> on its
              own line, so keep that instruction
            </>
          }
        />

        <PromptFold
          label="Carry-on prompt"
          id="pushback"
          edited={isEdited("donePushbackPrompt")}
          count={movedCount(["donePushbackPrompt"])}
          defaultOpen={openAtLoad(["donePushbackPrompt"])}
          className="min-h-[130px]"
          value={effective.donePushbackPrompt}
          onChange={(v) => patch({ donePushbackPrompt: v })}
          hint={
            <>
              Sent when the agent reports <span className="mono">DONE</span> on a
              run set to carry on. It must not be the continuation prompt, which
              asks for <span className="mono">DONE</span> — that buys an immediate
              second one and a billed spin
            </>
          }
        />

        <PromptFold
          label="Isolated-run preamble"
          id="isopre"
          edited={isEdited("isolationPreamble")}
          count={movedCount(["isolationPreamble"])}
          defaultOpen={openAtLoad(["isolationPreamble"])}
          className="min-h-[110px]"
          value={effective.isolationPreamble}
          onChange={(v) => patch({ isolationPreamble: v })}
          hint={
            <>
              Prepended to the first prompt of an isolated run. Keep the
              instruction to commit: a worktree holds committed work only, so
              anything left uncommitted never reaches your branch
            </>
          }
        />

        <PromptFold
          label="Continued-branch preamble"
          id="contwork"
          edited={isEdited("continuedWorkPrompt")}
          count={movedCount(["continuedWorkPrompt"])}
          defaultOpen={openAtLoad(["continuedWorkPrompt"])}
          className="min-h-[110px]"
          value={effective.continuedWorkPrompt}
          onChange={(v) => patch({ continuedWorkPrompt: v })}
          hint={
            <>
              Sent when a run picks up the branch the run before it was working
              on. The branch, that run and the commands to read it are added
              around this — what you write here is what to <em>do</em> with what
              is already there
            </>
          }
        />
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
