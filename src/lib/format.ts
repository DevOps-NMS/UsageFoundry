/** Presentation helpers. Client-safe — no node builtins in here. */

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtUSD(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(f: number | null): string {
  if (f === null || !Number.isFinite(f)) return "—";
  return `${(f * 100).toFixed(1)}%`;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 2h 14m" / "3m ago" — relative to now, with direction. */
export function fmtRelative(ts: number, now = Date.now()): string {
  const delta = ts - now;
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return delta >= 0 ? "now" : "just now";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const body = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return delta >= 0 ? `in ${body}` : `${body} ago`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Shorten an absolute path for display, keeping the tail meaningful. */
export function shortPath(p: string, keep = 3): string {
  if (!p) return "—";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= keep) return p;
  return `…/${parts.slice(-keep).join("/")}`;
}

export type Severity = "ok" | "warn" | "danger";

export function severityFor(fraction: number | null): Severity {
  if (fraction === null) return "ok";
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.7) return "warn";
  return "ok";
}
