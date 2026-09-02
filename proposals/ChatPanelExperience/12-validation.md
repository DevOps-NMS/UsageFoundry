# What was run, what it said, and what is still unverified

---

## Commands

Run from `/workspace/.uf-worktrees/usagefoundry-721638d11c0b-2` on branch
`uf/usagefoundry-721638d11c0b-2-3d588006`, with **nothing under `src/` changed by
this survey**.

```
$ NODE_ENV=development npm ci --include=dev
found 0 vulnerabilities

$ npm run typecheck
> tsc --noEmit
exit 0

$ npm test
# tests 2085
# suites 316
# pass 2085
# fail 0
exit 0   (16.5s)

$ node proposals/ChatPanelExperience/score.mjs
(the table in 10-comparison.md)
```

`NODE_ENV=development npm ci --include=dev` was necessary: this environment sets
`NODE_ENV=production`, under which a bare `npm ci` exits 0 having skipped
devDependencies, and `node_modules/.bin/tsc` is then absent. `CLAUDE.md` records
this trap and it is exactly what happened — the first check for `tsc` returned
`NO_TSC`.

## The dev server and the seeded database

No Docker in this container. A dev server was run directly against a throwaway
`DATA_DIR`:

```
$ setsid env -u __NEXT_PRIVATE_STANDALONE_CONFIG \
      UF_AUTH_TOKEN= UF_ALLOW_NO_AUTH=1 \
      DATA_DIR=$D/data NODE_ENV=development \
      npx next dev -p <port>
```

Three things about that line are worth recording because each cost a cycle to
find.

- `env -u __NEXT_PRIVATE_STANDALONE_CONFIG` for `CLAUDE.md`'s stated reason.
- **`UF_AUTH_TOKEN=` is required.** The repository's `.env` sets a token, Next
  loads `.env` for `next dev`, and every request to `/chat` answered `307 → /login`
  until the variable was overridden empty in `process.env`. `UF_ALLOW_NO_AUTH=1`
  is then what lets the server boot.
- Each Bash invocation in this harness gets a fresh sandbox, so a server started
  in one call is dead by the next. Every measurement below was taken inside the
  same call that started the server.

The database was seeded by a scratch script writing rows directly: one thread
with 26 pending proposals (25 templated/untemplated issue proposals plus one
carrying an `on-success` dependency with `continueBranch`), 5 open questions
(one with no choices, one with two, one with three, one with four), a
`run_templates` row, and two further threads for the ending states. Every DTO
figure quoted in [00-problem.md](00-problem.md) is from
`GET /api/chat` against that database.

## What was measured in a browser

Playwright, Chromium, `/usr/local/lib/node_modules/playwright`. **Note:
`browser.newPage({ viewportSize })` is silently ignored — the option is
`viewport`.** The first measurement pass reported identical geometry at four
window sizes because all four ran at the 1280×720 default; the figures below are
from the corrected pass.

**Proposal list geometry**, with the "Authentication is off" strip (49px,
measured) removed from the DOM before the second reading:

| Viewport | Visible list | Content | Cards |
|---|---|---|---|
| 1280 × 800 | 217px | 3791px | 1.2 of 26 |
| 1440 × 900 | 317px | 3791px | 1.8 of 26 |
| 1920 × 1080 | 497px | 3791px | 2.8 of 26 |

Row height 178.5px; scroller width 318px.

**The clipped task**, first card, 1440×900: paragraph `scrollHeight` 162px,
`clientHeight` 54px, `title` attribute `null`.

**Select all**, 26 ticked: hint reads *"Approve starts 26 unattended runs that
spend real money, under the guards shown on each. Runs beyond the concurrency
limit queue rather than being refused."*, button reads `Approve 26`.

**Guard labels** off the live payload: untemplated
`acceptEdits · own checkout · 4 cycles · 60 min · $5.00`; templated `Bug fix`
against a template whose real guards are `acceptEdits`, own checkout, 12 cycles,
45 min, $4.

