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

export function Meter({
  label,
  fraction,
  upperFraction,
  detail,
  unknownHint = "no ceiling set",
  compact = false,
}: {
  label: string;
  fraction: number | null;
  upperFraction?: number | null;
  detail?: string;
  unknownHint?: string;
  compact?: boolean;
}) {
  const known = fraction !== null && Number.isFinite(fraction);
  const clamped = known ? Math.min(Math.max(fraction, 0), 1) : 1;

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
    <div className={compact ? "mt-1.5" : "mt-2.5"}>
      <div className="mb-1.5 flex items-baseline justify-between text-xs text-ink-muted">
        <span>{label}</span>
        <span className="font-semibold tabular-nums text-ink">
          {known ? fmtPct(fraction) : unknownHint}
          {hasUpper && (
            <span className="font-medium text-ink-muted">
              {" "}
              – {fmtPct(upperFraction)}
            </span>
          )}
        </span>
      </div>
      <div
        className={`relative overflow-hidden rounded-full border border-line bg-inset ${
          compact ? "h-1.5" : "h-[7px]"
        }`}
        role="progressbar"
        aria-valuenow={known ? Math.round(clamped * 100) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {/* Absolutely positioned so the hatched upper band can sit *behind* the
            solid known-spend bar. As block siblings the second would be laid
            out below the first and clipped away by overflow-hidden. */}
        {hasUpper && (
          <div
            className="hatched absolute inset-y-0 left-0 rounded-full"
            data-unknown="true"
            style={{ width: `${upperClamped * 100}%` }}
          />
        )}
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ${
            known ? SEVERITY_FILL[severityFor(fraction)] : "hatched"
          }`}
          data-sev={known ? severityFor(fraction) : undefined}
          data-unknown={!known}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
      {detail && <div className="mt-1.5 text-xs text-ink-faint">{detail}</div>}
    </div>
  );
}
