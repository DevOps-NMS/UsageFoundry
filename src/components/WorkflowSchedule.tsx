"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  ScheduleOutcomeCodeDTO,
  ScheduleSpecDTO,
  WorkflowScheduleDTO,
} from "@/lib/apiTypes";
import { fmtDateTime, fmtRelative, type BadgeTone } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Field";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";

/**
 * When this workflow starts itself.
 *
 * The one card in this app describing something that spends money with nobody
 * looking, so it is built round the two things an operator has to be able to
 * check at a glance: **the recurrence in words and the next fire time as an
 * absolute instant, side by side**, and **what it last did**. Those two are
 * adjacent rows of one grouped box rather than a sentence and a caption,
 * because "every day at 09:00" and "next starts 15 Aug 2026, 09:00" only verify
 * each other when they are read together — a relative "in about an hour" is
 * exactly the form that cannot be checked.
 *
 * A schedule whose skips are invisible looks exactly like a schedule that is
 * working, which is why the outcome is a row here rather than a line in a log —
 * and why a run of identical skips reads as one state with a count rather than
 * as the newest of fifty.
 */

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** What each outcome means, in the operator's words rather than the code's. */
const OUTCOME: Record<
  ScheduleOutcomeCodeDTO,
  { label: string; tone: BadgeTone }
> = {
  started: { label: "started", tone: "ok" },
  overlap: { label: "skipped", tone: "warn" },
  unbudgeted: { label: "not started", tone: "danger" },
  refused: { label: "not started", tone: "danger" },
  missed: { label: "missed", tone: "warn" },
};

