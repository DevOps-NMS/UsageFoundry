# Frontend

Six gaps. The first two are one mechanism seen twice, and together they are the
worst thing on this axis: **the app cannot find a run it has already done.**

`docs/agent/conventions.md` is unusually strict and the components obey it —
typed variant props with `Record<Union, string>` lookup maps, seven grouping
affordances each capped, `light-dark()` canvas probing, `jsonMaybeGzipped` on
eighteen route handlers. None of these six is a convention violation. They are
things the conventions never had an opinion about.

---

## F1 — Run history stops at 100 rows and cannot be paged, filtered or searched

`src/app/api/runs/route.ts:49` is the whole of it:

```ts
const rows = listRuns(100);
```

No `searchParams` is read. There is no `offset`, no `limit`, no `repo`, no
`status`, no text query. The page knows, and says so —
`src/app/runs/page.tsx:82` sets `const SERVER_LIMIT = 100;` and `:840-844`
renders the admission:

```tsx
{runs.length >= SERVER_LIMIT && (
  <p className="mt-3 text-xs text-ink-muted">
    Showing the {SERVER_LIMIT} most recent runs — the list route does
    not page beyond that yet.
  </p>
)}
```

The status filter at `:495` and `:608` is client-side, over the hundred rows
that already arrived. Filtering to `failed` shows the failed runs *among the
hundred newest*, which is a different question from "show me the failed runs"
and looks identical.

**The contrast is in this repository, one directory over.** When issue #72 was
fixed, `/api/branches` got exactly the missing parameters, and its docstring at
`src/app/api/branches/route.ts:19-23` states the principle the runs route does
not follow:

> `repo` and `offset` are what make the whole set reachable rather than only its
> newest page.

So this is not an unconsidered design. It is a design that was reasoned through
for branches and never carried across to runs. That is the strongest case for
calling it a gap rather than a preference: the house already decided which side
it is on.

**Blast radius.** Every retrospective question. "What did the nightly schedule
do last week", "which runs on this repository ended `needs-review`", "how much
did that workflow cost". A fleet at `maxConcurrentRuns` with a schedule behind
it produces a hundred runs in hours, and everything before them is reachable
only by URL if the operator kept the id.

**Cost of leaving it.** The app accumulates a history it cannot show. Worse, it
accumulates one it cannot show *silently* for the first ninety-nine runs, so the
limit is discovered at the moment it starts mattering.

**Confidence: high.** Read directly from three files; no inference.

**Owned by:** nothing. #122 and #147 are open and neither is this.

---

## F2 — Quick open, the app's only search surface, inherits that cap

`src/components/shell/QuickOpen.tsx:82-83`:

```ts
jsonRequest<{ runs: RunListItemDTO[] }>("/api/runs"),
jsonRequest<{ workflows: WorkflowListItemDTO[] }>("/api/workflows"),
```

Then a client-side filter. Its corpus is those two lists, so it cannot find a
*chat*, a *branch*, an *agent*, a *template*, a *schedule*, or a run past the
hundredth. `⌘K` presents itself as "find anything here" and is in fact "filter
the two newest lists".

A sweep for every place in `src/app` and `src/components` that matches typed
text against a collection finds two others, and neither is a search: the chat
composer's agent picker filters agent names at
`src/app/chat/page.tsx:459`, and `/api/knowledge/search` searches the
operator's **vault**. Nothing indexes the app's own objects.

The failure mode is the bad one: a miss is indistinguishable from an absence.
Typing a run's task text and getting nothing back reads as "that run does not
exist", not as "that run is on page two of a route that has no page two".

**Blast radius.** Every navigation that is not a click through a list.

