"use client";

import { fmtPct, severityFor } from "@/lib/format";

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
export function Meter({
  label,
  fraction,
  upperFraction,
  detail,
  unknownHint = "no ceiling set",
}: {
  label: string;
  fraction: number | null;
  upperFraction?: number | null;
  detail?: string;
  unknownHint?: string;
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
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">
          {known ? fmtPct(fraction) : unknownHint}
          {hasUpper && (
            <span className="meter-upper"> – {fmtPct(upperFraction)}</span>
          )}
        </span>
      </div>
      <div
        className="meter-track"
        role="progressbar"
        aria-valuenow={known ? Math.round(clamped * 100) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {/* Hatched, never coloured by severity: this span is the part we
            explicitly cannot put a number on, and the hatch is already the
            established vocabulary for that. */}
        {hasUpper && (
          <div
            className="meter-fill"
            data-unknown="true"
            style={{ width: `${upperClamped * 100}%` }}
          />
        )}
        <div
          className="meter-fill"
          data-sev={severityFor(fraction)}
          data-unknown={!known}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
      {detail && <div className="hint">{detail}</div>}
    </div>
  );
}
