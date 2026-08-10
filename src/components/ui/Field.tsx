"use client";

import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

/**
 * Width is deliberately not in here. Two width utilities on one element do not
 * resolve by their order in the class attribute — they resolve by their order
 * in the generated stylesheet — so composing `CONTROL w-auto` silently kept
 * `w-full` and collapsed the sibling input to nothing. Each caller states its
 * own width exactly once.
 */
const CONTROL_BASE =
  "rounded-sm border border-line bg-inset px-2.5 py-2 text-sm text-ink " +
  "focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-dim";

const CONTROL = `w-full ${CONTROL_BASE}`;

export function Field({
  label,
  htmlFor,
  children,
  className = "",
}: {
  label?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-3.5 ${className}`}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="mb-1.5 block text-xs font-medium text-ink-muted"
        >
          {label}
        </label>
      )}
      {children}
    </div>
  );
}

export function Input({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} ${className}`} {...rest} />;
}

export function Select({
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${CONTROL} ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`${CONTROL} min-h-[90px] resize-y font-mono text-sm ${className}`}
      {...rest}
    />
  );
}

/** A labelled group of related fields inside a card, e.g. a run's stop limits. */
export function Subsection({
  title,
  children,
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mt-4 border-t border-line pt-3.5 ${className}`}>
      <div className="mb-2.5 text-xs font-semibold text-ink">{title}</div>
      {children}
    </div>
  );
}

/**
 * A limit that can be switched off entirely: an on/off picker, and the value
 * only when it is on.
 *
 * `null` is the wire form of "no limit" — normalizePolicy maps null/""/0 to an
 * unset cap rather than to a default — so the off state has to be expressible
 * without emptying the input, which would read as zero. Three call sites in the
 * run form repeated this markup verbatim.
 */
export function LimitField({
  id,
  enabled,
  onEnabledChange,
  value,
  onValueChange,
  unit,
  offLabel,
  onLabel = "Stop after…",
  modeLabel,
  min = 1,
  step,
}: {
  id: string;
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  value: string;
  onValueChange: (v: string) => void;
  unit: string;
  offLabel: string;
  onLabel?: string;
  modeLabel: string;
  min?: number;
  step?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        className={`${CONTROL_BASE} w-auto shrink-0`}
        value={enabled ? "on" : "off"}
        onChange={(e) => onEnabledChange(e.target.value === "on")}
        aria-label={modeLabel}
      >
        <option value="on">{onLabel}</option>
        <option value="off">{offLabel}</option>
      </select>
      {enabled && (
        <>
          <input
            id={id}
            type="number"
            min={min}
            step={step}
            className={`${CONTROL_BASE} w-full min-w-0 flex-1`}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
          />
          <span className="whitespace-nowrap text-xs text-ink-muted">
            {unit}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * A boolean. Replaces the sentence-long two-option <select>s the settings page
 * used for every flag — the label carries the meaning, the switch carries the
 * state, and the explanation goes in a Hint underneath.
 */
export function Toggle({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2.5 text-sm text-ink"
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
          checked
            ? "border-accent bg-accent"
            : "border-line-strong bg-inset"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
            checked ? "left-4 bg-white" : "left-0.5 bg-ink-faint"
          }`}
        />
      </button>
      {label}
    </label>
  );
}
