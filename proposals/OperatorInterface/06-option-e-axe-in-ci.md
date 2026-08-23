# Option E: an automated accessibility check in CI

The industry-standard answer, and the one this survey refuses. It is refused on
two grounds that are both specific to this repository, and it comes with the
condition that would flip it.

## The case

`axe-core` is the engine behind almost every accessibility checker in use. It is
free, it is maintained, its rules carry WCAG references, and it finds a class of
defect that `Option D` structurally cannot: a form control with no accessible
name, an `aria-*` attribute with an invalid value, a duplicate `id`, a heading
level skipped, a landmark that is not unique, a control with no accessible role.
Those are DOM facts, and `00-problem.md`'s finding 5 is exactly the kind of thing
a `heading-order` or `region` rule would have flagged without anybody writing a
regex.

`.github/workflows/ci.yml` already runs `npm run typecheck`, `npm test`,
`npm run build` and an `npm audit` job, so there is a place to put it. And `C10`
is the standing wound this would partly dress: 16,529 lines of page code, zero of
it rendered by any test. An accessibility check would be the first thing in this
repository's history that renders a page in anger.

## Why it is refused

**First: it cannot run at all without solving a much larger problem, and that
problem is not this survey's.** There is nothing here that renders a component
into a DOM. The eight existing component tests use `renderToStaticMarkup` and
assert on class strings; `package.json` has no jsdom, no `@testing-library`, no
Playwright, no Puppeteer. So Option E is not "add axe-core". It is one of:

- **axe-core plus jsdom**, which renders no layout and computes no styles; or
- **axe-core plus Playwright plus a Chromium download plus a running app**, on a
  project whose `README.md:967-980` states that CI "never starts the container
  and never exercises a run".

The second is a rendering-test harness, which is a real and defensible thing to
build. It is `proposals/GapRegister/01-frontend.md`'s F5, it was ranked there,
and it is a much bigger decision than an accessibility check. Attaching it to an
accessibility argument would be smuggling.

**Second, and decisively: the one criterion this survey actually measured is the
one axe cannot decide in the cheap configuration.** axe's `color-contrast` rule
needs computed styles and real compositing. In jsdom it returns `incomplete`
rather than a pass or a fail, and this app's colours are the worst possible case
for a non-rendering engine: every token is a `light-dark()` that no `@property`
registers, the ring is a `color-mix(in oklab, …, transparent)` composited by the
compositor at a 2px offset, and the tone lines are Oklab interpolations between
two opaque colours.
`docs/agent/conventions.md` already records the consequence of that shape for
the canvas: `getComputedStyle(root).getPropertyValue("--fg")` "returns source
text a 2D context rejects silently". The same property is what makes jsdom
useless here.

So in the affordable configuration, axe would report `incomplete` on the four
findings this survey found by arithmetic, and `Option D` decides all four
deterministically for the cost of one file and no dependency.

**Third: the coverage claim has to be read at its actual size.** `C9`, from
`/workspace2/3 Resources/Web Design/Automated Accessibility Testing Coverage.md`
(confidence medium, updated 2026-08-23): 13% to 57.38% of real issues depending
on the denominator, and the spread *is* the denominator. Deque's own 57.38%
counts issues weighted by occurrence, which flatters an automated tool because
the issues it finds are the repetitive ones. This app's attribute coverage is
already strong (31 `role="alert"`, 17 `aria-live"`, 23 `aria-invalid`, 18
`aria-describedby`), its keyboard patterns are correct where they are hardest
(`04-option-c`), and its modal path is the browser's. The population of defects
axe is good at finding is the population this codebase has least of, which is the
worst possible ratio of cost to yield.

## What it would still catch, honestly

Refusing an option means naming what is being given up.

- **The heading outline.** `heading-order` and `region` would flag finding 5
  mechanically and keep flagging it, which is more durable than
  `08-option-g`'s "file it as a question".
- **Regression on the strong attribute coverage.** Today's 31 `role="alert"`s
  are a fact about today. Nothing enforces the 32nd.
- **Everything on the fourteen pages this survey read by grep rather than by
  eye.** A tool does not get tired at page nine.

Those are real. They are not worth a browser in CI on this codebase this year.

## The condition that flips it

**If a rendering-test harness lands for any other reason, take Option E
immediately.** `proposals/GapRegister/01-frontend.md`'s F5 argues for one on
grounds that have nothing to do with accessibility, and
`proposals/GapRegister/06-recommendation.md` puts a survey of that question on
its list. Once a page can be rendered and asserted against in CI, `axe-core` is
one devDependency and about fifteen lines per page, and the coverage argument
inverts: 13% of a large number, for near-zero marginal cost, on fourteen pages
nobody will re-read by hand.

That is the falsifier for this refusal, and it is a scheduling fact rather than a
disagreement. Option E is not wrong. It is second in a queue whose first item is
somebody else's proposal.
