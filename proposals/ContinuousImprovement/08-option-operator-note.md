# Option E — the operator's per-repository note

A `Record<string, string>` on `Settings`, keyed by folder and resolved exactly
the way `isolationCopyGlobsByRepo` and the per-repository GitHub credential
already are, whose value is prepended to the opening prompt of every run on that
repository. No model writes it, no run can reach it, and it is not a memory: it
is the operator saying one thing, once, to every future agent in one folder.

The case against it is stronger than the case for it, because the mount's own
`CLAUDE.md` already does this, the CLI already loads it for free, and the
operator can review and diff it in git. Two narrow advantages survive that, and
the whole of the option is the scope on which those two are the point.

## The strongest case

**Both halves of the mechanism exist and are already tested.** The resolution
rule is `matchFolderKey` (`src/lib/config.ts:382`–`:400`): a configured key is
compared segment-wise and case-folded against the run's folder, the deepest
match wins (`:396`), and — this settles constraint 11 — nothing touches the
filesystem, so a stored key is a comparison and never a path that gets
dereferenced. Its docblock says why there is one copy rather than two
(`:372`–`:377`) and `src/lib/config.test.ts:162`–`:178` already covers the
parent-key, case-folding and near-miss cases. The delivery point is
`nextPrompt`'s fresh-session branch (`src/lib/orchestrator.ts:4299`, array at
`:4331`–`:4348`), a pure function already composing five conditional parts in a
deliberate order. This option adds one array slot and one `Record` lookup.

**It lives in `DATA_DIR`, which the run cannot write, and nothing else about a
run's instructions can say that.** `Settings` is a row in the `settings` table
(`src/lib/db.ts:137`) in the database under `/data`, and `/data` is `root:root`
mode `0700` (`Dockerfile:298`–`:299`) while every child the server spawns is
dropped to `UF_AGENT_UID`, which compose defaults to 1000
(`docker-compose.yml:218`). `CLAUDE.md` in the mount cannot claim that, and
neither can anything in `~/.claude`: that is one bind mount shared with the host
(`docker-compose.yml:243`), writable by the agent uid, which is why
`UF_LOCK_CLAUDE_HOME` exists — compose's own comment says that until it is on,
"a run can append `{"sandbox":{"filesystem":{"allowWrite":["/"]}}}` to it and
every later session, its own and its siblings', starts confined to nothing"
(`docker-compose.yml:146`–`:149`). Constraint 7 asks every option which side of
that line its store is on. This one is on the side where the write side and the
read side cannot be the same author by construction rather than by policy — and
a run *does* rewrite `CLAUDE.md`: runs default to `acceptEdits`
(`src/lib/settings.ts:610`), and `00-problem.md` records `CLAUDE.md` as the file
named by 54 of 67 AI conflict resolutions, the most contended file in this tree
by a factor of 3.6.

**It is editable mid-run without touching the tree, so it is cache-safe where a
`CLAUDE.md` edit is not.** Constraint 4: a repository change is a cache write,
and `proposals/ContextControl/00-problem.md:763` prices one at a median $2.32
(re-measured at $2.39, `proposals/ContextControl/19-validation.md:68`). Editing
`CLAUDE.md` to correct a running agent is a working-tree modification, so it
moves `gitStatus`, which sits ahead of the only cache breakpoint that matters —
the operator pays a full prefix re-write for the privilege of fixing a sentence.
Text appended at the tip of the next cycle's prompt is the opposite case:
`S = D`, `T* = −1`, paid once and read at 0.1× thereafter.

**Scope, which is where those two stop being narrow.** Facts about the
*container*, never about the code: which mount this folder is, what the run's
credential does and does not reach, and the two environment traps this
repository's own `CLAUDE.md:23` records — a bare `npm ci` under the image's
`NODE_ENV=production` "exits 0 having skipped devDependencies, and
`typecheck`/`test` then fail with exit 127 — use `NODE_ENV=development npm ci
--include=dev`", and a shell inheriting `__NEXT_PRIVATE_STANDALONE_CONFIG` from
a UsageFoundry container "(which is what an agent this app spawns gets) makes
`next build` die with `TypeError: generate is not a function` … `env -u
__NEXT_PRIVATE_STANDALONE_CONFIG npm run build` is the whole fix." Both are true
of the environment this app itself constructs, both are invisible from inside
the checkout, and neither is a fact about the source tree that a git history
would record.

