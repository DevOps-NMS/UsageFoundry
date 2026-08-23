# The operator interface

**The question:** sixteen pages and roughly fifty components are read by one
operator supervising money-spending agents. Where does this interface fail a
reader who is not the person who built it, and what is worth changing?

**The state:** open. Six findings, four of them arithmetic on declared colour
values. Nine options, one recommended as a pair, three refused by name, two
filed as questions for a person, one handed back to the document that already
owns it. **Nothing here is a decision and no product code changed.**

## The recommendation

**Option B, then Option D, as one piece of work**,
[12-recommendation.md](12-recommendation.md).

Six hex values and a dozen class strings close four measured contrast failures:
the focus ring at 1.93:1 to 2.26:1 against its own surround on every focusable
element in the app; `--fg-faint` at 3.19:1 to 3.62:1 in light mode, reaching 192
rendered strings through `ListRow`'s description, `Hint` and `Empty`; white on
`--danger` at 2.82:1 in dark mode on every irreversible button; and `--fg-muted`
at 3.54:1 on the bezel, which is the `/settings` section chips. Then one test
file, no dependency, that parses `globals.css` and pins them, in that order,
because a floor asserted over today's values pins the failures instead.

**What would overturn it:** one browser reading of the ring at 75% alpha, at the
operator's desk. `globals.css:92-97` is imitating AppKit, whose focus ring is a
halo, and at 75% a 2px outline is nearly solid. If it reads as loud to the person
who looks at it all day, that number is wrong. Nothing else in the
recommendation depends on the reading.

**Refused by name:** axe-core in CI, raising the type scale, and a
progressive-disclosure restructure of `/settings`. The last of those was asked
for and is the firmest refusal in the survey.

## The findings at a glance

| | |
|---|---|
| Pages opened | **16** of 16 |
| Lines of `src/app/**/page.tsx` | 16,529 |
| Non-test component files in `src/components/` | 39, exporting more components than that (`Card.tsx` alone exports `Card`, `CardTitle` and `Empty`) |
| Declared text-on-surface pairings computed | **98** (7 text tokens x 7 surfaces x 2 schemes) |
| Of those, failing 4.5:1 | **29 (29.6%)**, 12 light and 17 dark |
| Failing pairings that occur in real call sites | **4**, which are findings 1, 1b, 2 and 3 |
| Published baseline for comparison | 40.9% of 4,327 pairings across 240 homepages; 20.4% of sites fully compliant (Vaughan & Ortiz Suarez 2026, preprint, read at abstract depth) |
| Findings that are a conformance failure at AA | 4 |
| Findings that are a technique-level concern | 1 (the document outline) |
| Findings that violate one of the app's own documented invariants | 1 (a surviving `title` tooltip) |
| Browsers driven by this survey | **0** |
| Screen readers used | **0** |

Full evidence, with the arithmetic and the call-site counts:
[00-problem.md](00-problem.md).

## The four measured failures

1. **`--fg-faint` is the app's explanatory layer and its least legible text.**
   3.19:1 to 3.62:1 on every light surface, at 11 to 13px so no large-text
   exemption applies anywhere. It reaches 87 `ListRow` descriptions, 61 `Hint`s,
   44 `Empty` states, every run-log timestamp and every diff line number. And it
   has no repair: the lightest value that clears 4.5:1 on all four light surfaces
   is `#6d6d71`, five greys from `--fg-muted`'s `#68686d`. **The palette holds
   two text weights at AA in light mode, not three.**
2. **The focus ring fails 1.4.11 on every surface in both schemes.** One
   declaration, `outline: 2px solid var(--ring)`, and `--ring` is `--accent` at
   45% alpha. 75% is the first round figure that clears 3:1 everywhere.
3. **White on `--danger` is 2.82:1 in dark**, on six `variant="danger"` buttons
   and eight `confirmVariant="danger"` sheets. `globals.css:76-80` documents
   inventing `--tint`/`--tint-fg` to solve this exact failure for blue, and
   measures 5.06:1 for it. The same sentence with red in it is the repair.
4. **A resting text control has no boundary at 3:1 by either route**, across 88
   call sites. Recorded and **deliberately not repaired**: `--border` is
   documented as a hairline at AppKit weight, and raising it is a judgement about
   how the app should look rather than a colour bug.

## What is in better shape than the question implies

Recording this matters as much as the findings, because it is why four of the
nine options are worth less than they sound.

