"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  FoldersResponse,
  RunDTO,
  SettingsDTO,
  UsageResponse,
  WorkspaceFolderDTO,
  WorkspaceMountDTO,
} from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtCycles,
  fmtDateTime,
  fmtPct,
  fmtRelative,
  fmtTokens,
  fmtUSD,
  shortPath,
} from "@/lib/format";

export default function RunsPage() {
  const [runs, setRuns] = useState<RunDTO[]>([]);
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

  const loadRuns = useCallback(async () => {
    const res = await fetch("/api/runs", { cache: "no-store" });
    if (res.ok) setRuns((await res.json()).runs);
  }, []);

  // Folders carry occupancy, so this is refetched alongside the run list rather
  // than only at mount — otherwise the "busy" markers freeze at page load.
  const refreshFolders = useCallback(async () => {
    try {
      const res = await fetch("/api/folders", { cache: "no-store" });
      const d = (await res.json()) as FoldersResponse;
      setMounts(d.mounts ?? []);
      setAllFolders(d.folders ?? []);
      setFoldersLoaded(true);
      return d;
    } catch {
      setFoldersLoaded(true);
      return null;
    }
  }, []);

  useEffect(() => {
    loadRuns();
    const t = setInterval(() => {
      loadRuns();
      refreshFolders();
    }, 4000);
    return () => clearInterval(t);
  }, [loadRuns, refreshFolders]);

  useEffect(() => {
    refreshFolders().then((d) => {
      // Prefer the first mount that actually has something in it, so a
      // configured-but-empty mount does not look like the whole UI is broken.
      const first =
        d?.mounts?.find((m) => m.available && m.folderCount > 0) ??
        d?.mounts?.find((m) => m.available) ??
        d?.mounts?.[0];
      if (first) setMountId(first.id);
    });

    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setSettings(d.settings);
        if (d.settings?.defaultPermissionMode)
          setPermissionMode(d.settings.defaultPermissionMode);
      })
      .catch(() => void 0);

    fetch("/api/usage")
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => void 0);
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

  // Isolation needs a repository to branch from. Offering the choice on a plain
  // folder would promise parallelism the folder cannot give.
  const canIsolate = folder !== "" && selectedFolder?.isGitRepo === true;

  const activeRuns = useMemo(
    () =>
      runs.filter(
        (r) =>
          r.status === "running" ||
          r.status === "queued" ||
          // A parked run is still active: it holds its folder and will spend
          // again on its own.
          r.status === "paused",
      ),
    [runs],
  );

  const occupant = canIsolate && isolate ? null : selectedFolder?.busyRunId ?? null;
  const rootOccupant = folder === "" ? activeMount?.busyRunId ?? null : null;

  // Switching mounts invalidates the selected subfolder — fall back to the
  // mount's own root rather than carrying a path that lives somewhere else.
  function selectMount(id: string) {
    setMountId(id);
    setFolder("");
  }

  const weeklyCeilingSet =
    settings?.weeklyTokenLimit != null || settings?.weeklyCostLimit != null;
  const sessionCeilingSet =
    settings?.sessionTokenLimit != null || settings?.sessionCostLimit != null;
  const weeklyRolling = settings != null && settings.weeklyAnchor == null;
  const live = enforcement !== "between-cycles";
  const resuming = enforcement === "live-resume";
  const isolated = canIsolate && isolate;

  const noMountsUsable =
    foldersLoaded && !mounts.some((m) => m.available);

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
          budget: {
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
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to start run");

      // Stay put rather than following the new run. Several runs at once is the
      // normal case now, and navigating away after each one makes starting the
      // next a round trip back.
      setStarted(json.run as RunDTO);
      setPrompt("");
      await loadRuns();
      await refreshFolders();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1>Runs</h1>
      <p className="lede">
        A <strong>run</strong> hands Claude Code one task in one folder and lets
        it keep working until it says the task is done — or until one of your
        limits is reached.
      </p>

      <section className="grid grid-2">
        <div className="card">
          <h2 className="card-title">New run</h2>

          <div className="notice">
            <strong>How a run works.</strong> Claude works on your task and then
            reports back; that stretch of work is one <strong>cycle</strong>.
            UsageFoundry checks your limits, and if there is room it tells Claude
            to carry on into another cycle with the same conversation and
            context. The run ends as soon as Claude reports the task complete, or
            when a limit below is reached.
          </div>

          {noMountsUsable && (
            <div className="notice" data-tone="warn">
              None of the configured workspace mounts exist. Check{" "}
              <span className="mono">UF_WORKSPACE</span> in{" "}
              <span className="mono">.env</span> and the volumes in{" "}
              <span className="mono">docker-compose.yml</span>.
            </div>
          )}

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="mount">Workspace</label>
              <select
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
              </select>
              <div className="hint">
                {activeMount ? (
                  <>
                    One of the directories mounted into UsageFoundry, at{" "}
                    <span className="mono">{activeMount.path}</span>.{" "}
                    {activeMount.error ??
                      "A run can never read or write outside the workspace you pick."}
                  </>
                ) : foldersLoaded ? (
                  "No workspace mounts are configured."
                ) : (
                  "Loading workspaces…"
                )}
              </div>
            </div>

            <div className="field">
              <label htmlFor="folder">Folder</label>
              <select
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
                    {f.busyRunId ? "  · busy" : ""}
                    {f.queuedCount ? `  · ${f.queuedCount} waiting` : ""}
                  </option>
                ))}
              </select>
              <div className="hint">
                {!foldersLoaded
                  ? "Loading folders…"
                  : activeMount && !activeMount.available
                  ? "This workspace is not mounted, so there is nothing to list."
                  : folders.length === 0
                    ? "No subfolders found here — the run will start at the top of this workspace."
                    : `Claude starts here and works within it. ${folders.length} folder${
                        folders.length === 1 ? "" : "s"
                      } found${activeMount?.truncated ? " (list truncated)" : ""}.`}
              </div>
              {folder === "" && (
                <div className="hint">
                  Starting at the top of the workspace takes the whole tree: no
                  run in any folder inside it can start until this one finishes.
                </div>
              )}
              {rootOccupant && (
                <div className="hint" style={{ color: "var(--warn)" }}>
                  A run is already working somewhere in this workspace, so this
                  one will wait for it.
                </div>
              )}
            </div>

            <div className="field">
              <label htmlFor="isolate">Isolation</label>
              <select
                id="isolate"
                value={canIsolate && isolate ? "worktree" : "direct"}
                onChange={(e) => setIsolate(e.target.value === "worktree")}
                disabled={!canIsolate}
              >
                <option value="worktree">
                  Own checkout — run alongside other runs
                </option>
                <option value="direct">
                  Work in the folder itself — one run at a time
                </option>
              </select>
              <div className="hint">
                {!canIsolate ? (
                  folder === "" ? (
                    "The whole workspace is not a repository, so runs here take turns."
                  ) : selectedFolder ? (
                    "Not a git repository, so runs here take turns — a second run waits for the first."
                  ) : (
                    "Pick a folder to choose how it runs."
                  )
                ) : isolate ? (
                  <>
                    Claude gets its own git worktree on a new branch, so several
                    runs can work on this project at once. It starts from the
                    last commit — uncommitted work stays in your checkout, and
                    dependencies are installed fresh the first time.
                  </>
                ) : (
                  "Claude edits this folder directly, so only one run at a time can use it."
                )}
              </div>
              {occupant && (
                <div className="hint" style={{ color: "var(--warn)" }}>
                  This folder is in use.{" "}
                  <Link href={`/runs/${occupant}`}>See the run holding it</Link>{" "}
                  — yours will start when it finishes.
                </div>
              )}
            </div>

            <div className="field">
              <label htmlFor="prompt">Task</label>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Add integration tests for the payments module and make them pass."
                required
              />
              <div className="hint">
                Sent verbatim as the first turn. Later cycles use the
                continuation prompt from Settings, and the run ends when the
                agent replies <span className="mono">DONE</span>.
              </div>
            </div>

            <div className="field">
              <label htmlFor="perm">Permission mode</label>
              <select
                id="perm"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value)}
              >
                <option value="acceptEdits">acceptEdits — auto-accept file edits</option>
                <option value="default">default — prompt (will stall headless)</option>
                <option value="plan">plan — read-only planning</option>
                <option value="bypassPermissions">
                  bypassPermissions — allow everything
                </option>
              </select>
              {permissionMode === "bypassPermissions" && (
                <div className="hint" style={{ color: "var(--danger)" }}>
                  The agent can run any command in this folder without asking.
                  Only use this on code and a container you are willing to have
                  modified.
                </div>
              )}
              {permissionMode === "default" && (
                <div className="hint" style={{ color: "var(--warn)" }}>
                  Headless runs cannot answer a permission prompt — this mode
                  will likely hang until the time limit.
                </div>
              )}
            </div>

            <div className="subsection">
              <div className="subsection-title">When should this run stop?</div>

              <div className="field">
                <label htmlFor="iters">Work cycles before stopping</label>
                <div className="input-row">
                  <select
                    value={iterationsCapped ? "on" : "off"}
                    onChange={(e) => setIterationsCapped(e.target.value === "on")}
                    aria-label="Work cycle limit mode"
                  >
                    <option value="on">Stop after…</option>
                    <option value="off">No cycle limit</option>
                  </select>
                  {iterationsCapped && (
                    <>
                      <input
                        id="iters"
                        type="number"
                        min={1}
                        value={maxIterations}
                        onChange={(e) => setMaxIterations(e.target.value)}
                      />
                      <span className="unit">cycles</span>
                    </>
                  )}
                </div>
                <div className="hint">
                  {iterationsCapped ? (
                    <>
                      How many times Claude may be told to carry on. Each cycle
                      picks up where the last one left off. <strong>1</strong>{" "}
                      means one pass and then stop, no matter what state the work
                      is in.
                    </>
                  ) : (
                    <>
                      Claude keeps being told to carry on until something else
                      stops it. This needs a time limit below: the clock is the
                      only limit that keeps advancing whether or not Claude
                      reports what it spent.
                    </>
                  )}
                </div>
                {!iterationsCapped && !timeLimited && (
                  <div className="hint" style={{ color: "var(--danger)" }}>
                    With no cycle limit and no time limit, nothing would ever end
                    this run. Set a time limit below.
                  </div>
                )}
              </div>

              <div className="field">
                <label htmlFor="cost">Spending limit for this run</label>
                <div className="input-row">
                  <select
                    value={costLimited ? "on" : "off"}
                    onChange={(e) => setCostLimited(e.target.value === "on")}
                    aria-label="Spending limit mode"
                  >
                    <option value="on">Stop after…</option>
                    <option value="off">No spending limit</option>
                  </select>
                  {costLimited && (
                    <>
                      <input
                        id="cost"
                        type="number"
                        min={0}
                        step="0.5"
                        value={maxRunCostUSD}
                        onChange={(e) => setMaxRunCostUSD(e.target.value)}
                      />
                      <span className="unit">USD</span>
                    </>
                  )}
                </div>
                <div className="hint">
                  {costLimited
                    ? "Roughly what this one run may cost. No new cycle starts once this much has been spent, so the final figure can exceed it by up to one cycle."
                    : "This run is not capped in dollars. The two window percentages below cap it against your subscription instead, which is what you want when you care about the allowance rather than the invoice."}
                </div>
                {costLimited && live && (
                  <div className="hint" style={{ color: "var(--warn)" }}>
                    Claude Code only reports a cycle&rsquo;s cost when the cycle
                    finishes, and the mode you have chosen cuts cycles short. What
                    an interrupted cycle spent is worked out from your transcripts
                    afterwards, which is close but not exact — treat the cycle and
                    time limits as the ones that really bound this run.
                  </div>
                )}
              </div>

              <div className="field">
                <label htmlFor="dur">Time limit</label>
                <div className="input-row">
                  <select
                    value={timeLimited ? "on" : "off"}
                    onChange={(e) => setTimeLimited(e.target.value === "on")}
                    aria-label="Time limit mode"
                  >
                    <option value="on">Stop after…</option>
                    <option value="off">No time limit</option>
                  </select>
                  {timeLimited && (
                    <>
                      <input
                        id="dur"
                        type="number"
                        min={1}
                        value={maxDurationMinutes}
                        onChange={(e) => setMaxDurationMinutes(e.target.value)}
                      />
                      <span className="unit">minutes</span>
                    </>
                  )}
                </div>
                <div className="hint">
                  {!timeLimited ? (
                    "The run keeps going until Claude reports the task complete, or another limit stops it."
                  ) : (
                    <>
                      Measured from when the run starts.{" "}
                      {live
                        ? "The clock is checked during a cycle too, so a cycle can be cut off part-way."
                        : "A cycle already underway is never cut off mid-edit — the clock is only checked before the next one begins."}
                      {resuming &&
                        " Time spent waiting for a window to reset counts as well, so this is what finally ends a run that would otherwise keep resuming."}
                    </>
                  )}
                </div>
                {timeLimited && resuming && Number(maxDurationMinutes) > 720 && (
                  <div className="hint" style={{ color: "var(--warn)" }}>
                    That is about {(Number(maxDurationMinutes) / 60).toFixed(0)}{" "}
                    hours of unattended agent, most of it likely spent waiting.
                  </div>
                )}
              </div>

              <div className="field">
                <label htmlFor="sess">
                  {resuming
                    ? "Step aside at 5-hour usage (%)"
                    : "Stop at 5-hour usage (%)"}
                </label>
                <input
                  id="sess"
                  type="number"
                  min={1}
                  max={100}
                  placeholder="e.g. 85 — leave blank to disable"
                  value={maxSessionFraction}
                  onChange={(e) => setMaxSessionFraction(e.target.value)}
                />
                {maxSessionFraction && !sessionCeilingSet ? (
                  <div className="hint" style={{ color: "var(--warn)" }}>
                    No 5-hour ceiling is configured, so this guard has nothing to
                    measure against and the run will be refused. Set one in{" "}
                    <Link href="/settings">Settings</Link>, or run Calibrate
                    there.
                  </div>
                ) : (
                  <div className="hint">
                    {resuming
                      ? "How full your 5-hour window may get before this run steps aside. It picks up where it left off when the next 5-hour window opens, so one task can stretch across several of them."
                      : "How full your 5-hour window may get before this run stops. It measures your whole subscription, not just this run — anything else you do in Claude Code counts against it too."}{" "}
                    {usage?.snapshot.session.fraction != null
                      ? `Your 5-hour window is at ${fmtPct(usage.snapshot.session.fraction)} right now.`
                      : "Requires a 5-hour ceiling in Settings."}
                  </div>
                )}
              </div>

              <div className="field">
                <label htmlFor="wk">Stop at weekly usage (%)</label>
                <input
                  id="wk"
                  type="number"
                  min={1}
                  max={100}
                  placeholder="e.g. 80 — leave blank to disable"
                  value={maxWeeklyFraction}
                  onChange={(e) => setMaxWeeklyFraction(e.target.value)}
                />
                {maxWeeklyFraction && !weeklyCeilingSet ? (
                  <div className="hint" style={{ color: "var(--warn)" }}>
                    No weekly ceiling is configured, so this guard has nothing to
                    measure against and the run will be refused. Set one in{" "}
                    <Link href="/settings">Settings</Link> first.
                  </div>
                ) : (
                  <div className="hint">
                    Protects your subscription allowance, not just this run. This
                    one always ends the run — a weekly window takes days to
                    refill, so there is nothing useful to wait for.{" "}
                    {usage?.snapshot.weekly.fraction != null
                      ? `Your weekly window is currently at ${fmtPct(usage.snapshot.weekly.fraction)}.`
                      : "Requires a weekly ceiling in Settings."}
                  </div>
                )}
              </div>
            </div>

            <div className="subsection">
              <div className="subsection-title">How limits are enforced</div>

              <div className="field">
                <label htmlFor="enf">When a limit is reached</label>
                <select
                  id="enf"
                  value={enforcement}
                  onChange={(e) =>
                    setEnforcement(e.target.value as typeof enforcement)
                  }
                >
                  <option value="between-cycles">
                    Let the cycle finish, then stop
                  </option>
                  <option value="live">Stop the cycle in flight</option>
                  <option value="live-resume">
                    Stop the cycle, carry on next window
                  </option>
                </select>
                <div className="hint">
                  {enforcement === "between-cycles" ? (
                    <>
                      Limits are read between cycles. Claude always finishes what
                      it started, so the run can overshoot a limit by up to one
                      cycle — but no work is thrown away and every cycle reports
                      what it cost.
                    </>
                  ) : (
                    <>
                      Limits are read while a cycle is running too, about every{" "}
                      {settings?.liveGuardIntervalSeconds ?? 60} seconds, and
                      Claude is stopped as soon as one is reached.{" "}
                      <strong>The work in that cycle is lost.</strong> It is not
                      instantaneous either: usage is read from the transcript
                      files Claude Code writes as each turn completes, so a limit
                      is noticed at most one turn plus one check after it was
                      crossed.
                    </>
                  )}
                </div>
                {live && settings?.telemetryForRuns === false && (
                  <div className="hint" style={{ color: "var(--warn)" }}>
                    Consider turning on{" "}
                    <Link href="/settings">agent self-reporting</Link> — it is the
                    only independent record of what the cycles this mode cuts
                    short actually cost.
                  </div>
                )}
                {resuming && (
                  <div className="hint">
                    The run steps aside for two things: your own 5-hour
                    percentage, and Claude refusing a cycle because the
                    subscription allowance is used up. Everything else ends the
                    run, because nothing else comes back: your spend, your
                    cycles, the clock and the weekly window all move one way.
                  </div>
                )}
              </div>

              {resuming && !maxSessionFraction && (
                <div className="hint">
                  Without a 5-hour percentage the run carries on until Claude
                  itself refuses a cycle, then waits for the allowance to refill.
                  Set one above to step aside before the wall rather than at it.
                </div>
              )}

              {resuming && weeklyRolling && (
                <div className="notice" data-tone="warn">
                  Your weekly window is set to <strong>rolling 7 days</strong>, so
                  it has no reset instant. That does not stop this mode — the run
                  waits on the 5-hour window, which always rolls over — but a
                  weekly percentage will only fall again as old usage ages out,
                  over days. Set your reset day in{" "}
                  <Link href="/settings">Settings</Link> if you know it.
                </div>
              )}

              {resuming && !isolated && (
                <div className="notice" data-tone="warn">
                  A waiting run keeps hold of its folder. Nothing else can run in{" "}
                  <span className="mono">
                    {folder || activeMount?.label || "this workspace"}
                  </span>{" "}
                  while it waits, which can be up to five hours at a stretch.
                </div>
              )}

              <div className="field">
                <label htmlFor="done">When Claude says the task is done</label>
                <select
                  id="done"
                  value={continueAfterDone ? "1" : "0"}
                  onChange={(e) => setContinueAfterDone(e.target.value === "1")}
                >
                  <option value="0">End the run — it is finished</option>
                  <option value="1">Send it back in until a limit stops it</option>
                </select>
                <div className="hint">
                  {continueAfterDone ? (
                    <>
                      <span className="mono">DONE</span> no longer ends this run.
                      Claude is told the budget is not spent yet and sent back to
                      the same task — to verify, test and tighten rather than to
                      invent new work. There is then no way for it to finish
                      early: the run ends when a limit above is reached. The exact
                      wording it gets is in{" "}
                      <Link href="/settings">Settings</Link>.
                    </>
                  ) : (
                    <>
                      The run ends as soon as Claude replies{" "}
                      <span className="mono">DONE</span>, leaving whatever budget
                      is left unspent.
                    </>
                  )}
                </div>
                {continueAfterDone && !isolated && (
                  <div className="hint" style={{ color: "var(--warn)" }}>
                    This run edits your folder directly, and will keep editing it
                    after it believes the task is finished. Isolation would put
                    that on its own branch instead.
                  </div>
                )}
              </div>
            </div>

            {permissionMode === "bypassPermissions" &&
              (resuming || continueAfterDone) && (
                <div className="notice" data-tone="danger">
                  <strong>Read this before starting.</strong> This run can run any
                  command without asking
                  {resuming && ", will keep going across several 5-hour windows"}
                  {continueAfterDone &&
                    ", will not stop when it believes the work is finished"}
                  , and nobody will be watching it.{" "}
                  {timeLimited
                    ? `It ends by itself after ${maxDurationMinutes} minutes.`
                    : "Nothing here bounds it in wall-clock time."}
                </div>
              )}

            {formError && (
              <div className="notice" data-tone="danger">
                {formError}
              </div>
            )}

            {started && (
              <div
                className="notice"
                data-tone={started.status === "queued" ? "warn" : "info"}
              >
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
              </div>
            )}

            <div className="btn-row">
              {/* Mirrors the two rejections POST /api/runs makes, so the user is
                  not round-tripping to learn them. The server stays the
                  authority. */}
              <button
                type="submit"
                disabled={
                  submitting ||
                  !mountId ||
                  !prompt ||
                  (!iterationsCapped && !timeLimited)
                }
              >
                {submitting ? "Starting…" : "Start run"}
              </button>
            </div>
          </form>
        </div>

        <div className="card">
          <h2 className="card-title">History</h2>

          {activeRuns.length > 0 && (
            <div className="subsection">
              <div className="subsection-title">Running now</div>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {activeRuns.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <span className="badge" data-tone={STATUS_TONE[r.status]}>
                            {r.status === "queued"
                              ? `waiting · ${r.queuePosition ?? 0} ahead`
                              : r.status === "paused"
                                ? `paused · ${
                                    r.resume_at
                                      ? fmtRelative(r.resume_at, Date.now())
                                      : "waiting"
                                  }`
                                : r.status}
                          </span>
                        </td>
                        <td className="mono" title={r.work_dir ?? r.folder}>
                          <Link href={`/runs/${r.id}`}>
                            {r.relPath || r.mountLabel || shortPath(r.folder, 2)}
                          </Link>
                          {r.isolation === "worktree" && (
                            <span style={{ color: "var(--fg-faint)" }}>
                              {" "}
                              · own checkout
                            </span>
                          )}
                        </td>
                        <td className="num">
                          {fmtCycles(r.iterations, r.max_iterations)}
                        </td>
                        <td className="num">{fmtUSD(r.spent_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {runs.length === 0 ? (
            <div className="empty">No runs yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Folder</th>
                    <th>Status</th>
                    <th className="num">Cycles</th>
                    <th className="num">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/runs/${r.id}`}>
                          {fmtDateTime(r.started_at ?? r.created_at)}
                        </Link>
                      </td>
                      <td className="mono" title={r.folder}>
                        {r.mountLabel ? (
                          <>
                            <span style={{ color: "var(--fg-faint)" }}>
                              {r.mountLabel} /{" "}
                            </span>
                            {r.relPath || "."}
                          </>
                        ) : (
                          shortPath(r.folder, 2)
                        )}
                      </td>
                      <td>
                        <span className="badge" data-tone={STATUS_TONE[r.status]}>
                          {r.status}
                        </span>
                      </td>
                      <td className="num">
                        {fmtCycles(r.iterations, r.max_iterations)}
                      </td>
                      <td className="num">
                        {fmtUSD(r.spent_usd)}
                        <div className="hint" style={{ margin: 0 }}>
                          {fmtTokens(r.spent_tokens)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
