# Option B: repair the four measured colour failures

Three token or component edits and roughly a dozen call sites. No new
dependency, no new file, no structural change, and nothing that moves a pixel of
layout. This is the option the measurement actually supports, and it is
deliberately narrower than the measurement: one finding is left out on purpose,
and the reason is in `B4`.

---

## B1. The focus ring: one number

`src/app/globals.css:112-113`:

```css
--ring:        color-mix(in oklab, var(--accent-source) 45%, transparent);
--ring-danger: color-mix(in oklab, var(--danger)        45%, transparent);
```

Change `45%` to `75%` in both. That is the whole edit.

The alpha sweep, ring against the surface it is drawn on, worst and best of the
four surfaces in each scheme:

| alpha | light | dark |
|---|---|---|
| 45% (today) | 1.93 to 1.99 | 2.01 to 2.26 |
| 65% | 2.65 to 2.82 | 2.75 to 3.38 |
| 70% | 2.85 to 3.09 | 2.98 to 3.74 |
| **75%** | **3.10 to 3.40** | **3.20 to 4.12** |
| 100% | 4.59 to 5.22 | 4.52 to 6.39 |

75% is the first round figure that clears 3:1 on all four surfaces in both
schemes. `--ring-danger` at 75% clears too (3.83 to 4.16 light, 3.16 to 4.09
dark), so one number covers both lines.

Three things make this the cheapest real repair in the survey. `C1` says the
ring's **colour** is the one property a component may state and the base layer
is the only place a width or offset is stated, so alpha is the only lever the
invariant leaves and it happens to be the defective one. `--ring` is read by
nothing except the two `outline` declarations, so the grep that audits the change
is `grep -rn "ring" src/app/globals.css` and it terminates. And no geometry
moves, so none of the density audit's caps or the seven affordances are touched.

**The residual, stated rather than hidden.** `C11`: under `@supports` the app
substitutes the operator's own system `AccentColor` into `--accent-source`, and
every number above is for the declared accent. Alpha is a multiplier on the
distance from the surface, so 75% improves any accent's ratio by the same factor
it improves this one, but it cannot guarantee 3:1 for a colour the app never
sees. A system accent close to the page's own grey would fail at any alpha, and
nothing in the app measures that. This is a repair, not a conformance claim.

**The one thing that could make it wrong is visual and this survey cannot see
it.** `globals.css:92-97` is explicitly imitating AppKit, whose focus ring is a
soft halo. At 75% a 2px outline is nearly solid. If that reads as loud to the
person who looks at it all day, the right answer is a smaller number that clears
3:1 on the surfaces that actually carry focusable controls (`--bg-raised` and
`--bg-inset`) rather than all four, which 73% does in light and 71% in dark.
`13-validation.md` puts this first because it is the only judgement in Option B
that needs eyes.

## B2. Stop routing text a reader needs through the third weight

`C4` is why this is not a token edit: the lightest `--fg-faint` that clears
4.5:1 on all four light surfaces is `#6d6d71`, and `--fg-muted` is `#68686d`.
Darkening the token deletes it. So the repair is at the sites that chose it.

Three of them are the whole of the reach, because three kit components route
hundreds of call sites into the token:

| Site | Today | Proposed | Reaches |
|---|---|---|---|
| `src/components/ui/List.tsx:147` | `text-xs leading-snug text-ink-faint` | `text-ink-muted` | 87 `description=` |
| `src/components/ui/Hint.tsx:24` | `neutral: "text-ink-faint"` | `text-ink-muted` | 61 `<Hint>` |
| `src/components/ui/Card.tsx:117` | `py-5 text-center text-sm text-ink-faint` | `text-ink-muted` | 44 `<Empty>` |

and three more that are the app's evidence surfaces:

| Site | What |
|---|---|
| `src/components/ui/Log.tsx:118` | every run-log event's timestamp, `text-2xs` |
| `src/components/ui/Patch.tsx:110,117` | every diff's line numbers |
| `src/app/settings/page.tsx:133-134` and `src/components/WorkflowCanvas.tsx:835` | finding 1b: `text-ink-muted` at rest on `bg-bezel`, which is 3.54:1 in dark. Both already flip to `text-ink` on hover, and both carry the selected state in the fill plus `aria-current` or a label change, so the resting label can be `text-ink` and lose nothing |

`--fg-muted` after the change: 4.87:1 to 5.54:1 on every light surface, 4.97:1 to
7.03:1 on every dark surface except the bezel, which those two sites stop using.

**What `--fg-faint` is for afterwards.** Text whose absence would cost the reader
nothing, and inactive controls, which 1.4.3 exempts by name (`C11`). If it turns
out that nothing qualifies, the token should be deleted rather than kept as a
trap, but **that is a decision this survey cannot make**: whether a page with two
text weights reads flat is a question about looking at it. What the survey can
say is that the current third weight is being used for the opposite of decoration.

