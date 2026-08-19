"use client";

import {
  createContext,
  useContext,
  type ReactNode,
  type ThHTMLAttributes,
  type TdHTMLAttributes,
} from "react";

/** Tables are the one thing here that genuinely overflows on a narrow screen. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

/**
 * Whether the table this element belongs to becomes one block per record below
 * the shell's `md` breakpoint.
 *
 * A context rather than a prop threaded through five components, because the
 * decision belongs to the table and every part of the grid has to obey the same
 * answer: a `<thead>` that kept its column widths while the `<tbody>` under it
 * stacked is a header row standing over a column of cards, and nothing about
 * that throws, logs or fails a typecheck. One `stack` on `Table` settles it for
 * everything inside.
 */
const StackedContext = createContext(false);

/**
 * `stack` is stated per table and is never the default.
 *
 * `TableWrap`'s sideways scroll is the answer where a row is a set of readings
 * a reader compares; it is not a presentation of a *record*. In a 390px pane a
 * run's status and its spend are never on screen at once, and the row tint `Tr`
 * carries — the thing that holds a label and a figure on one line as the eye
 * crosses the width — does not exist on touch at all. So below `md` the grid
 * becomes one block per row and the hairline moves to the row itself.
 *
 * Opt-in because the two halves only work together: with the column heads gone,
 * a value says what it is only because its own `Td` carries a `label`, and a
 * table switched on here without them would be a column of unnamed figures —
 * worse than the scroll it replaced. So this is a prop a call site states as it
 * labels its cells, rather than a change to what `Table` does everywhere.
 *
 * The explicit ARIA roles are the other half of it. `display: block` strips a
 * table element's implicit role in every engine, taking the row and column
 * relationships with the layout; stated here they survive it. Above the
 * breakpoint each one is exactly the role the element already had, so nothing
 * about the flat table changes — including its pixels, since a role paints
 * nothing.
 */
export function Table({
  children,
  stack = false,
}: {
  children: ReactNode;
  stack?: boolean;
}) {
  return (
    <StackedContext.Provider value={stack}>
      <table
        role={stack ? "table" : undefined}
        className={`w-full border-collapse text-sm${stack ? " max-md:block" : ""}`}
      >
        {children}
      </table>
    </StackedContext.Provider>
  );
}

/**
 * The column heads — and nothing at all below the breakpoint, where each `Td`
 * names its own field. Two vocabularies for one set of columns is how a heading
 * and the label under it come to disagree.
 */
