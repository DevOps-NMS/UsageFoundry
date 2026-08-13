"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunDTO, RunReviewDTO } from "@/lib/apiTypes";
import { fmtDateTime, fmtUSD, pollFailureMessage } from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Spinner } from "@/components/ui/Log";
import { Markdown } from "@/components/Markdown";

/**
 * An AI read of what the run changed — asked for, never automatic.
 *
 * The button is the whole point: a review is a billed Claude Code invocation,
 * and one that ran on its own would be spend nobody authorised. Its cost is
 * shown here and nowhere else — it is deliberately absent from the run's own
 * spend, which counts work cycles.
 *
 * The renderer this used to own now lives in `Markdown.tsx`, because a work
 * cycle's own final message is rendered with it too. It gained fenced code and
 * inline markers there — a review that quotes a patch is better for it.
 */

function ReviewBody({ review }: { review: RunReviewDTO }) {
  return (
    <div className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span>{fmtDateTime(review.createdAt)}</span>
        {review.status === "running" ? (
          <Badge tone="accent">
            <Spinner /> running
          </Badge>
        ) : review.status === "failed" ? (
          <Badge tone="danger">failed</Badge>
        ) : (
          <Badge tone="ok">done</Badge>
        )}
        <span>
          {fmtUSD(review.costUSD)} · {review.model ?? "default model"}
        </span>
      </div>

      {review.truncated && (
        <Notice tone="warn" quiet>
          <strong>
            {review.diffShown} of {review.diffFiles} changed files were shown to it.
          </strong>{" "}
          The rest were named but not included, so this review says nothing about
          them.
        </Notice>
      )}

      {review.status === "failed" && <Notice tone="danger">{review.error}</Notice>}
      {review.status === "running" && (
        <div aria-live="polite">
          <Empty>Reading the diff — this takes a minute or two.</Empty>
        </div>
      )}
      {review.text && <Markdown text={review.text} />}
    </div>
  );
}

export function RunReview({ run }: { run: RunDTO }) {
  const [reviews, setReviews] = useState<RunReviewDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The land card's failure, in a card that spends money the same way: this
  // poll only runs while a review is in flight, so a read dropped on the floor
  // left "Reading the diff" on screen after the review had finished or failed.
  const load = useCallback(async () => {
    const res = await jsonRequest<{ reviews: RunReviewDTO[] }>(
      `/api/runs/${run.id}/review`,
    );
    if (!res.ok) {
      setReadError(pollFailureMessage(res.status, res.error));
      return;
    }
    setReviews(res.data.reviews);
    setReadError(null);
  }, [run.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only while one is in flight — a finished run's page otherwise does no work.
  const running = reviews?.some((r) => r.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [running, load]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await jsonRequest(`/api/runs/${run.id}/review`, {
        method: "POST",
      });
      if (!res.ok) setError(actionFailureMessage(res, "Could not start a review."));
      await load();
    } finally {
      setStarting(false);
    }
  }

  const latest = reviews?.[0];
  const earlier = reviews?.slice(1) ?? [];

  return (
    // Never the lead: a review is optional, billed, and only exists because
    // somebody pressed the button.
    <Card emphasis="quiet" className="mt-6">
      <CardTitle>
        Review
        <Button
          className="ml-auto transition-colors duration-150"
          onClick={start}
          disabled={starting || running}
          variant="secondary"
        >
          {running ? "Reviewing…" : reviews?.length ? "Review again" : "Review this run"}
        </Button>
      </CardTitle>

      <div role="alert">
        {readError && <Notice tone="danger">{readError}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>

      {/* Beside the button whether or not a review already exists: "Review
          again" spends exactly as much as the first one did. */}
      <Hint>
        Runs Claude once against this run&rsquo;s diff. It is billed and spends
        against the same 5-hour window your runs do
      </Hint>

      {!latest && <Empty>No review yet.</Empty>}

      {latest && <ReviewBody review={latest} />}

      {earlier.length > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-muted">
            {earlier.length} earlier review{earlier.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {earlier.map((r) => (
              <ReviewBody key={r.id} review={r} />
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
