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
import { Field, Input, Select } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";

/**
 * When this workflow starts itself.
 *
 * The one card in this app describing something that spends money with nobody
 * looking, so it is built round the two things an operator has to be able to
 * check at a glance: the **next fire time as an absolute instant**, and **what
 * it last did**. A schedule whose skips are invisible looks exactly like a
 * schedule that is working, which is why the outcome line is on the card rather
 * than in a log — and why a run of identical skips reads as one state with a
 * count rather than as the newest of fifty.
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

function minutesOf(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
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

  function save() {
    const spec =
      draft.kind === "everyHours"
        ? { kind: draft.kind, hours: draft.hours }
        : draft.kind === "daily"
          ? { kind: draft.kind, minutes: minutesOf(draft.time) }
          : {
              kind: draft.kind,
              weekday: draft.weekday,
              minutes: minutesOf(draft.time),
            };
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
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">
                    {schedule.description}
                  </span>
                  {schedule.paused && <Badge tone="warn">paused</Badge>}
                </div>
                {/* The absolute instant, not "in about an hour": a schedule an
                    operator cannot verify at a glance is one they will not
                    trust with an unattended agent. */}
                <div className="mt-1 text-sm text-ink-muted">
                  {schedule.paused ? "Would next start " : "Next starts "}
                  <span className="mono text-ink">
                    {fmtDateTime(schedule.nextFireAt)}
                  </span>{" "}
                  ({fmtRelative(schedule.nextFireAt)})
                </div>
              </div>
              <ButtonRow>
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
                  disabled={busy || confirmDelete}
                >
                  Remove
                </Button>
              </ButtonRow>
            </div>

            {schedule.refusal && (
              <Notice tone="danger">
                {schedule.refusal} Until then this schedule starts nothing.
              </Notice>
            )}

            {schedule.lastCode && (
              <div className="mt-4 border-t border-line pt-3 text-sm text-ink-muted">
                <div className="flex flex-wrap items-baseline gap-2">
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
                    <span>
                      ×{schedule.streak} since {fmtDateTime(schedule.streakSince)}
                    </span>
                  )}
                </div>
                {schedule.lastReason && (
                  <div className="mt-1 max-w-[80ch]">{schedule.lastReason}</div>
                )}
                {schedule.lastCode === "started" && schedule.lastInstanceId && (
                  <div className="mt-1">
                    <Link
                      href={`/workflows/${workflowId}/instances/${schedule.lastInstanceId}`}
                    >
                      What it started
                    </Link>
                  </div>
                )}
              </div>
            )}

            {confirmDelete && (
              <Notice tone="danger" live>
                <div className="mb-2">
                  Removing the schedule leaves the workflow, and anything it has
                  already started, untouched.
                </div>
                <ButtonRow>
                  <Button
                    variant="danger"
                    size="compact"
                    onClick={() => send("DELETE")}
                    busy={busy}
                  >
                    Remove schedule
                  </Button>
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </ButtonRow>
              </Notice>
            )}
          </>
        )}

        {editing && (
          <div className="max-w-lg">
            <Notice tone="warn">
              A schedule presses Run with nobody watching. Every block still runs
              under the guards its template names, and this workflow&rsquo;s own
              limits still stop the whole graph — nothing here changes either.
            </Notice>

            <Field label="How often" htmlFor="sched-kind">
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
            </Field>

            {draft.kind === "weekly" && (
              <Field label="Day" htmlFor="sched-weekday">
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
              </Field>
            )}

            {draft.kind !== "everyHours" && (
              <Field label="Time" htmlFor="sched-time">
                <Input
                  id="sched-time"
                  type="time"
                  value={draft.time}
                  onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                />
              </Field>
            )}

            {draft.kind === "everyHours" && (
              <Field
                label="Interval"
                htmlFor="sched-hours"
                hint="counted from the moment you save, so it does not move when the clocks do"
              >
                <Input
                  id="sched-hours"
                  type="number"
                  min={1}
                  max={168}
                  value={draft.hours}
                  unit="hours"
                  onChange={(e) =>
                    setDraft({ ...draft, hours: Number(e.target.value) })
                  }
                />
              </Field>
            )}

            {draft.kind !== "everyHours" && (
              <Field
                label="Timezone"
                htmlFor="sched-tz"
                hint="an IANA name — the server runs in UTC and reads this time in the zone you name"
              >
                <Input
                  id="sched-tz"
                  value={draft.timeZone}
                  onChange={(e) =>
                    setDraft({ ...draft, timeZone: e.target.value })
                  }
                />
              </Field>
            )}

            <ButtonRow>
              <Button onClick={save} busy={busy} disabled={busy}>
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
      </Card>
    </>
  );
}