export function THead({ children }: { children: ReactNode }) {
  const stacked = useContext(StackedContext);
  return (
    <thead
      role={stacked ? "rowgroup" : undefined}
      className={stacked ? "max-md:hidden" : undefined}
    >
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  const stacked = useContext(StackedContext);
  return (
    <tbody
      role={stacked ? "rowgroup" : undefined}
      className={stacked ? "max-md:block" : undefined}
    >
      {children}
    </tbody>
  );
}

/**
 * The one element in the grid that restores no role when the table stacks, and
 * that is a consequence rather than an omission: `THead` is `max-md:hidden`, so
 * at the widths where `display: block` would strip a `columnheader` there is no
 * header in the accessibility tree to strip it from. Anything that puts a `Th`
 * outside `THead` — or stops hiding the head below the breakpoint — owes it a
 * `role="columnheader"` on the same terms as the four beside it.
 */
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
      // Sentence case at 12px, one weight step above the cells rather than a
      // different treatment from them — see CardTitle. `--fg-muted`, not
      // `--fg-faint`: a column heading is read, and faint is under 4.5:1 at
      // this size in both schemes.
      className={`whitespace-nowrap border-b border-line px-2.5 py-2 text-xs font-medium text-ink-muted ${
        num ? "text-right tabular-nums" : "text-left"
      } ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

/**
 * Where a cell's field name sits once the row is a block.
 *
 * `inline` is the grouped-list row every reading wants — name at one edge, value
 * at the other, one line each, so a column of figures still scans. `above` is
 * for a value that is prose or a list rather than a reading: pushed into the
 * right half of a 390px row it becomes a four-word column, so the name takes its
 * own line and the value takes the width.
 */
export type TdLabelPlacement = "inline" | "above";

/**
 * How a cell lays itself out once its row is a block.
 *
 * Both spellings of `display` are in this map rather than one of them in the
 * shared string, because two class strings setting the same property under the
 * same variant resolve by Tailwind's own sort order rather than by anything
 * written here — the rule `Button`'s VARIANT map already follows. The hairline
 * is dropped here and drawn on the row instead: a rule under every field would
 * be eight of them per record, where the record is the thing being separated.
 */
const STACKED_CELL: Record<"inline" | "block", string> = {
  inline:
    "max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-4 " +
    "max-md:border-b-0 max-md:py-1",
  block: "max-md:block max-md:border-b-0 max-md:py-1",
};

/** The name itself, per placement — `display` in one entry for `STACKED_CELL`'s reason. */
const STACKED_LABEL: Record<TdLabelPlacement, string> = {
  inline: "shrink-0 md:hidden",
  above: "mb-0.5 block md:hidden",
};

export function Td({
  children,
  num = false,
  label,
  labelPlacement = "inline",
  className = "",
  ...rest
}: {
  children?: ReactNode;
  num?: boolean;
  /**
   * What this value is, drawn only below the breakpoint and only in a `stack`
   * table.
   *
   * `Th`'s `scope="col"` is what names the field above the breakpoint, and once
   * the row is a block there is no column for it to point at — so this is the
   * whole of what a reader, sighted or not, has to go on. A cell deliberately
   * left without one is a headline the record is identified by: a status, a
   * task, a branch name. Never a figure.
   */
  label?: ReactNode;
  labelPlacement?: TdLabelPlacement;
} & TdHTMLAttributes<HTMLTableCellElement>) {
  const stacked = useContext(StackedContext);
  const labelled = stacked && label !== undefined && label !== null;
  const shape = labelled && labelPlacement === "inline" ? "inline" : "block";

  return (
    <td
      role={stacked ? "cell" : undefined}
      className={`border-b border-line px-2.5 py-2.5 group-last/row:border-b-0 ${
        num ? "text-right tabular-nums" : ""
      } ${stacked ? STACKED_CELL[shape] : ""} ${className}`}
      {...rest}
    >
      {labelled && (
        // `font-sans` because several of these cells are `mono` and the field
        // name is not the value: a label rendered in the monospace face reads
        // as part of the path or the model id under it.
        <span
          className={`font-sans text-xs font-medium text-ink-muted ${STACKED_LABEL[labelPlacement]}`}
        >
          {label}
        </span>
      )}
      {labelled ? (
        // `contents` above the breakpoint, so this box exists only where the
        // cell is a flex row and generates nothing at all where it is a table
        // cell. Several of these hold two children — a figure and the guard's
        // higher reading beside it, a timestamp and a badge — which without a
        // wrapper would be two flex items with the field name pushed between
        // them. Only `display` is switched: an inherited property stated here
        // would reach the children through `contents` and change the flat table.
        <span className="block min-w-0 md:contents">{children}</span>
      ) : (
        children
      )}
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
 *
 * Below the breakpoint it has nothing left to do — there is no hover on touch
 * and no width to cross — so what holds a record together there is the box: the
 * row becomes a block and takes the hairline its cells give up.
 */
const STACKED_ROW =
  "max-md:block max-md:border-b max-md:border-line max-md:py-1.5 " +
  "max-md:last:border-b-0";

export function Tr({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const stacked = useContext(StackedContext);
  return (
    <tr
      role={stacked ? "row" : undefined}
      className={`group/row ui-transition hover:bg-inset ${
        stacked ? STACKED_ROW : ""
      } ${className}`}
    >
      {children}
    </tr>
  );
}