## Shape

Four doors, per constraint 1, and one is opened by another.

| door | precedent | shape |
|---|---|---|
| interface member | `src/lib/settings.ts:251` | `repoNotes: Record<string, string>` |
| `DEFAULTS` entry | `src/lib/settings.ts:620` | `repoNotes: {}` — empty, so `saveSettings`' deep compare (`:693`–`:706`) never persists it into an install that has none |
| `SETTINGS_KEYS` | `src/lib/settings.ts:649` | free: it is `Object.keys(DEFAULTS)`, so the row above opens this door |
| `PUT` arm | `src/app/api/settings/route.ts:305`–`:321` | one `if ("repoNotes" in body)` block, trimming trailing slashes exactly as `:310` does |

Resolution mirrors the credential rather than the seed globs, and the difference
decides constraint 10. `copyGlobsFor` (`src/lib/orchestrator.ts:2386`) is called
from inside `ensureWorktree` (`:2183`), so it exists only for isolated runs;
`githubTokenFor(run.repo_root ?? run.folder)` is called once per run before the
cycle loop (`:6475`) and covers every run. On this corpus that is the difference
between 243 runs and all 294 (`SELECT isolation, COUNT(*) FROM runs GROUP BY 1;`
→ 243 `worktree`, 40 `none`, 11 blank), and the fallback is load-bearing: 51 of
294 rows carry `repo_root IS NULL` and resolve on `folder` instead.

Delivery is one array slot in `nextPrompt`, placed **above** `o.task` and
therefore above `COMPLETION_NOTICE` (`:4344`) and `NEEDS_REVIEW_NOTICE`
(`:4347`), so the generated contract stays last — which is what the comment at
`:4342`–`:4343` says that position is for.

Resolution belongs to constraint 9's *once per run* class, beside `settings`
(`:6452`) and the credential (`:6475`), not to `enabledPluginDirs()`'s per-cycle
class (`:6763`): a note that changed between cycles would be a run whose
instructions changed with nothing saying so. The one exception is explicit — when
the stored text differs from what this run was last sent, the difference is
appended to the next cycle's continuation prompt, once, and logged.

## What it learns from, and when the decision is taken

Nothing, and never. It reads no `tool_error`, no `run_reviews`, no `run_events`
and no transcript, and takes no decision at any point in a run's life. The
operator writes a sentence; the sentence is delivered.

That is also its whole defence against `00-problem.md`'s weakest half: a mistakes
corpus of one `needs-review` in 294 and one non-zero `exit_code`, 40% of whose
`tool_error` volume is a single environment fault the codebase answered with a
classifier rather than a memory, all of it on a rolling thirty-day horizon
(`src/lib/retention.ts:137`, `src/lib/settings.ts:631`). This option has nothing
to mine and nothing to expire. The price is under the last heading: it cannot
improve, and nothing tells the operator it has gone stale.

## What it does to the prefix cache

Nothing beyond its own length. Text at the tip of a prompt is constraint 4's
`S = D` case, `T* = −1`; the mechanism never touches the working tree, so it
never moves `gitStatus` and never triggers the invalidation a `CLAUDE.md` edit
does.

The carrying cost is the whole arithmetic, and it is why the cap below is not
optional. Over the eleven days to 2026-08-21 this repository's runs made 17,218
main-thread requests:

```sql
SELECT COALESCE(NULLIF(r.repo_root,''),r.folder) AS repo, COUNT(*) AS reqs,
       COUNT(DISTINCT o.run_id) AS runs, ROUND(SUM(o.cost_usd),2) AS otlp_cost
FROM otlp_requests o JOIN runs r ON r.id = o.run_id
WHERE o.query_source = 'sdk' GROUP BY 1 ORDER BY 2 DESC;
-- /workspace/UsageFoundry | 17218 | 199 | 2822.83
```

