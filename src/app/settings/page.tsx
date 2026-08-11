"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SettingsDTO } from "@/lib/apiTypes";
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
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Tr } from "@/components/ui/Table";

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

/** Anchors for the section nav; order is the page order. */
const SECTIONS = [
  { id: "ceilings", label: "Ceilings" },
  { id: "defaults", label: "Run defaults" },
  { id: "prompts", label: "Prompts" },
  { id: "isolation", label: "Concurrency & isolation" },
  { id: "advanced", label: "Advanced" },
];

/** Epoch ms → the `YYYY-MM-DDTHH:mm` a datetime-local input wants, in local time. */
function toLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const local = new Date(ms - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function SectionCard({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-4 scroll-mt-4">
      <Card>
        <CardTitle>{title}</CardTitle>
        {children}
      </Card>
    </section>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<SettingsDTO | null>(null);
  const [env, setEnv] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cal, setCal] = useState<CalibrateResponse | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  /** Non-null only while the globs field is being edited. */
  const [copyGlobsText, setCopyGlobsText] = useState<string | null>(null);
  /** What the server last confirmed, for the dirty check. */
  const savedSnapshot = useRef<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setS(d.settings);
        setEnv(d.env ?? {});
        savedSnapshot.current = JSON.stringify(d.settings);
      });
  }, []);

  // One Save commits all twenty-odd fields, so the page has to say when there
  // is anything to commit — a button that is always available says nothing
  // about whether the thing on screen is what is stored.
  const dirty = useMemo(
    () => s !== null && JSON.stringify(s) !== savedSnapshot.current,
    [s],
  );

  function patch(p: Partial<SettingsDTO>) {
    setS((prev) => (prev ? { ...prev, ...p } : prev));
    setSaved(false);
    setSaveError(null);
  }

  function discard() {
    if (savedSnapshot.current) setS(JSON.parse(savedSnapshot.current));
    setCopyGlobsText(null);
    setSaveError(null);
    setSaved(false);
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s),
      });
      const json = await res.json();
      // A rejected field means nothing was saved — keep the edited form on
      // screen rather than replacing it with an undefined settings object.
      if (!res.ok) {
        setSaveError(String(json.error ?? `Save failed (${res.status}).`));
        return;
      }
      setS(json.settings);
      savedSnapshot.current = JSON.stringify(json.settings);
      setSaved(true);
      setSaveError(null);
    } finally {
      setBusy(false);
    }
  }

  async function calibrate() {
    setCalBusy(true);
    try {
      const res = await fetch("/api/calibrate");
      setCal(await res.json());
    } finally {
      setCalBusy(false);
    }
  }

  if (!s) return <Empty>Loading settings…</Empty>;

  const numOrEmpty = (v: number | null) => (v === null ? "" : String(v));
  const workspaceMounts = Array.isArray(env.workspaceMounts)
    ? (env.workspaceMounts as Array<{ id: string; label: string; path: string }>)
    : [];

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mb-4 text-ink-muted">
        Transcripts: <span className="mono">{String(env.claudeHome ?? "—")}</span>{" "}
        · Admin key: {env.adminKeyConfigured ? "configured" : "not set"} · GitHub:{" "}
        {env.githubTokenConfigured
          ? "token configured"
          : "no token (runs cannot push or use gh)"}
        <br />
        Workspaces:{" "}
        {workspaceMounts.length === 0 ? (
          <span className="mono">{String(env.workspaceRoot ?? "—")}</span>
        ) : (
          workspaceMounts.map((m, i) => (
            <span key={m.id}>
              {i > 0 && " · "}
              {m.label} <span className="mono">{m.path}</span>
            </span>
          ))
        )}
      </p>

      <nav
        aria-label="Settings sections"
        className="mb-5 flex flex-wrap gap-1.5 border-b border-line pb-4"
      >
        {SECTIONS.map((sec) => (
          <a
            key={sec.id}
            href={`#${sec.id}`}
            className="rounded-full border border-line bg-inset px-3 py-1 text-xs font-medium text-ink-muted no-underline hover:text-ink hover:no-underline"
          >
            {sec.label}
          </a>
        ))}
      </nav>

      <SectionCard id="ceilings" title="Limit ceilings">
        <Notice tone="warn">
          Anthropic does not publish the numeric value of a Pro/Max limit and
          offers no endpoint to read one. Anything you enter here is an{" "}
          <strong>estimate</strong>, and every percentage in this app is computed
          against it.
        </Notice>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="5-hour ceiling — equivalent API cost (USD)" htmlFor="sessc">
            <Input
              id="sessc"
              type="number"
              min={0}
              step="0.5"
              placeholder="blank = no percentage shown"
              value={numOrEmpty(s.sessionCostLimit)}
              onChange={(e) =>
                patch({
                  sessionCostLimit: e.target.value
                    ? Number(e.target.value)
                    : null,
                })
              }
            />
          </Field>

          <Field label="Weekly ceiling — equivalent API cost (USD)" htmlFor="wkc">
            <Input
              id="wkc"
              type="number"
              min={0}
              step="1"
              placeholder="blank = no percentage shown"
              value={numOrEmpty(s.weeklyCostLimit)}
              onChange={(e) =>
                patch({
                  weeklyCostLimit: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </Field>
        </div>
        <Hint className="-mt-2 mb-3.5">
          Cost is the primary metric because a Claude Code workload is mostly
          cache reads, which bill at 0.1× and would otherwise dominate a
          raw-token count without consuming a comparable share of your plan
        </Hint>

        <Field
          label="Reserved headroom for Cowork / Desktop / web (%)"
          htmlFor="head"
        >
          <Input
            id="head"
            type="number"
            min={0}
            max={95}
            placeholder="e.g. 30 — blank = reserve nothing"
            value={
              s.reservedHeadroomFraction === null
                ? ""
                : String(Math.round(s.reservedHeadroomFraction * 100))
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
            Those surfaces share your limits and write no local transcripts, so
            this tool cannot see them — reserving headroom shrinks every ceiling
            so guards trip early
            {s.reservedHeadroomFraction && s.weeklyCostLimit ? (
              <>
                {" · effective weekly ceiling "}
                <strong className="text-ink">
                  {fmtUSD(
                    s.weeklyCostLimit * (1 - s.reservedHeadroomFraction),
                  )}
                </strong>{" "}
                of {fmtUSD(s.weeklyCostLimit)}
              </>
            ) : null}
          </Hint>
        </Field>

        <details className="mb-3.5">
          <summary className="cursor-pointer text-xs text-ink-muted">
            Raw-token ceilings (fallback)
          </summary>
          <Hint className="mb-2.5">
            Used only when the matching cost ceiling above is blank
          </Hint>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="5-hour ceiling (tokens)" htmlFor="sess">
              <Input
                id="sess"
                type="number"
                min={0}
                placeholder="blank = unused"
                value={numOrEmpty(s.sessionTokenLimit)}
                onChange={(e) =>
                  patch({
                    sessionTokenLimit: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </Field>
            <Field label="Weekly ceiling (tokens)" htmlFor="wk">
              <Input
                id="wk"
                type="number"
                min={0}
                placeholder="blank = unused"
                value={numOrEmpty(s.weeklyTokenLimit)}
                onChange={(e) =>
                  patch({
                    weeklyTokenLimit: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </Field>
          </div>
        </details>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Weekly reset" htmlFor="anchor">
            <Select
              id="anchor"
              value={s.weeklyAnchor ? String(s.weeklyAnchor.weekday) : ""}
              onChange={(e) =>
                patch({
                  weeklyAnchor: e.target.value
                    ? {
                        weekday: Number(e.target.value),
                        hourUTC: s.weeklyAnchor?.hourUTC ?? 0,
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
            {s.weeklyAnchor && (
              <Input
                type="number"
                min={0}
                max={23}
                className="mt-2"
                aria-label="Reset hour (UTC)"
                value={s.weeklyAnchor.hourUTC}
                onChange={(e) =>
                  patch({
                    weeklyAnchor: {
                      weekday: s.weeklyAnchor!.weekday,
                      hourUTC: Number(e.target.value),
                    },
                  })
                }
              />
            )}
            <Hint>
              Hour is UTC — leave on rolling if you do not know your reset day
            </Hint>
          </Field>

          <Field label="5-hour window reset (override)" htmlFor="sessreset">
            <Input
              id="sessreset"
              type="datetime-local"
              value={toLocalInput(s.sessionResetOverrideAt)}
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
                s.sessionResetOverrideAt !== null &&
                Date.now() < s.sessionResetOverrideAt
                  ? "warn"
                  : "neutral"
              }
            >
              {s.sessionResetOverrideAt === null ? (
                "Blank is the normal state — only needed after a tier change, which restarts the window with no trace in any transcript"
              ) : Date.now() < s.sessionResetOverrideAt ? (
                <>
                  In force until{" "}
                  {new Date(s.sessionResetOverrideAt).toLocaleString()} — work
                  before it stays in history but leaves the current window and
                  the budget guard
                </>
              ) : (
                <>
                  Expired — that window ended{" "}
                  {new Date(s.sessionResetOverrideAt).toLocaleString()}; clear
                  the field to drop the split
                </>
              )}
            </Hint>
          </Field>
        </div>

        <Subsection title="Calibrate from history">
          <Hint className="mb-2.5 mt-0">
            Scans every transcript, finds the largest fully-elapsed 5-hour block
            and the peak trailing-7-day total, and proposes those as ceilings
          </Hint>
          <Button variant="secondary" onClick={calibrate} disabled={calBusy}>
            {calBusy ? "Scanning…" : "Run calibration"}
          </Button>

          {cal && !cal.ok && (
            <Notice tone="warn" className="mt-3.5">
              {cal.reason}
            </Notice>
          )}

          {cal?.ok && cal.suggestion && (
            <div className="mt-3.5">
              <TableWrap>
                <Table>
                  <tbody>
                    <Tr>
                      <Td>
                        Suggested 5-hour ceiling
                        <div className="text-xs text-ink-faint">
                          {fmtTokens(cal.suggestion.sessionTokenLimit ?? 0)} raw
                          tokens
                        </div>
                      </Td>
                      <Td num className="mono">
                        {cal.suggestion.sessionCostLimit === null
                          ? "—"
                          : fmtUSD(cal.suggestion.sessionCostLimit)}
                      </Td>
                    </Tr>
                    <Tr>
                      <Td>
                        Suggested weekly ceiling
                        <div className="text-xs text-ink-faint">
                          {fmtTokens(cal.suggestion.weeklyTokenLimit ?? 0)} raw
                          tokens
                        </div>
                      </Td>
                      <Td num className="mono">
                        {cal.suggestion.weeklyCostLimit === null
                          ? "—"
                          : fmtUSD(cal.suggestion.weeklyCostLimit)}
                      </Td>
                    </Tr>
                    <Tr>
                      <Td>History available</Td>
                      <Td num className="mono">
                        {cal.evidence?.historyDays ?? 0} days
                      </Td>
                    </Tr>
                    <Tr>
                      <Td>Confidence</Td>
                      <Td num>
                        <Badge
                          tone={
                            cal.confidence === "reasonable"
                              ? "ok"
                              : cal.confidence === "moderate"
                                ? "warn"
                                : "danger"
                          }
                        >
                          {cal.confidence}
                        </Badge>
                      </Td>
                    </Tr>
                  </tbody>
                </Table>
              </TableWrap>

              <Notice tone="warn" className="mt-3">
                {cal.caveat}
              </Notice>

              <Button
                variant="secondary"
                onClick={() =>
                  patch({
                    sessionCostLimit: cal.suggestion!.sessionCostLimit,
                    weeklyCostLimit: cal.suggestion!.weeklyCostLimit,
                    sessionTokenLimit: cal.suggestion!.sessionTokenLimit,
                    weeklyTokenLimit: cal.suggestion!.weeklyTokenLimit,
                  })
                }
              >
                Apply suggestion
              </Button>
              <Hint>
                Applies both metrics; cost drives the meters, tokens show as a
                secondary reading — remember to save
              </Hint>
            </div>
          )}
        </Subsection>
      </SectionCard>

      <SectionCard id="defaults" title="Run defaults">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Default model" htmlFor="model">
            <Input
              id="model"
              type="text"
              placeholder="blank = Claude Code's own default"
              value={s.defaultModel ?? ""}
              onChange={(e) => patch({ defaultModel: e.target.value || null })}
            />
            <Hint>
              e.g. <span className="mono">claude-opus-5</span> or{" "}
              <span className="mono">claude-sonnet-5</span>
            </Hint>
          </Field>

          <Field label="Default permission mode" htmlFor="pm">
            <Select
              id="pm"
              value={s.defaultPermissionMode}
              onChange={(e) => patch({ defaultPermissionMode: e.target.value })}
            >
              <option value="acceptEdits">acceptEdits</option>
              <option value="default">default</option>
              <option value="plan">plan</option>
              <option value="bypassPermissions">bypassPermissions</option>
            </Select>
            <Hint>Pre-selected on the new-run form; every run can override it</Hint>
          </Field>
        </div>
      </SectionCard>

      <SectionCard id="prompts" title="Prompts">
        <Field label="Continuation prompt" htmlFor="cont">
          <Textarea
            id="cont"
            className="min-h-[130px]"
            value={s.continuationPrompt}
            onChange={(e) => patch({ continuationPrompt: e.target.value })}
          />
          <Hint>
            Sent at the start of every work cycle after the first — the run ends
            when the reply contains <span className="mono">DONE</span> on its own
            line, so keep that instruction
          </Hint>
        </Field>

        <Field label="Carry-on prompt" htmlFor="pushback">
          <Textarea
            id="pushback"
            className="min-h-[130px]"
            value={s.donePushbackPrompt}
            onChange={(e) => patch({ donePushbackPrompt: e.target.value })}
          />
          <Hint>
            Sent when Claude reports <span className="mono">DONE</span> on a run
            set to keep going — point it at verification, or it will invent
            features
          </Hint>
        </Field>

        <Field label="Isolated-run preamble" htmlFor="isopre" className="mb-0">
          <Textarea
            id="isopre"
            className="min-h-[110px]"
            value={s.isolationPreamble}
            onChange={(e) => patch({ isolationPreamble: e.target.value })}
          />
          <Hint>
            Prepended to the first prompt of an isolated run — keep the
            instruction to commit, or the work never reaches your branch
          </Hint>
        </Field>
      </SectionCard>

      <SectionCard id="isolation" title="Concurrency & isolation">
        <Field label="Runs allowed at the same time" htmlFor="conc">
          <Input
            id="conc"
            type="number"
            min={1}
            placeholder="blank = no limit"
            value={s.maxConcurrentRuns ?? ""}
            onChange={(e) =>
              patch({
                maxConcurrentRuns: e.target.value
                  ? Number(e.target.value)
                  : null,
              })
            }
          />
          <Hint>
            Each run carries its own spending limit, so this multiplies the worst
            case — three runs at $5 can spend $15. Runs over the limit wait
            rather than being refused
          </Hint>
        </Field>

        <Field label="Files copied into a new checkout" htmlFor="copyglobs">
          {/* Held as raw text while editing. Splitting on every keystroke
              drops the separator the moment it is typed, which makes a
              second pattern impossible to enter. */}
          <Input
            id="copyglobs"
            value={copyGlobsText ?? s.isolationCopyGlobs.join(", ")}
            onChange={(e) => setCopyGlobsText(e.target.value)}
            onBlur={() => {
              if (copyGlobsText === null) return;
              patch({
                isolationCopyGlobs: copyGlobsText
                  .split(",")
                  .map((g) => g.trim())
                  .filter(Boolean),
              });
              setCopyGlobsText(null);
            }}
          />
          <Hint>
            A fresh checkout holds committed work only — prefix a pattern with{" "}
            <span className="mono">!</span> to exclude it. Dependencies are not
            copied; the agent installs them
          </Hint>
        </Field>

        <Field label="Landing a branch" htmlFor="landstrategy">
          <Select
            id="landstrategy"
            value={s.landStrategy}
            onChange={(e) =>
              patch({ landStrategy: e.target.value as "merge" | "squash" })
            }
          >
            <option value="merge">Merge, keeping the run&rsquo;s commits</option>
            <option value="squash">Squash the run into one commit</option>
          </Select>
          <Hint>
            Merging keeps the run page&rsquo;s diff meaningful afterwards;
            squashing gives your history one commit per run
          </Hint>
        </Field>

        <Field label="Keep waiting runs after a restart for" htmlFor="grace" className="mb-0">
          <div className="flex items-center gap-2">
            <Input
              id="grace"
              type="number"
              min={1}
              className="flex-1"
              value={s.resumeGraceHours}
              onChange={(e) => patch({ resumeGraceHours: Number(e.target.value) })}
            />
            <span className="whitespace-nowrap text-xs text-ink-muted">
              hours
            </span>
          </div>
          <Hint>
            Past this age a parked run is closed out instead, so a forgotten run
            cannot wake up days later and start spending
          </Hint>
        </Field>
      </SectionCard>

      <SectionCard id="advanced" title="Advanced">
        <Field className="mb-4">
          <Toggle
            id="side"
            checked={s.includeSidechains}
            onChange={(v) => patch({ includeSidechains: v })}
            label="Count sub-agent turns in usage totals"
          />
          <Hint>
            Sub-agent turns bill normally, so including them is the accurate
            default — exclude only to compare main-thread cost
          </Hint>
        </Field>

        <Field className="mb-4">
          <Toggle
            id="telemetry"
            checked={s.telemetryForRuns}
            onChange={(v) => patch({ telemetryForRuns: v })}
            label="Let agents report per-request cost over OpenTelemetry"
          />
          <Hint>
            The only record of what a work cycle killed mid-flight actually cost.
            Off by default because it changes the child process&rsquo;s
            behaviour; it never affects the dashboard or the budget guard
          </Hint>
        </Field>

        <Field className="mb-4">
          <Toggle
            id="killgroup"
            checked={s.killProcessGroup}
            onChange={(v) => patch({ killProcessGroup: v })}
            label="Stopping a run also stops everything it started"
          />
          <Hint>
            Builds, test runners and servers the agent launched hold the working
            directory open and keep writing to a folder the next run is about to
            use
          </Hint>
        </Field>

        <Field label="Live limit check" htmlFor="livechk" className="mb-0">
          <div className="flex items-center gap-2">
            <Input
              id="livechk"
              type="number"
              min={15}
              className="flex-1"
              value={s.liveGuardIntervalSeconds}
              onChange={(e) =>
                patch({ liveGuardIntervalSeconds: Number(e.target.value) })
              }
            />
            <span className="whitespace-nowrap text-xs text-ink-muted">
              seconds
            </span>
          </div>
          <Hint>
            How often a run set to stop mid-cycle re-reads usage — it cannot beat
            one turn however low this goes, because usage comes from transcripts
            written as each turn completes
          </Hint>
        </Field>
      </SectionCard>

      {saveError && (
        <Notice tone="danger">Nothing was saved: {saveError}</Notice>
      )}

      {/* Sticky, because one Save commits every field on a page that is now
          five sections long — the button must not be somewhere you have to
          hunt for after editing something at the top. */}
      {/* The negative margin must match the shell's gutter at each breakpoint,
          or the bar is wider than the page and scrolls it sideways. */}
      {/* Opaque and raised, not translucent: this bar spends most of its life
          lying across the middle of a card, and `bg-canvas/95` + blur left the
          card's border and text showing faintly through it — in dark mode,
          where canvas and surface are four hex digits apart, it read as a card
          torn in half with a button floating in the gap rather than as a bar in
          front of one. The upward shadow is what says "in front". */}
      <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-canvas px-4 py-3 shadow-bar sm:-mx-5 sm:px-5">
        <ButtonRow>
          <Button onClick={save} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={discard} disabled={busy}>
              Discard changes
            </Button>
          )}
          {dirty ? (
            <span className="text-xs text-warn">Unsaved changes</span>
          ) : saved ? (
            <Badge tone="ok">saved</Badge>
          ) : (
            <span className="text-xs text-ink-faint">
              Everything here is saved
            </span>
          )}
        </ButtonRow>
      </div>
    </>
  );
}
