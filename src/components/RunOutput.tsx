"use client";

import type { CycleOutput } from "@/lib/cycles";
import { fmtClock } from "@/lib/format";
import { Card, CardTitle } from "@/components/ui/Card";
import { Markdown } from "@/components/Markdown";

/**
 * What the agent said it did, one block per work cycle.
 *
 * The live log below already carries this text, but as one monospace line per
 * content block inside a stream of tool calls — so a report written as headings,
 * steps and a code fence arrives as an unreadable wall, and the reader scrolls
 * past the answer looking for it. This is the same words rendered as what they
 * were written as, and nothing else: no fetch, no second source, no spend.
 *
 * Only the most recent cycle is open. Earlier ones are the agent's account of
 * work that later cycles then changed, so they are history rather than the
 * outcome — but they are still each here, because a run that quietly reports
 * only its last cycle hides the cycle where it said it was stuck.
 */

function CycleBody({ cycle }: { cycle: CycleOutput }) {
  return (
    <div className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="mb-2 text-xs text-ink-muted">
        Work cycle {cycle.n} · {fmtClock(cycle.ts)}
        {cycle.resumed && " · same conversation"}
      </div>
      <Markdown text={cycle.text} />
    </div>
  );
}

/**
 * `cycles` rather than the raw events: the run page has to know whether there
 * is a report at all before it offers a tab for one, so it does the segmenting
 * and this renders it. Two callers of `cycleOutputs` over the same stream would
 * be the same walk twice on every paint.
 */
export function RunOutput({ cycles }: { cycles: CycleOutput[] }) {
  // Nothing to show rather than an empty card: a run that has not spoken yet is
  // already visibly working in the log, and a "waiting…" card beside it says
  // nothing the page does not already say.
  if (cycles.length === 0) return null;

  const latest = cycles[cycles.length - 1];
  const earlier = cycles.slice(0, -1);

  return (
    <Card>
      <CardTitle>What the agent reported</CardTitle>

      <CycleBody cycle={latest} />

      {earlier.length > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-muted">
            {earlier.length} earlier work cycle{earlier.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {earlier.map((c) => (
              <CycleBody key={`${c.n}-${c.ts}`} cycle={c} />
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