That is 10,957 turns a week on one repository, every one of them
`claude-opus-5` (same query grouped by `o.model`), at $5 per million input
(`src/lib/pricing.ts:38`) and 0.1× of that on a cache read
(`src/lib/pricing.ts:16`). At the survey's soft four-bytes-per-token conversion:

| note length | tokens | carried, per week, this repository | written, per week |
|---|---|---|---|
| 763 B — the two traps, verbatim from `CLAUDE.md:23` | 191 | **$1.05** | $0.24–$0.72 |
| 1,000 B | 250 | $1.37 | $0.32–$0.95 |
| 2,000 B — the proposed cap | 500 | $2.74 | $0.63–$1.90 |
| 15,473 B — this repository's whole `CLAUDE.md` (`wc -c CLAUDE.md`) | 3,868 | **$21.19** | $4.90–$14.70 |

The write range is one to three 1h writes per run at 2.0×
(`src/lib/pricing.ts:18`) across 126.6 runs a week; the upper end comes from
`proposals/ContextControl/00-problem.md:763`, where 79 of 108 handovers
re-wrote. The chain cross-checks against constraint 12's independent figure of
$8.14–$8.26 a week for 995 tokens over 16,605 container turns: this install's
`sdk` requests across all folders come to 24,092 in eleven days, or 15,331 a
week, within 8% of that turn count on a different measurement taken five days
apart.

**So a 2,000-byte note is under three dollars a week and a pasted design
document is twenty.** Idle and success cost are the same number here, which is
unusual in this survey: constraint 13's success cost has no analogue, because a
container fact *is* the answer rather than a pointer to one.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: untouched, and constraint 2 is met without a re-send.** The note
rides in the cycle-1 prompt, which is part of the conversation `--resume` carries
forward, so it is present on cycle 7 at 0.1× without being sent again. It is not
an argv entry, so it inherits neither `--plugin-dir`'s does-not-survive problem
nor `--settings`' composer, and constraint 3 does not apply because nothing here
goes near `sandboxArgs`.

**The DONE contract and `needs-review`: unchanged in code, reachable in prose.**
`COMPLETION_NOTICE` (`src/lib/orchestrator.ts:4466`) and `NEEDS_REVIEW_NOTICE`
(`:4506`) stay generated and stay last. But the note is operator text in the same
message, and an operator who writes "never stop until the build is green" has
written a sentence arguing with the one at `:4466`. Placement above the task
mitigates and does not remove that; it is the exposure `isolationPreamble`
already carries, and the reason constraint 1's rule is that only *guidance* may
be settings-backed. A container fact is guidance; an ending rule is not, and
nothing in code can tell the two apart.

**Retention: no fourth horizon, and that is a liability as much as a saving.**
`Settings` is never swept — "Nothing here deletes a `runs` row, a review, a
workflow record or a setting" (`src/lib/retention.ts:30`–`:31`) — so constraint 8
is answered by inheritance and `StorageReport` gains no arm. Read the other way:
a note about a trap fixed three months ago goes on being written at 2.0× and
carried at 0.1× on every turn of every run on that repository for ever, with
nothing anywhere reporting it.

## Guards, the three cost sources, and who may author it

**It is not a cost source and it does not spend.** Nothing calls a model, writes
`run_reviews.cost_usd` or touches `runs.spent_usd`; the note's cost appears where
every other prompt byte's does, inside a cycle already being paid for, so
constraint 5 is satisfied by having nothing to report and no new figure on any
page. Guards are untouched: no budget read, no ceiling moved, no rung added to
the check order.

**The author is the operator alone, enforced by the filesystem rather than by a
rule.** The write door is `PUT /api/settings`, behind `src/middleware.ts`'s auth;
the store is `/data`, `root:root 0700`; the read door is one lookup before the
cycle loop. A run has no path to any of the three — and the comparison that
matters is not with `CLAUDE.md` in the abstract but with `CLAUDE.md` on *this*
install, where 54 of 67 conflict resolutions named it.

