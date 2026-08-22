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
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib, Meter.tsx and LiveTelemetry.tsx already do.
import { Hint, type HintTone } from "./Hint";

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
  // 16px below the shell's breakpoint, and that number is a platform floor
  // rather than a type decision: iOS Safari zooms the page in whenever a
  // control under 16px takes focus, and it never zooms back out — so one tap
  // on the first field leaves every screen after it offset sideways for the
  // rest of the session, with nothing on the page saying why.
  //
  // Deliberately an arbitrary value and not a step in the type scale.
  // --text-sm and --text-base are both 13 for the reason written beside them
  // in globals.css, twenty other things read them, and neither may move to
  // accommodate a control's touch floor. It is equally not a font-size on
  // `html`, which redefines `rem` and takes 12.5% off every spacing and type
  // utility in the app. Everything not on this kit gets the same floor from
  // the element selectors in globals.css's legacy layer.
  //
  // Every text control in the app concatenates this string — Input, Select,
  // Textarea and LimitField's two — so this is the one place it is stated.
  "max-md:text-[16px] " +
  "placeholder:text-ink-faint " +
  // No ring here any more. `focus:outline-none focus:shadow-focus` was a text
  // control's own second focus treatment, and it is the half of the pair that
  // disagreed with every button on the page; @layer base now draws one halo for
  // both. The border colour stays, because AppKit tints the border too and that
  // is not a ring.
  "focus:border-accent " +
  "disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-faint";

/**
 * One line of text in a 36px box, so a control is aimed at, not passed over —
 * and 44px below the shell's breakpoint, which is what a finger needs. A
 * `max-md:` override rather than a change to --control-h-lg, which is the
 * *pointer's* floor and what the whole kit is sized from. See Button's SIZE map
 * for why the two heights sit in one string.
 */
const CONTROL_LINE = "min-h-[var(--control-h-lg)] max-md:min-h-11 py-1.5";
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

/**
 * Exported for `ui/List`, which is the other thing in the kit that stands
 * around a control and knows the description it should be pointing at. It
 * provides this rather than carrying its own copy, so `Input`, `Select` and
 * `Switch` behave identically in a grouped row and in a Field.
 */
