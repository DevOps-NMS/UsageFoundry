"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunDTO, RunReviewDTO } from "@/lib/apiTypes";
import { fmtDateTime, fmtUSD } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Spinner } from "@/components/ui/Log";

/**
 * An AI read of what the run changed — asked for, never automatic.
 *
 * The button is the whole point: a review is a billed Claude Code invocation,
 * and one that ran on its own would be spend nobody authorised. Its cost is
 * shown here and nowhere else — it is deliberately absent from the run's own
 * spend, which counts work cycles.
 */

/**
 * The three headings the reviewer is asked for, rendered without a markdown
 * dependency. Deliberately small: it handles headings, bullets and paragraphs,
 * and anything else falls through as text rather than as markup this cannot be
 * sure of.
 */
function Rendered({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed">
      {text.split("\n").map((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) {
          return (
            <div
              key={i}
              className="mt-3.5 mb-1 text-sm font-semibold text-ink first:mt-0"
            >
              {trimmed.replace(/^#+\s*/, "")}
            </div>
          );
        }
        if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
          return (
            <div key={i} className="mb-1 flex gap-2 pl-1">
              <span className="text-ink-faint">•</span>
              <span className="min-w-0 flex-1">{trimmed.replace(/^([-*]|\d+\.)\s+/, "")}</span>
            </div>
          );
        }
        if (!trimmed) return <div key={i} className="h-2" />;
        return (
          <p key={i} className="mb-1.5">
            {trimmed}
          </p>
        );
      })}
    </div>
  );
}

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
        <Empty>Reading the diff — this takes a minute or two.</Empty>
      )}
      {review.text && <Rendered text={review.text} />}
    </div>
  );
}

export function RunReview({ run }: { run: RunDTO }) {
  const [reviews, setReviews] = useState<RunReviewDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/runs/${run.id}/review`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { reviews: RunReviewDTO[] };
    setReviews(json.reviews);
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
      const res = await fetch(`/api/runs/${run.id}/review`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setError(json.error ?? "Could not start a review.");
      await load();
    } finally {
      setStarting(false);
    }
  }

  const latest = reviews?.[0];
  const earlier = reviews?.slice(1) ?? [];

  return (
    <Card className="mt-6">
      <CardTitle>
        Review
        <Button
          className="ml-auto"
          onClick={start}
          disabled={starting || running}
          variant="secondary"
        >
          {running ? "Reviewing…" : reviews?.length ? "Review again" : "Review this run"}
        </Button>
      </CardTitle>

      {error && <Notice tone="danger">{error}</Notice>}

      {!latest && (
        <>
          <Empty>No review yet.</Empty>
          <Hint>
            Runs Claude once against this run&rsquo;s diff. It is billed and spends
            against the same 5-hour window your runs do
          </Hint>
        </>
      )}

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
