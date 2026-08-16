"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  FleetReopenReportDTO,
  FleetStateDTO,
  FleetStopReportDTO,
} from "@/lib/apiTypes";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";

/**
 * The three controls that act on the whole install.
 *
 * Every stop in this app is per run or per workflow instance, which at
 * twenty-five unattended runs is twenty-five pages — so the only install-wide
 * control was stopping the container, and that discards every in-flight cycle's
 * spend accounting. These three compose out of the transitions a single run
 * already uses; see `src/lib/fleet.ts` for why none of them is a new one.
 *
 * Both consequential presses go through a `Sheet`, and the stop's opens with
 * Cancel focused — that is what `danger` does, and one Return on a control that
 * ends twenty-five billed agents is not a confirmation.
 *
 * The hold is deliberately **not** part of the stop. An operator stopping the
 * fleet to re-point it wants the queue to carry on afterwards; one who wants
 * both presses both, and the sheet says so in a sentence.
 */
export function FleetControls({
  /**
   * Terminal runs this page is currently displaying, in the order it shows
   * them. Handed in rather than read here, because the whole point of the rule
   * is that the ids on the wire are the ones somebody looked at — a run that
   * failed between the render and the click must not be swept into a pick-up
   * nobody saw. `POST /api/chat/[id]/approve` follows the same rule.
   */
  reopenable,
  /** Called after anything that can have changed a run, so the list re-reads. */
  onChanged,
}: {
  reopenable: Array<{ id: string; status: string }>;
  onChanged: () => void;
}) {
  const [state, setState] = useState<FleetStateDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [maxIterations, setMaxIterations] = useState("1");
  const [maxRunCostUSD, setMaxRunCostUSD] = useState("");

  const load = useCallback(async () => {
    const res = await jsonRequest<{ state: FleetStateDTO }>("/api/fleet");
    if (res.ok) setState(res.data.state);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = state
    ? Object.values(state.counts).reduce((a, b) => a + b, 0)
    : 0;

  async function post(body: Record<string, unknown>, describe: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await jsonRequest<{
        state: FleetStateDTO;
        report?: FleetStopReportDTO & FleetReopenReportDTO;
      }>("/api/fleet", { method: "POST", body });
      if (!res.ok) {
        setError(actionFailureMessage(res, `Could not ${describe}.`));
        return;
      }
      setState(res.data.state);
      setNote(summarize(body.action as string, res.data.report));
    } finally {
      setBusy(false);
      setConfirmStop(false);
      setConfirmReopen(false);
      // Either way: a request that never came back may still have been carried
      // out, and the list below is where the operator finds out.
      onChanged();
      void load();
    }
  }

  const paused = state?.newWorkPaused === true;

  return (
    <Card emphasis="quiet" className="mb-8">
      <CardTitle>
        Fleet
        {paused && <Badge tone="warn">new work held</Badge>}
      </CardTitle>

      <div role="status" aria-live="polite">
        {note && <Notice tone="info">{note}</Notice>}
      </div>
      <div role="alert">{error && <Notice tone="danger">{error}</Notice>}</div>

      {paused && (
        <Notice tone="warn">
          <strong>New work is held.</strong> Nothing starts — queued runs stay
          queued, dependents stay waiting, schedules do not fire and an
          orchestrator block cannot emit. Anything already running carries on to
          its own end.
        </Notice>
      )}

      <p className="mb-4 max-w-[68ch] text-sm text-ink-muted">
        {state
          ? live === 0
            ? "Nothing is in flight."
            : `${describeCounts(state)}${
                state.startedInstances > 0
                  ? `, in ${state.startedInstances} workflow run${
                      state.startedInstances === 1 ? "" : "s"
                    }`
                  : ""
              }.`
          : "Reading…"}
      </p>

      <ButtonRow>
        <Button
          variant="danger"
          disabled={busy || live === 0}
          onClick={() => setConfirmStop(true)}
        >
          Stop everything
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void post({ action: paused ? "resume" : "pause" }, "change that")}
        >
          {paused ? "Resume new work" : "Hold new work"}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || reopenable.length === 0}
          onClick={() => setConfirmReopen(true)}
        >
          Pick up {reopenable.length} stopped
        </Button>
      </ButtonRow>

      <Sheet
        open={confirmStop}
        onDismiss={() => setConfirmStop(false)}
        title="Stop every run in flight"
        confirmLabel="Stop everything"
        confirmVariant="danger"
        busy={busy}
        onConfirm={() => void post({ action: "stop" }, "stop the fleet")}
      >
        <p>
          {state ? describeCounts(state) : ""}. Every workflow run is halted
          whole, and every run outside one is stopped where it stands — a run
          with a child in flight gets the same signal ladder its own Stop button
          uses, so a cycle that can report what it spent still does.
        </p>
        <p className="mt-3 text-ink-muted">
          This does not hold new work. A queued run that is released afterwards
          starts as usual; press Hold new work as well if you want the queue to
          stay still.
        </p>
      </Sheet>

      <Sheet
        open={confirmReopen}
        onDismiss={() => setConfirmReopen(false)}
        title={`Pick up ${reopenable.length} run${reopenable.length === 1 ? "" : "s"}`}
        confirmLabel="Pick them up"
        busy={busy}
        onConfirm={() =>
          void post(
            {
              action: "reopen",
              runIds: reopenable.map((r) => r.id),
              budget: {
                maxIterations: maxIterations === "" ? null : Number(maxIterations),
                maxRunCostUSD:
                  maxRunCostUSD === "" ? null : Number(maxRunCostUSD),
              },
            },
            "pick those up",
          )
        }
      >
        <p className="mb-4">
          The {reopenable.length} failed or stopped run
          {reopenable.length === 1 ? "" : "s"} listed on this page, each
          continuing its own session. One budget applies to all of them; a run
          that has already used more than it allows is refused by name and left
          alone. Two kinds are not in this list at all: one that reported the
          task done, and one you set aside — both are a decision per run, on its
          own page.
        </p>
        <Field
          label="Work cycles"
          hint="Blank means no cycle limit, which needs a time limit on each run"
        >
          <Input
            type="number"
            min={1}
            value={maxIterations}
            onChange={(e) => setMaxIterations(e.target.value)}
          />
        </Field>
        <Field label="Spending limit (USD)" hint="Blank switches it off">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={maxRunCostUSD}
            onChange={(e) => setMaxRunCostUSD(e.target.value)}
          />
        </Field>
      </Sheet>
    </Card>
  );
}

