# The Dreaming pane

**A requirement, not an option.** The operator has said the app gets a
left-navigation destination where they can see what Dreaming produced, and that
it gets one regardless of what the rest of this survey recommends. This file is
about *how*, and about the one invariant it walks into, which is documented and
load-bearing and cannot simply be edited around.

Everything below applies whichever option ships. What changes per option is what
the pane has to show, which is §5.

---

## 1. What a tenth destination collides with

`src/components/shell/panes.ts` is the app's list of destinations, and its
docblock says why it is a module rather than an array inside the sidebar
(`:6`–`:9`):

> "The source list draws them, the toolbar titles itself from them, ⌘1…⌘9
> navigates to them and quick open searches them. **Four readers** is why this is
> a module rather than an array inside the sidebar: a pane added in one of them
> and missed in the others is a pane you can reach and cannot get back from, or
> a shortcut that lands somewhere the list does not highlight."

The four are real and each has to be checked:

| reader | site | what it does with a pane |
|---|---|---|
| `Sidebar` | `Sidebar.tsx:167`–`:176` | draws the row; announces `aria-keyshortcuts={\`Meta+${pane.shortcut}\`}` |
| `AppShell` | `AppShell.tsx:248` | `PANES.find((p) => p.shortcut === e.key)` on ⌘+digit |
| `QuickOpen` | `QuickOpen.tsx:204`–`:208` | lists it, with `detail: \`⌘${pane.shortcut}\`` |
| `Toolbar` | `Toolbar.tsx:108` via `toolbarTitle`/`activePane` | titles the page |

And `:12`–`:16` states the ceiling that a tenth row breaks:

> "The digit follows the row's position rather than the pane's age … **Nine is
> the ceiling** and Knowledge is the ninth — a tenth destination has no digit,
> and a row without one is a row two of the four readers cannot describe."

**"Two of the four readers cannot describe it" is precise and checkable, and it
checks out.** Both sites interpolate the digit into a string with no guard:
`Sidebar.tsx:176` would announce `aria-keyshortcuts="Meta+undefined"` and
`QuickOpen.tsx:208` would render a `detail` of `⌘undefined`. Neither is a type
error — `shortcut: string` is required today, so the failure only appears the
moment somebody makes it optional — and neither throws. A screen reader would
announce a shortcut that does not exist, and the palette would print `⌘undefined`
beside the row. **That is the invariant, it is real, and it is the thing to fix
rather than the thing to ignore.**

## 2. One defect found on the way

**The docblock names the wrong pane.** It says "Knowledge is the ninth". In the
array at `:26`–`:39`, Knowledge is **seventh** — the comment at `:34`–`:36`
records it being moved *above* API account and Settings, "those two are the
install's own configuration and stay at the bottom", and the docblock above was
not updated to match. Settings is the ninth.

The rule survives the error: nine is still the ceiling, because ⌘1…⌘9 is still
nine digits and the array still has nine entries. But the sentence that states
the rule is wrong about which row sits at the boundary, and it is the sentence
anybody adding a pane will read first. Fix it in the same change.

## 3. Three ways to seat a tenth row

**(a) Dreaming takes a digit and everything below renumbers.** The docblock's own
rule — "inserting a pane renumbers the ones under it" — applied literally: place
Dreaming after Knowledge and it becomes ⌘8, API account ⌘9, and **Settings falls
off the end**. Rejected. Settings is the pane an operator reaches for when
something is wrong, and trading its shortcut for a readout's is the wrong way
round.

**(b) Dreaming is the tenth row and has no digit.** Make `Pane.shortcut`
optional and guard the two interpolation sites:

```ts
// panes.ts
shortcut?: string;   // absent on a row past the ninth — ⌘1…⌘9 is nine digits

// Sidebar.tsx:176
aria-keyshortcuts={pane.shortcut ? `Meta+${pane.shortcut}` : undefined}

// QuickOpen.tsx:208
detail: pane.shortcut ? `⌘${pane.shortcut}` : undefined,
```

Three lines, and `AppShell.tsx:248` needs nothing — `PANES.find` compares against
a keypress, and `undefined === "8"` is false, so a digit-less row is simply never
matched. **`QuickOpen` needs nothing beyond the guard either**, checked rather
than assumed: `QuickItem.detail` is already `detail?: string`
(`QuickOpen.tsx:47`) and the render site is already conditional,
`{item.detail && (` at `:373`. So a row with no digit draws no detail chip and
the palette is correct by construction.

**This is the recommendation.** It is the smallest change, it makes the
docblock's warning enforceable by the type system instead of by prose, and it
answers the ceiling honestly: the tenth destination exists and does not pretend
to have a shortcut.

**(c) Dreaming is a sub-route of Knowledge**, at `/knowledge/dreaming`, where
`activePane`'s segment matching keeps the Knowledge row highlighted and no digit
is needed. **Rejected on the requirement**, not on merit — the operator asked for
a left-nav row and this is not one. Recorded because it is what the codebase
would otherwise push you toward, and so that a later reader can see it was
considered rather than missed.

### The rest of the wiring

- **`activePane` matches on a path segment, not a prefix** (`panes.ts:44`–`:47`),
  so `/dreaming` and `/dreaming/<id>` both highlight the row and a future
  `/dreamings` would not. Nothing to add.
