# Recommendation

**Take Option B, then Option D, in that order, as one piece of work. Refuse E, F
and H. File G and the type-scale question for a person. Hand I back to
`docs/verification.md`, which already owns it.**

## The whole of it

**1. Option B**, six files, every edit a hex value or a class string:

- `src/app/globals.css:112-113`: `45%` becomes `75%` in `--ring` and
  `--ring-danger`. Clears 1.4.11's 3:1 on all four surfaces in both schemes
  (3.10 to 3.40 light, 3.20 to 4.12 dark), up from 1.93 to 2.26.
- `src/app/globals.css`: add `--danger-fill: light-dark(#d70015, #c4514b)` beside
  `--tint`, **and** a `--color-danger-fill: var(--danger-fill)` line in
  `@theme inline` next to `:339-340`'s siblings, or the `bg-danger-fill` utility
  does not exist. `src/components/ui/Button.tsx:50` then reads `bg-danger-fill`.
  White on the fill goes from 2.82:1 to 4.54:1 in dark, and the fill keeps a
  3.15:1 boundary against a card.
- `src/components/ui/List.tsx:147`, `src/components/ui/Hint.tsx:24`,
  `src/components/ui/Card.tsx:117`: `text-ink-faint` becomes `text-ink-muted`.
  That is 87 `ListRow` descriptions, 61 `Hint`s and 44 `Empty` states, from
  3.19 to 3.62:1 up to 4.87 to 5.54:1 in light.
- `src/components/ui/Log.tsx:118` and `src/components/ui/Patch.tsx:110,117`: the
  same swap for run-log timestamps and diff line numbers.
- `src/app/settings/page.tsx:134` and `src/components/WorkflowCanvas.tsx:835`:
  the resting label on `bg-bezel` becomes `text-ink`, closing finding 1b's
  3.54:1 in dark. Both already flip to `text-ink` on hover and both carry their
  state in the fill plus `aria-current` or a label change, so nothing is lost.
- **Not** the placeholder at `Field.tsx:48`, and **not** `--border`. Both are
  stated exceptions with reasons in `03-option-b`, not oversights.

**2. Option D**, one new test file, no dependency: parse
`src/app/globals.css`, assert the pairing floors, assert the token count first so
a parse failure is loud.

**3. One five-line deletion.** `src/app/branches/page.tsx:335-340`'s `title`
attribute, the seventh tooltip after `docs/agent/ui-density-audit.md:2687-2694`
deleted six, carrying the definition of a dollar figure. `docs/agent/ui-density-audit.md:1.2`
says where that text goes: a `ListRow` description or a `Field` hint, both of
which Option B is making legible anyway.

## Why in that order, and why they are one piece of work

Because `CLAUDE.md`'s own bar for a fix is that the test fails before it and
passes after. So the sequence is: write D's pairing table with the target
thresholds, run `npm test` and watch four rows fail, apply B, run it again and
watch them pass. That gives the repair a witness, and it is the only witness
available in a container with no browser.

Taken the other way round, D pins today's values and converts four failures from
an unmeasured default into an asserted intention, which is worse than no test.
`05-option-d` says so and it is the reason this is one recommendation and not two.

## Why not the others

- **E (axe in CI)** is refused on cost, not merit. In the affordable
  configuration it reports `incomplete` on all four findings, because jsdom
  cannot resolve `light-dark()` inside `color-mix()` and this app's every colour
  is that shape. In the unaffordable one it is a browser and a running app in CI,
  which is a rendering-test harness wearing an accessibility argument. It is
  second in a queue whose first item is `proposals/GapRegister/01-frontend.md`'s
  F5.
- **F (type scale)** has the better science and loses anyway:
  `globals.css:707-711` already refused it in writing, the change reflows every
  layout in an app where nothing renders in a test, and browser zoom is a
  strictly better instrument for an angular criterion than a token is.
- **H (progressive disclosure)** contradicts two named prohibitions, restructures
  the longest file in `src/app`, and moves in the direction SearchPilot 2020 and
  Peytchev et al. 2010 both point away from. The real gap on `/settings` is a
  field search, which is `proposals/GapRegister/01-frontend.md`'s F6 and F2.
- **C (keyboard)** dissolves into `B1`. That it dissolves is worth recording: the
  keyboard path here is better than the default assumption about an interface like
  this one, and the only thing wrong with it was a colour.

## Two things to file, which this proposal does not do

This proposal does not edit `docs/`, so both of these are follow-ups rather than
part of the option:

- **`docs/agent/testing.md`** is where a new test records the grounds it earned.
  D's grounds are in `05-option-d` and should move there when it lands.
- **`docs/agent/ui-density-audit.md:2191-2262`** leaves fifteen questions open for
  a person. `08-option-g`'s outline question is a sixteenth, and
  `07-option-f`'s angular-size reading is a seventeenth. Neither is a code
  change and both need an instrument this container does not have.

## The fact that would overturn this

**One browser reading, at the operator's desk, of the ring at 75%.**

`globals.css:92-97` is explicitly imitating AppKit, whose focus ring is a soft
halo. At 45% alpha a 2px outline is a halo; at 75% it is nearly solid. If that
reads as loud to the one person who looks at it all day, then B1's number is
wrong and the choice is a smaller alpha that clears 3:1 only on the two surfaces
that actually carry focusable controls (73% light, 71% dark), or dropping B1 and
accepting that the app's focus indicator sits below 1.4.11.

Nothing else in the recommendation depends on that reading. B2 and B3 are
arithmetic on opaque colours, and B2's is in light mode, where `C8` says the
formula's critics have their weakest case.

**The second overturning fact is a scheduling one.** If a rendering-test harness
lands for any reason, take E immediately: `axe-core` becomes one devDependency
and about fifteen lines per page, and the 13% of a large number that
`C9` describes stops being expensive.

## What this recommendation does not claim

It does not claim conformance, and `C8` is why: the thresholds are conventions
with thin provenance and the vault's instruction is explicit that an automated
contrast pass is not proof that text is readable. It does not claim the app was
in bad shape: 29.6% of declared pairings failing against a published 40.9%
baseline puts it better than the median site in that corpus and outside the
compliant fifth. And it does not claim to have looked at anything: no browser was
driven, no screen reader was used, no page was seen holding real data.

What it claims is narrower and checkable. Four ratios are below their thresholds,
the arithmetic that says so is in `contrast.py` and runs in a second, and the
repair is six hex values, a dozen class strings and a test that keeps them there.
