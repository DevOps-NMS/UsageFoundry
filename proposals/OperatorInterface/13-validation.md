# Validation: how somebody would know it worked

Four checks. Two run in a container, one needs a browser at a desk, one needs a
screen reader. They are in the order they should be done, and the first two are
the only ones this proposal can promise.

---

## 1. Automatic: the test fails before the repair and passes after

The whole of Option D's value, and the repository's own bar for a fix.

```sh
NODE_ENV=development npm ci --include=dev     # CLAUDE.md's trap: a bare npm ci skips devDeps
npm test
```

**Before Option B**, with Option D's pairing table in place, expect exactly four
groups of failures, and the count matters as much as the failure:

| assertion | expected before | expected after |
|---|---|---|
| `--ring` composited on each of four surfaces, both schemes, >= 3.0 | 8 failures (1.93 to 2.26) | 8 passes (3.10 to 4.12) |
| `--fg-faint` on four light surfaces >= 4.5 | 4 failures, or 0 if the table has been rewritten to assert `--fg-muted` at those sites instead | see note |
| `#ffffff` on dark `--danger-fill` >= 4.5 | 1 failure (2.82) | 1 pass (4.54) |
| `--fg-muted` on dark `--bezel` >= 4.5 | 1 failure (3.54) | not asserted; the sites stop using the pairing |

The note matters and is the one place this check can lie to itself. Two of the
four findings are repaired **at the call site** rather than in the token, so a
token-level test cannot see them: after B2, `--fg-faint` still measures 3.19:1 on
`--bg` and always will. The pairing table therefore has to assert what the app
*uses*, which means it encodes a hand-maintained claim about usage, and that
claim can go stale silently. Two mitigations, both cheap and both worth writing
into the test file:

- Assert the parsed token count first, so a CSS change that moves a declaration
  fails loudly rather than checking a subset.
- Keep the four repaired sites in the table as a comment naming the file and line
  (`List.tsx:147`, `Hint.tsx:24`, `Card.tsx:117`, `Button.tsx:50`), so the next
  person reading a failure knows which grep to run.

## 2. Automatic: the new utility exists in the emitted CSS

`B3` adds a token, and a token without a matching `@theme inline` entry produces
a class Tailwind never emits. Nothing typechecks that, and the page renders with
no background at all, which in dark mode is a nearly invisible failure.

```sh
env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build
grep -cF 'bg-danger-fill' .next/static/css/*.css     # expect >= 1
npm run typecheck                                     # expect clean
```

The `env -u` is `CLAUDE.md`'s documented trap, not decoration: a shell that
inherited `__NEXT_PRIVATE_STANDALONE_CONFIG` from a UsageFoundry container makes
`next build` die with `TypeError: generate is not a function`.

And use `grep -F`. `docs/verification.md:1113-1250` records, measured, that the
unescaped form of a Tailwind class grep "returns **0 on a build where the class
is present**". A negative result from the wrong grep is exactly how this check
would produce a false alarm.

## 3. Manual, at the desk, with a browser: the four judgements arithmetic cannot make

This is the check that decides whether Option B was right, and no container can
run it. Twenty minutes.

**Four things to accept or reject, in order of how likely they are to be
rejected:**

1. **The focus ring at 75%.** Tab through `/runs/new`. `globals.css:92-97` is
   imitating AppKit, whose ring is a halo; at 75% it is nearly solid. If it reads
   as loud, drop to 73% light / 71% dark (clears 3:1 on `--bg-raised` and
   `--bg-inset`, the surfaces that actually carry controls) or drop `B1`. **This
   is the recommendation's stated falsifier.**
2. **The `Empty` state and the `ListRow` description at `text-ink-muted`.** Open
   `/workflows` (which has 167 lines and an `Empty`) and `/agents`. The question
   is whether the description still reads as subordinate to the title, or whether
   the row now looks like two equal lines. Size and position are doing that work
   after B2; if they are not enough, the fix is `text-2xs` on the description
   rather than a lighter colour.
3. **The destructive button in dark mode.** Any `confirmVariant="danger"` sheet.
   `#c4514b` is a duller red than `#ff6961` and the button is the app's loudest
   affordance by intent.
4. **The `/settings` section chips in dark mode** at `text-ink`. The unselected
   chips carry more weight than before; the selected one is `bg-tint` with
   `aria-current`, so the distinction should still be obvious at a glance.

**And while a browser is open, three readings that are not this proposal's but
are on the same screen.** `docs/verification.md:1113-1250` prescribes them and
`C6` records that nobody has ever taken them:

- 390x844. The seventeen tables with `Table stack`, the branches selection bar's
  left edge, the `max-md:h-80` spacer, and the workflow instance page as the
  cross-component `stack` proof. `ui/Table.test.tsx` asserts that markup and no
  human has ever seen the result.
- Whether any `max-md:` variant changes a colour pairing. `10-option-i` states,
  as inference rather than measurement, that none does.
- The two device-only iOS checks that file still lists: the zoom on `/runs/new`
  and `--keyboard-inset` returning to `0px`.

## 4. Manual, with a screen reader: the one question this survey could not open

`08-option-g`. Ten minutes on `/` and `/runs/[id]` with VoiceOver or NVDA,
navigating by heading.

The question is single and answerable: **can a listener tell the three cost
sources apart?** `/` announces eleven `<h2>`s at one level, three of which are
the `SourceRegion` containers that `docs/agent/architecture.md` says must never
be summed or mixed.

- If no, `G1` becomes the cheapest correct change in the survey: `role="region"`
  and `aria-labelledby` on nine `<div>`s, with the precedent and the reasoning
  already written at `src/app/knowledge/page.tsx:417-419`.
- If yes, because each card's title carries its source in its own words, G is
  closed for good and nothing gets written.

Either answer is worth having. It is listed fourth because it is independent of
Options B and D and blocks neither.

---

## What would count as this having failed

Stated in advance, so it cannot be reinterpreted afterwards.

- **The ring is rejected at every alpha that clears 3:1.** Then the app keeps a
  sub-1.4.11 focus indicator by explicit decision, `B1` is dropped, and the
  decision goes in a comment beside `--ring` so the next person measuring it
  finds the reason rather than the defect.
- **A page looks flat after B2.** Then the third text weight was carrying
  hierarchy after all, and the repair is size or position at those three call
  sites, not colour. B2's reasoning about size and position doing the work would
  be wrong, and it is reasoning, not measurement.
- **Option D's test fails for a reason that is not a contrast regression.** A
  regex over CSS is a parser and a bad one. If it produces its first false alarm
  within a month, it is costing more than it protects and should be narrowed to
  the composite cases (the ring and the Oklab tone lines), which are the ones a
  person genuinely cannot check by eye.
- **Nobody ever runs check 3.** This is the likeliest failure and the one worth
  naming. `docs/verification.md`'s "Not yet verified by hand" list already
  carries narrow-viewport entries from a previous pass, and `CLAUDE.md` says that
  list "must stay honest". If Options B and D land and check 3 is never done, the
  honest record is that four ratios were repaired by arithmetic and nobody looked
  at the result, and that sentence belongs in `docs/verification.md` rather than
  in nobody's head.
