# Option G — give the list room

**Answers:** C5 (twenty-six cards through a window showing two), C6 (Select all
ticks what approval will refuse). Prerequisite for
[06-option-e](06-option-e-open-the-proposal.md) being a net gain rather than a
net loss.

---

## The measurement

Seeded to 26 pending proposals and measured in Chromium, with the
"Authentication is off" banner discounted:

| Viewport | Visible list | Content | Cards on screen |
|---|---|---|---|
| 1280 × 800 | 217px | 3791px | **1.2 of 26** |
| 1440 × 900 | 317px | 3791px | **1.8 of 26** |
| 1920 × 1080 | 497px | 3791px | **2.8 of 26** |

One card is 178.5px. The column is 318px of usable width
(`lg:grid-cols-[minmax(0,1fr)_360px]`, `page.tsx:847`).

Pressing `Select all` produces the sentence

> Approve starts 26 unattended runs that spend real money, under the guards
> shown on each.

above a button reading `Approve 26`. Both captured.

**The gap is between the gate's reasoning and its geometry.** Every argument on
this path — `MAX_PENDING_PROPOSALS`' docblock ("an approval list nobody can read
is an approval gate that gets clicked through", `chat.ts:301-309`), the approve
row being outside the scroll region ("a twentieth proposal must not push the
sentence off the top of the list it is about", `page.tsx:1232-1235`), the guard
set wrapping rather than truncating (`:1695-1702`) — is about making the
approval informed. The column those arguments are drawn in shows 7% of what is
being approved at 1440×900.

## The candidates

**G-1. Widen the column.** `360px` → `420px` or `minmax(360px, 28rem)`. Cheapest
possible change, one token. Buys width, not height, and the constraint is
height: it takes each card from 178.5px to maybe 160px by fitting the title on
one line. Roughly one extra card at 1920. **Not enough on its own** and it costs
the thread its measure, which is the one thing on this page sized for reading
prose (`max-w-[70ch]`, `page.tsx:1324`).

**G-2. A denser row past a threshold.** Below ~6 pending, the card as it is;
above it, a compact row — title, folder, guard mark, a `⌄` for the rest. A
compact row is ~64px, so 26 of them is 1664px and 1440×900 shows 5 rather than
1.8. Combined with E's fold, the reader scans titles and opens the two they are
unsure about, which is how a person actually reviews twenty-six of anything.

The threshold is the awkward part: two renderings of one object is two things to
keep in step, and X6's spirit (nothing rearranges under the reader) argues
against a layout that changes when a poll adds the sixth card. A
**Compact / Full** toggle on the tab row is the same idea with the operator
deciding, and it does not change under them.

**G-3. Reclaim the height the page already has.** The proposals card and the
conversation card share a grid row and each gets whatever the header furniture
leaves (`page.tsx:826-846`). The furniture is: the auth banner when auth is off
(49px, measured), the data-directory notice when this server does not own it,
`<h1>` plus the cost and New chat (~44px), and the standing `Notice` with its
disclosure (60px measured, more when open). On the seeded page at 1440×900 the
whole two-box row got 366px of an 900px window.

The `Notice` is the negotiable one. Its comment (`page.tsx:789-797`) already
argues the split — the safety sentence stays visible, the rest folds — and the
fold is closed by default. What is left visible is two lines that never change.
Moving those two lines beside the `<h1>` as a single line, or into the
disclosure summary, returns ~40px to the row on every render. That is a quarter
of a card and it is free.

**G-4. A review mode.** A full-width list of proposals — the panel's content
without the conversation beside it. Everything here already exists as a
component; what it needs is somewhere to be. There is no `/chat/[id]` route
(O3), so a dedicated URL is a new page, which is more than this finding is
worth; a `Sheet` or an in-place "expand the panel" toggle is not.

**G-5. Do not tick what approval will refuse.** `Select all` (`page.tsx:1250-1254`)
takes every pending id including the ones whose card says in red that approval
will be refused (`missing`, `agentMissing`, and a workflow whose graph did not
parse). Excluding them, and saying so — "Select all (2 cannot be approved)" —
is five lines and removes a count the operator agreed to that was never
achievable. **This is the cheapest change in the whole directory and it is
strictly correct**: the route already drops them, so this only aligns the number
shown with the number that happens.

## What it costs

| Candidate | Lines | Buys | Risk |
|---|---|---|---|
| G-1 widen | 1 | ~0.5 card | costs the thread's measure |
| G-2 compact toggle | ~40 | 3 extra cards at 1440 | a second rendering to keep in step |
| G-3 reclaim header | ~10 | ~0.25 card, every page load | the notice's own comment argues the current split |
| G-5 select-all excludes refusals | ~5 | correctness | none |

## The argument against the whole option

**Twenty-five is the pathological case.** `MAX_PENDING_PROPOSALS` exists to
bound "open a run for every issue" against a repository with four hundred; the
median thread proposes two or three, which fit. Optimising the layout for the
tail can make the common case worse — G-2's compact row hides the guard set on
a two-proposal thread where it fits perfectly well.

That argument is why the recommendation takes **G-5 and G-3 only**, and treats
G-2 as conditional on somebody actually reviewing twenty-five. G-5 is right at
n=2. G-3 is right at n=0 — it is height every visitor gets back.

## Score

G-5 is free and correct. G-3 is nearly free. G-2 is the one that answers C5 at
its worst and is the one this survey will not recommend without knowing that the
worst case happens.
