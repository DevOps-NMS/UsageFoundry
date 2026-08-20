# Validation

A pass over the twelve files before this one, on 2026-08-20, from inside a live
work cycle on the install they were written on and against the same tree. Every
`path/file.ts:42` in `00-` through `11-` was resolved mechanically and the line
it lands on was read; every measurement in `00-problem.md` was re-run through
the same compiled `src/lib/` rather than re-derived.

**The recommendation stands as written, because the one finding that moved a
number moved it *against* building a router rather than for one.** The sub-agent
prize that made Option J the largest figure in the survey is 59% spend this app
never started. That correction is in `00-problem.md` and
`11-option-route-the-delegated-turn.md`, made before this file was written, and
it is the reason `13-recommendation.md` can say the prize row is a column of
zeros and ones without leaning on judgement.

Counts across the twelve files: **31 claims opened and confirmed**, **5
refuted**, **8 unverifiable from here**. All five refutations were corrected in
place — this file records what they were rather than leaving them for a reader
to rediscover.

---

## Verdict table

Refuted first.

| # | Claim | Where | Verdict | Evidence |
|---|---|---|---|---|
| 1 | Sub-agent turns are worth "$488.24 against $212.59, a difference of $275.65, or **6.8% of the window**", and Option J is "where the money is, by a factor of six over the next-largest measured prize" | `00:466`–`471`, `11:17`–`21` | **refuted** (inference, not measurement) | The $488.24 is right for the *window* and wrong as a prize for this app. Splitting the same 7,263 turns by project directory: `$250.65 workflow-subagent @ /Users/…/UsageFoundry` and `$39.48 workflow-subagent @ /Users/…/GHtranslator` — $290.16, **59%** — are host paths. `scanUsage()` reads `~/.claude/projects`, one bind mount shared with the host, so it sees the operator's own laptop sessions; `ls /Users` from inside the container is `No such file or directory`, so no argv this app builds reached them. Reachable: $198.08 over 3,227 turns, 4.8% of the window, $96.51 at Sonnet's rates, a difference of **$101.57 or 2.5%**. Corrected in both files with the command that produced the split. |
| 2 | A classifier's shape would be `spawnAssist`'s "almost exactly", including "its own `--max-budget-usd`" | `08:33`–`37` | **refuted** | `grep -n "max-budget-usd" src/lib/*.ts` finds exactly two `args.push` sites: `src/lib/orchestrator.ts:4882` and `src/lib/chat.ts:1704`. `spawnAssist` is neither — a review runs with no cost bound inside the CLI at all, which is coherent for a diff reader under `--permission-mode plan` and not for a classifier reading operator prose. The rest of the sentence holds: `--output-format json`, `--permission-mode`, `--allowedTools` and no telemetry env are all there (`src/lib/review.ts:616`–`641`, `reviewEnv()` at `:760`–`:775` stripping every `OTEL_` key). Corrected, and the option now owes a fourth `--max-budget-usd` call site on `chat.ts`'s precedent. |
| 3 | "no caller supplies agents to `spawnAssist` today (`docs/agent/architecture.md:131`)" | `05:187`, `11:72` | **refuted** (attribution) | The claim is true; the citation is not. `docs/agent/architecture.md:131` is the four-kinds-of-child paragraph and says nothing about it. The sentence is at `src/lib/agents.ts:354`–`355`: "no caller of `startAssist` supplies one, so a review has never been given an agent." Corrected in both files. |
| 4 | A model column on `run_templates` would be "an idempotent statement beside the thirty already there" | `04:38`–`39` | **refuted** | `grep -c "addColumn(db," src/lib/db.ts` → **55**. The helper is declared at `src/lib/db.ts:1320` and its `ALTER TABLE` is at `:1330`, which is what the proposal cited as "the helper". Corrected to fifty-five, with the command. |
| 5 | Twenty-seven bare `` `:NNNN` `` references resolve against the file cited before them | throughout `00`–`11` | **refuted** (unresolvable as written) | Every one is an `orchestrator.ts` line whose nearest preceding citation is a `docs/agent/*.md` file, a route file or `templates.ts` — e.g. the bare `6412` at `01:207` chained off `docs/agent/concurrency-and-ownership.md`, which has 21 lines. A human resolves them from the surrounding prose; a reader following `proposals/README.md`'s own rule cannot. Twelve chain starts now name their file and the remaining fifteen chain correctly off those; the affected paragraphs were re-wrapped. |
| 6 | `settings.defaultModel` is the only control; free-form; `null` in `DEFAULTS`; one text box | `00:10`–`14` | confirmed | `src/lib/settings.ts:86` (`defaultModel: string \| null`), `:611` (`defaultModel: null` inside `DEFAULTS` at `:601`), `src/app/settings/page.tsx:2229`–`2248` with `label="Default model"` at `:2232` and `placeholder="Claude Code's own default"`. |
| 7 | `createRun` resolves `input.model ?? settings.defaultModel` at the INSERT, with no `await` on the path | `00:16`–`18`, `01:195`–`203` | confirmed | `src/lib/orchestrator.ts:3205` is the expression verbatim; `getSettings()` at `:3150`; `db().transaction()` at `:3190`. |
| 8 | Nothing this app ships sets `input.model`; five server-side `createRun` call sites carry no `model:` key | `00:20`–`32` | confirmed | `grep -rn "createRun({" src/` outside the tests returns six sites and the greps reproduce. The four hits in `src/app/runs/new/page.tsx` are two comments, the agent-model copy at `:1531`–`1537` and the template picker's description at `:2209`. |
| 9 | Nothing writes `runs.model` after the INSERT | `00:34`–`37`, `02:62`–`65` | confirmed | `grep -rn "SET model" src/` → no output. `reopenRun` at `src/lib/orchestrator.ts:8080` takes no model argument. |
| 10 | `RunDTO.model` renders on no page; the run page shows the *agent's* and the review card the *review's* | `00:39`–`43` | confirmed, **and sharper than claimed** | `grep -rn "\.model" src/app src/components --include=*.tsx` returns ten hits and `run.model` is not among them. The run detail page's row is `<ListRow label="Its model">{run.agent.model ?? "the run's own"}</ListRow>` (`src/app/runs/[id]/page.tsx:1329`–`1333`) — a fallback string naming a value the page never renders, inside a block that only draws when `run.agent` is set. |
| 11 | `buildArgs` pushes `--model` first and is called inside the cycle loop, so the flag is re-sent every cycle including a resumed one | `00:50`–`58`, `09:11`–`17` | confirmed | `src/lib/orchestrator.ts:4843` is the first `args.push` after the base array at `:4842`; loop at `:6412`; `buildArgs({… model: run.model …})` at `:6701`–`:6703`; the test at `src/lib/orchestrator.test.ts:2353` is titled "still passes the mode, the model and the session to resume". |
| 12 | The reviewer and the conflict resolver are one spawn site reading `run.model`; `chat.ts` skips the run and reads the setting | `00:67`–`79` | confirmed | `src/lib/review.ts:51` (`AssistKind`), `:624` (`if (run.model) args.push("--model", run.model)`), `src/lib/chat.ts:1699` (`if (settings.defaultModel) …`). |
| 13 | Four records deliberately hold no model, each with its reasoning beside it | `00:81`–`110` | confirmed | All four quotations are verbatim: `src/lib/templates.ts:35`–`42`, `src/lib/db.ts:367`–`370`, `:616`–`619`, `src/lib/workflows.ts:1345`–`1351`. |
| 14 | An agent may carry a model; the four-line precedence measurement; `--model` outranks the pin | `00:117`–`132`, `01:128`–`137` | confirmed | `src/lib/agents.ts:121` for the field, `src/lib/db.ts:289` for the column, and the measurement block at `src/lib/agents.ts:99`–`110` reproduces line for line. `src/lib/orchestrator.test.ts:2207` is `it("still sends the run's own model when the agent names a different one")` and asserts `args[args.indexOf("--model") + 1] === "opus"`. |
| 15 | `general-purpose` and `Explore` are refused by name at save | `00:236`–`241`, `11:78`–`84` | confirmed | `BUILT_IN_AGENTS` at `src/lib/agents.ts:179`–`185` holds five names and both are on it; the refusal is at `:284`–`:292`. |
| 16 | `RunGuards` is three fields and the model is in neither half of the split | `01:9`–`36` | confirmed | `src/lib/settings.ts:489`–`:493`; the comment at `:480`–`:488` is quoted verbatim. |
| 17 | `resolvePrice` returns null for an unplaceable model; `costOf(t, null)` is 0; `guardCostOf` charges `{input: 10, output: 50}`; the comment says why that rate | `01:64`–`87` | confirmed | `src/lib/pricing.ts:115`, `:84`, `:194`–`:199`, and the reasoning at `:71`–`:83` including "deliberately not the $5/$25 Opus tier". `claude-opus-5` is `{input: 5, output: 25}` at `:38` and `claude-haiku-4-5` `{input: 1, output: 5}` at `:56`. |
| 18 | `isKnownModel` exists and has no call site | `01:113`–`116`, and every option that leans on it | confirmed | `grep -rn "isKnownModel" src/` returns exactly one line: its own definition at `src/lib/pricing.ts:135`. |
| 19 | Cache classes are multiples of the input rate; Sonnet 5's introductory rate ends 2026-09-01; fast mode is a separate table at 2× for two Opus entries | `01:118`–`124` | confirmed | `src/lib/pricing.ts:16`–`18` (0.1 / 1.25 / 2.0), `:68`–`:69`, `:62`–`:66`. |
| 20 | `costUSD`/`fraction` versus `costGuardUSD`/`guardFraction`, and `guardFraction` is null exactly when `fraction` is | `01:83`–`86`, `07:63`–`70` | confirmed | `src/lib/windows.ts:65`, `:259`, `:353`, `:365`, with the comment at `:351`–`352` saying it in those words. `windowRefusal`'s reason for reading `guardFraction` is at `src/lib/review.ts:465`–`467`. |
| 21 | A review has no `BudgetPolicy` and is not put through `evaluateBudget` | `03:20`–`23`, `03:120`–`124` | confirmed | The docblock at `src/lib/review.ts:457`–`463` says exactly that. |
| 22 | `maxConcurrentAssists` bounds three of the four kinds of child through `assistRefusal()` over `liveAssistChildren()`, which counts rows in three tables | `08:72`–`85` | confirmed | `src/lib/review.ts:437` and `:375`, with the three-table reasoning at `:358`–`:374`. The login child is bounded by "at most one pending per install" at `src/lib/claudeAuth.ts:18`. |
| 23 | Five `origin` values, three of them unattended | `06:46`–`49`, `10:92`–`96`, `14` | confirmed | `RUN_ORIGINS` at `src/lib/orchestrator.ts:273`–`284` with the reasoning at `:263`–`:272`. |
| 24 | `agentsFlagValue` omits `model` rather than nulling it, because a member whose `model` is JSON null is dropped, and every violation on the offered path is silent | `01:154`–`158`, `05:97`–`102`, `11:109`–`115` | confirmed | The encoder is `...(agent.model ? { model: agent.model } : {})` at `src/lib/agents.ts:385`; the measurement and "no error, no warning and a zero exit" are at `:360`–`366`. |
| 25 | `startRun` freezes the row before the loop; `enabledPluginDirs()` is the per-cycle precedent and `settings` the counter-precedent | `01:205`–`225` | confirmed | `const run = getRun(id)` at `src/lib/orchestrator.ts:6278`, loop at `:6412`, `enabledPluginDirs()` at `:6690` with its reason at `:6686`–`:6689`, `const settings = getSettings()` at `:6379` and the "fixed for the segment" comment at `:6722`–`:6723`. |
| 26 | `currentSnapshot()` and `evaluateBudget` are ten lines apart in the cycle loop | `07:9`–`16`, `07:40`–`43` | confirmed | `await currentSnapshot()` at `src/lib/orchestrator.ts:6419`, `evaluateBudget(` at `:6438`. |
| 27 | `--max-budget-usd` is `max(0, maxRunCostUSD - spentGuardUSD)`, derived per cycle | `01:50`–`53` and five options | confirmed | `src/lib/orchestrator.ts:4880`–`4882`, with the per-invocation reasoning at `:4875`–`4879`. |
| 28 | `maxIterations` counts cycles; `null` only alongside `maxDurationMinutes`; refused as `no_terminus` | `01:55`–`59` | confirmed | `src/lib/budget.ts:97`, the invariant at `:87`–`:91`, the refusal at `:494`–`:496`. |
| 29 | `max_iterations` is `NOT NULL DEFAULT 1` and `maxIterations` defaults to 1 | `09:146`–`147` | confirmed, **with a stronger citation available** | `src/lib/db.ts:156` is verbatim. The proposal cites `src/lib/orchestrator.ts:110`–`111` for the default, which is a comment *asserting* it; the code is `!("maxIterations" in o) ? 1 : …` at `src/lib/budget.ts:613`–`618`. Left as written — the claim is right and the comment is a fair witness — but the code line is the better reference and `13-`/`14-` use it. |
| 30 | `saveSettings` stores only what differs from `DEFAULTS`, per key | `03:92`–`96` and four others | confirmed | `src/lib/settings.ts:693`–`706`, a `for (const key of SETTINGS_KEYS)` loop over `sameValue(next[key], DEFAULTS[key])`. |
| 31 | Every ceiling is `null` in `DEFAULTS` | `07:186`–`188` | confirmed | `sessionCostLimit`, `weeklyCostLimit`, `sessionTokenLimit`, `weeklyTokenLimit` at `src/lib/settings.ts:602`–`605`; `weeklyAnchor` at `:606`; `defaultAgentId` at `:612`. |
| 32 | A workflow loop pass is a fresh run through `createRun`, filed `origin: "workflow"` | `09:104`–`112` | confirmed | `src/lib/workflows.ts:4720`–`4729`, including the comment "A pass is not an `orchestrator-block` run". `NODE_KINDS` is `["run", "orchestrator", "merge", "loop"]` at `:398`. |
| 33 | There is no `templateId` on the run wire or the row | `04:186`–`189`, `06:64`–`69` | confirmed | `grep -rn "templateId" src/lib/orchestrator.ts` → no output. The reason is at `src/lib/templates.ts:43`–`46`. |
| 34 | A chat proposal names a template, resolved at the click | `04:81`–`84`, `08:63`–`66` | confirmed | `src/lib/chat.ts:920`–`926`, with the comment "Read at the click rather than at the proposal". |
| 35 | The agents page hint reads "What the delegated turn runs on", which the singular flag made false for a work cycle | `02:77`–`82`, `05:111`–`116` | confirmed | `src/app/agents/page.tsx:282` verbatim; `src/lib/agents.ts:88`–`96` records the meaning change. |
| 36 | The template narrowing rule — on save, on read, and again at `POST /api/runs` | `04:41`–`43` | confirmed | `src/lib/templates.ts:22`–`31`. `RunTemplate` begins at `:51`. |