/** `540` → `"09:00"`, for a time input. */
function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60,
  ).padStart(2, "0")}`;
}

/**
 * `"09:00"` → `540`, and null for a time input holding nothing.
 *
 * A `<input type="time">` legitimately holds `""` — the browser's own clear
 * affordance produces it — and the arithmetic below turns that into `NaN`.
 * Returning it was the bug: `JSON.stringify` has no NaN and emits `null`, which
 * the server then read as a deliberate 00:00. Null rather than NaN so the one
 * caller has to answer for it.
 */
function minutesOf(value: string): number | null {
  const [h, m] = value.split(":");
  const minutes = Number(h) * 60 + Number(m);
  return Number.isFinite(minutes) && minutes >= 0 && minutes < 24 * 60
    ? minutes
    : null;
}

type Draft = {
  kind: ScheduleSpecDTO["kind"];
  hours: number;
  time: string;
  weekday: number;
  timeZone: string;
};

function draftOf(schedule: WorkflowScheduleDTO | null, browserZone: string): Draft {
  const spec = schedule?.spec;
  return {
    kind: spec?.kind ?? "daily",
    hours: spec?.kind === "everyHours" ? spec.hours : 6,
    time:
      spec && spec.kind !== "everyHours" ? hhmm(spec.minutes) : "09:00",
    weekday: spec?.kind === "weekly" ? spec.weekday : 1,
    timeZone: schedule?.timeZone ?? browserZone,
  };
}

export function WorkflowSchedule({
  workflowId,
  schedule,
  onChanged,
}: {
  workflowId: string;
  schedule: WorkflowScheduleDTO | null;
  /** Reload the workflow, so the card redraws off the server's own answer. */
  onChanged: () => void | Promise<void>;
}) {
  // The zone the operator is reading the page in, which is the zone they mean
  // when they type a time. The container runs in UTC and would otherwise be the
  // default — an hour or two out, silently, for the life of the schedule.
  const [browserZone, setBrowserZone] = useState("UTC");
  useEffect(() => {
    setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }, []);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(schedule, "UTC"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function openEditor() {
    setDraft(draftOf(schedule, browserZone));
    setError(null);
    setEditing(true);
  }

  async function send(method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/schedule`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setEditing(false);
      setConfirmDelete(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Derived rather than held, so the message and the disabled Save cannot
  // disagree with what `save` would actually put on the wire.
  const minutes = draft.kind === "everyHours" ? null : minutesOf(draft.time);
  const timeError =
    draft.kind !== "everyHours" && minutes === null
      ? "A schedule needs a time of day. 00:00 is a time; blank is not."
      : null;

  function save() {
    if (draft.kind === "everyHours") {
      return send("PUT", {
        kind: draft.kind,
        hours: draft.hours,
        timeZone: draft.timeZone.trim(),
      });
    }
    // Unreachable behind the disabled Save, and guarded anyway: this is the step
    // that puts the value on the wire, where a NaN becomes a null and a null
    // used to become midnight. The server refuses it too.
    if (minutes === null) return;
    const spec =
      draft.kind === "daily"
        ? { kind: draft.kind, minutes }
        : { kind: draft.kind, weekday: draft.weekday, minutes };
    return send("PUT", { ...spec, timeZone: draft.timeZone.trim() });
  }

  return (
    <>
      <CardTitle className="mt-8">Schedule</CardTitle>
      <Card emphasis="quiet">
        <div role="alert">
          {error && (
            <Notice tone="danger" live>
              {error}
            </Notice>
          )}
        </div>

        {!schedule && !editing && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-ink-muted">
              Nothing starts this workflow but you.
            </div>
            <Button variant="secondary" size="compact" onClick={openEditor}>
              Add schedule
            </Button>
          </div>
        )}

        {schedule && !editing && (
          <>
            <ListGroup>
              <ListRow
                label="Repeats"
                description={
                  schedule.spec.kind === "everyHours"
                    ? "counted from when it was saved, so it does not move when the clocks do"
                    : `read in ${schedule.timeZone}`
                }
              >
                <span className="text-sm text-ink">{schedule.description}</span>
                {schedule.paused && <Badge tone="warn">paused</Badge>}
              </ListRow>

              {/* The absolute instant, not "in about an hour": a schedule an
                  operator cannot verify at a glance is one they will not trust
                  with an unattended agent. The relative form is beside it
                  rather than instead of it. */}
              <ListRow label={schedule.paused ? "Would next start" : "Next start"}>
                {schedule.nextFireAt === null ? (
                  // Never a stand-in instant: the refusal below says why.
                  <span className="text-sm text-warn">unknown</span>
                ) : (
                  <>
                    <span className="mono text-ink">
                      {fmtDateTime(schedule.nextFireAt)}
                    </span>
                    <span className="text-xs text-ink-muted">
                      {fmtRelative(schedule.nextFireAt)}
                    </span>
                  </>
                )}
              </ListRow>

              {schedule.lastCode && (
                <ListRow
                  label="Last occurrence"
                  description={schedule.lastReason ?? undefined}
                >
                  <Badge tone={OUTCOME[schedule.lastCode].tone}>
                    {OUTCOME[schedule.lastCode].label}
                  </Badge>
                  {schedule.lastFireAt !== null && (
                    <span className="mono text-ink">
                      {fmtDateTime(schedule.lastFireAt)}
                    </span>
                  )}
                  {/* Fifty identical rows are a log nobody reads; one row with
                      a count is a fact somebody acts on. */}
                  {schedule.streak > 1 && schedule.streakSince !== null && (
                    <span className="text-xs tabular-nums text-ink-muted">
                      ×{schedule.streak} since {fmtDateTime(schedule.streakSince)}
                    </span>
                  )}
                </ListRow>
              )}
            </ListGroup>

            {schedule.lastCode === "started" && schedule.lastInstanceId && (
              <div className="mt-2 text-sm">
                <Link
                  href={`/workflows/${workflowId}/instances/${schedule.lastInstanceId}`}
                >
                  What it started
                </Link>
              </div>
            )}

            {schedule.refusal && (
              <Notice tone="danger" className="mt-4">
                {schedule.refusal} Until then this schedule starts nothing.
              </Notice>
            )}

            <ButtonRow className="mt-4">
              <Button
                variant="secondary"
                size="compact"
                onClick={() => send("PATCH", { paused: !schedule.paused })}
                disabled={busy}
              >
                {schedule.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                onClick={openEditor}
                disabled={busy}
              >
                Change
              </Button>
              <Button
                variant="ghost"
                size="compact"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
              >
                Remove
              </Button>
            </ButtonRow>
          </>
        )}

        {editing && (
          <div className="max-w-lg">
            <Notice tone="warn">
              A schedule presses Run with nobody watching. Every block still runs
              under the guards its template names, and this workflow&rsquo;s own
              limits still stop the whole graph — nothing here changes either.
            </Notice>

            <ListGroup>
              <ListRow label="How often" htmlFor="sched-kind">
                <div className="w-52">
                  <Select
                    id="sched-kind"
                    value={draft.kind}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        kind: e.target.value as ScheduleSpecDTO["kind"],
                      })
                    }
                  >
                    <option value="daily">Every day at a time</option>
                    <option value="weekly">Every week on a day</option>
                    <option value="everyHours">Every N hours</option>
                  </Select>
                </div>
              </ListRow>

              {draft.kind === "weekly" && (
                <ListRow label="Day" htmlFor="sched-weekday">
                  <div className="w-40">
                    <Select
                      id="sched-weekday"
                      value={String(draft.weekday)}
                      onChange={(e) =>
                        setDraft({ ...draft, weekday: Number(e.target.value) })
                      }
                    >
                      {WEEKDAYS.map((day, i) => (
                        <option key={day} value={i}>
                          {day}
                        </option>
                      ))}
                    </Select>
                  </div>
                </ListRow>
              )}

              {draft.kind !== "everyHours" && (
                <ListRow
                  label="Time"
                  htmlFor="sched-time"
                  // The message rides the row's own description, which is what
                  // reaches the control as aria-describedby — a `Field`'s error
                  // slot has nothing to align a right edge against in a row.
                  description={
                    timeError ? (
                      <span className="text-danger">{timeError}</span>
                    ) : undefined
                  }
                >
                  <div className="w-32">
                    <Input
                      id="sched-time"
                      type="time"
                      aria-invalid={timeError !== null || undefined}
                      value={draft.time}
                      onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                    />
                  </div>
                </ListRow>
              )}

              {draft.kind === "everyHours" && (
                <ListRow
                  label="Interval"
                  htmlFor="sched-hours"
                  description="counted from the moment you save, so it does not move when the clocks do"
                >
                  <div className="w-36">
                    <Input
                      id="sched-hours"
                      type="number"
                      min={1}
                      max={168}
                      className="tabular-nums"
                      value={draft.hours}
                      unit="hours"
                      onChange={(e) =>
                        setDraft({ ...draft, hours: Number(e.target.value) })
                      }
                    />
                  </div>
                </ListRow>
              )}

              {draft.kind !== "everyHours" && (
                <ListRow
                  label="Timezone"
                  htmlFor="sched-tz"
                  description="an IANA name — the server runs in UTC and reads this time in the zone you name"
                >
                  <div className="w-52">
                    <Input
                      id="sched-tz"
                      value={draft.timeZone}
                      onChange={(e) =>
                        setDraft({ ...draft, timeZone: e.target.value })
                      }
                    />
                  </div>
                </ListRow>
              )}
            </ListGroup>

            <ButtonRow className="mt-4">
              {/* Disabled only alongside the row message that says why — a
                  Save that is off with nothing explaining it is a dead end. */}
              <Button
                onClick={save}
                busy={busy}
                disabled={busy || timeError !== null}
              >
                Save schedule
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </ButtonRow>
          </div>
        )}

        {/* A sheet rather than a panel under the card, for the reason the
            branch purge is one: the confirmation is the whole interaction, and
            a sheet is what makes the pane behind it inert while it is open. */}
        <Sheet
          open={confirmDelete}
          onDismiss={() => setConfirmDelete(false)}
          title="Remove this schedule?"
          confirmLabel="Remove schedule"
          confirmVariant="danger"
          busy={busy}
          onConfirm={() => send("DELETE")}
        >
          Nothing will start this workflow but you. The workflow itself, and
          anything the schedule has already started, are untouched.
        </Sheet>
      </Card>
    </>
  );
}