## What the operator sees, and how they override it

**On the run's own log, on the credential's model.** Constraint 6 is not optional
here, and the precedent is one line away: `src/lib/orchestrator.ts:6477` logs
"GitHub credential scoped to …" with the matched key on the payload, and `:6482`
logs the configured-to-none case. A note that resolves writes the key it matched
and its byte count; a note that was cut says it was cut. This is required rather
than nice, because the other disclosure does not exist — constraint 6 records
that the `iteration` event persists the whole prompt while `describeEvent`
renders only "Work cycle N", so without a log line the note is invisible to the
person who wrote it.

**In Settings — where the four doors are actually six.** The page carries its own
`EDITABLE_PATHS` (`src/app/settings/page.tsx:197`–`:236`) driving the edited
rail, and per-fold key lists such as `ISOLATED_RUN_KEYS` (`:253`–`:258`); the
docblock at `:238`–`:251` says a path missing from one is "a setting that can sit
behind a closed summary at a value nobody on this install chose — which is
silent".

**And the editor is where the `isolationCopyGlobsByRepo` precedent stops being
free.** `parseGlobsByRepo` (`src/app/settings/page.tsx:477`) splits the textarea
on `\n` and takes everything before the first `:` as the folder, which cannot
carry prose with newlines in it, so a note needs a control of its own — the
largest single item in the build below.

**Override is per repository by construction**, the deepest key winning
(`src/lib/config.ts:396`): a key on `/workspace` is a mount-wide default and one
on `/workspace/UsageFoundry` beats it. Per-*run* override is not expressible and
should not be.

## How it fails, and whether loudly

**Silently at the door it is most likely to miss.** Omit the `PUT` arm and the
route answers 200 without the key while the form reverts under a "Saved"
confirmation (`src/lib/settings.ts:645`–`:647`).

**Silently and expensively if it is not capped, and nothing else in the app caps
it.** `grep -n "length" src/app/api/settings/route.ts` returns nothing across 468
lines: not one of the four prompt fields — `continuationPrompt` (`:238`),
`isolationPreamble` (`:324`), `continuedWorkPrompt` (`:329`),
`donePushbackPrompt` (`:338`) — is bounded by anything but `.trim()`. A
repository-scoped prose box is exactly what an operator pastes a document into,
and the table above prices one paste at $21.19 a week, recurring, unreported.

**Silently when the key does not match.** `matchFolderKey` returns `null` for a
near miss — `src/lib/config.test.ts:178` has `/workspace/acme/web-legacy` against
key `acme/web` returning `null` — and that is indistinguishable from having
written no note. The log line is the whole of the defence.

**And the failure that decides the option: it is declined.** `00-problem.md`
closes on 112 runs editing `src/lib/` against eleven reading the doc the gate
names. This option delivers text to the same place, in the same message, from a
different store.

## What it costs to build

Small, and concentrated in the file the mechanism does not live in. Four doors
plus two page lists; a resolution helper of five lines beside `copyGlobsFor`; one
parameter and one array slot in `nextPrompt`; one `log` call; a cap constant and
a cut modelled on `clipToolInput` (`src/lib/logLine.ts:145`, cap
`MAX_TOOL_INPUT_CHARS = 4_000` at `:104`, per-field cut
`MAX_TOOL_FIELD_CHARS = 1_000` at `:119`) reporting `truncatedFrom` for that
function's stated reason, "a short input and a shortened one must not look
alike"; the separate pause row; and the settings control. Call it 250–350 lines
across six files, over half of it `src/app/settings/page.tsx`. Two unit tests
clear `docs/agent/testing.md`'s bar — the cap, whose failure is silent and
recurring, and `nextPrompt`'s ordering with a note present — and `matchFolderKey`
needs none, being covered already.

**Two repairs are prerequisites rather than polish.**

The first is the cap, **in code, not in the placeholder text** — every byte is
written at 2.0× and carried at 0.1× on every turn of every run on that
repository for as long as the note stands, and 2,000 characters holds the two
traps at 763 bytes with room to spare. `clipToolInput` is the shape: a named
exported constant, a cut that marks itself, a `truncatedFrom` beside the value.

