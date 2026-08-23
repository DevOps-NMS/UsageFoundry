# Option G: a narrow-viewport status page

A phone-shaped page answering "does anything need me?" — small payload, one
screen, no navigation. The brief asked for it and it is **handed back rather than
scored**, for a different reason than the one that retired the same question in
the previous proposal, and with one real contribution of its own.

## First, what this option is not allowed to re-decide

`proposals/OperatorInterface/10-option-i-narrow-viewport.md` already handed the
narrow-viewport *question* back to `docs/verification.md:1113-1250`, which owns
it, prescribes the reading (390x844, the branches selection bar's left edge, the
`max-md:h-80` spacer, the workflow instance page as the cross-component `stack`
proof), records the two escaped greps that work and the unescaped one that returns
0 on a build where the class is present, and separates the two device-only iOS
checks from the browser-only ones. C9 is why it is still open: no browser has
crossed the `md` breakpoint at this app, ever.

**None of that is re-opened here**, and this file does not repeat it. The
different question this option gets to ask is: *should there be a separate,
narrower surface at all?*

## The answer, and it is the useful part of this file

**No, because the surface already exists and its value is Option B's.**

The app is already responsive and already installable. `Table`'s `stack` prop
covers seventeen of twenty tables, three deliberately flat and named
(`docs/verification.md:1113-1250`). `Field.tsx:29` swaps to
`max-md:text-[16px]`, `max-md:min-h-11` raises control heights, and
`WorkflowCanvas.tsx:826-836` grows a `max-md:after` hit-target overlay. The
manifest makes it home-screen installable (`src/app/manifest.ts`), the icons are
rasterised including a maskable one, and `layout.tsx` sets `viewportFit: "cover"`
and a dual `themeColor`. Somebody has already built the phone version of this app.

So the operator standing away from their desk who wants to know whether anything
needs them opens the app on their phone and looks at `/runs`. What is missing is
not a page. It is (a) the *answer* being one glance rather than four filter
changes across three pages, which is exactly `03-option-b-in-app-digest.md`, and
(b) somebody having ever looked at it at 390px, which has an owner and a written
procedure.

**That raises Option B's score and it should be recorded as such.** Option B's
own file scores it as "converts eight pages into one" and concedes it removes zero
latency for an operator not looking at the app. The correction is narrower than
that: a digest badge visible in the shell is *also* the phone answer, and the
phone is where an operator who is not at their desk actually is. It still requires
the operator to open something. It no longer requires them to be at a computer.

## Why a *separate* page would be worse

**It cannot be a tenth pane.** `src/components/shell/panes.ts:12-16`: "Nine is the
ceiling and Knowledge is the ninth — a tenth destination has no digit, and a row
without one is a row two of the four readers cannot describe." `PANES` has exactly
nine entries with shortcuts 1-9, read by the source list, the toolbar's title,
⌘1-9 and quick open. A separate status page is either a tenth destination two of
those four readers cannot describe, or it is unlinked and reachable only by typing
a URL, which is not a surface an operator uses at 07:00.

**It would be a second copy of a live view.** `01-constraints.md` C6 bounds the
unauthenticated version to counts, so a useful one is behind the session gate —
at which point it renders the same data as `/runs`, from the same tables, with a
second set of components to keep in step. `proposals/OperatorInterface`'s C10 is
the cost: 16,529 lines of page code, **0 page components rendered by any test**.
A duplicate view is duplicate untested surface.

**And `/` is already crowded.** `proposals/OperatorInterface/00-problem.md`'s
document-outline finding counts eleven peer `<h2>`s on the dashboard, three of
which are the cost-source containers. Adding a twelfth is what
`/workspace2/3 Resources/Web Design/Progressive Disclosure.md` orders as the
*last* move after Delete, Show and Hide have been tried, and
`docs/agent/ui-density-audit.md` §1.0 says the same in this repository's own words.

## The speed argument, and why it does not apply

The obvious case for a purpose-built narrow page is weight: a small payload for a
phone on a bad connection. That case is weaker than it sounds, twice.

**The app has already engineered payload size where it matters.**
`docs/agent/conventions.md`: eighteen route handlers answer through
`jsonMaybeGzipped` because "Next filters every app-router handler out of its own
compression by content type", and the streaming routes are excluded by name. This
is not an app that ignored transfer size.

**And the causal evidence for speed does not reach this user.**
`/workspace2/3 Resources/Web Design/Speed as a Design Constraint.md` is unusually
disciplined about this: the only causal evidence that speed changes behaviour is
deliberate-slowdown experiments at Bing (Kohavi et al., KDD '13: +0.6% revenue per
100 ms) and Google (Brutlag 2009: −0.20% at 100 ms to −0.59% at 400 ms), and both
measured **server latency on a search page for anonymous users who have
alternatives**. The mechanism Brutlag identified is attrition — harm roughly
doubled in the experiment's second half and persisted for five weeks after the
delay was removed. A single operator opening their own admin tool to find out
whether their agents need them does not attrit. They wait.

The one figure that does transfer is Arapakis et al. (SIGIR '14): under 500 ms is
not reliably detectable, over 1000 ms is reliably noticed. That is a floor to stay
under, not an argument for a new page. The note's own instruction is that the
correlational numbers quoted in performance pitches report effects roughly 14x
larger than the controlled ones, "which is itself evidence of confounding", and
importing them here would be exactly the misapplication it catalogues.

## Coverage against the nine rows

Whatever Option B's assembly function reads, rendered narrower — so all nine
except row 3, which emits nothing. Identical to Option B, because it *is* Option B
with a different stylesheet.

## Cost

Not costed, because it is not recommended as a build. If it were: a duplicate
untested view, a tenth pane or an unlinked URL, and no data Option B does not
already have.

## Verdict

**Handed back, in two directions.** The rendering question belongs to
`docs/verification.md:1113-1250`, which owns it and has the procedure written, and
`CLAUDE.md` says that file's "Not yet verified by hand" list "must stay honest" —
so the honest thing is to point at it rather than produce a second copy. The
*content* question belongs to Option B, whose score this file raises.

The scheduling observation `proposals/OperatorInterface/13-validation.md` already
makes applies here too and is worth repeating once: if anybody gets a browser to
390px, the seventeen stacked tables, Option B's badge and this survey's phone
premise are all on the same screen and should be looked at in one sitting.