---

## The measurements, re-run

Same procedure as `00-problem.md`: compile `src/lib/` and call the app's own
functions rather than write arithmetic for this document.

    $ node_modules/.bin/tsc -p tsconfig.test.json --outDir "$TMPDIR/uf-42bb8e94/build"
    (exit 0)

**The window split by model reproduces to a tenth of a point.** Its numbers are
larger because the rolling seven days moved with the clock and this session and
its siblings are inside it.

    turns 29085 total $4107.43 unpriced []          (was: 28868 / $4080.13 / [])
    claude-opus-5              $4078.20 99.3%       (was: $4050.90 99.3%)
    claude-sonnet-5            $28.99 0.7%          (identical)
    claude-haiku-4-5-20251001  $0.25 0.0%           (identical)
    <synthetic>                $0.00 0.0%           (identical)

**The bucket split is identical except for main-thread Opus**, which is the only
row this week's own work could move. `general-purpose` is still 1,231 turns on
Sonnet against 948 on Opus, and `Explore` still 13 on Sonnet — so the claim that
something is already routing, and that it is not this app, holds unchanged.

**The cache split reproduces exactly**: `cacheRead` 62.1%, `cacheWrite1h` 20.9%,
`output` 12.0%, so 83% of the bill is carried context. `resolvePrice` puts
Sonnet 5 at 0.400× Opus 5 on both rates today.

