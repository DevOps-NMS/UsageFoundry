/**
 * What the shell's one keyboard listener is allowed to act on.
 *
 * Kept apart from the listener because both halves are rules rather than
 * behaviour, and both are easy to get subtly wrong in a way nothing reports: a
 * layer that swallows a keystroke inside a text field looks like a dropped
 * character, and one that claims a chord the browser owns looks like the
 * browser broke.
 */

/**
 * Input types that are not text entry, so a chord over one is not typing.
 *
 * Listed as the exceptions rather than the other way round: a type this app
 * has never used, and any the platform adds later, are assumed to be text and
 * therefore left alone, which is the direction that costs a shortcut rather
 * than a keystroke.
 */
const NON_TEXT_INPUT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target.tagName !== "INPUT") return false;
  return !NON_TEXT_INPUT.has((target as HTMLInputElement).type);
}

/**
 * Is this a chord this layer may look at at all?
 *
 * ⌘ and nothing else beside it. Ctrl is deliberately not treated as an
 * equivalent: on Windows and Linux, Ctrl+1…8 switches browser tab and Ctrl+K
 * is the address bar, so accepting it would shadow four of the browser's own
 * bindings to save a Mac-shaped app one modifier. ⌥ and ⇧ are excluded because
 * ⌘⇧K and ⌘⌥1 are other people's shortcuts, not aliases of ours.
 */
export function isPlainCommandChord(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/**
 * ⌘↩ is the one chord that keeps working while a text field holds focus.
 *
 * The shell binds nothing to it. The carve-out is what guarantees this layer
 * can never become the reason a form's own "commit while typing" stops
 * working — the rule is stated where the exclusion is, rather than being an
 * absence somebody has to notice.
 */
export function isCommitChord(e: { metaKey: boolean; key: string }): boolean {
  return e.metaKey && e.key === "Enter";
}
