import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentBlocksCard } from "./RecentBlocksCard";
import type { SessionBlockDTO } from "../lib/apiTypes";

/**
 * The Tokens column is a sum this card does itself, and the sum is the whole
 * risk.
 *
 * `TokenCountsDTO` has five members and a window's volume is all five. Dropping
 * one — `cacheWrite1h` is the one that arrived last and is easiest to forget —
 * understates every row against the meter this table exists to break down, and
 * it fails nothing: the column still holds a plausible number, the typecheck is
 * green, and no total on the page is drawn across these rows to disagree with.
 *
 * The tail is pinned for the reason `docs/agent/git-and-review.md` gives about a
 * shortened diff: a list that stops at fifteen saying nothing reads as the whole
 * set, and the count is drawn from the same constant that does the slicing, so
 * the two cannot be wired apart.
 */

const HOUR = 3_600_000;
const START = Date.UTC(2026, 7, 12, 10, 0);

function block(over: Partial<SessionBlockDTO> = {}): SessionBlockDTO {
  return {
    startsAt: START,
    endsAt: START + 5 * HOUR,
    lastActivityAt: START + HOUR,
    isActive: false,
    agg: {
      // Doubling, and every member far enough above `fmtTokens`' 0.01M step
      // that dropping any one of the five lands on a different string.
      tokens: {
        input: 100_000,
        output: 200_000,
        cacheRead: 400_000,
        cacheWrite5m: 800_000,
        cacheWrite1h: 1_600_000,
      },
      costUSD: 12.5,
      costGuardUSD: 12.5,
      entryCount: 7,
    },
    models: ["claude-opus-5", "claude-haiku-4-5-20251001"],
    projects: ["/w/one"],
    ...over,
  };
}

test("the token column is every one of the five counts", () => {
  const html = renderToStaticMarkup(<RecentBlocksCard blocks={[block()]} />);
  // 3.1M is all five. Dropping one gives 3.00M, 2.90M, 2.70M, 2.30M or 1.50M —
  // every omission is visible, which is what makes this assertion worth having.
  assert.match(html, /3\.10M/);
});

test("the claude- prefix is stripped from every model, not only the first", () => {
  const html = renderToStaticMarkup(<RecentBlocksCard blocks={[block()]} />);
  assert.match(html, /opus-5, haiku-4-5-20251001/);
  assert.doesNotMatch(html, /claude-/);
});

test("a live window is marked and a finished one is not", () => {
  const live = renderToStaticMarkup(
    <RecentBlocksCard blocks={[block({ isActive: true })]} />,
  );
  const done = renderToStaticMarkup(<RecentBlocksCard blocks={[block()]} />);
  assert.match(live, /live/);
  assert.doesNotMatch(done, /live/);
});

test("the tail is cut at fifteen and counted, never dropped silently", () => {
  const many = Array.from({ length: 18 }, (_, i) =>
    block({ startsAt: START + i * 5 * HOUR }),
  );
  const html = renderToStaticMarkup(<RecentBlocksCard blocks={many} />);
  assert.equal(html.match(/<tr/g)?.length, 16, "15 rows and one header row");
  assert.match(html, /3 older blocks are recorded but not listed\./);
});

test("exactly fifteen blocks says nothing about a tail", () => {
  const html = renderToStaticMarkup(
    <RecentBlocksCard
      blocks={Array.from({ length: 15 }, (_, i) =>
        block({ startsAt: START + i * 5 * HOUR }),
      )}
    />,
  );
  assert.doesNotMatch(html, /not listed/);
});

test("one omitted block is singular", () => {
  const html = renderToStaticMarkup(
    <RecentBlocksCard
      blocks={Array.from({ length: 16 }, (_, i) =>
        block({ startsAt: START + i * 5 * HOUR }),
      )}
    />,
  );
  assert.match(html, /1 older block is recorded but not listed\./);
});