/** "3 running, 2 queued, 1 waiting" — zeroes left out, order fixed. */
function describeCounts(state: FleetStateDTO): string {
  const order = ["running", "queued", "paused", "waiting"];
  const parts = order
    .filter((s) => (state.counts[s] ?? 0) > 0)
    .map((s) => `${state.counts[s]} ${s}`);
  return parts.length === 0 ? "Nothing is in flight" : parts.join(", ");
}

/**
 * What just happened, counted.
 *
 * A press that stopped nothing and a press that never arrived look identical
 * otherwise, and this control's whole job is being believed at 02:00.
 */
function summarize(
  action: string,
  report?: FleetStopReportDTO & FleetReopenReportDTO,
): string {
  if (action === "pause") return "New work is held.";
  if (action === "resume") return "New work may start again.";
  if (action === "reopen" && report) {
    const refused = report.refused.length;
    return (
      `Picked up ${report.reopened.length} run${report.reopened.length === 1 ? "" : "s"}` +
      (refused > 0
        ? `. ${refused} refused — ${report.refused
            .slice(0, 3)
            .map((r) => `${r.id.slice(0, 8)}: ${r.reason}`)
            .join(" ")}`
        : ".")
    );
  }
  if (action === "stop" && report) {
    const parts = [
      `${report.signalled.length} signalled`,
      `${report.cancelled.length} closed out`,
      `${report.blocked.length} that had not started`,
    ];
    const instances = report.instances.filter((i) => i.acted).length;
    return (
      `Stopped ${parts.join(", ")}` +
      (instances > 0
        ? `, across ${instances} workflow run${instances === 1 ? "" : "s"}.`
        : ".")
    );
  }
  return "Done.";
}