**The run distribution reproduces and grew by two sessions**: 306 sessions under
`.uf-worktrees/` (was 304), and of the 181 with fifty turns or more (was 179)
the range is still `min $4.75 median $13.97 max $66.66`. **Fourteen times, at
one model, is still the number.**

**The documentation wave of 2026-08-19 reproduces to the cent**, including all
eight per-run figures: `$7.52 $6.29 $12.15 $9.21 $6.88 $9.82 $11.64 $11.29`,
647 turns, $74.80, $29.92 at Sonnet's rates. Its share of the window reads 1.82%
rather than 1.83% because the denominator grew.

**And the one measurement that was not in `00-problem.md` and changed a
conclusion** — the split of delegated turns by project directory — is
finding #1 above, now in `00-problem.md` with its command.

## Also found, not a claim anyone made

- **`typescript` is not on the built-in refusal list, and something already
  answers to it here.** `BUILT_IN_AGENTS` holds five names
  (`src/lib/agents.ts:179`–`185`); the six-name list `00-problem.md` quotes from
  `docs/agent/agents-and-templates.md:10` adds `typescript`, and
  `~/.claude/agents/typescript.md` exists on this machine. `docs/verification.md:479`
  records the CLI's own answer measured off the pin — `claude, Explore,
  general-purpose, Plan, statusline-setup, uf-set-probe` — with no `typescript`
  in it, so the sixth name in that quoted list is a *user-defined* agent found
  on disk rather than a built-in. Consequence: `normalizeAgentInput` would
  accept a saved agent named `typescript`, and it would land in exactly the
  ambiguity the refusal exists to prevent — "either does nothing or replaces the
  built-in one, and it does not say which" (`src/lib/agents.ts:286`–`290`). It
  bears on Option J only in that the option's built-in argument is right for the
  wrong boundary. **Not corrected**: the list is in `docs/`, and this proposal
  changes nothing there.
- **Nothing tests `pricing.ts`.** There is no `src/lib/pricing.test.ts`, and the
  only reference to `resolvePrice`, `guardCostOf` or `isKnownModel` in any test
  file is a comment (`src/lib/windows.test.ts:482`). Three pure functions whose
  failure modes are silent and expensive, two with unexercised branches — a date
  boundary eleven days out (`src/lib/pricing.ts:68`–`69`) and a fast-mode table
  (`:62`–`:66`). `14-implementation-sketch.md` names it and does not propose to
  fix it, because it is not routing.
- **`??` makes an empty-string model on the wire shadow the setting.**
  `input.model ?? settings.defaultModel` (`src/lib/orchestrator.ts:3205`) treats
  `""` as a value, so a run created with `model: ""` would store `""`, emit no
  `--model` (`:4843` tests truthiness) and silently run on the CLI's own default
  instead of `settings.defaultModel`. What prevents it today is
  `body.model ? String(body.model) : null` at
  `src/app/api/runs/route.ts:233` — load-bearing rather than incidental, and the
  reason `14-implementation-sketch.md` says a form-side narrowing helper would
  make it worse.
- **The run detail page's model row only draws when the run has an agent.** It
  is inside the `run.agent && (` block (`src/app/runs/[id]/page.tsx:1323`), so on
  a stock install — `settings.defaultAgentId` is `null` at
  `src/lib/settings.ts:612` — the "How it was set up" region shows no model row
  at all.

## Unverifiable from here

Eight, and each is named in the file that depends on it.

1. **Anything in the live `runs`, `run_reviews` or `chat_sessions` tables.**
   `/data` is a named volume, root-owned 0700, and `docker-compose.yml:35`–`36`
   says why an agent cannot open it. The `.data/usagefoundry.db` reachable from
   here is a `npm run dev` artefact whose `runs` table is empty
   (`00-problem.md`). So: the share of runs carrying an agent, the share
   carrying a template, the split of spend by `origin`, `run_reviews.cost_usd`
   against `runs.spent_usd`, and `runs.max_iterations` are all unanswerable from
   a work cycle. **Five of the survey's named experiments are in this bucket**,
   including the one `13-recommendation.md` says would promote Option D.
2. **Whether this install has overridden `weeklyAnchor`.** `00-problem.md` marks
   it "assumed" for the same reason and that is still the right word.
3. **Whether `settings.defaultModel` was non-null for the two Opus-main-thread
   sessions with delegated Sonnet turns.** The settings row is in the same
   database and the transcripts do not record argv.
4. **Whether a member's `model` still governs a delegated sub-turn on the
   offered path** (`agentsArgs` without `--agent`,
   `src/lib/agents.ts:391`–`401`). Every measurement quoted in this repository
   is off the `system`/`init` event, which reports the session's model. Option J
   rests entirely on this and says so; Option D's second experiment is the same
   question.
5. **Whether switching model on a `--resume` keeps the conversation's cached
   context.** Unmeasured anywhere, and 83% of the bill is that context. Option H
   is unknown rather than unfavourable until it is answered.
6. **Whether `--model` would survive a `--resume` on its own.** Not needed by
   anything recommended here — `buildArgs` re-sends it either way — and worth
   keeping on the list because an option that stops sending it per cycle would
   depend on it silently.
7. **Whether a cheaper model completes any of this install's real tasks in the
   same number of cycles.** The assumption the whole survey rests on, unmeasured
   by construction: it needs a billed run, not a scan.
8. **Which of the eight documentation runs came through the form.** `runs.origin`
   holds the answer and is in the unreadable database; `10-option-run-form-override.md`
   marks it "not verified" and that stands.

## The experiments, gathered

Every experiment the survey named, in the order they should be run — cheapest
and most decisive first. Three of the ten are free.

| # | Question it settles | Cost | Where it was named |
|---|---|---|---|
| 1 | Do a week's per-run model choices differ from each other at all? Blank `settings.defaultModel`, set one by hand between runs. | free, one week of ordinary use | `10`, and `13-recommendation.md` says run it first |
| 2 | What share of runs carry `runs.agent`, and do they cost differently? `SELECT agent IS NOT NULL, COUNT(*), AVG(spent_usd) FROM runs GROUP BY 1;` | free, needs database access | `05`, promotes Option D |
| 3 | Split the window's spend by `runs.origin` and by whether the run carried an agent. | free, needs database access | `06`, is Option E's only candidate discriminator |
| 4 | `run_reviews.cost_usd` and `chat_sessions.cost_usd` against `runs.spent_usd` — is the *kind of child* a material axis? | free, needs database access | `03` |
| 5 | `SELECT max_iterations, COUNT(*) FROM runs GROUP BY 1;` — what share of runs could have a phase at all? | free, needs database access | `09` |
| 6 | Score a cheap model's model-choices offline against the eight tasks of 2026-08-19, the way `proposals/ExternalValidator/` scored its spike. | cents | `08` |
| 7 | **Re-run two of the four read-only audits on `claude-sonnet-5` and compare cycles, cost, ending status and filed issues.** | ~$10 billed | `08`'s second, and it is `13-recommendation.md`'s overturning fact |
| 8 | Does a model switch on `--resume` keep the cache? Run cycle 1, switch, resume, compare `cacheRead`/`cacheWrite1h` against a control. | small, billed | `09`, gates Option H entirely |
| 9 | Does a member's `model` govern a delegated turn on the offered path? `claude -p --agents '{"uf-x":{…,"model":"haiku"}}'` with no `--agent`, prompt a delegation, read the turn's model off the transcript — `attributionAgent` and `model` are both on the record (`src/lib/transcripts.ts:255`–`264`), so `scanUsage()` answers it with no new code. | small, billed | `05` and `11`, gates Option J entirely |
| 10 | Does anything on an argv this app can build reach a *built-in* agent's model? | small, billed | `11` |

Experiments 2–5 are one session at a database an operator can open, and between
them they decide three of the ten options. That they are all blocked on the same
thing is worth naming: **this app's own ledger is the evidence the survey most
often wanted and least often had**, and every figure in `00-problem.md` comes
from the transcripts instead.

## What this validation did not check

- **It executed no experiment.** Nothing above ran a `claude` child; every
  billed line in the table is named, not run. The one billed thing this pass did
  was compile `src/lib/` and call pure functions on the existing transcripts.
- **It did not open the pinned CLI.** Every claim about the binary's behaviour —
  the four-line precedence measurement, the silent handling of a malformed
  `--agents` payload, `--agent`'s error message — was taken on trust from the
  comment that records it (`src/lib/agents.ts:99`–`110`, `:360`–`366`) and from
  `docs/verification.md`. Those comments state their own method and the pin
  (`@anthropic-ai/claude-code@2.1.226`, `Dockerfile:194`); this pass confirmed
  the comments say what the proposal says they say, which is a weaker claim.
- **It did not re-derive the price table.** `resolvePrice`'s answers were taken
  from the function; whether `claude-sonnet-5` really is $3/$15 after
  2026-09-01 is the table's claim, not this file's, and nothing tests it.
- **It did not check the rendering.** Whether a `ListRow` for `run.model` sits
  inside the right band is a claim about `docs/agent/conventions.md:46`, read
  and cited but not built.
- **It read the option files for accuracy, not for completeness.** No search was
  made for an eleventh shape. `12-comparison.md` names one that was considered
  and left out — a model editable on a running run — and gives the reason.
