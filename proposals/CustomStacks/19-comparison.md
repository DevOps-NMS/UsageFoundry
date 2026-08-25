# The comparison

Fifteen option files, three questions, one table. The criteria and their weights
are stated **before** any score, because a comparison whose weights are chosen
after the scores are known is an argument wearing a table's clothes.

## 1. The criteria, and the weights are the argument

Someone who disagrees with the weights gets a different answer, and that is the
point: the weights are where the judgement is, and they are contestable in a way
the scores are not. Each is derived from a finding in this directory rather than
from a general principle.

| # | Criterion | Weight | Why that weight |
|---|---|---|---|
| 1 | **Loud** — does it convert a silent failure into a visible one? | **5** | `14-` §5. A stacks feature that adds a third silent failure is worse than no feature, and this tree has the number: **213 sessions told a plugin was active against a command that was never present** (`.env.example:222-226`). Highest weight because it is the only failure class here with evidence attached. |
| 2 | **Reach** — does it address `00-problem.md` §"Missing 3"? | **5** | The single unmeasured fact the survey turns on. A tool that is installed, on `PATH`, and cannot be invoked by a work cycle is a feature that delivers nothing. Scored on whether an option *addresses* it, not on whether reach is broken — that is unmeasured (`07-` §10). |
| 3 | **Durable** — the four events of `01-constraints.md` §1 | **4** | The operator's own stated requirement, and the one thing all three existing volumes were built for. Below loudness because the tree already solves three of the four events twice over. |
| 4 | **Cheap** — inverse of build cost | **4** | Equal to durability deliberately. `14-` §8's asymmetry is that effort spent on the installer buys less than effort spent on the read-back, so cost is not a tiebreaker here — it is a first-class criterion. |
| 5 | **Safe** — boundary and security cost, inverted | **3** | Real, and below the top three because `08-` §2 establishes that arbitrary execution, the agent uid and write access to every mount are all **already shipped**. The question is only what a new surface adds. |
| 6 | **Asked** — does it answer *"deploy from the web interface"*? | **3** | It is the operator's sentence and it cannot be scored at zero. It is not weighted higher because `00-` §"The three-way split" and `12-` §1 both find that the terminal was a *means* — to an install they could see — and the survey's job is to say when a request's means and its end come apart. |
| 7 | **Quiet** — `docs/agent/` invariant churn, inverted | **2** | Lowest, because it is a cost paid once. It is not zero: every invariant in `docs/agent/` fails silently by construction (`CLAUDE.md`, "Before you edit"), so moving one is a permanent maintenance liability rather than a one-off edit. |

Scores are 0–5, ordinal. **The arithmetic is not precise and the ranking is what
survives it** — a four-point gap between two rows is noise, a thirty-point gap is
a finding. Maximum is 130.

## 2. Four collapses, before anything is scored

**`04-` (C), `16-` (M) and `12-` (J) are one decision taken at three depths, not
three options.** `04-` is a manifest in the database with the reconcile host left
open and identity unaddressed; `16-` is that decision with both answered; `12-`
is `16-` with a streaming transcript in front of it, and says so in its own §2 —
*"the manifest half is `04-` and is not re-argued here."* Scored once, as **C/M**,
at `16-`'s costed depth. `12-`'s transcript is a two-day addition to it
(`12-` §9) and does not change any score enough to move the row.

**`06-` (E) and `13-` (K) are one decision taken in two halves.** `13-` §2 item 3
folds `06-` §2's four documentation items into itself by reference. Both are
"build nothing, write it down". Scored once, as **E/K**.

**`11-` (I) is a component of C/M as much as a rival to it.** `16-` §2 takes
`11-`'s closed verb list and constant argv templates as its installer, and
`18-` takes them too. `11-` scores separately only in the form its own §9
distinguishes — **as a log rather than a manifest**, three to five days, no
reconcile-host question inherited.

**`15-` (L) and `17-` (N) share a module and differ on one decision: report, or
refuse.** `15-` §2 offers the pre-spawn check as an optional half; `17-` makes it
the whole feature and moves it onto the template. They are scored separately
because that one decision is exactly what is being chosen between — and because
`17-` §10 concedes that if its check cannot be made reliable, the correct version
of it *is* `15-`.

So: **twelve scored rows from fifteen files.**

## 3. The ten headings, one line each

`01-constraints.md`'s fixed list, compressed. Headings 1 and 10 are arguments
rather than facts and are not tabulated; they are what the option files are for.

