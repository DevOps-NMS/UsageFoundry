"use client";

import { useEffect, useMemo, useState } from "react";
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
import { fmtPct } from "@/lib/format";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button, ButtonRow } from "@/components/ui/Button";
import {
  Field,
  Input,
  LimitField,
  Select,
  Textarea,
} from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";

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

  useEffect(() => {
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
  const selectedFolder = useMemo(
    () => folders.find((f) => f.path === folder) ?? null,
    [folders, folder],
  );

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
  const noTerminus = !iterationsCapped && !timeLimited;
  const noMountsUsable = foldersLoaded && !mounts.some((m) => m.available);

  // Switching mounts invalidates the selected subfolder — fall back to the
  // mount's own root rather than carrying a path that lives somewhere else.
  function selectMount(id: string) {
    setMountId(id);
    setFolder("");
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
            <Hint>
              {activeMount ? (
                <>
                  Mounted at <span className="mono">{activeMount.path}</span>
                  {activeMount.error ? ` — ${activeMount.error}` : ""}
                </>
              ) : foldersLoaded ? (
                "No workspace mounts are configured"
              ) : (
                "Loading workspaces…"
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
              {costLimited
                ? "No new cycle starts once this much is spent, so the final figure can exceed it by up to one cycle"
                : "Not capped in dollars — the two window percentages below cap it against your subscription instead"}
            </Hint>
            {costLimited && live && (
              <Hint tone="warn">
                Claude Code only reports a cycle&rsquo;s cost when the cycle
                finishes, and this mode cuts cycles short. An interrupted
                cycle&rsquo;s spend is worked out from your transcripts
                afterwards — close, but not exact
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
              onChange={(e) => setPermissionMode(e.target.value)}
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
            </Select>
            <Hint>
              {enforcement === "between-cycles"
                ? "Limits are read between cycles, so the run can overshoot by up to one cycle — but no work is thrown away"
                : `Limits are also read mid-cycle, about every ${
                    settings?.liveGuardIntervalSeconds ?? 60
                  }s, and that cycle's work is lost. Usage comes from transcripts written as each turn completes, so it is tighter, not instant`}
            </Hint>
            {live && settings?.telemetryForRuns === false && (
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
