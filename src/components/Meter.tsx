"use client";

// Relative, not "@/lib/format": tsconfig.test.json emits plain CommonJS and
// nothing rewrites the path alias at runtime, so a tested component has to
// import the way src/lib already does.
import { fmtPct, severityFor, type Severity } from "../lib/format";

/**
 * A single limit meter.
 *
 * `fraction === null` means no ceiling is configured. That renders as a hatched
 * indeterminate bar rather than an empty one — an empty bar reads as "0% used,
 * plenty left", which is the opposite of "we don't know".
 *
 * `upperFraction` is an optional second, higher reading for the same window:
 * what the total *could* be once models with no known price are charged a
 * fallback rate. It is drawn as a hatched band extending past the solid fill,
 * because that span is precisely the part we cannot put a number on. Without
 * it the budget guard would refuse a run at a threshold the visible meter has
 * not reached, with nothing on screen to explain why.
 */

export type MeterSize = "compact" | "default" | "hero";

/**
 * Picked by a map, not by two competing CSS rules.
 *
 * `severityFor(null)` returns "ok", so an unknown fill used to carry both
 * `data-sev="ok"` and `data-unknown="true"` and the hatch won only because its
 * rule was declared three lines later in the stylesheet. As Tailwind variants
 * that tiebreak would move to Tailwind's internal variant sort order, which is
 * not a documented contract — and since an unknown fill is clamped to full
 * width, losing the race paints a solid green 100% bar. That is a worse lie
 * than the empty bar this component exists to avoid, so `known` short-circuits
 * before the severity map is ever consulted.
 */
const SEVERITY_FILL: Record<Severity, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
};

/**
 * Complete class strings per size, never interpolated — Tailwind scans source
 * as text, so `h-${n}` emits nothing and does it silently. Same rule the tone
 * maps in `ui/Badge` and `ui/Button` follow.
 *
 * `hero` exists for the one meter the dashboard is built around: the 5-hour
 * window. Size is how that card says it leads, so the track and the reading
 * both step up rather than the card being tinted a different colour.
 */
const SIZE: Record<
  MeterSize,
  {
    root: string;
    head: string;
    track: string;
    value: string;
    /** The guard's higher reading. Never larger than `value` at the same size. */
    upper: string;
    detail: string;
  }
> = {
  compact: {
    root: "mt-2.5 first:mt-0",
    head: "mb-1.5",
    track: "h-1.5",
    value: "text-xs",
    upper: "text-xs",
    detail: "mt-1.5",
  },
  default: {
    root: "mt-3",
    head: "mb-1.5",
    track: "h-2",
    value: "text-sm",
    upper: "text-xs",
    detail: "mt-2",
  },
  hero: {
    root: "mt-3",
    head: "mb-2",
    track: "h-3",
    value: "text-lg",
    upper: "text-sm",
    detail: "mt-2",
  },
};

/**
 * A reading below about half a percent is a sub-pixel sliver on a 200px track,
 * so it paints as an empty bar — the same lie the hatch exists to prevent at
 * the other end of the scale. The floor is on the *drawn* width only:
 * `aria-valuenow` and the printed percentage keep reporting the true figure,
 * and a genuine zero still draws nothing.
 */
const MIN_VISIBLE_PX = 3;

export function Meter({
  label,
  fraction,
  upperFraction,
  detail,
  value,
  unknownHint = "no ceiling set",
  size = "default",
}: {
  label: string;
  fraction: number | null;
  upperFraction?: number | null;
  detail?: string;
  /**
   * Replaces the percentage in the head, for readings where the raw pair says
   * more than the ratio does ("2/5" over "40.0%"). Ignored when the fraction is
   * unknown — that state must keep saying so rather than showing any number.
   */
  value?: string;
  unknownHint?: string;
  size?: MeterSize;
}) {
  const known = fraction !== null && Number.isFinite(fraction);
  const clamped = known ? Math.min(Math.max(fraction, 0), 1) : 1;
  const sz = SIZE[size];

  // Only meaningful when it exceeds the known reading; equal values are the
  // normal, fully-priced case and must not draw a zero-width band.
  const hasUpper =
    known &&
    upperFraction !== null &&
    upperFraction !== undefined &&
    Number.isFinite(upperFraction) &&
    upperFraction > fraction;
  const upperClamped = hasUpper
    ? Math.min(Math.max(upperFraction, 0), 1)
    : clamped;

  return (
    <div className={sz.root}>
      <div
        className={`flex items-baseline justify-between gap-3 text-xs text-ink-muted ${sz.head}`}
      >
        <span>{label}</span>
        {/* An unknown reading is never scaled up with the size: it is a
            statement that there is no figure, and setting it in the headline
            weight the known reading uses makes absence look like a value. */}
        {known ? (
          <span className={`font-semibold tabular-nums text-ink ${sz.value}`}>
            {value ?? fmtPct(fraction)}
            {hasUpper && (
              <span className={`font-medium text-ink-muted ${sz.upper}`}>
                {" "}
                – {fmtPct(upperFraction)}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs font-medium text-ink-muted">
            {unknownHint}
          </span>
        )}
      </div>
      <div
        className={`relative overflow-hidden rounded-full border border-line bg-inset ${sz.track}`}
        role="progressbar"
        aria-valuenow={known ? Math.round(clamped * 100) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        // Spoken instead of the bare percentage in the two cases where the
        // number alone misleads: no ceiling at all, and a guard reading that
        // sits above the visible bar.
        aria-valuetext={
          !known
            ? unknownHint
            : hasUpper
              ? `${fmtPct(fraction)}, up to ${fmtPct(upperFraction)} once unpriced models are charged`
              : undefined
        }
        aria-label={label}
      >
        {/* Absolutely positioned so the hatched upper band can sit *behind* the
            solid known-spend bar. As block siblings the second would be laid
            out below the first and clipped away by overflow-hidden. */}
        {hasUpper && (
          <div
            className="hatched absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ease-out"
            data-unknown="true"
            style={{ width: `${upperClamped * 100}%` }}
          />
        )}
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ease-out ${
            known ? SEVERITY_FILL[severityFor(fraction)] : "hatched"
          }`}
          data-sev={known ? severityFor(fraction) : undefined}
          data-unknown={!known}
          style={{
            width: `${clamped * 100}%`,
            minWidth: clamped > 0 ? MIN_VISIBLE_PX : undefined,
          }}
        />
      </div>
      {/* `text-ink-muted`, not `text-ink-faint`: this line names the ceiling the
          bar above is measured against, and `--fg-faint` is 3.4:1 on the card
          surface in light and 3.6:1 in dark — under 4.5:1 at 12px in both. */}
      {detail && (
        <div className={`text-xs text-ink-muted ${sz.detail}`}>{detail}</div>
      )}
    </div>
  );
}
