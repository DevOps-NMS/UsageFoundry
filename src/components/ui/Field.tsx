"use client";

import {
  createContext,
  useContext,
  useId,
  type AriaAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Hint, type HintTone } from "@/components/ui/Hint";

/**
 * Width is deliberately not in here. Two width utilities on one element do not
 * resolve by their order in the class attribute — they resolve by their order
 * in the generated stylesheet — so composing `CONTROL w-auto` silently kept
 * `w-full` and collapsed the sibling input to nothing. Each caller states its
 * own width exactly once.
 *
 * The border colour and the vertical padding are not in here either, for the
 * same reason: each is one of the strings below, so no element can be handed
 * two of them and leave the winner to Tailwind.
 */
const CONTROL_BASE =
  "ui-transition rounded-sm border bg-inset px-2.5 text-sm text-ink " +
  "placeholder:text-ink-faint " +
  // No ring here any more. `focus:outline-none focus:shadow-focus` was a text
  // control's own second focus treatment, and it is the half of the pair that
  // disagreed with every button on the page; @layer base now draws one halo for
  // both. The border colour stays, because AppKit tints the border too and that
  // is not a ring.
  "focus:border-accent " +
  "disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-faint";

/** One line of text in a 36px box, so a control is aimed at, not passed over. */
const CONTROL_LINE = "min-h-[var(--control-h-lg)] py-1.5";
/** Many lines, where the padding is what keeps the text off the border. */
const CONTROL_BLOCK = "py-2";

const BORDER_REST = "border-line enabled:hover:border-line-strong";
const BORDER_INVALID = "border-danger enabled:hover:border-danger";

const CONTROL = `w-full ${CONTROL_BASE} ${CONTROL_LINE}`;

/**
 * What a `Field` tells the control inside it.
 *
 * The alternative was cloning children to inject `aria-describedby`, which
 * breaks the moment a Field holds a fragment or two controls — and several
 * already do. A context costs nothing, survives any nesting, and means the
 * pages never have to hand-wire an id to a hint they did not name.
 *
 * Everything here is a *default*. A prop stated on the control itself always
 * wins, so a Field can never take a choice away from its caller.
 */
interface FieldControlState {
  describedBy?: string;
  invalid: boolean;
  disabled: boolean;
}

const FieldControlContext = createContext<FieldControlState | null>(null);

interface ControlBits {
  disabled: boolean | undefined;
  describedBy: string | undefined;
  ariaInvalid: AriaAttributes["aria-invalid"];
  border: string;
}

function useControlBits(rest: {
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: AriaAttributes["aria-invalid"];
}): ControlBits {
  const field = useContext(FieldControlContext);
  const disabled = rest.disabled ?? field?.disabled;
  const describedBy = rest["aria-describedby"] ?? field?.describedBy;
  const ariaInvalid = rest["aria-invalid"] ?? (field?.invalid ? true : undefined);
  const invalid =
    ariaInvalid !== undefined && ariaInvalid !== false && ariaInvalid !== "false";
  return {
    disabled,
    describedBy,
    ariaInvalid,
    border: invalid ? BORDER_INVALID : BORDER_REST,
  };
}

/** A unit, currency symbol or other short suffix sitting beside a control. */
function Affix({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <span
      className={`shrink-0 whitespace-nowrap text-xs ${
        disabled ? "text-ink-faint" : "text-ink-muted"
      }`}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  hintTone = "neutral",
  error,
  disabled = false,
  children,
  className = "",
}: {
  label?: ReactNode;
  htmlFor?: string;
  /**
   * The one short line under the control. As a prop rather than a child so it
   * gets an id and reaches the control as `aria-describedby` — a hint a screen
   * reader never reads is a hint that is not there.
   */
  hint?: ReactNode;
  hintTone?: HintTone;
  /**
   * What is wrong with what is in the control right now. Announced on
   * appearance, and it turns the control's border red — the two together,
   * because colour alone is not a message and a message alone is easy to miss.
   */
  error?: ReactNode;
  /** Applies to every control inside, and dims the label to match. */
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  // htmlFor is what the ids hang off wherever a caller supplied one, so they
  // stay readable in the DOM. useId only covers the fields that have no label.
  const generated = useId();
  const base = htmlFor ?? generated;
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`mb-3.5 ${className}`}>
      {label && (
        <label
          htmlFor={htmlFor}
          className={`mb-1.5 block text-xs font-medium ${
            disabled ? "text-ink-faint" : "text-ink-muted"
          }`}
        >
          {label}
        </label>
      )}
      <FieldControlContext.Provider
        value={{ describedBy, invalid: Boolean(error), disabled }}
      >
        {children}
      </FieldControlContext.Provider>
      {hint && (
        <Hint id={hintId} tone={hintTone}>
          {hint}
        </Hint>
      )}
      {error && (
        <Hint id={errorId} tone="danger" role="alert">
          {error}
        </Hint>
      )}
    </div>
  );
}

