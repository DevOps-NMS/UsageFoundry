# Option E — open the proposal

**Answers:** C1 (the task is clipped), C2 (a templated card names its guards and
does not state them), C3 (a dependency names an invisible label). Partially C6.

---

## The finding this exists for

`docs/orchestrator-chat.md:24-26`:

> Every proposal card says which guard set it will run under, spelling the
> untemplated one out in full — **an approval gate that does not show what is
> being approved is a gate that gets clicked through.**

The card honours that for the guard set of an *untemplated* proposal and for
nothing else. Measured:

- the task paragraph is 162px of text in a 54px box (`line-clamp-3`,
  `page.tsx:1683`), with no `title` and no expander;
- a templated card's guard label is the template's **name**
  (`dto.ts:150-154`) — the seeded card read `Bug fix` where the template's
  actual guards are `acceptEdits`, own checkout, 12 cycles, 45 min, $4;
- `Starts after auth-fix` names a `specId` that appears on no card.

The thing being approved is the *task*. It is the one field on the card that is
clipped.

## What it is

**E-1. A fold on the card.** `Disclosure` is already imported on this page
(`page.tsx:29`) and used in the standing notice (`:804-820`). One per card,
collapsed by default, holding what does not fit:

```
▸ Full task, guards and prompt
```

Inside: the task in full; for a templated proposal, the template's guards
spelled out the way the untemplated ones already are; the rewritten prompt when
`promptRewritten` is set (today the card says *that* it was rewritten and never
*what* it says); and the proposal's own `specId` when it has one.

X5 permits this — the proposals card is the one card on the page allowed to
change size, and this expands inside its own scroll region. X9 is satisfied by
using the kit primitive. X10 is satisfied by not using a tooltip.

**E-2. Guards for a templated proposal.** `defaultGuardsLabel()`
(`dto.ts:213-228`) already builds the exact string from a `Budget` and a
permission mode. A templated proposal has all the same fields on
`getTemplate(p.template_id)` (`dto.ts:134`). So the DTO gains a
`guardsDetail: string | null` built by the same function against the template's
own values, and the fold renders it:

```
Bug fix — acceptEdits · own checkout · 12 cycles · 45 min · $4.00
```

The *card* keeps the name, which preserves the argument at
`dto.ts:203-212` (a template is a thing the operator wrote and can go and read).
The fold is where the numbers go.

`templateId` is already on the DTO (`dto.ts:146`) and unused; a link to
`/settings` beside the name costs nothing and is the second half of "can go and
read".

**E-3. The proposal's own label.** Add `specId` to `ChatProposalDTO` and render
it where a dependency can be matched against it — the fold is enough, a small
mono chip on the card is better. Without it, "Approve them together" is an
instruction with no referent (C3).

## What it costs

| | |
|---|---|
| Files | `src/lib/apiTypes.ts`, `src/app/api/chat/dto.ts`, `src/app/chat/page.tsx` |
| Lines | ~40 |
| New requests | none — every field is already read server-side |
| Payload | the full task per pending proposal is **already on the wire**; the card clips it in CSS. So E-1 adds nothing to the response. `guardsDetail` adds ~50 bytes per templated card. |
| Test | `defaultGuardsLabel` becomes a two-caller pure function over a `Budget`; its failure is a card asserting the wrong ceiling, which is silent. That earns a unit test by `docs/agent/testing.md`'s stated bar. |

The payload point is worth stating plainly: **the operator is not being spared a
fetch.** The whole task text is in the JSON the page already polls every three
or ten seconds. The clip is a rendering decision alone.

## The argument against it

**A fold is hidden text, and the house rule is against hiding what most readers
need.** `docs/agent/conventions.md` and the interface-copy rule both say
disclosure is for what *some* users need, and that always-visible beats hidden.
If the task is what is being approved, folding it is the wrong instinct.

The counter is geometry, and it is measured: the card is 178.5px today and the
list shows 1.8 of 26 at 1440×900 (C5). An unclipped task takes each card to
~290px and the list to 0.9 cards. **Un-hiding the task without
[08-option-g](08-option-g-room-for-the-list.md) makes the batch worse, not
better** — which is exactly why this survey's recommendation pairs them, and why
neither is recommended alone.

The second argument is that this puts the decision in two places: a reader who
does not open the fold approves on the same information they have today. True,
and it is the honest limit of E on its own. What it changes is that the
information *exists somewhere the operator can reach without leaving the page*,
which today it does not.

## Score

Three findings, ~40 lines, no new request and no payload cost for the largest of
the three. The single highest-value line in the option is E-2: it is the one
that makes the documented claim about the approval gate true for the common
case.