| | 2 Shape | 3 Persists | 4 Reach | 5 Tool state | 6 Boundaries | 7 Surface | 8 Loud? | 9 Cost |
|---|---|---|---|---|---|---|---|---|
| **A** `02-` | a 4th `UF_*` list + volume; no `src/` | all four, via the declaration | unchanged | a `state/` dir beside `bin/` | crosses none | `.env` + restart | **no** — stderr, as today | 2-3 d |
| **B** `03-` | one writable volume on `PATH` | `up --build` only | unchanged | wherever the installer put it | an agent-writable `PATH` entry | nothing to configure | **no** — worst in the set | ½ d |
| **D** `05-` | `Dockerfile.stack` + override | all four, via git | unchanged | operator's own `ENV` | **narrows** — root-owned, agent-unwritable | a file + a rebuild | **yes** — a failing `RUN` fails the build | ½–2 d |
| **E/K** `06-`+`13-` | four doc edits + one `Field` hint | documents what already survives | unchanged | names the gap | crosses none | `.env`, `exec`, an override | **no** — and scores it a loss | 1 d |
| **F** `07-` | `stackTools` → `--allowedTools` | a setting, in the backup | **the only option that touches it** | nothing | widens the CLI grant install-wide | a settings field | partly — validated at save | 1-2 d |
| **G** `09-` | `node-pty` + xterm.js + a transport | installs nothing itself | unchanged | whatever you type | root-in-a-browser, backpressure, keystrokes | a shell in a tab | partly — you watch it | 1-2 wk, **+ a hole** |
| **H** `10-` | `POST` argv, SSE out | installs nothing itself | unchanged | whatever you type | argv from a browser; `/proc/1/cmdline` | a form | partly — an exit code | 2-4 d |
| **I** `11-` | four typed verbs, constant argv | as a log: nothing | unchanged | §5 named, not managed | **the only one that never argues with `CLAUDE.md:134`** | a page of forms | **yes** — refusals by name | 3-5 d |
| **C/M** `04-`+`16-` | `stacks` table, page, boot reconcile | `down -v` destroys it; backup buys it back | derives the allowlist | named on the page, not managed | a 4th non-`claude` child, root-spawned; MCP exclusion | a Settings section + Deploy | **yes** — `last_error` on the row | 1-2 wk |
| **L** `15-` | `toolInventory.ts`, one route, one card | stores nothing; `.env` is the truth | makes `F` maintainable | names the gap | **crosses none** | a read-only card | **yes** — three states, honestly | 2-3 d |
| **N** `17-` | a template column + a refusal | a column, in the backup | makes the gap **unreachable** | nothing — installs nothing | crosses none, **narrows one** | a template field | **yes** — refused before it spawns | 2-3 d |
| **O** `18-` | `.usagefoundry/stack.toml` + approval by hash | **all four, including a fresh host** | suggests the allowlist per repo | worse — `.terraform/` is per-worktree | **widest** — untrusted input from a mount becomes an install | approve per repository | **yes** — an unapproved manifest is a discovery | 1-2 wk |

## 4. The scores

| | Loud ×5 | Reach ×5 | Durable ×4 | Cheap ×4 | Safe ×3 | Asked ×3 | Quiet ×2 | **Total** |
|---|---|---|---|---|---|---|---|---|
| **L** `15-` | 5 | 2 | 5 | 4 | 5 | 1 | 5 | **99** |
| **N** `17-` | 5 | 3 | 4 | 4 | 5 | 0 | 5 | **97** |
| **D** `05-` | 5 | 0 | 5 | 5 | 5 | 0 | 5 | **90** |
| **F** `07-` | 2 | 5 | 4 | 4 | 3 | 0 | 4 | **84** |
| **I** `11-` | 4 | 0 | 3 | 3 | 4 | 3 | 5 | **75** |
| **E/K** `06-`+`13-` | 1 | 0 | 5 | 5 | 5 | 0 | 5 | **70** |
| **O** `18-` | 4 | 2 | 5 | 1 | 1 | 2 | 1 | **65** |
| **A** `02-` | 1 | 0 | 5 | 3 | 4 | 1 | 5 | **62** |
| **C/M** `04-`+`16-` | 4 | 1 | 2 | 1 | 2 | 5 | 2 | **62** |
| **B** `03-` | 0 | 0 | 2 | 5 | 3 | 2 | 4 | **51** |
| **H** `10-` | 3 | 0 | 0 | 2 | 1 | 4 | 2 | **42** |
| **G** `09-` | 3 | 0 | 0 | 0 | 0 | 5 | 0 | **30** |

