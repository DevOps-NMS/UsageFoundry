"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";

interface Restarted {
  count: number;
  runs: { id: string; prompt: string; status: string }[];
}

interface Reopened {
  reopened: number;
  refused: { id: string; reason: string }[];
}

/**
 * "N runs were closed out by a restart", and one press to pick them all up.
 *
 * The only route back used to be the run page, one run at a time, each asking
 * for a budget at the door — and nothing in the product said the runs were
 * there at all. The count went to a `console.warn` at boot, into a container
 * log, so the operator's first sign of a restart was a dashboard that had gone
 * quiet.
 *
 * Read once rather than polled. It is a fact about the last boot: it changes
 * when this component changes it, and at no other time.
 *
 * The press is behind a `Sheet` because it starts up to N billed agents at
 * once, which is the one thing in this app that never happens without somebody
 * saying so a second time. The sheet states the count, which is the number that
 * matters.
 */
export function RestartClosed({ onReopened }: { onReopened: () => void }) {
  const [state, setState] = useState<Restarted | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await jsonRequest<Restarted>("/api/runs/restarted");
    // A failed read shows nothing. This is standing context rather than a
    // reading being acted on, and the page's own poll already reports a server
    // that has stopped answering.
    setState(res.ok ? res.data : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function pickUpAll() {
    setBusy(true);
    setError(null);
    const res = await jsonRequest<Reopened>("/api/runs/restarted", { method: "POST" });
    setBusy(false);
    setConfirming(false);

    if (!res.ok) {
      setError(
        actionFailureMessage(res, "Could not pick those runs up. Try again."),
      );
      return;
    }

    const { reopened, refused } = res.data;
    setOutcome(
      refused.length === 0
        ? `${reopened} run${reopened === 1 ? "" : "s"} back in the queue.`
        : `${reopened} back in the queue. ${refused.length} refused: ${refused
            .map((r) => `${r.id.slice(0, 8)} — ${r.reason}`)
            .join(" ")}`,
    );
    await load();
    onReopened();
  }

  if (error) {
    return (
      <Notice tone="danger" live>
        {error}
      </Notice>
    );
  }

  if (outcome && (state === null || state.count === 0)) {
    return (
      <Notice tone="info" live>
        {outcome}
      </Notice>
    );
  }

  if (!state || state.count === 0) return null;

  const { count } = state;

  return (
    <>
      <Notice tone="warn">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {count} run{count === 1 ? " was" : "s were"} closed out when the
            server last restarted. Nothing of theirs was lost — each carries on
            from the session it left off in.
          </span>
          <Button onClick={() => setConfirming(true)} disabled={busy}>
            Pick up {count}
          </Button>
        </div>
      </Notice>

      <Sheet
        open={confirming}
        title={`Pick up ${count} run${count === 1 ? "" : "s"}?`}
        onDismiss={() => setConfirming(false)}
        confirmLabel="Pick up"
        onConfirm={() => void pickUpAll()}
        confirmDisabled={busy}
        busy={busy}
      >
        <p>
          Each goes back in the queue under the limits it was started with, and
          starts spending again as soon as its folder is free. Your concurrency
          limit still applies.
        </p>
      </Sheet>
    </>
  );
}
