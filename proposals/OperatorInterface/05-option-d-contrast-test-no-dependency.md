# Option D: a contrast floor in the existing test harness, with no new dependency

One new file under `src/`, roughly 120 lines, no dependency, running inside the
`node --test` suite that already exists. It reads `src/app/globals.css`, parses
the `light-dark()` token pairs, computes the ratios, and asserts a floor on the
pairings the app actually uses.

## The argument that carries it

**It replaces a copy with a read.** `proposals/OperatorInterface/contrast.py`
has a warning in its own docstring, and the warning is the point:

> The token values below are transcribed from `src/app/globals.css:50-160`. They
> are a copy, not a read, and that is the one thing here that can go stale: if a
> token moves, this file is wrong and says nothing about it.

Every number in `00-problem.md` inherits that defect. A repair made under Option
B would be pinned by nothing: `--fg-muted` could be lightened next month for a
perfectly good aesthetic reason, and the four failures would come back with no
signal at all. The parse-and-assert version has no transcription in it, so it
cannot disagree with the file it is checking.

**It matches the repository's stated bar, in the repository's own words.**
`CLAUDE.md`:

> **A pure function whose failure mode is silent gets a unit test.**

A contrast ratio is a pure function of two hex values. Its failure mode is that
nothing throws, nothing fails to typecheck, the build succeeds, the page looks
right, and text is harder to read than the project intended. That is the failure
mode the sentence describes. And `docs/agent/testing.md`'s existing precedent is
closer still: the eight component tests earned their place because a styling
invariant fails silently **in both directions**, which is exactly this, since a
token change can also silently *fix* something and hide that the repair was
needed.

**It is the criterion automation decides best.** `C9`: automated coverage lands
between 13% and 57.38% of real issues, and the reason the range is so wide is the
denominator. Contrast is at the top of that range, because it is arithmetic on
declared values rather than a judgement about meaning. `00-problem.md`'s four
failures were not missed for want of a tool; they were missed because nobody ran
the arithmetic. This makes the arithmetic run on every `npm test`.

**It costs nothing to run.** Reading one file and doing a few hundred
multiplications is microseconds inside a 16.5-second suite. No browser, no DOM,
no network, no install.

## What it would look like

```
src/app/globals.contrast.test.ts     (name and location follow the suite's convention)
```

Four parts:

1. `readFileSync` on `src/app/globals.css`, then a regex over
   `--token: light-dark(#aaa, #bbb);` and the plain `--token: #aaa;` form.
   **Assert the token count first**: if the parse finds fewer tokens than the
   table expects, fail with what was expected and what was seen rather than
   quietly checking a subset. That is the one place this test can go wrong, so it
   is the one place it fails loudest.
2. The luminance and ratio arithmetic, ported from `contrast.py`. Twenty lines.
3. A table of the pairings the app uses, each with a threshold and a reason,
   one row per finding in `00-problem.md` plus the ones that currently pass and
   should keep passing: `--fg` and `--fg-muted` on all four surfaces at 4.5,
   `--tint-fg` on `--tint` at 4.5, every `Badge` tone on `--bg-inset` at 4.5,
   `--accent` on `--bg-raised` at 4.5.
4. The composite cases, which is where the value is concentrated because they are
   the ones a person cannot eyeball: the ring's alpha composite at 3.0, and the
   `color-mix(in oklab, …)` tone lines at 3.0. The Oklab round trip is 25 lines
   and already written in `contrast.py`.

## What it does not catch, stated plainly

**It pins tokens, not usage.** The pairing table is hand-written, because the CSS
does not know which text token sits on which surface: that lives in 88 `Field`
call sites and 87 `ListRow` descriptions. So a *new* component that puts
`text-ink-faint` on a card is invisible to this test. It catches a token drifting
and a repair being reverted, which is precisely the risk Option B creates and
cannot otherwise mitigate.

**It is not a conformance claim** and `C8` is why: the thresholds it asserts are
conventions with thin provenance, and the vault's instruction is explicit that an
automated contrast pass is not proof that text is readable. What the test asserts
is "this project's declared floor", and the floor happens to be WCAG's numbers
because those are the enforceable ones and the alternative has no validation
either.

**A regex over CSS is a parser, and a bad one.** If a token moves into an
`@media` block, gains a fallback, or is renamed, the parse changes behaviour.
The count assertion in part 1 is the mitigation and it is a real one, but this is
the option's genuine fragility and it should be written down in the test file
rather than discovered.

## The objection, and the answer

*The repository has deliberately refused tooling, and this is tooling.*

It is a test, not tooling, and `C5` records why that distinction is the whole
argument. There is no linter here, `eslint.ignoreDuringBuilds` is on, and
`CLAUDE.md` states the absence as a fact rather than an omission. But `npm test`
exists, has 230 suites in it, and has a written admission criterion that this
either meets or does not. It adds no line to `package.json`, no binary, no
postinstall, and nothing to `.github/workflows/ci.yml`, which already runs
`npm test`.

The honest cost is different and smaller: one more file for a future editor to
understand, and one more thing that can fail for a reason that is not the reason
it was written. `docs/agent/testing.md` is where that cost is normally paid, by
recording the grounds each test earned. This proposal does not edit `docs/`, so
that record is a follow-up rather than part of the option, and
`12-recommendation.md` says so.

## What would make Option D wrong

If Option B is not taken. A test that pins today's values pins four failures,
which is worse than no test, because it converts them from an unmeasured default
into an asserted intention. **D depends on B and does not stand alone**, and that
dependency is the reason the recommendation is a pair rather than a menu.
