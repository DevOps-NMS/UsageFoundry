# Option F: raise the type scale

The strongest option in this survey that this survey refuses, and the only one
whose refusal turns on a measurement the container cannot take.

## The case, and it is a real one

The app's body text is 13px. `src/app/globals.css:372-375`:

```css
--text-sm:   0.8125rem;   /* 13 — inputs, tables, buttons */
--text-base: 0.8125rem;   /* 13 — body, was 14 */
```

`--text-xs` is 12 and `--text-2xs` is 11. The comment records that `--text-base`
was *reduced* from 14.

The vault's evidence on size is the best-grounded typographic evidence it has,
and it does not support 13px.
`/workspace2/3 Resources/Web Design/Typographic Measure and Rhythm.md:56-62`:

> "16px minimum" traces to `font-size: medium` being 16px in every major engine,
> not to research. WCAG specifies no minimum size. … The real account is Legge &
> Bigelow (2011): reading speed is flat across a ~10x range of print sizes (the
> "fluent range", x-height 0.2° to 2° of visual angle) and falls sharply below
> the **critical print size** (~0.2° x-height). Because that is *angular*, it is
> a joint function of size and viewing distance, a pixel value alone cannot
> satisfy it. Their corpus survey found online newspaper running text averaged
> **0.19°, at or just below critical print size**.

And Rello et al. (2016) found benefits continuing well past the convention:
fixation duration fell from .255 s at 10pt to .199 s at 22pt (F(5,445) = 66.825,
η² = .159), comprehension better at 18 and 26pt than at 10 and 12pt, with the
empirical optimum at 18 to 22pt, roughly 24 to 29px.

Doing the angular arithmetic for this app, with every assumption named:

| assumption | value |
|---|---|
| x-height ratio of the resolved `system-ui` face | **assumed** 0.52 (SF Pro ~0.52, Segoe ~0.50, Roboto ~0.53); not measured, no font metrics were read |
| display | **assumed** a 227 ppi laptop panel at device-pixel-ratio 2, so 1 CSS px = 0.224 mm |
| 13px em | 2.91 mm |
| x-height | 1.51 mm |
| at 450 mm viewing distance | **0.192°** |
| at 550 mm | **0.157°** |
| at 700 mm | **0.124°** |

Every one of those is at or below Legge & Bigelow's 0.2° critical print size,
which is where reading speed stops being flat and starts falling. The app is in
the same place their corpus survey found the online press: at or just under the
line. On this evidence, an operator who reads run logs and diffs all day is
reading below the fluent range unless they sit closer than 45 cm.

That is a stronger empirical case than the one behind finding 1's 4.5:1 threshold
(`C8`), and honesty requires saying so.

## Why it is refused anyway

**The file has already refused it, in writing, with reasons that are still
true.** `src/app/globals.css:707-711`:

> Three things this deliberately is not. Not a change to `--text-sm`: twenty
> other things read it, and the note beside it in `@theme` is the reason it and
> `--text-base` are both 13. Not a `font-size` on `html`, which redefines `rem`
> and silently takes 12.5% off every spacing and type utility in the app.

That is not an omission to be corrected, it is a decision with a stated cost,
and the cost lands exactly where `C10` says this repository is thinnest: a change
to `--text-base` reflows every one of 16,529 lines of page code that no test
renders, and there is no browser in the container where the change would be made.
`docs/agent/ui-density-audit.md`'s entire 2,774 lines are an argument about how
much fits on a page; F would invalidate its measurements without being able to
re-take them.

**The one size rule that is not craft convention is already implemented, twice.**
The same vault note says the single hard technical fact behind 16px is that iOS
Safari auto-zooms form inputs below it. `globals.css:701-722` handles it with an
element-selector floor inside the exact media query Tailwind emits for `max-md:`,
"character for character, rather than a max-width, so the breakpoint is one
boundary and not two that agree to within a fraction of a pixel", and
`src/components/ui/Field.tsx:29` carries `max-md:text-[16px]` so a control that
states its own size still wins. The non-craft part of the size argument is done.

**The instrument the reader already has is better than the one F would build.**
Angular size is a joint function of size and distance, so the correct control is
one the reader can move: browser zoom, which scales type, spacing, line-height
and hit targets together and coherently, and which this app does not fight
(`rem`-based scale, no `font-size` on `html`, `--control-h` in `rem`). One
operator pressing `⌘+` once gets 14.3px at every one of the app's twelve type
steps in proportion. A token change gets 15px at one step and leaves the other
eleven where they were, which is worse typography arrived at by more work.

**And the measurement that would decide it is the one nobody can take.** Three of
the seven rows in the table above are assumptions, and two of them (the resolved
face's x-height ratio, the operator's actual viewing distance and panel density)
are facts about a machine this container has never seen. F is the one option in
this survey whose case rests on numbers I cannot check, and `contrast.py`'s
numbers are the opposite: arithmetic on values declared in a file in this
repository.

## What to do with it instead

Two things, neither of which is a code change.

**Tell the operator the number.** If reading the app is tiring, the finding above
is the reason and browser zoom is the fix, and 110% or 125% is the whole
intervention. That belongs in a sentence somewhere a person reads, not in a token.

**If a size change is ever wanted, measure first, at the desk.** Legge &
Bigelow's criterion is angular, so the reading has to be taken at the real
viewing distance on the real panel, and then the decision is which of the twelve
steps moves and what it does to the density audit's caps. That is a browser task
with an operator in the chair. It is on `13-validation.md`'s list as an open
question rather than as a verification, because there is nothing here to verify.
