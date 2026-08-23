# Option C: a keyboard and focus pass

The option the question invites, and the one that mostly dissolves on contact
with the code. It is here at its strongest because the dissolving is a finding.

## The case, as it would normally be made

One operator supervising money-spending agents will sometimes want to stop
something without reaching for a mouse. Sixteen pages, roughly fifty components,
a canvas editor, a chat composer, twenty tables and no test that renders any of
it (`C10`). A keyboard audit is the cheapest broad sweep available: tab through
every page, confirm every control is reachable in a sensible order, confirm focus
is always visible, confirm nothing traps, confirm every custom widget implements
its ARIA pattern's key bindings.

## What the code actually shows

Every part of that sweep that source can settle has already been done, and done
in the places a hurried implementation misses.

**The patterns are correct where they are hardest.**
`src/components/ui/SegmentedControl.tsx:122` runs a roving tabindex,
`tabIndex={selected ? 0 : -1}`, with its own `onKeyDown` at `:2` occurrences in
the file. That is the composite-widget pattern, not the "make every segment
tabbable" shortcut. `src/app/page.tsx:995` records that a hand-rolled pill strip
claiming `role="tablist"` was deleted in favour of it, which is a correction
somebody made deliberately.

**Scrollable regions are reachable, which is the most-missed defect on the web.**
`src/components/ui/Log.tsx:82-84` and `src/components/ui/Patch.tsx:56,63,91` set
`tabIndex={0}` on the scroll containers with the reason in a comment
("unreachable. tabIndex is what fixes that; the outline comes from" the base
layer). A run's log and a diff are exactly the two surfaces where a keyboard
operator would otherwise be stuck.

**The modal path is the browser's.** `src/components/ui/Sheet.tsx` uses a native
`<dialog>` with `showModal()`, so the focus trap, the inert background, the top
layer and Esc are not hand-rolled. `onCancel` is prevented so Esc routes through
`onDismiss`, and the Cancel button takes `autoFocus` when the confirm is
destructive.

**Programmatic focus is managed with announcements.**
`src/app/knowledge/page.tsx:417-425` moves focus to a `tabIndex={-1}`
`role="region"` and puts an `sr-only aria-live="polite"` paragraph as its first
child so the announcement precedes the content.
`src/components/WorkflowCanvas.tsx:590` does the same for link mode.

**The one `onClick` on a non-interactive element is event delegation over real
anchors**, resolved in `00-problem.md`'s finding 6.

**The canvas is not pointer-only.** Every function is on an inner `<button>`
with an `aria-label` (`:705`, `:758`, `:799`). What a keyboard cannot do is
*drag*, which is layout rather than function, and `docs/agent/conventions.md`
already states that arranging a graph is a screen task.

## So what is left

**One thing: the focus ring is at 1.93:1 to 2.26:1 against its own surround.**
The keyboard path is built and the indicator that makes it usable is the part
that fails. That is `B1`, one number in one declaration, and Option C's entire
unique content collapses into it.

Two smaller residues, both stated as unverified because they are:

- **Tab order across a page was not traced.** Nothing here walked the DOM in
  order. Order follows source order absent `tabIndex` above 0, and
  `grep -rn "tabIndex={[1-9]" src/` returns nothing, so there is no positive
  tabindex anywhere and the order is the document's. That is an argument from
  absence, not an observation. **Assumed:** that no page's source order diverges
  from its visual order enough to matter.
- **No key binding was pressed.** `SegmentedControl`'s `onKeyDown` was read, not
  exercised. **Assumed:** that it implements arrow keys as the pattern requires.

## Why this option is not recommended as an option

Not because the concern is wrong, but because there is nothing left in it that is
separable from `B1`. An option is a decision, and "do a keyboard pass" as a
decision would buy: one number that Option B already changes, plus two
verifications that need a browser and therefore belong to
`13-validation.md` rather than to a work item.

Naming it and closing it is worth more than folding it silently into B, because
"the keyboard path is probably weak" is the default assumption about an interface
like this one, and here it is measurably false.

## What would overturn this

A browser session finding a control that cannot be reached, a trap, or a custom
widget whose arrow keys do nothing. Any of those turns Option C from a dissolved
option into a real one, and `13-validation.md`'s first pass is where it would
surface. On the current evidence the prior should be low: the two files that
comment about keyboard reachability are the two that had the defect and fixed it.
