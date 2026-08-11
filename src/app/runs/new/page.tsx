"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MAX_TEMPLATE_NAME } from "@/lib/apiTypes";
import type {
  BudgetPolicyDTO,
  FoldersResponse,
  RunDTO,
  RunTemplateDTO,
  SettingsDTO,
  UsageResponse,
  WorkspaceFolderDTO,
  WorkspaceMountDTO,
} from "@/lib/apiTypes";
import { fmtPct, fmtUSD, pctField } from "@/lib/format";
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
  parts.push(t.folder === null ? "asks for a folder" : t.folder || "whole workspace");
  return parts.join(" · ");
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

  const [mountId, setMountId] = useState("");
  const [folder, setFolder] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isolate, setIsolate] = useState(true);
  const [permissionMode, setPermissionMode] = useState("acceptEdits");
  // Defaults reproduce today's behaviour exactly. There is deliberately no
  // `settings.defaultEnforcement`: a settable default is a way to turn every run
  // into a live-killing run by accident, and between-cycles is the only mode
  // that never throws work away.
  const [iterationsCapped, setIterationsCapped] = useState(true);
  const [maxIterations, setMaxIterations] = useState("5");
  const [costLimited, setCostLimited] = useState(true);
  const [maxRunCostUSD, setMaxRunCostUSD] = useState("5");
  const [maxSessionFraction, setMaxSessionFraction] = useState("");
  const [maxWeeklyFraction, setMaxWeeklyFraction] = useState("");
  const [timeLimited, setTimeLimited] = useState(true);
  const [maxDurationMinutes, setMaxDurationMinutes] = useState("60");
  const [enforcement, setEnforcement] = useState<
    "between-cycles" | "live" | "live-resume"
  >("between-cycles");
  const [continueAfterDone, setContinueAfterDone] = useState(false);

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

  // Set before any fetch is issued, so the loaders below can tell "nobody has
  // chosen yet" from "a seed is on its way". Without it the mount default and
  // the settings default race a seed that arrives later and win or lose
  // depending on the connection.
  const seeded = useRef(false);

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
        if (first && !seeded.current) setMountId(first.id);
      })
      .catch(() => setFoldersLoaded(true));

    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setSettings(d.settings);
        if (d.settings?.defaultPermissionMode && !seeded.current)
          setPermissionMode(d.settings.defaultPermissionMode);
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

  const occupant = isolated ? null : selectedFolder?.busyRunId ?? null;
  const rootOccupant = folder === "" ? activeMount?.busyRunId ?? null : null;
  // A parked run has yielded the folder, so this is worth saying but is not a
  // wait — hence separate from the two above, which are.
  const parked = isolated ? null : selectedFolder?.parkedRunId ?? null;
  const rootParked = folder === "" ? activeMount?.parkedRunId ?? null : null;

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
   * that reads as zero.
   */
  function applySeed(seed: FormSeed, note: string) {
    if (seed.mountId) {
      setMountId(seed.mountId);
      setFolder(seed.folder ?? "");
    }
    // A seed with no mount leaves the picker alone: it is saying "ask me",
    // and moving the selection would be answering on the operator's behalf.
    setPrompt(seed.prompt);
    setIsolate(seed.isolate);
    setPermissionMode(seed.permissionMode);

    const b = seed.budget;
    setIterationsCapped(b.maxIterations !== null);
    if (b.maxIterations !== null) setMaxIterations(String(b.maxIterations));
    setCostLimited(b.maxRunCostUSD !== null);
    if (b.maxRunCostUSD !== null) setMaxRunCostUSD(String(b.maxRunCostUSD));
    setTimeLimited(b.maxDurationMinutes !== null);
    if (b.maxDurationMinutes !== null)
      setMaxDurationMinutes(String(b.maxDurationMinutes));
    setMaxSessionFraction(pctField(b.maxSessionFraction));
    setMaxWeeklyFraction(pctField(b.maxWeeklyFraction));
    setEnforcement(b.enforcement);
    setContinueAfterDone(b.continueAfterDone === true);

    // The two that decide what an unattended agent may do. Applied, but
    // announced — see the notices under the template card.
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
    applySeed(t, `Loaded “${t.name}”`);
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
      setTemplateNote(`Deleted “${t.name}”. The form still holds its settings.`);
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">New run</h1>
        <p className="text-ink-muted">
          Claude works on your task and reports back; that stretch of work is
          one <strong className="font-semibold text-ink">cycle</strong>. If your
          limits allow, it is told to carry on into another with the same
          context. The run ends when Claude reports the task complete, or when a
          limit below is reached.
        </p>
      </div>

      {noMountsUsable && (
        <Notice tone="warn">
          None of the configured workspace mounts exist. Check{" "}
          <span className="mono">UF_WORKSPACE</span> in{" "}
          <span className="mono">.env</span> and the volumes in{" "}
          <span className="mono">docker-compose.yml</span>.
        </Notice>
      )}

      <form onSubmit={submit}>
        <Card className="mb-4" emphasis="quiet">
          <CardTitle>Templates</CardTitle>

          {templates.length > 0 && (
            <Field label="Start from a saved template" htmlFor="tpl">
              <Select
                id="tpl"
                value={templateId}
                onChange={(e) => pickTemplate(e.target.value)}
              >
                <option value="">— start from scratch —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <Hint>
                {selectedTemplate
                  ? describeTemplate(selectedTemplate)
                  : "Loading one fills in everything below. Nothing starts until you press Start run."}
              </Hint>
            </Field>
          )}

          <Field label="Save this form as a template" htmlFor="tpl-name">
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
              />
              <Button
                type="button"
                variant="secondary"
                className="shrink-0"
                onClick={saveTemplate}
                disabled={savingTemplate || !templateName.trim() || !prompt}
              >
                {savingTemplate
                  ? "Saving…"
                  : nameTaken
                    ? "Update"
                    : "Save"}
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
              {!prompt
                ? "Write the task below first — the prompt is the part worth saving"
                : nameTaken
                  ? `Replaces the template already called “${templateName.trim()}”`
                  : "Saves the task, the limits and how it behaves. Not the model — that stays a single global setting"}
            </Hint>
          </Field>

          <Field className="mb-0">
            <Toggle
              id="tpl-folder"
              checked={rememberFolder}
              onChange={setRememberFolder}
              label="Remember the workspace and folder chosen below"
            />
            <Hint>
              {rememberFolder
                ? "The template pre-selects that folder. Right for a task about one project"
                : "The template asks for a folder each time. Right for a task that applies to any project"}
            </Hint>
          </Field>

          {templateNote && (
            <Hint className="mt-3">{templateNote}</Hint>
          )}
          {templateError && (
            <Hint tone="danger" className="mt-3">
              {templateError}
            </Hint>
          )}
        </Card>

        {/* Applying a template must not be the same as not choosing. These two
            settings decide what an unattended agent is allowed to do, and both
            are deliberately absent from Settings for that reason — there is no
            `defaultEnforcement` precisely so that no single edit can turn every
            run into a live-killing one. A template is a second way to inherit
            that choice, so it is applied, named, and offered back. */}
        {carriedEnforcement && (
          <Notice tone="warn">
            <strong>This carries a limit mode that cuts cycles short.</strong>{" "}
            {enforcement === "live-resume"
              ? "“Stop the cycle, carry on next window”"
              : "“Stop the cycle in flight”"}{" "}
            reads your limits mid-cycle and kills the agent when one trips, so
            that cycle&rsquo;s work is thrown away. It is worth choosing again
            rather than inheriting — there is no global default for it for the
            same reason.
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

        {carriedPermission && (
          <Notice tone="danger">
            <strong>
              This carries <span className="mono">bypassPermissions</span>.
            </strong>{" "}
            The agent can run any command in the folder without asking. Only use
            it on code and a container you are willing to have modified.
            <ButtonRow className="mt-2.5">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setPermissionMode("acceptEdits");
                  setCarriedPermission(false);
                }}
              >
                Use acceptEdits instead
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

        <Card className="mb-4">
          <CardTitle>What to work on</CardTitle>

          <Field label="Workspace" htmlFor="mount">
            <Select
              id="mount"
              value={mountId}
              onChange={(e) => selectMount(e.target.value)}
              required
            >
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
              {activeMount ? (
                <>
                  Mounted at <span className="mono">{activeMount.path}</span>
                  {activeMount.error ? ` — ${activeMount.error}` : ""}
                </>
              ) : !foldersLoaded ? (
                "Loading workspaces…"
              ) : mounts.length === 0 ? (
                "No workspace mounts are configured"
              ) : (
                "That workspace is not configured any more — pick one above"
              )}
            </Hint>
          </Field>

          <Field label="Folder" htmlFor="folder">
            <Select
              id="folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
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
                  {f.busyRunId ? "  · busy" : f.parkedRunId ? "  · parked" : ""}
                  {f.queuedCount ? `  · ${f.queuedCount} waiting` : ""}
                </option>
              ))}
            </Select>
            {folder === "" && folders.length > 0 && (
              <Hint>
                The whole workspace takes the entire tree — no run in any folder
                inside it can start until this one finishes
              </Hint>
            )}
            {rootOccupant && (
              <Hint tone="warn">
                A run is already working somewhere in this workspace, so this
                one will wait for it
              </Hint>
            )}
            {!rootOccupant && rootParked && (
              <Hint>
                A parked run is waiting somewhere in this workspace. Yours starts
                now; it takes its folder back when yours finishes
              </Hint>
            )}
          </Field>

          {canIsolate && (
            <Field label="Isolation" htmlFor="isolate">
              <Select
                id="isolate"
                value={isolate ? "worktree" : "direct"}
                onChange={(e) => setIsolate(e.target.value === "worktree")}
              >
                <option value="worktree">
                  Own checkout — run alongside other runs
                </option>
                <option value="direct">
                  Work in the folder itself — one run at a time
                </option>
              </Select>
              <Hint>
                {isolate
                  ? "Claude gets its own git worktree on a new branch, starting from the last commit — your uncommitted work stays put"
                  : "Claude edits this folder directly, so only one run at a time can use it"}
              </Hint>
              {occupant && (
                <Hint tone="warn">
                  This folder is in use.{" "}
                  <Link href={`/runs/${occupant}`}>See the run holding it</Link>{" "}
                  — yours will start when it finishes
                </Hint>
              )}
              {!occupant && parked && (
                <Hint>
                  A <Link href={`/runs/${parked}`}>parked run</Link> is waiting
                  for this folder. Yours starts now; it takes the folder back
                  when yours finishes
                </Hint>
              )}
            </Field>
          )}

          <Field label="Task" htmlFor="prompt" className="mb-0">
            <Textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Add integration tests for the payments module and make them pass."
              required
            />
            <Hint>
              Sent verbatim as the first turn; the run ends when Claude replies{" "}
              <span className="mono">DONE</span>
            </Hint>
          </Field>
        </Card>

        <Card className="mb-4">
          <CardTitle>When it should stop</CardTitle>

          <Field label="Work cycles" htmlFor="iters">
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
            <Hint>
              {iterationsCapped
                ? "Each cycle picks up where the last left off; 1 means one pass and then stop"
                : "Needs a time limit below — the clock is the only limit that advances whether or not Claude reports what it spent"}
            </Hint>
          </Field>

          <Field label="Spending limit for this run" htmlFor="cost">
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
            <Hint>
              {!costLimited
                ? "Not capped in dollars — the two window percentages below cap it against your subscription instead"
                : live
                  ? "Read mid-cycle too, so the run stops near this figure rather than a whole cycle past it"
                  : "No new cycle starts once this much is spent, so the final figure can exceed it by up to one cycle"}
            </Hint>
            {liveSpendGuard && (
              <Hint>
                Needs Claude Code&rsquo;s own per-request reporting, so this run
                switches that on for itself — records land a few seconds behind
                the spend. What the cut-short cycle cost is worked out from your
                transcripts afterwards, close but not exact
              </Hint>
            )}
          </Field>

          <Field label="Time limit" htmlFor="dur">
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
            <Hint>
              {!timeLimited
                ? "The run continues until Claude reports the task complete, or another limit stops it"
                : live
                  ? "Measured from the start; checked during a cycle too, so a cycle can be cut off part-way"
                  : "Measured from the start; a cycle already underway is never cut off mid-edit"}
            </Hint>
            {timeLimited && resuming && Number(maxDurationMinutes) > 720 && (
              <Hint tone="warn">
                That is about {(Number(maxDurationMinutes) / 60).toFixed(0)}{" "}
                hours of unattended agent, most of it likely spent waiting
              </Hint>
            )}
          </Field>

          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field
              label={
                resuming
                  ? "Step aside at 5-hour usage (%)"
                  : "Stop at 5-hour usage (%)"
              }
              htmlFor="sess"
            >
              <Input
                id="sess"
                type="number"
                min={1}
                max={100}
                placeholder="blank = off"
                value={maxSessionFraction}
                onChange={(e) => setMaxSessionFraction(e.target.value)}
              />
              {maxSessionFraction && !sessionCeilingSet ? (
                <Hint tone="warn">
                  No 5-hour ceiling is configured, so this guard has nothing to
                  measure against and the run will be refused —{" "}
                  <Link href="/settings">set one</Link>
                </Hint>
              ) : (
                <Hint>
                  {resuming
                    ? "The run steps aside and picks up in the next window"
                    : "Measures your whole subscription, not just this run"}
                  {usage?.snapshot.session.fraction != null
                    ? ` · now at ${fmtPct(usage.snapshot.session.fraction)}`
                    : ""}
                </Hint>
              )}
            </Field>

            <Field label="Stop at weekly usage (%)" htmlFor="wk">
              <Input
                id="wk"
                type="number"
                min={1}
                max={100}
                placeholder="blank = off"
                value={maxWeeklyFraction}
                onChange={(e) => setMaxWeeklyFraction(e.target.value)}
              />
              {maxWeeklyFraction && !weeklyCeilingSet ? (
                <Hint tone="warn">
                  No weekly ceiling is configured, so this guard has nothing to
                  measure against and the run will be refused —{" "}
                  <Link href="/settings">set one</Link>
                </Hint>
              ) : (
                <Hint>
                  Always ends the run — a weekly window takes days to refill
                  {usage?.snapshot.weekly.fraction != null
                    ? ` · now at ${fmtPct(usage.snapshot.weekly.fraction)}`
                    : ""}
                </Hint>
              )}
            </Field>
          </div>

          {noTerminus && (
            <Notice tone="danger" className="mb-0 mt-1">
              <strong>Nothing would end this run.</strong> With no cycle limit
              and no time limit there is no quantity that only moves one way.
              Set a time limit.
            </Notice>
          )}
        </Card>

        <Card className="mb-4">
          <CardTitle>How it behaves</CardTitle>

          <Field label="Permission mode" htmlFor="perm">
            <Select
              id="perm"
              value={permissionMode}
              onChange={(e) => {
                setPermissionMode(e.target.value);
                // Chosen here, so it is no longer inherited — the banner above
                // would be describing a decision that is now the operator's.
                setCarriedPermission(false);
              }}
            >
              <option value="acceptEdits">
                acceptEdits — auto-accept file edits
              </option>
              <option value="default">
                default — prompt (will stall headless)
              </option>
              <option value="plan">plan — read-only planning</option>
              <option value="bypassPermissions">
                bypassPermissions — allow everything
              </option>
            </Select>
            {permissionMode === "bypassPermissions" && (
              <Hint tone="danger">
                The agent can run any command in this folder without asking.
                Only use this on code and a container you are willing to have
                modified
              </Hint>
            )}
            {permissionMode === "default" && (
              <Hint tone="warn">
                Headless runs cannot answer a permission prompt — this mode will
                likely hang until the time limit
              </Hint>
            )}
          </Field>

          <Field label="When a limit is reached" htmlFor="enf">
            <Select
              id="enf"
              value={enforcement}
              onChange={(e) => {
                setEnforcement(e.target.value as typeof enforcement);
                setCarriedEnforcement(false);
              }}
            >
              <option value="between-cycles">
                Let the cycle finish, then stop
              </option>
              <option value="live">Stop the cycle in flight</option>
              <option value="live-resume">
                Stop the cycle, carry on next window
              </option>
            </Select>
            <Hint>
              {enforcement === "between-cycles"
                ? "Limits are read between cycles, so the run can overshoot by up to one cycle — but no work is thrown away"
                : `Limits are also read mid-cycle, about every ${
                    settings?.liveGuardIntervalSeconds ?? 60
                  }s, and that cycle's work is lost — tighter than waiting for the cycle to end, but not an exact cut-off`}
            </Hint>
            {live && !costLimited && settings?.telemetryForRuns === false && (
              <Hint tone="warn">
                Consider turning on{" "}
                <Link href="/settings">agent self-reporting</Link> — it is the
                only independent record of what a cut-short cycle cost
              </Hint>
            )}
            {resuming && !maxSessionFraction && (
              <Hint>
                With no 5-hour percentage the run carries on until Claude itself
                refuses a cycle, then waits for the allowance to refill
              </Hint>
            )}
          </Field>

          <Field
            label="When Claude says the task is done"
            htmlFor="done"
            className="mb-0"
          >
            <Select
              id="done"
              value={continueAfterDone ? "1" : "0"}
              onChange={(e) => setContinueAfterDone(e.target.value === "1")}
            >
              <option value="0">End the run — it is finished</option>
              <option value="1">Send it back in until a limit stops it</option>
            </Select>
            <Hint>
              {continueAfterDone ? (
                <>
                  Claude is sent back to verify and tighten rather than invent
                  work; the run can then only end at a limit
                </>
              ) : (
                <>
                  The run ends as soon as Claude replies{" "}
                  <span className="mono">DONE</span>
                </>
              )}
            </Hint>
            {continueAfterDone && !isolated && (
              <Hint tone="warn">
                This run edits your folder directly and will keep editing it
                after it believes the task is finished
              </Hint>
            )}
          </Field>
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
            A waiting run keeps hold of its folder. Nothing else can run in{" "}
            <span className="mono">
              {folder || activeMount?.label || "this workspace"}
            </span>{" "}
            while it waits, which can be up to five hours at a stretch.
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
              {timeLimited
                ? `It ends by itself after ${maxDurationMinutes} minutes.`
                : "Nothing here bounds it in wall-clock time."}
            </Notice>
          )}

        {formError && <Notice tone="danger">{formError}</Notice>}

        {started && (
          <Notice tone={started.status === "queued" ? "warn" : "info"}>
            {started.status === "queued" ? (
              <>
                Queued behind {started.queuePosition ?? 0} other run
                {(started.queuePosition ?? 0) === 1 ? "" : "s"} for that folder —
                it starts on its own.{" "}
              </>
            ) : (
              <>Started. </>
            )}
            <Link href={`/runs/${started.id}`}>Open it</Link>, or start another.
          </Notice>
        )}

        <ButtonRow>
          {/* Mirrors the two rejections POST /api/runs makes, so the user is
              not round-tripping to learn them. The server stays the authority. */}
          <Button
            type="submit"
            disabled={submitting || !mountId || !prompt || noTerminus}
          >
            {submitting ? "Starting…" : "Start run"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push("/runs")}
          >
            Back to runs
          </Button>
        </ButtonRow>
      </form>
    </div>
  );
}