The second is an **off switch that does not ride the settings blob**.
`fleet.newWorkPaused` is the precedent and its docblock is the argument
(`src/lib/settings.ts:740`–`:761`, key at `:762`, pair at `:764`–`:770`): "the
settings page sends the whole object on Save, so a field in that blob is one an
unrelated edit from a tab opened before the pause would silently clear — which
for a preference is a nuisance and for the fleet's kill switch is the failure it
exists to prevent." `src/lib/plugins.ts:32`–`:36` and
`src/lib/apiTypes.ts:1769`–`:1775` name the same reasoning twice more. An
operator who has just discovered their note is wrong needs to stop it reaching
runs *now*, and blanking a key in the blob races a stale tab that will put it
back with nothing said.

## What would have to be true

**That the mount's `CLAUDE.md` is not already doing this — and for one of the two
traps it demonstrably is.** The corpus answers from the call side rather than the
error side, because a stored tool input keeps the command first and cuts each
field at 1,000 characters (`src/lib/logLine.ts:119`, `:177`), so a command-line
prefix survives the clip:

```sql
WITH b AS (SELECT e.run_id, json_extract(e.payload,'$.input.command') AS cmd
           FROM run_events e JOIN runs r ON r.id = e.run_id
           WHERE e.kind='tool' AND json_extract(e.payload,'$.name')='Bash'
             AND COALESCE(NULLIF(r.repo_root,''),r.folder)='/workspace/UsageFoundry')
SELECT SUM(cmd LIKE '%npm ci%'), SUM(cmd LIKE '%NODE_ENV=development%npm ci%') FROM b;
```

| clause of `CLAUDE.md:23` | calls | guarded | runs | runs guarded |
|---|---|---|---|---|
| `npm ci` | 219 | 186 (84.9%) | 133 | **126 (94.7%)** |
| `npm run build` / `next build` | 557 | 137 (24.6%) | 123 | **50 (40.7%)** |

**Two clauses of one paragraph, in one file, in one position, at 94.7% and
40.7%,** and it cuts both ways. It is direct evidence for
`00-problem.md:260`–`:264`'s open question, since position is held constant here
and compliance still moves fifty-four points — which is the premise this option
most needs. And it is the reason to build nothing: moving those sentences from
`CLAUDE.md` into `DATA_DIR` changes neither their position nor their content, so
no mechanism in this option would lift the build clause above 40.7%. What changes
is only who may rewrite them.

Three further things would have to hold, and the first decides it.

**That some container fact worth telling every run is not expressible in
`CLAUDE.md`.** Both traps are in `CLAUDE.md` today. A credential's scope is not,
and cannot honestly be: `githubTokenFor` resolves from `UF_GITHUB_TOKENS` in the
operator's `.env` (`src/lib/config.ts:442`, parsed at `:351`–`:363`), whose
values "never leave this map except into a child's environment" (`:347`–`:349`),
and a repository configured to get none tells its run nothing beyond one log line
(`src/lib/orchestrator.ts:6482`). That is the one class where this option carries
a fact `CLAUDE.md` structurally cannot — and one class is a thin base for a
`Settings` key, six doors and a second off switch.

**That an operator would keep it current.** There is no staleness signal in this
design and none available: nothing in the app knows whether a container fact is
still true, and constraint 8's "never swept" is the same sentence read as a
liability.

**That the cap ships in the same commit.** An uncapped operator text box carried
on every turn of every run on a repository for ever is a recurring bill nothing
here reports, and the four existing prompt fields show that the default is to
ship without one.

**And the fact that would overturn the case against it:** a measurement showing
that one run rewrote `CLAUDE.md` in the mount and a later run on the same
repository then acted on the changed text. `run_reviews` establishes that runs
collide in that file 54 times; this file did **not** establish that any run's
*instructions* were changed by another run's edit — that check was not run and is
assumed unmeasured. If it happened even once, the `DATA_DIR` argument stops being
narrow, because closing that loop is the one thing this option does that no
sibling in the survey does.
