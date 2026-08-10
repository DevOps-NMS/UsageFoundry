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

/** Carries the `group/row` marker `Td` uses to drop the final border. */
export function Tr({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <tr className={`group/row ${className}`}>{children}</tr>;
}
