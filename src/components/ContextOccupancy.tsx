"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib, Meter.tsx and LiveTelemetry.tsx already do.
import type { ContextOccupancyDTO, ContextSampleDTO } from "../lib/apiTypes";
import { fmtClock, fmtDuration, fmtRelative, fmtTokens } from "../lib/format";
import { Meter } from "./Meter";
import { Stat } from "./ui/Card";
import { TBody, THead, Table, Td, Th, Tr } from "./ui/Table";

/**
 * How far the figure may fall behind the read before the gap is worth naming.
 *
 * Above the two-minute ceiling on the read itself, deliberately: a gap smaller
 * than that is one tick that found the same frame, which is the ordinary case
 * on any tool call and says nothing an operator needs. What this catches is the
 * case that used to render as a dead poll — a run inside one long tool call or
 * one sub-agent, whose main thread has not been billed for a request in
 * minutes, and whose figure is nonetheless the current one.
 */
const HOLD_NOTICE_MS = 3 * 60_000;

/**
 * How full one run's context is now, and how it got there.
 *
 * ## The one thing this must not be read as
 *
 * Every other token figure on the run page is either money or the transcript's
 * own turns. This is neither: it is `apiContextTokens` — the whole prompt as the
 * API was billed for the last finished request — which is the basis the cycle
 * ceiling acts on and the *only* basis a percentage of that ceiling can be
 * computed in. The pruning block two regions away counts `contextTokens`, and
 * the two are tens of thousands of tokens apart **in both directions** on this
 * install: the prompt carries a system prompt and tool list no transcript holds,
 * while the intake filter drops tool results the transcript keeps. So a prune's
 * `tokensRemoved` is not the drop drawn here, and subtracting one from the other
 * produces a number that looks entirely ordinary. The caption is what stops
 * that, on the same grounds `LiveTelemetry`'s does.
 *
 * ## Why the ceiling travels on the wire
 *
 * `ceilingTokens` comes from the DTO and is never written here. The constant
 * behind it has already moved twice — 167,000, then 300,000, then 200,000 — and
 * a component dividing by a hardcoded 200,000 would go on drawing the old
 * percentage after the next move, correctly-looking and wrong.
 *
 * ## Why the age shown is not the newest point's
 *
 * `lastCheck` is when the tick last *read* this run; the newest sample is when
 * the number last *moved*. They come apart by design — the series is
 * deduplicated on the `usage` frame it came from, and a run whose main thread is
 * inside one sub-agent gains no frame at all for as long as that lasts, measured
 * at 22 minutes on this install. Drawing the sample's own timestamp as "read 22m
 * ago" said the poll had died when what had actually happened was that the
 * figure was still correct, which is the one thing this panel must not get
 * backwards. So the age is the read's, and the hold is said separately.
 *
 * ## What the picture claims
 *
 * Every returned sample is drawn; nothing is thinned. The series is already
 * capped server-side at `CONTEXT_SERIES_MAX_POINTS` as a **tail** rather than a
 * thinned set, and when it is holding one the caption says so — a graph that
 * quietly drops points claims a smoothness its data does not have. Dots are the
 * one thing that stands down on a long run, and they carry no information the
 * line does not, except for the fallback-basis markers, which are drawn at every
 * length because a reading in a different measure is not decoration.
 */