**The keyboard path has been engineered in the places usually missed.**
`SegmentedControl` runs a roving tabindex with its own `onKeyDown`;
`Log.tsx:82-84` and `Patch.tsx:56,63,91` add `tabIndex={0}` to scroll containers
with a comment saying why; `Sheet.tsx` is a native `<dialog>` with `showModal()`,
so the focus trap and Esc are the browser's; `page.tsx:995` records a hand-rolled
`role="tablist"` being deleted in favour of the kit's component. Seven files
carry an `onKeyDown` and none of them is a `<div>` pretending to be a button. The
one `onClick` on a non-interactive element is event delegation over real anchors.
**The only thing wrong with the keyboard path is a colour**, which is finding 2.

**The four non-interaction states are designed**: `Empty` on 13 of 16 pages,
`Skeleton` on 10, `Notice` on 14, `role="alert"` on 8. First run is designed too,
and distinguishes "no billable turn yet" from a wrongly pointed `CLAUDE_HOME`.

## What this survey could not do

- **Open a browser.** At any viewport. Nothing here is a judgement about how
  anything looks, and the 390px reading that `docs/verification.md:1113-1250`
  prescribes remains exactly as open as that file says.
- **Use a screen reader.** Attribute coverage was counted; nothing was heard.
  Which is [08-option-g](08-option-g-document-outline.md)'s whole problem.
- **See real data.** `DATA_DIR` is unreadable from a work cycle, so no page was
  seen holding a hundred runs, a long log or a large diff.

Full accounting, including the two over-claims caught and dropped and everything
read by grep rather than opened:
[00-problem.md](00-problem.md#what-was-not-inspected).

## Files

| | |
|---|---|
| [00-problem.md](00-problem.md) | Six findings, the arithmetic behind each, the baseline comparison, and what is in better shape than expected |
| [01-constraints.md](01-constraints.md) | C1 to C11, every invariant and standing decision that bounds the field |
| [02-option-a-change-nothing.md](02-option-a-change-nothing.md) | The null, at its strongest, and the two things that beat it |
| [03-option-b-token-and-contrast-repair.md](03-option-b-token-and-contrast-repair.md) | **Recommended.** B1 the ring, B2 the third text weight, B3 the danger fill, B4 what is left alone and why |
| [04-option-c-keyboard-and-focus-pass.md](04-option-c-keyboard-and-focus-pass.md) | Dissolves into B1. That it dissolves is the finding |
| [05-option-d-contrast-test-no-dependency.md](05-option-d-contrast-test-no-dependency.md) | **Recommended.** A parse-and-assert floor in `node --test`; replaces a transcription with a read |
| [06-option-e-axe-in-ci.md](06-option-e-axe-in-ci.md) | Refused on cost, with the scheduling fact that would flip it |
| [07-option-f-type-scale.md](07-option-f-type-scale.md) | Refused despite having the better science. The angular arithmetic, with every assumption named |
| [08-option-g-document-outline.md](08-option-g-document-outline.md) | Filed as a sixteenth question for a person; the instrument is missing, not the effort |
| [09-option-h-progressive-disclosure.md](09-option-h-progressive-disclosure.md) | Refused on four independent grounds, including a named prohibition |
| [10-option-i-narrow-viewport.md](10-option-i-narrow-viewport.md) | Handed back to `docs/verification.md`, which owns it and has the procedure written |
| [11-comparison.md](11-comparison.md) | Seven weighted criteria, justified, and where the table misleads |
| [12-recommendation.md](12-recommendation.md) | B then D, three refusals, two things to file, and the falsifier |
| [13-validation.md](13-validation.md) | Four checks, two automatic, and what would count as this having failed |
| [contrast.py](contrast.py) | The instrument. `python3 proposals/OperatorInterface/contrast.py`, no dependencies |

## Neighbours

[GapRegister](../GapRegister/) surveyed where the gaps are and this proposal
starts from its frontend inventory. Two of its rows are load-bearing here and
neither is overturned: **F5** (nothing that renders is checked by anything) is
why [06-option-e](06-option-e-axe-in-ci.md) is refused as second in a queue
rather than on merit, and **F6** (settings has no field search) is why
[09-option-h](09-option-h-progressive-disclosure.md) calls progressive disclosure
a misdiagnosis of a reachability problem that already has an owner. GapRegister's
Survey 3 is the harness question; this proposal only adds that the one criterion
automation decides best does not need one.

Verification loop on the tree this was written against (`a4d6ad9`):
`npm run typecheck` exit 0; `npm test` 1,578 tests / 230 suites / 0 failures in
16.5 s. Green, and none of these six findings is something a green tree tells
you: there is no linter, no browser driver and no accessibility checker in this
repository, and `grep -ic contrast docs/agent/ui-density-audit.md` returns 0
across the 2,774 lines of the most thorough UI document here.
