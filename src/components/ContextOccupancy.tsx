"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib, Meter.tsx and LiveTelemetry.tsx already do.
import { Fragment, type ReactNode } from "react";
import type {
  ContextCompositionDTO,
  ContextCompositionSliceDTO,
  ContextOccupancyDTO,
  ContextSampleDTO,
} from "../lib/apiTypes";
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
 * produces a number that looks entirely ordinary.
 *
 * The caption used to say that on every render, on the same grounds
 * `LiveTelemetry`'s does. It no longer does: the operator read the standing
 * paragraph as wall-of-text and asked for it gone, so **nothing on this panel
 * states the separation to a sighted reader** — the sr-only prune table still
 * warns at its own figures, and this comment is the rest of the record. The
 * invariant is unchanged, only unsurfaced, and the arithmetic that breaks it
 * still typechecks: anything editing this file, or reading these two figures
 * together, has this paragraph and nothing on the screen to catch it.
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

          <CompositionStack
            readings={context.composition}
            readingCount={context.compositionCount}
            absence={context.compositionAbsence}
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
/* What the window is made of                                          */
/* ------------------------------------------------------------------ */

/**
 * The stack's own box, taller than the sparkline's rather than shorter.
 *
 * The line above is one series and reads at any height; this is six bands, two
 * of which are a few percent of the window, and at the sparkline's 56 the
 * thinnest of them were under a pixel of a 336px-wide card — present in the
 * markup, absent from the picture, and the legend beside them saying they had a
 * figure. 84 gives the smallest band about three pixels at its own scale.
 */
const STACK_H = 84;
const STACK_PLOT_H = STACK_H - PAD_TOP - 2;
/** Width of the single column drawn for a lone reading; see `CompositionStack`. */
const LONE_COLUMN_W = 44;

/**
 * The six fills, in the fixed order a band is assigned one.
 *
 * **Assigned to an entity and never cycled**, which is why this is an ordered
 * list read by a stable index rather than a modulo over however many bands
 * came back: a conversation that stops carrying attachments loses a band, and a
 * palette indexed by rank would repaint every band above it at that moment. The
 * order the index comes from is `bandOrder`.
 *
 * Deliberately none of the status tones. `stroke-danger` is already the ceiling
 * rule on the chart above this one, and a band wearing it would read as "this
 * part of your context is the problem" — which a composition must not assert,
 * least of all about `prefix`, the one part of it nothing here can cut.
 */
const BAND_FILL = [
  "fill-band-1",
  "fill-band-2",
  "fill-band-3",
  "fill-band-4",
  "fill-band-5",
  "fill-band-6",
] as const;

/**
 * What the window is made of, over the same span as the series above it.
 *
 * ## The one thing this must not be read as
 *
 * It is drawn against **winnow's** window, not the sample series'. Both are the
 * same measure — `input + cache_creation + cache_read` on a priced request —
 * and they are anchored differently: `apiContextTokens` takes the last
 * *main-thread* frame, sidechains excluded, because a sub-agent's turns are not
 * this conversation's context; winnow takes the last priced request in the
 * transcript whatever wrote it, and a sub-agent's frames are in that same file.
 * So the two agree on an idle conversation and come apart for exactly as long
 * as a sub-agent runs — 22 minutes at a stretch on this install. Scaling these
 * bands onto the sample's figure would hide that; the caption names it instead,
 * and nothing subtracts one from the other.
 *
 * ## Why the cycle ceiling is not on this chart
 *
 * It is on the one above, where the figure it bounds is drawn. Repeating it
 * here would put this app's own policy line across a picture measured from a
 * different anchor, and the first thing anyone would do with the two is read
 * the gap between them.
 *
 * ## Why the bands are ordered by total and not by size at each reading
 *
 * Winnow returns its nodes largest-first *per reading*, so two readings can
 * disagree about the order — and bands that swap places mid-chart cross each
 * other, which reads as one provenance turning into another. The order is
 * settled once, over the whole series, and every reading is stacked in it.
 */
