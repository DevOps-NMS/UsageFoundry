"use client";

import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";

/** Tables are the one thing here that genuinely overflows on a narrow screen. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="w-full border-collapse text-sm">{children}</table>;
}

export function Th({
  children,
  num = false,
  className = "",
  ...rest
}: {
  children?: ReactNode;
  num?: boolean;
} & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      // Every header here labels a column. Without scope a screen reader has to
      // guess, and guesses wrong on any table with a leading label column —
      // which is most of the breakdowns on the dashboard.
      scope={rest.scope ?? "col"}
      className={`whitespace-nowrap border-b border-line px-2.5 py-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint ${
        num ? "text-right tabular-nums" : "text-left"
      } ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  num = false,
  className = "",
  ...rest
}: {
  children?: ReactNode;
  num?: boolean;
} & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={`border-b border-line px-2.5 py-2.5 group-last/row:border-b-0 ${
        num ? "text-right tabular-nums" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </td>
  );
}

/**
 * Carries the `group/row` marker `Td` uses to drop the final border.
 *
 * The hover tint is not decoration: these tables run the full width of the
 * shell with a label at one end and a figure at the other, and the tint is what
 * keeps the two on the same line as the eye crosses. It is the faintest step
 * the palette has — one surface, not a highlight.
 */
export function Tr({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <tr className={`group/row ui-transition hover:bg-inset ${className}`}>
      {children}
    </tr>
  );
}