**The waiting row**, on a chat set `thinking` after boot: `Thinking…13m 26s`,
composer hint `Stop ends this turn and signals the process answering it`. The
13m26s figure is an artefact of the seeded row (the elapsed is measured from the
last thread message, and that message was seeded thirteen minutes earlier) — it
demonstrates the mechanism rather than a naturally occurring value. The real
case for D3 is `save_template`'s mid-turn append (`src/app/api/mcp/route.ts:1635`)
and it was **not** reproduced in the browser; it is read from source.

**The restart ending**, reproduced accidentally and then deliberately: a row
seeded `thinking` came back from `reconcileChatsOnBoot` as `failed` with
`The server restarted while this message was being answered.` on the row and
**nothing in the thread**, drawn as the red `turnFailure` box under a grey
`save_template` note. This is the only one of the five endings drawn in red and
the only one with no permanent record.

**`ChatDTO` keys**, live:
`id, createdAt, updatedAt, title, status, costUSD, tokens, error, messages, proposals, questions`.
No `turnStartedAt`.

**Narrow**, 390 × 844 with the banner present: the conversation card's top is at
y = 335 and the composer's at y = 670.

Captures are under `$TMPDIR`-scoped scratch and are **not committed**; every
figure they support is quoted above in text.

---

## What is not verified, and what each gates

**1. Whether the ten-minute wait actually bothers this operator.** Not
inferable. It sets B's `wait` score and it is the whole case for C. *"The wait
is fine, I go and do something else"* deletes both.
**Cost to find out: one sentence.**

**2. Whether twenty-five pending proposals ever happens here.** The
`chat_proposals` table on this install could not be read — both databases in
this image (`/workspace/UsageFoundry/.data/usagefoundry.db` and the standalone
copy) are outside this worktree's sandbox and `better-sqlite3` returns "unable
to open database file". So C5, C6 and G's whole case rest on a seeded 26 rather
than on a measured distribution. *"I have never had more than three"* deletes
most of G and makes E's fold something to open by default.

**3. Whether rejections are caused by the task or by the folder.** The query
that settles F — rejected proposals whose thread's next user message
near-duplicates the rejected task — needs the same unreadable table. F is
refused on an argument rather than on a measurement, and says so.

**4. Whether a killed turn's spend is material.** F5 is established from the
code — `finishTurn` takes cost from the CLI's final JSON, which a signalled
child never prints — but nobody has measured how much a typical eight-minute
turn burns before being stopped. `chatTurnBudgetUSD` bounds it at $2 by default.
If turns are rarely stopped, F5 is a correctness note rather than an accounting
problem.

**5. Nothing was heard.** The `role="log" aria-live="polite"
aria-relevant="additions"` region (`page.tsx:864-868`) and the `role="status"`
on the waiting word with the clock `aria-hidden` beside it (`:1402-1407`) are
read from markup. Whether a turn landing mid-read announces sensibly needs a
screen reader.

**6. No real turn was ever run.** No `claude` process was spawned by this
survey. Every claim about what a turn *does* — the `--output-format json`
buffering, `parseTurnOutput`'s two branches, the signal ladder, the sweeper —
is read from `src/lib/chat.ts`. The five ending states were reproduced by
writing rows, which exercises the page and not the child.

**7. The workflow proposal card was never rendered.** `ProposedGraph`
(`page.tsx:1807-1879`) was read and no workflow proposal was seeded, so every
claim in this survey about a proposal card is about the **run** card.

**8. `retention.ts` and the Settings storage card were not read.**
[09-option-h](09-option-h-reach-the-history.md)'s H-4 and H-5 rest on
`docs/agent/retention.md` and on `retention.ts:670-675` alone.

---

## The three questions to ask

In the order that most changes this proposal:

1. **Have you sat through a ten-minute turn not knowing whether to cancel?**
   Yes → C moves from deferred to next after the cheap tier. No → B keeps parts
   1 and 3 and drops the deadline clause, and C is refused rather than deferred.
2. **What is the largest number of proposals you have had waiting at once?**
   Three or fewer → G shrinks to G-5 alone and E's fold opens by default.
   Twenty-plus → G-2 joins the sequence.
3. **When you reject a proposal, is it the task that is wrong, or the folder?**
   Folder or template → F-b moves from refused to first.
