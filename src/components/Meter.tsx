"use client";

import { fmtPct, severityFor } from "@/lib/format";

/**
 * A single limit meter.
 *
 * `fraction === null` means no ceiling is configured. That renders as a hatched
 * indeterminate bar rather than an empty one — an empty bar reads as "0% used,
 * plenty left", which is the opposite of "we don't know".
 */
export function Meter({
  label,
  fraction,
  detail,
  unknownHint = "no ceiling set",
}: {
  label: string;
  fraction: number | null;
  detail?: string;
  unknownHint?: string;
}) {
  const known = fraction !== null && Number.isFinite(fraction);
  const clamped = known ? Math.min(Math.max(fraction, 0), 1) : 1;

  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">
          {known ? fmtPct(fraction) : unknownHint}
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