**Cost of leaving it.** [F1](#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) makes history unreachable by browsing; this
makes it unreachable by searching. Fixing either alone leaves the other route
closed, which is why the register treats them as one item with two heads rather
than two independent ranks.

**Confidence: high.**

**Owned by:** nothing.

---

## F3 — A chat turn renders nothing until it finishes; the run path streams

Two children of the same kind, two experiences.

The run path streams. `src/app/api/runs/[id]/stream/route.ts` is an SSE route,
consumed at `src/app/runs/[id]/page.tsx:552`, and `emit()` persists to
`run_events` *then* publishes — the ordering `docs/agent/architecture.md` calls
out as what makes reconnect lossless. An operator watching a run sees each tool
call as it happens.

The chat path does not. `src/lib/chat.ts:1731`:

```ts
child.stdout.on("data", (c: string) => (stdout += c));
```

The entire turn accumulates in one string. The assistant's message is inserted
into `chat_messages` once, after the child exits, through the statement at
`:330`. The page polls — `src/app/chat/page.tsx:362`,
`const t = setInterval(() => void load(chatId), period);` — and until the turn
ends there is nothing to poll for, so it shows `Thinking…` at `:765`.

Two consequences, and the second is not a UI problem at all:

1. A turn that takes four minutes shows four minutes of a spinner. There is no
   signal that it is working rather than wedged, and no way to tell an expensive
   turn from a stuck one before paying for it.
2. **A turn is not durable until it exits.** If the process is killed, the
   container restarts, or the operator closes the browser and the child dies,
   the text is gone — it lived only in that string. The cost is gone too:
   `chat_turn_spend` is written at `src/lib/chat.ts:1978`, after the latch, so a
   turn that dies mid-flight spent money the install ceiling never sees. This
   half is [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits) and is ranked there.

**Blast radius.** Every orchestrator chat turn — which is the surface
`docs/agent/chat.md` describes as the one where a model may write half of a run.

**Cost of leaving it.** The chat is the newest operator surface and it feels the
least alive. The mechanism it lacks is not novel: it is in the repository, one
route away, already reasoned about.

**Confidence: high** on the mechanism. **Assumed:** that the four-minute figure
is representative — no live chat was observed, and turn durations would come
from the unreadable `DATA_DIR`.

**Owned by:** nothing. #114 is open and is not this.

---

## F4 — A run's log cannot be searched or filtered

Neither `src/components/ui/Log.tsx` nor `src/components/RunOutput.tsx` contains
a filter input, a search box or a level selector. The log is scroll-only.

This compounds with how events arrive: `runEvents` pages by id and reports a
`dropped` count (`src/lib/orchestrator.ts:640-665`), so a long run's log is both
long and knowingly incomplete, and the operator's only tool for finding the tool
call that mattered is the browser's own `⌘F` over whatever is currently in the
DOM.

**Blast radius.** Post-mortem on any run of more than a few dozen events, which
after several work cycles is most of them.

**Cost of leaving it.** Diagnosing a failed run means reading it. This is the
smallest item on this axis and the cheapest to close — a filter box over an
array that is already in client state.

**Confidence: high** that no filter exists. **Medium** on the severity: no run
history was readable, so "most runs are long" is inference from the work-cycle
model, not a measurement.

**Owned by:** nothing.

---

## F5 — Nothing that renders is checked by anything

The suite is real and it stops at the door of the UI.

| | |
|---|---|
| Test files in `src/` | 88 |
| Tests, suites, failures | 1,578 / 230 / 0 (`npm test`, 16.5 s) |
| Tests under `src/app` | 8 — seven route handlers, one pure helper (`src/app/runs/new/budgetPayload.test.ts`) |
| Page components rendered by a test | **0** |
| Lines of `src/app/**/page.tsx` | **16,529** |
| Component tests | 8: `Meter`, `Markdown`, `LiveTelemetry`, `UsagePeriods`, `ui/Disclosure`, `ui/LimitField`, `ui/ListView`, `ui/Table` |
| Their mechanism | `renderToStaticMarkup` — server markup, asserted on class strings |
| jsdom, `@testing-library`, Playwright, Puppeteer in `package.json` | **none** |
| Browser driven in CI | none; `.github/workflows/ci.yml` runs typecheck, test, build, and an `npm audit` job |

`README.md:967-980` states the position plainly: CI **"never starts the
container and never exercises a run."**

The eight component tests are not a token effort — each one is documented as
earning its place because a styling invariant fails silently in both directions,
which is exactly the bar `docs/agent/testing.md` sets. They are also the
complete list. Sixteen and a half thousand lines of page code, all the state
machinery, every fetch boundary, every poll gate, is checked by a human opening
a browser or not at all.

**And often not at all.** `docs/verification.md:1033+` — "Not yet verified by
hand" — carries four separate narrow-viewport entries, including the stacked
tables and the mobile form pass at 390px, with the note that *the browser
refused to resize*. `docs/agent/conventions.md` makes stacking a hard invariant:
a table stacks below `md` only with `Table stack` **and** a `label` on every
`Td`, and one without the other is a column of unnamed figures. That invariant
has a test (`ui/Table.test.tsx`) and has never been seen.

**What the vault says, including where it says less than you would want.**
`3 Resources/Testing and Correctness/The Test Pyramid.md` (confidence: low) is
careful: the *cost* claim is supported — a defect caught at a lower level is
cheaper — while the familiar ratios were never measured and the note declines to
endorse them. So it argues for having *something* below the browser layer, not
for a target number. And
`3 Resources/Web Design/Automated Accessibility Testing Coverage.md` (medium,
updated 2026-08-23) argues against over-reading whatever gets built: automated
coverage lands between 13% and 57.38% of real issues depending on the
denominator. A rendering test suite would be a real improvement and would not be
a guarantee, and this survey declines to imply otherwise.

**Blast radius.** Every visual and interactive regression, on a codebase whose
own documentation says its invariants fail *silently*.

**Cost of leaving it.** Rising. This is the axis where the cost of the gap grows
with the code rather than staying flat, because each new page adds surface that
nothing watches.

**Confidence: high** on every count above; all of them are `find`, `grep`,
`wc -l` or `npm test` output.

**Owned by:** #155 is open and is adjacent — read it before opening this. The
scope here is broader than any one issue.

---

## F6 — Settings is nine sections in a 3,502-line page with no way to find a field

`src/app/settings/page.tsx` is 3,502 lines and declares nine `SECTIONS` at
`:100-111`, navigated by chips at `:1857`. There is no search input on the page.

The page is not careless — the opposite. It tracks a saved baseline (`savedS`,
`:1349`), derives `dirty` (`:1576`), marks individual changed fields
(`:676-678`) and binds `⌘S` (`:1698-1703`). `docs/agent/conventions.md`'s
`saveSettings` invariant — store only what differs from `DEFAULTS`, because
writing the whole object kills every future default on that install — is
honoured. The gap is narrower and duller than "settings is a mess": an operator
who knows a setting exists and does not remember which of nine sections holds it
has no route to it except opening sections.

One thing worth noting rather than fixing: **`grep -rn "beforeunload" src/`
returns zero hits**, so navigating away with unsaved edits loses them
without a prompt. The per-field dirty marks make the state visible while you are
on the page, which is most of the protection, and this survey rates the missing
prompt as an issue somebody should file rather than as a register row.

**Blast radius.** Configuration, on the install's single most consequential
page — the guards, the enforcement mode, the model, the plugin set.

**Cost of leaving it.** Small and constant. It is on the register because it is
cheap and because [F2](#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) suggests the fix twice: a search that reached
settings fields would close both.

**Confidence: high** on the structure. **Medium** on the severity — nine
sections is not obviously too many, and no operator was observed failing to find
anything.

**Owned by:** nothing.
