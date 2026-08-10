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
  fmtDateTime,
  fmtPct,
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
  const [maxIterations, setMaxIterations] = useState("5");
  const [maxRunCostUSD, setMaxRunCostUSD] = useState("5");
  const [maxWeeklyFraction, setMaxWeeklyFraction] = useState("");
  const [timeLimited, setTimeLimited] = useState(true);
  const [maxDurationMinutes, setMaxDurationMinutes] = useState("60");

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
    () => runs.filter((r) => r.status === "running" || r.status === "queued"),
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
            maxIterations,
            maxRunCostUSD,
            maxWeeklyFraction: maxWeeklyFraction || null,
            // null is the wire form of "no time limit" — normalizePolicy maps
            // it back to an unset cap rather than to a default.
            maxDurationMinutes: timeLimited ? maxDurationMinutes : null,
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
                <input
                  id="iters"
                  type="number"
                  min={1}
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(e.target.value)}
                />
                <div className="hint">
                  How many times Claude may be told to carry on. Each cycle picks
                  up where the last one left off.{" "}
                  <strong>1</strong> means one pass and then stop, no matter what
                  state the work is in.
                </div>
              </div>

              <div className="field">
                <label htmlFor="cost">Spending limit for this run (USD)</label>
                <input
                  id="cost"
                  type="number"
                  min={0}
                  step="0.5"
                  placeholder="leave blank for no limit"
                  value={maxRunCostUSD}
                  onChange={(e) => setMaxRunCostUSD(e.target.value)}
                />
                <div className="hint">
                  Roughly what this one run may cost. No new cycle starts once
                  this much has been spent, so the final figure can exceed it by
                  up to one cycle. Leave blank for no limit.
                </div>
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
                  {timeLimited
                    ? "Measured from when the run starts. A cycle already underway is never cut off mid-edit — the clock is only checked before the next one begins."
                    : "The run keeps going until Claude reports the task complete, or another limit stops it."}
                </div>
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
                    Protects your subscription allowance, not just this run.{" "}
                    {usage?.snapshot.weekly.fraction != null
                      ? `Your weekly window is currently at ${fmtPct(usage.snapshot.weekly.fraction)}.`
                      : "Requires a weekly ceiling in Settings."}
                  </div>
                )}
              </div>
            </div>

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
              <button type="submit" disabled={submitting || !mountId || !prompt}>
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
                          {r.iterations}/{r.max_iterations}
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
                        {r.iterations}/{r.max_iterations}
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