export function ContextOccupancy({
  context,
  now,
  live,
}: {
  context: ContextOccupancyDTO;
  now: number;
  /**
   * Whether the run can still move. Only the wording depends on it: the last
   * point of a finished run is a final reading, and "read 3h ago" on a series
   * that will never gain another point reads as a stalled poll.
   */
  live: boolean;
}) {
  const { ceilingTokens, samples, sampleCount, prunes, pruneCount } = context;

  // A ceiling of zero is not a ceiling. Guarded rather than divided by, because
  // `x / 0` is `Infinity`, `Meter` treats a non-finite fraction as unknown, and
  // the two would agree by accident rather than because anything checked.
  const hasCeiling = Number.isFinite(ceilingTokens) && ceilingTokens > 0;
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const fraction =
    latest !== null && hasCeiling ? latest.tokens / ceilingTokens : null;

  // Only while the run can move. A finished run's last reading is final and the
  // tick that took it stopped when the run did, so an age against it would count
  // up for ever on a number nothing is going to change.
  const check = live ? context.lastCheck : null;
  // Falls back to the sample's own timestamp, which is what this line said
  // before `lastCheck` existed: a server restarted mid-run has read nothing yet,
  // and borrowing the previous process's reading would be exactly the freshness
  // this exists to stop inventing.
  const readAt = check?.ts ?? latest?.ts ?? now;
  const held = latest === null || check === null ? 0 : check.ts - latest.ts;

  return (
    <>
      {latest === null ? (
        // Deliberately not a zero fill. `Meter`'s hatch is this app's vocabulary
        // for "no figure", and an empty bar here would read as "this run is
        // using none of its context" for a run nothing has measured yet.
        //
        // The meter says it and nothing above it repeats it: a headline over a
        // hint that carries the same words is one fact wearing two voices, and
        // the reader then looks for the difference between them.
        <>
          <Meter
            size="compact"
            label="Of the cycle ceiling"
            fraction={null}
            unknownHint="not measured yet"
          />
          <p className="mt-2 max-w-[68ch] text-xs leading-snug text-ink-muted">
            Readings are taken on the live-guard tick, so a run that has not been
            ticked yet — or one that finished before this series existed — has
            nothing to show.{" "}
            {pruneCount > 0 && (
              <>
                Its {pruneCount} {pruneCount === 1 ? "prune is" : "prunes are"}{" "}
                recorded, with no series to mark{" "}
                {pruneCount === 1 ? "it" : "them"} on.
              </>
            )}
          </p>
        </>
      ) : (
        <>
          {/* The figure and the fill. The token count leads because it is what
              the operator carries to a transcript; the percentage rides the
              meter's own head, where it is already tabular and already sized. */}
          <Stat>{fmtTokens(latest.tokens)}</Stat>
          <div className="mt-0.5 text-xs tabular-nums text-ink-muted">
            {!live ? (
              <>final reading</>
            ) : check?.basis === "unreadable" ? (
              // Said in place of the age rather than beside it. A read that
              // failed is not a fresh reading, and "read just now" over a figure
              // nothing could confirm is the one wording that would make this
              // panel worse than having none.
              <>last read {fmtRelative(readAt, now)} found nothing to read</>
            ) : (
              <>read {fmtRelative(readAt, now)}</>
            )}
            {held >= HOLD_NOTICE_MS && (
              <> · unchanged for {fmtDuration(held)}</>
            )}{" "}
            · work cycle {latest.iteration}
          </div>
          <Meter
            size="compact"
            label="Of the cycle ceiling"
            fraction={fraction}
            unknownHint="no ceiling reported"
          />

          <Sparkline
            samples={samples}
            prunes={prunes}
            ceilingTokens={ceilingTokens}
          />

          <Caption
            context={context}
            latest={latest}
            held={held}
            drawnPrunes={prunesInSpan(samples, prunes).length}
          />
        </>
      )}

      {/* Outside the branch: a run with prunes and no samples still owes a
          reader what they were, and the marks are the half of this panel that
          is a list of events rather than a shape. */}
      {prunes.length > 0 && (
        <div className="sr-only">
          <Table>
            <caption>
              Each cut this run&rsquo;s context took, in order. Measured in the
              transcript&rsquo;s own turns, which is not the measure the series
              above is drawn in — these figures say when a fall happened, never
              how far the line should drop.
              {pruneCount > prunes.length && (
                <>
                  {" "}
                  The newest {prunes.length} of {pruneCount}.
                </>
              )}
            </caption>
            <THead>
              <tr>
                <Th>When</Th>
                <Th>What triggered it</Th>
                <Th num>Removed</Th>
              </tr>
            </THead>
            <TBody>
              {prunes.map((p, i) => (
                <Tr key={`${p.ts}-${i}`}>
                  <Td>{fmtClock(p.ts)}</Td>
                  <Td>{PRUNE_TRIGGER[p.trigger] ?? p.trigger}</Td>
                  <Td num>{fmtTokens(p.tokensRemoved)} tokens</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </>
  );
}

/**
 * The two triggers spelled for a reader, and anything else passed through.
 *
 * `trigger` is a bare `string` on the wire rather than a union, so an unknown
 * value has to render as itself: a lookup that fell back to "pruned" would put
 * a word on the screen for a mechanism nobody named.
 */
const PRUNE_TRIGGER: Record<string, string> = {
  boundary: "at a work-cycle boundary",
  "early-end": "a cycle ended early on the ceiling",
};

/* ------------------------------------------------------------------ */
/* The sparkline                                                       */
/* ------------------------------------------------------------------ */

/**
 * A fixed user-space box, scaled by the browser rather than by arithmetic here.
 *
 * `preserveAspectRatio` is left at its default on purpose: `none` would stretch
 * the box to the column and take the stroke widths, the dot radii and the
 * marker triangles with it, so the same picture would be drawn differently in
 * the inspector and on a phone. At 320 wide it is already narrower than the
 * 21rem inspector column, so the scale is a shrink of at most a few percent.
 */
const VIEW_W = 320;
const VIEW_H = 56;
const PAD_X = 3;
/** Room above the ceiling rule so it is a line on the chart, not its edge. */
const PAD_TOP = 5;
/** Room under the baseline for the prune markers, which hang below it. */
const PAD_BOTTOM = 10;
const PLOT_W = VIEW_W - PAD_X * 2;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;

/**
 * Above this many points the per-sample dots stand down and the line is drawn
 * alone.
 *
 * They are an affordance rather than data — the polyline already passes through
 * every point — so dropping them claims nothing about the series. The
 * fallback-basis markers are exempt and drawn at every length, because those
 * *are* data: they say a point is in a different measure from its neighbours.
 */
const DOT_LIMIT = 60;

function Sparkline({
  samples,
  prunes,
  ceilingTokens,
}: {
  samples: ContextSampleDTO[];
  prunes: ContextOccupancyDTO["prunes"];
  ceilingTokens: number;
}) {
  const t0 = samples[0].ts;
  const span = samples[samples.length - 1].ts - t0;
  const peak = samples.reduce((m, s) => Math.max(m, s.tokens), 0);
  // The ceiling is always on the chart, so the distance to it is readable
  // without arithmetic; a cycle that overshot it before the boundary caught it
  // still has to fit, which is why this is a max rather than the ceiling flat.
  const yMax = Math.max(ceilingTokens, peak, 1);

  const x = (ts: number) =>
    round(span <= 0 ? PAD_X + PLOT_W / 2 : PAD_X + ((ts - t0) / span) * PLOT_W);
  const y = (tokens: number) =>
    round(
      PAD_TOP + (1 - Math.min(Math.max(tokens, 0), yMax) / yMax) * PLOT_H,
    );

  const baseline = PAD_TOP + PLOT_H;
  const ceilingY = y(ceilingTokens);
  const points = samples.map((s) => ({ s, cx: x(s.ts), cy: y(s.tokens) }));
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.cx} ${p.cy}`)
    .join(" ");

  // Clamped away rather than clamped to an edge: a mark pinned to the first
  // drawn point asserts a cut happened at a time it did not. The caption counts
  // the ones that fall outside instead.
  const marks = prunesInSpan(samples, prunes);
  const fallbacks = samples.filter((s) => s.basis === "transcript").length;

  return (
    <>
      <svg
        // `h-auto` with a viewBox: the intrinsic ratio drives the height, so the
        // box never letterboxes and never has to be kept in step with VIEW_H.
        className="mt-2.5 block h-auto w-full"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={describeSeries(samples, prunes, ceilingTokens, peak)}
      >
        {/* The floor of the scale, so a line low in the box is visibly low
            rather than floating. */}
        <path
          d={`M${PAD_X} ${baseline}H${VIEW_W - PAD_X}`}
          className="stroke-line"
          strokeWidth="1"
          fill="none"
        />

        {/* The ceiling. Dashed rather than tinted, because the legend under the
            chart names it in words and a reader who cannot separate the two
            colours still has a solid line and a broken one. */}
        <path
          d={`M${PAD_X} ${ceilingY}H${VIEW_W - PAD_X}`}
          className="stroke-danger"
          strokeWidth="1.25"
          strokeDasharray="4 3"
          fill="none"
        />

        {/* Where the falls came from. Drawn under the series so the line stays
            the thing the eye follows. */}
        {marks.map((p, i) => {
          const mx = x(p.ts);
          return (
            <g key={`prune-${p.ts}-${i}`}>
              <path
                d={`M${mx} ${PAD_TOP}V${baseline}`}
                className="stroke-accent"
                strokeWidth="1"
                strokeDasharray="2 2.5"
                fill="none"
              />
              <path
                d={`M${mx} ${baseline + 1.5}L${round(mx + 3)} ${baseline + 8}L${round(mx - 3)} ${baseline + 8}Z`}
                className="fill-accent"
              />
            </g>
          );
        })}

        {samples.length > 1 && (
          <path
            d={line}
            className="stroke-accent"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        )}

        {points.map((p, i) => {
          const last = i === points.length - 1;
          // A hollow square, never a smaller circle: this point was measured
          // off the transcript's bytes rather than a usage frame, and a reader
          // has to be able to tell that apart from its neighbours in greyscale.
          if (p.s.basis === "transcript") {
            const r = last ? 2.6 : 2;
            return (
              <rect
                key={`f-${i}`}
                x={round(p.cx - r)}
                y={round(p.cy - r)}
                width={r * 2}
                height={r * 2}
                className="fill-surface stroke-accent"
                strokeWidth="1.2"
              />
            );
          }
          if (!last && samples.length > DOT_LIMIT) return null;
          return (
            <circle
              key={`d-${i}`}
              cx={p.cx}
              cy={p.cy}
              r={last ? 2.6 : 1.6}
              className="fill-accent"
            />
          );
        })}
      </svg>

      {/* The legend, and the reason the two chart rules are not colour alone:
          each one is named here beside the mark that draws it. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <svg viewBox="0 0 14 4" className="h-1 w-3.5" aria-hidden="true">
            <path
              d="M0 2h14"
              className="stroke-danger"
              strokeWidth="2"
              strokeDasharray="4 3"
              fill="none"
            />
          </svg>
          <span className="tabular-nums">
            ceiling {fmtTokens(ceilingTokens)}
          </span>
        </span>
        {marks.length > 0 && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <svg viewBox="0 0 8 8" className="h-2 w-2" aria-hidden="true">
              <path d="M4 0.5 7.4 7H0.6Z" className="fill-accent" />
            </svg>
            <span className="tabular-nums">
              {marks.length} {marks.length === 1 ? "prune" : "prunes"}
            </span>
          </span>
        )}
        {fallbacks > 0 && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <svg viewBox="0 0 8 8" className="h-2 w-2" aria-hidden="true">
              <rect
                x="1.6"
                y="1.6"
                width="4.8"
                height="4.8"
                className="fill-surface stroke-accent"
                strokeWidth="1.4"
              />
            </svg>
            <span className="tabular-nums">{fallbacks} byte estimate</span>
          </span>
        )}
      </div>
    </>
  );
}

/**
 * Two decimals, because this markup is re-rendered every three seconds.
 *
 * Full float precision puts fifteen digits into every coordinate of a
 * five-hundred-point path for a picture drawn at three hundred pixels.
 */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The prune marks that fall inside the drawn span.
 *
 * Samples and prunes are capped independently on the wire, so a long run can
 * return a prune older than its oldest returned sample. Such a mark has no
 * honest position: the chart's x axis starts at the first sample, and pinning it
 * to that edge would say the cut happened at a time it did not.
 */
function prunesInSpan(
  samples: ContextSampleDTO[],
  prunes: ContextOccupancyDTO["prunes"],
): ContextOccupancyDTO["prunes"] {
  if (samples.length === 0) return [];
  const t0 = samples[0].ts;
  const t1 = samples[samples.length - 1].ts;
  return prunes.filter((p) => p.ts >= t0 && p.ts <= t1);
}

/**
 * The series in words, for the reader who gets no picture at all.
 *
 * A sparkline's text alternative is its shape and its notable points, not a
 * transcription of five hundred coordinates — the marks are listed as a table
 * below, where a row per event is a form a screen reader can move through.
 */
function describeSeries(
  samples: ContextSampleDTO[],
  prunes: ContextOccupancyDTO["prunes"],
  ceilingTokens: number,
  peak: number,
): string {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const pct = (n: number) =>
    ceilingTokens > 0 ? ` (${Math.round((n / ceilingTokens) * 100)}%)` : "";

  if (samples.length === 1) {
    return (
      `Context occupancy: one reading so far, ${fmtTokens(first.tokens)} tokens` +
      `${pct(first.tokens)} against a ceiling of ${fmtTokens(ceilingTokens)}, ` +
      `taken at ${fmtClock(first.ts)}. No shape yet.`
    );
  }

  const marks = prunesInSpan(samples, prunes);
  return (
    `Context occupancy: ${samples.length} readings from ${fmtClock(first.ts)} ` +
    `to ${fmtClock(last.ts)}, against a ceiling of ${fmtTokens(ceilingTokens)} ` +
    `tokens. It starts at ${fmtTokens(first.tokens)}${pct(first.tokens)}, ` +
    `peaks at ${fmtTokens(peak)}${pct(peak)} and is now ` +
    `${fmtTokens(last.tokens)}${pct(last.tokens)}. ` +
    (marks.length === 0
      ? "No prune falls inside this span, so every fall in the line is the conversation's own."
      : `${marks.length} ${marks.length === 1 ? "prune is" : "prunes are"} marked inside it; the line falls at each.`)
  );
}

/* ------------------------------------------------------------------ */
/* The caption                                                         */
/* ------------------------------------------------------------------ */

/**
 * What stops this figure being added to, or subtracted from, the others.
 *
 * The run page carries four token figures in three different currencies, and
 * `LiveTelemetry` is the precedent for where the separation lives: in the
 * component's own caption, every time the figure is drawn, rather than in a
 * note somewhere on the page. The load-bearing sentence is the third — see
 * `ContextOccupancy.test.tsx`.
 */
function Caption({
  context,
  latest,
  held,
  drawnPrunes,
}: {
  context: ContextOccupancyDTO;
  latest: ContextSampleDTO;
  /** How far the newest reading trails the newest read; 0 where it does not. */
  held: number;
  drawnPrunes: number;
}) {
  const { samples, sampleCount, prunes } = context;
  const fallbacks = samples.filter((s) => s.basis === "transcript").length;
  const hiddenPrunes = prunes.length - drawnPrunes;

  return (
    <p className="mt-2 max-w-[68ch] text-xs leading-snug text-ink-muted">
      The whole prompt as the API was billed for this run&rsquo;s last finished
      request, against the size a work cycle is ended early at. It lags one turn
      by construction — a cycle mid-turn shows the request before this one. The
      pruning figures on this page are in the transcript&rsquo;s own turns
      instead, which runs tens of thousands of tokens either side of this in both
      directions, so a prune&rsquo;s removed tokens must not be subtracted from
      anything here.
      {held >= HOLD_NOTICE_MS && (
        <>
          {" "}
          Nothing has moved it for {fmtDuration(held)} and it is still being
          read: the series only gains a point when this run&rsquo;s{" "}
          <em>main thread</em> finishes another request, and a long tool call or
          a sub-agent adds nothing to that — a sub-agent&rsquo;s turns are not
          this conversation&rsquo;s context and do not enter it until its result
          comes back. The figure is current; it is the conversation that is
          waiting.
        </>
      )}
      {latest.basis === "transcript" && (
        <>
          {" "}
          This last reading had no usage frame to read and fell back to the
          transcript&rsquo;s byte estimate — a different measure rather than a
          rougher one, so the percentage above is against a quantity the rest of
          the series is not in.
        </>
      )}
      {fallbacks > 0 && latest.basis !== "transcript" && (
        <>
          {" "}
          {fallbacks} earlier {fallbacks === 1 ? "reading" : "readings"} fell
          back to the transcript&rsquo;s byte estimate with no usage frame to
          read; those are drawn hollow, and are a different measure rather than a
          rougher one.
        </>
      )}
      {sampleCount > samples.length && (
        <>
          {" "}
          Drawn from the newest {samples.length} of {sampleCount} readings — the
          end of the series, not a thinning of it. Every point returned is drawn.
        </>
      )}
      {samples.length > DOT_LIMIT && (
        <>
          {" "}
          Past {DOT_LIMIT} readings the per-point dots stand down and the line is
          drawn alone — it still passes through every one of them.
        </>
      )}
      {hiddenPrunes > 0 && (
        <>
          {" "}
          {hiddenPrunes} {hiddenPrunes === 1 ? "prune falls" : "prunes fall"}{" "}
          outside the span drawn and {hiddenPrunes === 1 ? "is" : "are"} not
          marked.
        </>
      )}
      {samples.length === 1 && (
        <>
          {" "}
          One reading so far; the line appears from the second.
        </>
      )}
    </p>
  );
}
