"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  FoldersResponse,
  RunDTO,
  SettingsDTO,
  UsageResponse,
  WorkspaceFolderDTO,
  WorkspaceMountDTO,
} from "@/lib/apiTypes";
import { fmtDateTime, fmtPct, fmtTokens, fmtUSD, shortPath } from "@/lib/format";

const STATUS_TONE: Record<RunDTO["status"], string> = {
  queued: "",
  running: "accent",
  completed: "ok",
  stopped: "warn",
  blocked: "warn",
  failed: "danger",
};

export default function RunsPage() {
  const router = useRouter();
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [mounts, setMounts] = useState<WorkspaceMountDTO[]>([]);
  const [allFolders, setAllFolders] = useState<WorkspaceFolderDTO[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [mountId, setMountId] = useState("");
  const [folder, setFolder] = useState("");
  const [prompt, setPrompt] = useState("");
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

  useEffect(() => {
    loadRuns();
    const t = setInterval(loadRuns, 4000);
    return () => clearInterval(t);
  }, [loadRuns]);

  useEffect(() => {
    fetch("/api/folders")
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
        if (first) setMountId(first.id);
      })
      .catch(() => setFoldersLoaded(true));

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
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mountId,
          folder,
          prompt,
          permissionMode,
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
      router.push(`/runs/${json.run.id}`);
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

            <div className="btn-row">
              <button type="submit" disabled={submitting || !mountId || !prompt}>
                {submitting ? "Starting…" : "Start run"}
              </button>
            </div>
          </form>
        </div>

        <div className="card">
          <h2 className="card-title">History</h2>
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