export function Input({
  className = "",
  prefix,
  unit,
  ...rest
}: {
  /** Sits before the control, e.g. a currency symbol. */
  prefix?: ReactNode;
  /** Sits after it, e.g. `minutes`. Both keep the figure and its unit one
   *  object, which is what stops a bare number meaning nothing. */
  unit?: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "prefix">) {
  const bits = useControlBits(rest);
  const affixed = prefix !== undefined || unit !== undefined;
  const control = (
    <input
      {...rest}
      disabled={bits.disabled}
      aria-describedby={bits.describedBy}
      aria-invalid={bits.ariaInvalid}
      className={`${affixed ? "min-w-0 flex-1" : "w-full"} ${CONTROL_BASE} ${CONTROL_LINE} ${bits.border} ${className}`}
    />
  );
  if (!affixed) return control;
  return (
    <div className="flex items-center gap-2">
      {prefix !== undefined && <Affix disabled={bits.disabled}>{prefix}</Affix>}
      {control}
      {unit !== undefined && <Affix disabled={bits.disabled}>{unit}</Affix>}
    </div>
  );
}

export function Select({
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const bits = useControlBits(rest);
  return (
    <select
      {...rest}
      disabled={bits.disabled}
      aria-describedby={bits.describedBy}
      aria-invalid={bits.ariaInvalid}
      className={`${CONTROL} ${bits.border} ${className}`}
    >
      {children}
    </select>
  );
}

export function Textarea({
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const bits = useControlBits(rest);
  return (
    <textarea
      {...rest}
      disabled={bits.disabled}
      aria-describedby={bits.describedBy}
      aria-invalid={bits.ariaInvalid}
      className={`w-full ${CONTROL_BASE} ${CONTROL_BLOCK} ${bits.border} min-h-[90px] resize-y font-mono text-sm ${className}`}
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
 *
 * The two controls are written out rather than composed from `Select` and
 * `Input`, because both need a width this row decides and neither component
 * accepts one — see the note at the top of this file.
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
  disabled,
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
  disabled?: boolean;
}) {
  const bits = useControlBits({ disabled });
  return (
    <div className="flex items-center gap-2">
      <select
        className={`${CONTROL_BASE} ${CONTROL_LINE} ${bits.border} w-auto shrink-0`}
        value={enabled ? "on" : "off"}
        onChange={(e) => onEnabledChange(e.target.value === "on")}
        disabled={bits.disabled}
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
            className={`${CONTROL_BASE} ${CONTROL_LINE} ${bits.border} w-full min-w-0 flex-1`}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            disabled={bits.disabled}
            aria-describedby={bits.describedBy}
            aria-invalid={bits.ariaInvalid}
          />
          <Affix disabled={bits.disabled}>{unit}</Affix>
        </>
      )}
    </div>
  );
}

/**
 * A boolean. Replaces the sentence-long two-option <select>s the settings page
 * used for every flag — the label carries the meaning, the switch carries the
 * state, and the explanation goes in a Hint underneath.
 *
 * The whole row is the hit target, not the 20px pill: the label points at the
 * switch, so the 36px row is what the pointer has to find.
 */
export function Toggle({
  id,
  checked,
  onChange,
  label,
  disabled,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  const bits = useControlBits({ disabled });
  const off = bits.disabled === true;
  return (
    <label
      htmlFor={id}
      className={`flex min-h-[var(--control-h-lg)] items-center gap-2.5 text-sm ${
        off ? "cursor-not-allowed text-ink-faint" : "cursor-pointer text-ink"
      }`}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={bits.describedBy}
        disabled={off}
        onClick={() => onChange(!checked)}
        className={`ui-transition relative h-5 w-9 shrink-0 cursor-pointer rounded-full border
          disabled:cursor-not-allowed disabled:opacity-50 ${
            checked
              ? "border-accent bg-accent enabled:hover:brightness-110"
              : "border-line-strong bg-inset enabled:hover:border-ink-faint"
          }`}
      >
        {/* `left`, not a transform: the knob is the one thing in the kit that is
            *meant* to travel, and the distance it travels is the state. */}
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all duration-[var(--motion-fast)] ease-standard ${
            checked ? "left-4 bg-white" : "left-0.5 bg-ink-faint"
          }`}
        />
      </button>
      {label}
    </label>
  );
}