function CompositionStack({
  readings,
  readingCount,
  absence,
}: {
  readings: ContextCompositionDTO[];
  readingCount: number;
  absence: ContextOccupancyDTO["compositionAbsence"];
}) {
  if (readings.length === 0) {
    return (
      <p className="mt-2 max-w-[68ch] text-xs leading-snug text-ink-muted">
        {absence === "off" ? (
          <>
            What the window is made of is not read: it costs a winnow
            subprocess, and context pruning is switched off, so nothing here
            runs winnow against this conversation.
          </>
        ) : (
          <>
            What the window is made of is taken on the guard tick, paced by
            how far the conversation has grown rather than by the clock — so a
            run that has not moved much yet has nothing to show.
          </>
        )}
      </p>
    );
  }

  const order = bandOrder(readings);
  const yMax = Math.max(...readings.map((r) => r.window), 1);
  const t0 = readings[0].ts;
  const span = readings[readings.length - 1].ts - t0;
  const lone = readings.length === 1;
  // A column, never an area, whenever the readings share one instant. For a
  // lone reading that is the point: one point stretched across the box asserts
  // this composition held for the whole span, which is the one claim a single
  // measurement cannot make. For several at the same `ts` — which the pacing
  // makes vanishingly unlikely and does not forbid — it is what stops the area
  // path collapsing to a zero-width sliver that renders as nothing at all.
  const column = lone || span <= 0;

  const x = (ts: number) =>
    column
      ? PAD_X + PLOT_W / 2
      : round(PAD_X + ((ts - t0) / span) * PLOT_W);
  const y = (tokens: number) =>
    round(PAD_TOP + (1 - Math.min(Math.max(tokens, 0), yMax) / yMax) * STACK_PLOT_H);

  // Cumulative tops, band by band, so each band's own area is the strip between
  // its top and the one below it.
  const stacked = readings.map((reading) => {
    const byLabel = new Map(reading.slices.map((s) => [s.label, s.tokens]));
    let running = 0;
    return order.map((label) => {
      running += byLabel.get(label) ?? 0;
      return { cx: x(reading.ts), top: y(running) };
    });
  });

  const baseline = PAD_TOP + STACK_PLOT_H;
  const latest = readings[readings.length - 1];
  const latestByLabel = new Map(latest.slices.map((s) => [s.label, s]));

  return (
    <>
      <svg
        // `h-auto` with a viewBox and the default `preserveAspectRatio`, for the
        // sparkline's reasons — see its own note.
        className="mt-3 block h-auto w-full"
        viewBox={`0 0 ${VIEW_W} ${STACK_H}`}
        role="img"
        aria-label={describeComposition(latest, order, readings.length)}
      >
        {order.map((label, band) => {
          const upper = stacked.map((cols) => cols[band]);
          const lower =
            band === 0 ? null : stacked.map((cols) => cols[band - 1]);

          const d = column
            ? // The column: a rectangle from this band's top down to the one
              // below it, or to the baseline for the first.
              `M${round(upper[0].cx - LONE_COLUMN_W / 2)} ${upper[0].top}` +
              `H${round(upper[0].cx + LONE_COLUMN_W / 2)}` +
              `V${lower ? lower[0].top : baseline}` +
              `H${round(upper[0].cx - LONE_COLUMN_W / 2)}Z`
            : upper.map((p, i) => `${i === 0 ? "M" : "L"}${p.cx} ${p.top}`).join(" ") +
              (lower
                ? // Back along the band below, right to left, which is what
                  // closes this band against it rather than against the floor.
                  lower
                    .map((p) => `L${p.cx} ${p.top}`)
                    .reverse()
                    .join(" ")
                : ` L${upper[upper.length - 1].cx} ${baseline} L${upper[0].cx} ${baseline}`) +
              "Z";

          return (
            <path
              key={label}
              d={d}
              className={`${BAND_FILL[band]} stroke-surface`}
              // The gap between stacked segments, drawn as a surface-coloured
              // edge rather than as a real gap: a gap would let the chart's ground
              // through and make each band look like it had its own baseline.
              //
              // 0.75 rather than the 2 a full-size chart takes, because this
              // viewBox is about 1:1 with device pixels and the stroke is
              // centred on the boundary — so it costs each band half its width
              // top and bottom. `conversation` is around 1% of the window here,
              // four units tall, and at 1.5 the separator was most of the band.
              strokeWidth="0.75"
              strokeLinejoin="round"
            >
              {/* The native tooltip, which is the whole of this chart's hover
                  layer. A crosshair would need client state on a component that
                  has none and is re-rendered on a three-second poll; the band's
                  own identity is what a pointer is actually asking for.

                  One interpolated string and never `{label} — {value}`. React
                  renders a `<title>` whose children are an *array* as empty,
                  with a console warning and no other symptom: the element is
                  there, the markup is well-formed, and every band's tooltip is
                  blank. */}
              <title>{`${label} — ${fmtTokens(
                latestByLabel.get(label)?.tokens ?? 0,
              )} at the last reading`}</title>
            </path>
          );
        })}
      </svg>

      {/* The legend, and it is not optional: six bands cannot be told apart by
          position, and `kind` — whether a figure was read, subtracted or
          estimated — is the one thing about a band that no fill can carry.

          One column and not two. These labels are winnow's and cannot be
          shortened here, and at 21rem a two-column grid truncated four of the
          six — "retained reaso…", "standing confi…" — which is the legend
          failing at the one job it has. Six rows is the cost. */}
      <ul className="mt-1.5 space-y-0.5 text-xs text-ink-muted">
        {order.map((label, band) => {
          const slice = latestByLabel.get(label);
          return (
            <li key={label} className="flex items-baseline gap-1.5">
              <svg
                viewBox="0 0 8 8"
                className="h-2 w-2 shrink-0 translate-y-px"
                aria-hidden="true"
              >
                <rect x="0" y="0" width="8" height="8" className={BAND_FILL[band]} />
              </svg>
              <span className="min-w-0 flex-1">{label}</span>
              <span className="tabular-nums">{fmtTokens(slice?.tokens ?? 0)}</span>
            </li>
          );
        })}
      </ul>

      {/* Discrete, so it is a table — the same split the sparkline makes. The
          `kind` column is here rather than in the legend because it is a word
          per row and the legend is two columns of a 21rem pane. */}
      <div className="sr-only">
        <Table>
          <caption>
            What the window held at the last reading, and how each figure was
            reached.
          </caption>
          <THead>
            <tr>
              <Th>Provenance</Th>
              <Th num>Tokens</Th>
              <Th>How it was reached</Th>
            </tr>
          </THead>
          <TBody>
            {order.map((label) => {
              const slice = latestByLabel.get(label);
              return (
                <Tr key={label}>
                  <Td>{label}</Td>
                  <Td num>{fmtTokens(slice?.tokens ?? 0)}</Td>
                  <Td>{slice?.kind || "not stated"}</Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </div>

      <p className="mt-1.5 max-w-[68ch] text-xs leading-snug text-ink-muted">
        {/* The load-bearing sentence of this half of the panel. The two windows
            are the same measure from different anchors, and the whole reason
            this is said here rather than in a note somewhere on the page is
            `LiveTelemetry`'s: a separation stated once, away from the figure,
            is a separation nobody reads at the moment they need it. */}
        Winnow&rsquo;s reading of the same window, apportioned. It anchors on the
        last priced request in the transcript where the figure above anchors on
        the last <em>main-thread</em> one, so the two totals part company for as
        long as a sub-agent runs. Take each against its own chart and subtract
        neither from the other.
        {lone && <> One reading so far; the area appears from the second.</>}
        {readingCount > readings.length && (
          <>
            {" "}
            The newest {readings.length} of {readingCount} readings.
          </>
        )}
      </p>
    </>
  );
}

/**
 * The order bands are stacked in, settled once over the whole series.
 *
 * Largest total at the bottom, and anything winnow called a **residual** on top
 * whatever its size. The residual is what nothing accounted for, so it is the
 * one band whose height is a statement about the measurement rather than about
 * the conversation; buried between two real provenances it reads as one of
 * them, and at the top it reads as the gap it is.
 *
 * Ties break on the label so the order is total rather than merely stable —
 * two provenances at exactly zero must not swap between two polls.
 */
function bandOrder(readings: ContextCompositionDTO[]): string[] {
  const totals = new Map<string, number>();
  const residual = new Set<string>();
  for (const reading of readings) {
    for (const slice of reading.slices) {
      totals.set(slice.label, (totals.get(slice.label) ?? 0) + slice.tokens);
      if (slice.kind === "residual") residual.add(slice.label);
    }
  }
  return [...totals.keys()]
    .sort((a, b) => {
      const ra = residual.has(a) ? 1 : 0;
      const rb = residual.has(b) ? 1 : 0;
      if (ra !== rb) return ra - rb;
      const d = (totals.get(b) ?? 0) - (totals.get(a) ?? 0);
      return d !== 0 ? d : a.localeCompare(b);
    })
    // A seventh provenance would be a band with no fill assigned to it. Dropped
    // rather than given a generated hue, and the bands then fail to sum to the
    // window, which is visible — where a repeated colour is not.
    .slice(0, BAND_FILL.length);
}

/**
 * The composition in words, for the reader who gets no picture.
 *
 * The *latest* reading rather than the series' shape, which is the opposite of
 * what `describeSeries` does and is right for the opposite reason: a stacked
 * area's subject is the proportions at a moment, and six bands' worth of
 * trajectory is a paragraph nobody can hold. The table under it carries the
 * figures.
 */
function describeComposition(
  latest: ContextCompositionDTO,
  order: string[],
  readings: number,
): string {
  const parts = order.map((label) => {
    const slice = latest.slices.find((s) => s.label === label);
    const tokens = slice?.tokens ?? 0;
    const pct =
      latest.window > 0 ? Math.round((tokens / latest.window) * 100) : 0;
    return `${label} ${fmtTokens(tokens)} (${pct}%)`;
  });
  return (
    `What the context is made of, over ${readings} ` +
    `${readings === 1 ? "reading" : "readings"}. At the last one the window was ` +
    `${fmtTokens(latest.window)} tokens: ${parts.join(", ")}.`
  );
}

/* ------------------------------------------------------------------ */
/* The caption                                                         */
/* ------------------------------------------------------------------ */

/**
 * What this drawing is doing that the picture alone does not say.
 *
 * Every clause is conditional, so the ordinary case — an api-basis series that
 * is complete, current and short — renders **nothing**, and this returns `null`
 * rather than an empty `<p>`, whose bottom margin would otherwise sit under the
 * chart with no text in it. The standing prose that used to open it, naming the
 * two token currencies and the one-turn lag, was removed at the operator's ask:
 * it was read as wall-of-text, being the longest paragraph in that region. What
 * it stated is unchanged as a fact about the data and is on record on the module
 * doc above; nothing on this panel asserts it any more except the sr-only prune
 * table's warning at its own figures.
 *
 * The clauses are assembled as a list rather than written as siblings inside the
 * `<p>` because each used to carry its own leading separator, prose having run
 * before it. Whichever one renders first now opens the paragraph, and there is
 * no combination in which that one may start with a space.
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

  const clauses: { key: string; node: ReactNode }[] = [];

  if (held >= HOLD_NOTICE_MS) {
    clauses.push({
      key: "held",
      node: (
        <>
          Nothing has moved it for {fmtDuration(held)} and it is still being
          read: the series only gains a point when this run&rsquo;s{" "}
          <em>main thread</em> finishes another request, and a long tool call or
          a sub-agent adds nothing to that — a sub-agent&rsquo;s turns are not
          this conversation&rsquo;s context and do not enter it until its result
          comes back. The figure is current; it is the conversation that is
          waiting.
        </>
      ),
    });
  }

  if (latest.basis === "transcript") {
    clauses.push({
      key: "latest-fallback",
      node: (
        <>
          This last reading had no usage frame to read and fell back to the
          transcript&rsquo;s byte estimate — a different measure rather than a
          rougher one, so the percentage above is against a quantity the rest of
          the series is not in.
        </>
      ),
    });
  }

  if (fallbacks > 0 && latest.basis !== "transcript") {
    clauses.push({
      key: "earlier-fallbacks",
      node: (
        <>
          {fallbacks} earlier {fallbacks === 1 ? "reading" : "readings"} fell
          back to the transcript&rsquo;s byte estimate with no usage frame to
          read; those are drawn hollow, and are a different measure rather than a
          rougher one.
        </>
      ),
    });
  }

  if (sampleCount > samples.length) {
    clauses.push({
      key: "tail",
      node: (
        <>
          Drawn from the newest {samples.length} of {sampleCount} readings — the
          end of the series, not a thinning of it. Every point returned is drawn.
        </>
      ),
    });
  }

  if (samples.length > DOT_LIMIT) {
    clauses.push({
      key: "dots",
      node: (
        <>
          Past {DOT_LIMIT} readings the per-point dots stand down and the line is
          drawn alone — it still passes through every one of them.
        </>
      ),
    });
  }

  if (hiddenPrunes > 0) {
    clauses.push({
      key: "hidden-prunes",
      node: (
        <>
          {hiddenPrunes} {hiddenPrunes === 1 ? "prune falls" : "prunes fall"}{" "}
          outside the span drawn and {hiddenPrunes === 1 ? "is" : "are"} not
          marked.
        </>
      ),
    });
  }

  if (samples.length === 1) {
    clauses.push({
      key: "single",
      node: <>One reading so far; the line appears from the second.</>,
    });
  }

  if (clauses.length === 0) return null;

  return (
    <p className="mt-2 max-w-[68ch] text-xs leading-snug text-ink-muted">
      {clauses.map((clause, i) => (
        <Fragment key={clause.key}>
          {i > 0 && " "}
          {clause.node}
        </Fragment>
      ))}
    </p>
  );
}