**The strongest objection, and what the evidence says about it.** Collapsing
three weights into two removes a layer of visual hierarchy, and the app's
information density is the thing `docs/agent/ui-density-audit.md` spent 2,774
lines on. Two things blunt it. First, weight is not the only differentiator at
these sites: `ListRow`'s description stays `text-xs` against a `text-sm` title,
`Hint` stays below its field, `Empty` stays centred in a card, so the hierarchy
survives in size and position. Second, the vault gives no support for a third
grey as a hierarchy device and does give support for the layer this change
protects. `/workspace2/3 Resources/Web Design/Visual Hierarchy and Scanning.md`
(confidence medium) reads the F-pattern as a **symptom of weak hierarchy** whose
remedy is headings differentiated enough to be entry points, which is finding 5,
not text colour. And
`/workspace2/3 Resources/Web Design/Interface Copy Density.md` puts helper text
under a label in the category where the redundancy prediction is "positive or
null" (Mayer & Johnson 2008, 2 to 3 redundant words adjacent, d = 0.47 to 0.70;
Adesope & Nesbit 2012, 57 studies, N = 3,452, g = 0.15 [0.08, 0.22]), and records
the finding that cuts closest here: users **prefer** the more explanatory version
while performing worse with it. The app has already decided to carry the
explanatory layer, 192 times. Option B makes it legible; it does not add a word.

**One judgement call inside B2, flagged rather than decided.**
`src/components/ui/Field.tsx:48` is `placeholder:text-ink-faint`, 3.33:1 on
`--bg-inset` in light. A placeholder is text and the criterion applies to it. But
a placeholder as dark as a value is the classic "the field looks filled" defect,
and this app has 88 text controls. The conforming move is `text-ink-muted`; the
safe move is to leave it and note that every `Field` can carry the same
information in a `hint`, which `Hint` is for and which B2 is fixing anyway. This
survey recommends leaving the placeholder alone and says so as a stated
exception rather than counting it as a pass.

## B3. Give the destructive button its own fill, the way the file already did for blue

`src/app/globals.css:76-80` documents the pattern for the accent, in the file's
own words: "in dark mode no single blue does both; `#4a9bff` carries white at
2.8:1. So the filled control gets its own, deeper blue and white stays legible at
5.1:1." Measured: 5.06:1. The pattern works and the same sentence with red in it
is the repair.

Add a `--danger-fill` beside `--tint`:

```css
--danger-fill: light-dark(#d70015, #c4514b);
```

and change `bg-danger` to `bg-danger-fill` at
`src/components/ui/Button.tsx:50`. Six `variant="danger"` sites and eight
`confirmVariant="danger"` sheets inherit it.

The candidates, white label against fill and fill against a card:

| fill | white on it | vs `--bg-raised` |
|---|---|---|
| `#ff6961` (today) | **2.82** | 5.07 |
| `#d4534b` | 4.09 | 3.50 |
| **`#c4514b`** | **4.54** | **3.15** |
| `#b84a45` | 5.12 | 2.80 |

`#c4514b` is the only candidate in the family that clears 4.5:1 for the label
**and** 3:1 for the button's own boundary against the card. Deepening further
buys label contrast by losing the boundary, which is 1.4.11 in exchange for
1.4.3, and `#b84a45` has already crossed.

`--danger` itself does not move, so the badge tones, the tone lines and the
danger text stay exactly as they measure now.

**The alternative, and why it loses.** A dark label on the existing fill scores
better: `#1d1d1f` on `#ff6961` is 5.97:1. It also gives the app two filled
buttons whose label colours disagree, for no reason a reader could infer, and it
breaks the symmetry with `--tint-fg` that `globals.css:76-80` established
deliberately. Worse ratio, better system.

**And the honest caveat.** `C8`: white on a saturated red in dark mode is the
exact case where the vault records the sRGB formula's critics as having their
strongest argument, and where neither side has participant evidence. B3 is the
part of Option B whose *number* is least secure. Its justification is not the
number, it is that the file already decided this question once, wrote down the
reasoning, and applied it to one of the two colours.

## B4. What Option B deliberately leaves alone

Finding 4, the resting control boundary: `--border` against a card is 1.28:1
light and 1.26:1 dark, `--bg-inset` against a card is 1.09:1 and 1.26:1, and
neither route reaches 1.4.11's 3:1 across 88 call sites.

Option B does not touch it, for a reason that is in the file.
`src/app/globals.css:56-58` describes `--border` as a hairline at macOS weight,
explicitly matching AppKit's `separatorColor`, with the depth coming from
`--shadow-e1` rather than from the edge. Raising it to 3:1 would put it far
above the platform it is imitating, on a token read across every card, table,
list and control in the app, verified by nothing (`C10`). That is a different
size of change from the three above and it rests on a judgement about how the app
should look, which is the operator's and not this survey's.

What Option B does instead is record the number and note that the focused state
is already fine: `Field.tsx:53` sets `focus:border-accent`, which is 5.22:1
light and 5.06:1 dark. So a keyboard operator can always see which control they
are in; what is weak is only the resting boundary of an unfocused field, and the
field is a filled box on a card rather than a bare underline.

## Cost, and what it does not buy

Six files: `globals.css` (two numbers, one new token), `List.tsx`, `Hint.tsx`,
`Card.tsx`, `Log.tsx`, `Patch.tsx`, plus `Button.tsx`, `settings/page.tsx` and
`WorkflowCanvas.tsx` at one line each. Every one is a class string or a hex
value. No dependency, no test, no schema, no layout.

It does not buy conformance, and no option in this survey does. It closes four
measured failures, of which one is arithmetic on opaque light-mode colours and
therefore about as solid as this criterion gets, one is a single number in a
single base-layer declaration, one is authorised by the file's own precedent,
and one is a call-site weight choice on two chips. `C9` is the frame: contrast is
the criterion automation decides best, and the reason these four survived was
never a missing tool, it was that nobody had run the arithmetic.