- **`IconName` is a closed union** (`Icon.tsx:19`–`:51`) and `GLYPH` is a
  `Record<IconName, ReactElement>` (`:54`), so adding `"dreaming"` to the union
  is a typecheck error until the glyph exists. That is the file working as
  intended; draw the glyph at the same 16-unit box and stroke weight as its
  neighbours, and put it in the union's first group, which is commented "Sidebar
  and nav, one per destination the app has."
- **`toolbarTitle` needs nothing** for a flat `/dreaming`; it falls through to
  `activePane(pathname)?.label`. It needs a line only if the pane grows a
  sub-route, and then it goes *above* the fall-through for the reason the
  `/runs/…/touched` case documents at `:68`–`:70`.

## 4. The route and the page

Both rules come from `docs/agent/conventions.md` and neither is optional.

- **`export const runtime = "nodejs"` and `export const dynamic =
  "force-dynamic"`** on the route handler, because it touches SQLite and the
  filesystem. "Every existing data route has both" (`conventions.md:11`).
- **The page is a client component** that reads its route, like every other page
  in the app; there is no server-side data layer (`:15`).
- **Answer through `jsonMaybeGzipped`** if the body can get large, and write the
  `Cache-Control` at the call site — the helper knows nothing about caching
  (`:18`). A ledger of 77 rows will not need it; a recurrence readout of 1,177
  signatures with per-day counts might.

**And it must not poll.** `conventions.md:15`: "A poll stands down when its
subject can no longer move, and re-arming it is the half that has to be
designed." A Dreaming pane's subject moves **once a night**. A 120-second poll
against a table that changes at 03:04 is 720 requests for an answer that cannot
have changed, and the re-arm logic that makes polling correct elsewhere has
nothing to key on here. Load on mount, and let the operator reload. If a run is
in flight, the place that shows it moving is `/runs`, which already does.

## 5. What the pane shows, per option

The pane is not the same page for each option, and one of them cannot be built at
all without something else being built first.

**Option G — the recurrence readout.** The pane *is* the feature. A table sorted
by days-spanned: the signature quoted verbatim, the count, the date range, and
links to the sessions. 77 rows qualify today, carrying 49.4% of 2,549 error
instances. It needs a cached rollup of its own rather than riding `/api/usage`'s
transcript walk — the cold scan is 2,985–3,041 ms against a warm 82.5–88.9 ms
(`proposals/GrowthLimits`), and this adds to the cold number.

**Option I — the licensed errors-only writer.** The pane renders the **ledger**,
which is a table this app owns: signature, days seen, the night it was written,
the note it became, and whether that file still exists. Five real columns, no
transcript walk, and the last one is a `statSync` per row.

**Option H — the unscoped writer.** The pane renders whatever the ledger holds,
which for Option H is 0.2% of what it read (`16-option-h` §4). There is no key
for a learning drawn from a successful tool call, so the other 99.8% of its output
is unlistable. **The pane is the argument against Option H stated as a screen:
most of what it writes cannot be shown here.**

**One fact governs all three.** There is no way to render "what Dreaming wrote"
by reading the vault. A note in the vault carries no author field and nothing
saying this app produced it (`01-constraints.md` C7: "no memory system found so
far authenticates what wrote a memory"). **The pane can only ever show a record
this app kept at write time**, so the ledger is a precondition for the pane, not
a nicety beside it — and if the pane ships before any writer does, it shows the
recurrence readout and nothing else, which is Option G and is fine.

## 6. The three kinds of nothing

The pane must not render them the same way, for the reason
`docs/agent/git-and-review.md` gives about the three ways of having no diff:

- **Never configured.** No schedule exists, nothing has ever run. Say that, and
  say where to make one.
- **Configured, ran, wrote nothing.** A night where no signature reached a second
  day — six of the 23 measured days. This is the *success* case for the
  write-on-second policy and must not read as a failure. "Ran at 03:04, nothing
  recurred."
- **Ran and failed.** The run errored, was cancelled, or tripped a budget guard.
  Link to the run.

An empty table for all three is the failure this rule exists to prevent: the
operator cannot tell a working quiet night from a job that has been broken for a
week.

## 7. What it costs

| piece | size |
|---|---|
| `shortcut?: string` plus two guarded interpolations | three lines |
| fix the docblock's "Knowledge is the ninth" | one line |
| `"dreaming"` in `IconName` + a glyph | small |
| the pane row itself | trivial — one entry in `PANES` |
| route handler + client page + three empty states | small, and conventional |
| **the ledger table the pane reads** | **medium — and it is the real work** |
| a cached rollup, if the pane shows Option G's readout | medium; it must not ride `/api/usage` |

The nav row is cheap. The thing behind it is not, and the row without the thing
behind it is a destination that shows an empty table for ever — which is the one
outcome worse than not having it. **Ship the pane with Option G's readout in it,
because that has no prerequisite**, and let the ledger columns appear when a
writer exists to fill them.

## 8. What it must not do

**No control that starts a run.** `conventions.md:29` states the rule for quick
open and the reasoning is general: "a keystroke away from spending money is what
every approval gate in this app exists to prevent, and a palette is exactly where
such a thing would look convenient." A readout is exactly where a Run Now button
would look convenient too. The place to start a scheduled workflow is
`/workflows`, which already has the budget refusal attached
(`schedules.ts:529`–`:539`).

**No delete-from-vault button, on the first version.** Deleting a file out of the
operator's document store from a web page, in a store with no `.git` and no undo,
is a heavier action than anything else this app does to a mount it does not own.
Show the path and whether the file is still there. Let the operator delete it in
Obsidian, which is where they can see it first.