## 5. What the table says that the option files did not

**The top four are not rivals.** `L`, `N`, `D` and `F` touch four different
things — a read-back, a precondition, a substrate, and a permission grant — and
the highest-scoring combination is not a choice between them but a sum of them.
That is unusual and it is the single most useful output of this table: **the
survey's answer is a small bundle, not a winner.**

**"Asked" is the only column the losers win.** `G` scores 5 there and 0 or 1
everywhere else; `C/M` scores 5 there and is otherwise mid-table. Every option
that answers the operator's sentence literally is expensive, and every option
that is cheap and loud answers it obliquely or not at all. **That correlation is
the finding**, and it is what `21-recommendation.md` has to justify overruling —
because it means the recommendation is going to tell the operator no.

**`D` is the surprise, and it got cheaper during validation.** `05-` argued its
own minimal form required the operator to have tagged a build; that was wrong —
`docker-compose.yml:37` gives the build an `image: usagefoundry:${UF_IMAGE_TAG:-latest}`
tag, so `FROM usagefoundry:latest` resolves after any stock
`docker compose up --build` (`22-validation.md`, correction 20). Documentation
only, all four events, root-owned, loudest failure mode in the directory, and it
scores 90 while costing half a day. **Its zero is entirely in one column.**

**`B` is dominated by `A` and should not be built alone.** Same substrate, one
fewer property, worse on five of seven criteria, better only on cost — and its
own §8 calls it *"the option with the worst failure profile in the directory."*
If a general-purpose volume is wanted, it is `A`'s volume with the loop left
unbuilt, which is a decision to make later rather than a different option.

**`G` at 30 is not close, and the gap is not about security.** It scores zero on
durable, cheap and quiet, and its own §9 says the estimate *"has a hole in it
nobody here can close"* — whether Next's generated standalone server can carry an
HTTP upgrade. **A number with an unbounded tail is not a cost estimate**, and
that alone would keep it out of a recommendation regardless of the other six
columns.

**The one column nobody wins.** Reach — `00-problem.md` §"Missing 3" — has one 5
in the table and it belongs to the option nobody would build for its own sake.
Eleven of twelve rows score 0-3. **The whole directory is a set of ways to
install something that may not be invokable**, and `07-` §10's probe is a single
work cycle.

## 6. Sensitivity: what changes the ranking

| If | Then |
|---|---|
| **Reach turns out not to be broken** (`07-` §10, outcome 3) | `F` drops from 84 to ~40 and leaves the recommendation. Nothing else moves — every other row scores 0-3 there. |
| **"Asked" is weighted 5 instead of 3** | `C/M` rises to 72 and `G` to 40. **The ranking does not change.** `L` and `N` still lead. |
| **"Asked" is weighted 5 *and* "Cheap" 2** | `L` 93, `N` 89, `D` 80, `C/M` 70, `G` 40. Still no change. **There is no reasonable reweighting under which the terminal or the table wins**, which is the strongest statement this table supports. |
| **"Loud" is weighted 2** | `L` 84, `N` 82, `D` 75, `F` 78, `I` 63. `F` closes on `L`. The bundle survives; the ordering inside it shifts. |
| **The operator has four repositories needing four toolchains** | `O` gains on Asked and Durable but its Cheap and Safe scores are what hold it down, and neither moves. It stays mid-table — but it becomes the *only* option expressing that shape (`18-` §10). |
| **The operator has no host access to the container** | `E/K` collapses entirely (`13-` §10) and `G`/`H` become the only doors. This is the one scenario that overturns the whole table and **nobody has asked** (`13-` §10, `14-` §9). |

## 7. What this table cannot score

- **Anything about a real rebuild.** Docker is unavailable in this container, so
  every "Durable" score is reasoned from the compose file's own statements and
  Docker's documented semantics (`01-constraints.md` §11).
- **Reach, for real.** Criterion 2 scores *addressing* the gap, because measuring
  it costs a work cycle nobody has spent.
- **Demand.** `/data` is unreadable here, so there is no figure for how many runs
  would have used a stack tool, how often an operator installs one, or how long a
  boot takes today (`01-constraints.md` §5, `14-` §9).
- **`G`'s true cost.** Its ceiling depends on a question about Next's generated
  server that cannot be answered by reading (`09-` §9, `08-` §9 item 1).