export const FieldControlContext = createContext<FieldControlState | null>(null);

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
      // `max-w` rather than a width, so the note above still holds — this
      // narrows and never fights `w-full`. The pane fills the window by
      // design, so the prompt editors on the settings page and the task box on
      // the run form were monospace boxes 340 columns across on a 2560px
      // display: a line of a prompt ran off the edge of what anyone reads,
      // and the resize handle was the only way back. 100 columns is the
      // measure the text in them is written to.
      className={`w-full max-w-[100ch] ${CONTROL_BASE} ${CONTROL_BLOCK} ${bits.border} min-h-[90px] resize-y font-mono text-sm ${className}`}
    />
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
  modeId,
  enabled,
  onEnabledChange,
  value,
  onValueChange,
  unit,
  offLabel,
  onLabel = "Stop after…",
  modeLabel,
  invalid = false,
  min = 1,
  step,
  disabled,
}: {
  id: string;
  /**
   * Names the picker, for the one caller that has to be able to *send the
   * cursor* to a limit that is switched off.
   *
   * `id` is the value box, which only exists while the limit is on — so a
   * validation error whose whole message is "switch one of these back on" has
   * nothing to point at through it. The picker is the half that is there in
   * both states, which is exactly why the error points at it. Optional because
   * a caller with no such error owes the DOM no second id.
   */
  modeId?: string;
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  value: string;
  onValueChange: (v: string) => void;
  unit: string;
  offLabel: string;
  onLabel?: string;
  modeLabel: string;
  /**
   * What the two written-out controls cannot read off `Field`'s context: a
   * `ListRow` provides that context with `invalid: false` fixed, so a row whose
   * value is missing had a red border through `Field` and none through a
   * grouped list. Stated as a prop rather than by widening the context, because
   * the row is a layout and the error belongs to the control.
   */
  invalid?: boolean;
  min?: number;
  step?: string;
  disabled?: boolean;
}) {
  const bits = useControlBits({
    disabled,
    "aria-invalid": invalid ? true : undefined,
  });
  return (
    <div className="flex items-center gap-2">
      <select
        id={modeId}
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
 * Both halves of a switch's appearance in one entry per state, for the reason
 * every other map in the kit is shaped this way: the track colour and the knob
 * position are the same statement, and split across a shared string and a
 * conditional one the winner would be Tailwind's sort order.
 *
 * The knob stays white in the off state on macOS; here it is `--fg-faint`,
 * which is the one deliberate divergence. `--bg-inset` is a very light grey in
 * the light scheme — a white knob on it is a white knob on white, and the state
 * this control exists to report would be unreadable at rest.
 */
const SWITCH: Record<"on" | "off", { track: string; knob: string }> = {
  on: {
    track:
      "border-transparent bg-tint enabled:hover:brightness-110 enabled:active:brightness-95",
    knob: "left-[18px] bg-white",
  },
  off: {
    track:
      "border-line-strong bg-inset enabled:hover:border-ink-faint enabled:active:brightness-95",
    knob: "left-0.5 bg-ink-faint",
  },
};

/**
 * The macOS switch: a 38×22 pill with an 18px knob, sized so the travel is
 * legible rather than a hint.
 *
 * The button *is* the track, so the focus halo from @layer base hugs the pill
 * instead of a padded box around it; the hit target comes from an `::after`
 * overlay stretched to --control-h, which the pointer hits and the layout never
 * sees. A padded button would have given the ring a 32px box to draw round.
 *
 * It reads `Field`'s context for `aria-describedby` and `disabled`, so a switch
 * in a Field or a ListRow is wired to the hint beside it without the page
 * naming an id.
 */
export function Switch({
  id,
  checked,
  onChange,
  disabled,
  label,
  className = "",
}: {
  id?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Only where nothing else names the control — a ListRow's label already does. */
  label?: string;
  className?: string;
}) {
  const bits = useControlBits({ disabled });
  const off = bits.disabled === true;
  const state = SWITCH[checked ? "on" : "off"];
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={bits.describedBy}
      disabled={off}
      onClick={() => onChange(!checked)}
      className={
        "ui-transition relative h-[22px] w-[38px] shrink-0 cursor-pointer rounded-full border " +
        "disabled:cursor-not-allowed disabled:opacity-50 " +
        // The pointer target, not the box: inset vertically past the pill to
        // --control-h and no wider, so a row of controls keeps its spacing.
        "after:absolute after:-inset-y-[5px] after:inset-x-0 after:content-[''] " +
        // 44×44 below the shell's breakpoint, and still entirely inside the
        // overlay: the pill stays 38×22, so a grouped list's right edge does
        // not move and no row gets taller for it. This is the one control that
        // has to grow sideways as well — 22px is short enough that height
        // alone leaves it under the floor in the axis a thumb misses in — and
        // 3px of bleed per side sits well inside the 8px `gap` a ListRow puts
        // between two trailing controls, so two targets still cannot touch.
        "max-md:after:-inset-y-[11px] max-md:after:-inset-x-[3px] " +
        `${state.track} ${className}`
      }
    >
      {/* `left`, not a transform: the knob is the one thing in the kit that is
          *meant* to travel, and the distance it travels is the state. */}
      <span
        className={`absolute top-0.5 h-[18px] w-[18px] rounded-full shadow-e1 transition-all duration-[var(--motion-fast)] ease-standard ${state.knob}`}
      />
    </button>
  );
}

/**
 * A boolean with its label beside it. Replaces the sentence-long two-option
 * <select>s the settings page used for every flag — the label carries the
 * meaning, the switch carries the state, and the explanation goes in a Hint
 * underneath.
 *
 * The whole row is the hit target: the label points at the switch, so the 36px
 * row is what the pointer has to find. `ListRow` is the same arrangement with
 * the control on the *right*, which is what a grouped list wants; this one puts
 * it first because a stack of Fields has nothing to align a right edge against.
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
      // The whole row is the target, so the row is what takes the 44px floor
      // below the breakpoint — the switch inside it keeps its own overlay for
      // the case where the label is not what the finger lands on.
      className={`flex min-h-[var(--control-h-lg)] max-md:min-h-11 items-center gap-2.5 text-sm ${
        off ? "cursor-not-allowed text-ink-faint" : "cursor-pointer text-ink"
      }`}
    >
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
      {label}
    </label>
  );
}

/**
 * A range control has no styling surface of its own: the track and the thumb are
 * shadow parts, and the only way to reach them is the vendor pseudo-elements
 * below. Both spellings are needed — Chrome and Safari drop a rule block
 * entirely if it names a selector they do not know, so one combined selector
 * would style neither.
 *
 * A 4px track under a 14px thumb, which is the macOS proportion. The thumb's
 * negative margin centres it on the track in WebKit, which aligns the *top* of
 * the thumb box with the top of the track; Firefox centres it already and would
 * double-count a margin, so it gets none.
 */
const SLIDER_TRACK =
  "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full " +
  "[&::-webkit-slider-runnable-track]:border [&::-webkit-slider-runnable-track]:border-line " +
  "[&::-webkit-slider-runnable-track]:bg-inset " +
  "[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full " +
  "[&::-moz-range-track]:border [&::-moz-range-track]:border-line [&::-moz-range-track]:bg-inset";

const SLIDER_THUMB =
  "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:-mt-[5px] " +
  "[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 " +
  "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-tint " +
  "[&::-webkit-slider-thumb]:shadow-e1 " +
  "[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:border-0 " +
  "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-tint [&::-moz-range-thumb]:shadow-e1";

/**
 * A continuous setting, with the number it is currently at beside it.
 *
 * The figure is not optional. A slider whose effect is immediate still leaves
 * the operator with no way to say what they set, no way to get back to it, and
 * nothing to compare against a default — and `tabular-nums` on a fixed width so
 * the track does not shorten by a few pixels every time a digit is added.
 *
 * The row is what takes the 44px touch floor rather than the input, because a
 * range's own box is where the drag starts and shrinking it would be worse.
 */
export function Slider({
  id,
  value,
  onChange,
  min,
  max,
  step,
  format = String,
  disabled,
  label,
  className = "",
}: {
  id?: string;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step: number;
  /** How the figure beside the track reads — a unit, or fewer decimals. */
  format?: (value: number) => string;
  disabled?: boolean;
  /** Only where nothing else names the control — a ListRow's label already does. */
  label?: string;
  className?: string;
}) {
  const bits = useControlBits({ disabled });
  const off = bits.disabled === true;
  return (
    <div className={`flex min-h-[var(--control-h-lg)] max-md:min-h-11 items-center gap-2 ${className}`}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-describedby={bits.describedBy}
        disabled={off}
        onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
        className={
          "ui-transition h-4 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent " +
          "disabled:cursor-not-allowed disabled:opacity-50 " +
          `${SLIDER_TRACK} ${SLIDER_THUMB}`
        }
      />
      <span
        className={`w-10 shrink-0 text-right text-xs tabular-nums ${
          off ? "text-ink-faint" : "text-ink-muted"
        }`}
      >
        {format(value)}
      </span>
    </div>
  );
}

/**
 * A colour, as a swatch that opens the platform picker.
 *
 * Native rather than a palette of our own: the operator is choosing a colour to
 * tell two groups of notes apart on their own display, so the set they can pick
 * from should be the one their eyes can, not seven we guessed. The default that
 * lands in the field still comes from `GROUP_PALETTE`, so nobody has to open a
 * picker to get a usable colour.
 */
export function ColorSwatch({
  id,
  value,
  onChange,
  label,
  disabled,
  className = "",
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  /** Names the control: a swatch on its own is an unexplained square. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const bits = useControlBits({ disabled });
  const off = bits.disabled === true;
  return (
    <input
      id={id}
      type="color"
      value={value}
      aria-label={label}
      aria-describedby={bits.describedBy}
      disabled={off}
      onChange={(e) => onChange(e.currentTarget.value)}
      className={
        "ui-transition h-7 w-7 max-md:h-11 max-md:w-11 shrink-0 cursor-pointer rounded-sm " +
        "border border-line bg-inset p-0.5 enabled:hover:border-line-strong " +
        "disabled:cursor-not-allowed disabled:opacity-50 " +
        "[&::-webkit-color-swatch-wrapper]:p-0 " +
        "[&::-webkit-color-swatch]:rounded-[3px] [&::-webkit-color-swatch]:border-0 " +
        "[&::-moz-color-swatch]:rounded-[3px] [&::-moz-color-swatch]:border-0 " +
        `${className}`
      }
    />
  );
}
