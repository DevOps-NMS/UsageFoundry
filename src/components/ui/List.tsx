"use client";

import { useId, type ReactNode } from "react";
import { FieldControlContext } from "@/components/ui/Field";

/**
 * The grouped inset list macOS System Settings is built from: a rounded box, a
 * hairline between each row, and the explanation as a footnote under the box
 * rather than a paragraph over it.
 *
 * The box deliberately does not clip its children. Rows carry no background of
 * their own, so the hairlines never reach a corner and nothing needs
 * `overflow-hidden` — which matters, because a caller with a marker in the
 * gutter (the settings page draws an edited rail there) would have it clipped
 * away by a rounded box that hid its overflow.
 */
export function ListGroup({
  label,
  footnote,
  children,
  className = "",
}: {
  /** A short heading over the box. Most groups are named by the card instead. */
  label?: ReactNode;
  /** What the group as a whole needs saying about it, under the box. */
  footnote?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {label && (
        <div className="mb-1.5 px-1 text-xs font-medium text-ink-muted">
          {label}
        </div>
      )}
      <div className="divide-y divide-line rounded-lg border border-line bg-grouped">
        {children}
      </div>
      {footnote && (
        <p className="mt-1.5 max-w-[70ch] px-1 text-xs leading-snug text-ink-muted">
          {footnote}
        </p>
      )}
    </div>
  );
}

/**
 * One row: what it is on the left, the control that changes it on the right.
 *
 * The row itself is inert — every interaction state belongs to the control
 * inside it, which is why there is no hover tint here. A row that lit up under
 * the pointer would be claiming to be clickable across its whole width, and
 * only the 38px switch at the end of it is.
 *
 * It provides `Field`'s context rather than a copy of it, so an `Input`,
 * `Select` or `Switch` dropped in here is wired to the description beside it
 * and dimmed by the row's `disabled` without the page naming an id — the same
 * behaviour those controls have inside a `Field`.
 */
export function ListRow({
  label,
  description,
  htmlFor,
  disabled = false,
  children,
  className = "",
}: {
  label: ReactNode;
  /** The secondary line under the label. Reaches the control as aria-describedby. */
  description?: ReactNode;
  /** Names the control this row's label points at, where the caller has one. */
  htmlFor?: string;
  disabled?: boolean;
  /** The trailing control. */
  children: ReactNode;
  className?: string;
}) {
  const generated = useId();
  const descriptionId = description ? `${htmlFor ?? generated}-desc` : undefined;

  const labelClasses =
    // Every property the legacy sheet sets on a bare `label` is restated, or
    // its 12px muted block with a 5px bottom margin wins wherever this renders
    // one: display, size, weight, colour, margin.
    `mb-0 block text-sm font-normal ${disabled ? "text-ink-faint" : "text-ink"}`;

  return (
    <div
      className={`relative flex min-h-[var(--control-h-lg)] items-center justify-between gap-4 px-3.5 py-2.5 ${className}`}
    >
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={labelClasses}>
            {label}
          </label>
        ) : (
          <span className={labelClasses}>{label}</span>
        )}
        {description && (
          <p
            id={descriptionId}
            className="mt-0.5 max-w-[68ch] text-xs leading-snug text-ink-faint"
          >
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <FieldControlContext.Provider
          value={{ describedBy: descriptionId, invalid: false, disabled }}
        >
          {children}
        </FieldControlContext.Provider>
      </div>
    </div>
  );
}
