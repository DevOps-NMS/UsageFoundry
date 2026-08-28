"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib and UsagePeriods.tsx already do.
import type { RunEventDTO } from "../lib/apiTypes";
import { Card, CardTitle, Empty } from "./ui/Card";
import { Disclosure } from "./ui/Disclosure";
import { Hint } from "./ui/Hint";
import { Notice } from "./ui/Notice";

/**
 * The generation of the Land tab that `RunLand` replaced, kept whole and moved
 * one click away.
 *
 * Two things it says are not said anywhere else — the commit list as the agent
 * wrote it, and the `git merge` line — so it is an escape hatch rather than a
 * duplicate, and Tier 2 evidence is what a fold is for.
 *
 * What it withholds is unchanged and must stay withheld: the merge command is
 * absent entirely while the operator's checkout is dirty, never shown with a
 * warning, because a copyable command gets copied.
 *
 * Takes the event rather than its payload, and renders nothing without one: a
 * run that never handed off has no fold, and the alternative is a `&&` at the
 * call site that this component's own absent case already states.
 */
export function RunHandoff({ handoff }: { handoff: RunEventDTO | undefined }) {
  if (!handoff) return null;

  return (
    <Disclosure
      className="mt-4"
      summary="Do it in your own terminal"
      summaryClassName="text-xs font-semibold text-ink-muted"
    >
      <Card emphasis="quiet" className="mt-3">
        <CardTitle>In your own terminal</CardTitle>

        {Array.isArray(handoff.payload.commits) &&
        handoff.payload.commits.length > 0 ? (
          <div className="mono max-h-40 overflow-auto rounded-sm border border-line bg-inset p-2.5">
            {(handoff.payload.commits as string[]).map((c) => (
              <div key={c} className="whitespace-pre-wrap text-ink-muted">
                {c}
              </div>
            ))}
          </div>
        ) : (
          <Empty>The agent made no commits on this branch.</Empty>
        )}

        {Array.isArray(handoff.payload.uncommitted) &&
          handoff.payload.uncommitted.length > 0 && (
            <Notice tone="warn" quiet className="mt-3">
              <strong>Uncommitted changes left in the checkout.</strong> They are
              not on the branch, so a merge will not bring them over.
            </Notice>
          )}

        <div className="mt-4 border-t border-line pt-3.5">
          <div className="mb-2 text-xs font-semibold text-ink">Review it</div>
          {(Array.isArray(handoff.payload.review)
            ? (handoff.payload.review as string[])
            : []
          ).map((c) => (
            <div key={c} className="mono break-all text-ink-muted">
              {c}
            </div>
          ))}
        </div>

        <div className="mt-4 border-t border-line pt-3.5">
          <div className="mb-2 text-xs font-semibold text-ink">Bring it in</div>
          {handoff.payload.merge ? (
            <div className="mono break-all text-ink-muted">
              {String(handoff.payload.merge)}
            </div>
          ) : (
            // Withheld rather than shown with a caveat: a copyable command gets
            // copied.
            <Hint tone="warn">{String(handoff.payload.mergeBlocked)}</Hint>
          )}
        </div>
      </Card>
    </Disclosure>
  );
}
