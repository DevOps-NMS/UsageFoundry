# Comparison

**A note on the numbering.** The Sandboxing proposal put its comparison at `07`
because it surveyed five options. This survey ran to ten, so `07` through `10`
are option files and the four closing files carry on from `11`. Nothing was
renumbered: the option files cross-reference each other by letter and the
survey's own numbering is left exactly as the two runs before this one wrote it.

## Four of the ten differ only in where a person types a string

Say this before the table, because otherwise four rows read as four mechanisms.
Options **B**, **C**, **D** and **I** all end in the same place: a value on
`runs.model` (or, for B's two new keys, at the review and chat spawns), reaching
the CLI as `--model` on an argv `buildArgs` already builds
(`src/lib/orchestrator.ts:4843`). Not one of them computes anything. They differ
only in **which record holds the string**, and therefore in scope, in who can
edit it and in how long it lasts:

| | Record | Scope | Who edits it | Read back where |
|---|---|---|---|---|
| B | `settings` keys | per install, per kind of child | operator, Settings page | nowhere |
| C | `run_templates.model` | per kind of task, every instantiation | operator, template form | nowhere |
| D | `agents.model` | per role, only runs started as one | operator, agents page | the agent's row, which is not the run's |
| I | `CreateRunInput.model` | one run | whoever starts it | nowhere |

Only **D**'s record exists today; only **I**'s wire field exists today and is
sent by nothing. The rest of the survey is different in kind: **A** stores
nothing new, **E**/**F**/**G**/**H** compute a value rather than store one, and
**J** writes a different flag entirely.

## The criteria, and their weights, stated before the scoring

Ten criteria, taken from `01-constraints.md`'s closing list and from the fixed
headings every option file answered. The weights encode a judgement about *this*
app and *this* measurement — a bill that is 83% carried context, a fourteen-fold
spread at a constant model, and a reachable delegated prize of 2.5% of the
window. Disagreeing with the weights is the cleanest way to disagree with
`13-recommendation.md`.

| Criterion | Weight | Why that weight |
|---|---|---|
| Drift — places a person may set a model | 3 | The one objection this app has already written down about a model, in the file a template's column would go in (`src/lib/templates.ts:35`–`42`). |
| Unpriced model | 3 | The only axis where being wrong bills real money, displays $0 and fires a guard early, all at once (`src/lib/pricing.ts:84`, `docs/agent/metering.md:16`, `:18`). |
| The measured precedence | 2 | Already dead on any install with the box filled (`src/lib/agents.ts:99`–`110`). An option can hand it back or kill it for good. |
| Where the decision may be taken | 3 | An `await` between `createRun`'s entry and its INSERT silently puts two agents in one directory (`docs/agent/concurrency-and-ownership.md:10`). Not negotiable. |
| Reaches delegated turns | 1 | Weighted **down** by measurement: `00-problem.md`'s reachable share is $101.57, 2.5% of the window, and every dollar of it is in a bucket `BUILT_IN_AGENTS` refuses. |
| Loudness of failure | 3 | This repository's standing complaint (`CLAUDE.md`). A router that quietly stops routing looks exactly like one that never ran. |
| Operator can predict and audit | 3 | Today they can predict (one string) and cannot audit (`RunDTO.model` renders on no page). An option may improve or destroy either half. |
| Guards untouched | 3 | A gate, not a preference: a model choice must not become a route to a budget, a permission mode or an isolation decision. |
| Measured prize | 2 | What the thing is actually for. |
| Build cost | 2 | Real, one-off. 3 is free. |

Two criteria are deliberately **not** scored. "Which half of the split" is a
position each option takes rather than an axis it wins — it is argued in the
files and revisited below. And "reaches every creation path" is not scored
because it would reward reach for its own sake on a question where the
measurement says reach is worth almost nothing.

## Scores

0 = no change from today, so **Option A is 0 by construction on the nine
behaviour axes** and the table cannot show its two live silent failures. Signed:
negative is worse than today. Build cost alone runs 3 = free.

| | A: do nothing | B: per-kind default | C: on the template | D: on the agent | E: rule-based | F: budget-aware | G: model-decided | H: per-phase | I: run form | J: delegated turn |
|---|---|---|---|---|---|---|---|---|---|---|
| Drift (×3) | 0 | −2 | −1 | 0 | −1 | −1 | −1 | −1 | −1 | 0 |
| Unpriced model (×3) | 0 | 0 | −1 | −1 | −1 | −2 | −2 | −1 | **+1** | −1 |
| Precedence (×2) | 0 | 0 | −1 | **+3** | +1 | −1 | 0 | 0 | +2 | 0 |
| Where taken (×3) | 0 | 0 | 0 | 0 | 0 | −2 | **−3** | −2 | 0 | 0 |
| Delegated turns (×1) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **+2** |
| Loudness (×3) | 0 | −1 | −2 | +1 | −2 | −3 | −2 | −3 | **+2** | −3 |
| Predict and audit (×3) | 0 | −1 | −1 | 0 | −2 | −3 | −3 | −2 | **+3** | −1 |
| Guards untouched (×3) | 0 | 0 | 0 | 0 | 0 | −2 | −1 | 0 | 0 | 0 |
| Measured prize (×2) | 0 | 0 | +1 | 0 | +1 | 0 | +1 | +1 | +1 | +1 |
| Build cost (×2) | **3** | 2 | 1 | 2 | 1 | 0 | −2 | 0 | 2 | 1 |
| **Weighted total** | **+6** | **−8** | **−13** | **+10** | **−12** | **−41** | **−38** | **−25** | **+25** | **−9** |

E is scored as **shipped rules**, the shape `06` argues for; operator-authored
rules take a further −1 on drift and −2 on build cost, for −19. G is scored as
the **free-form classifier**; the constrained form `08` says is the defensible
one moves unpriced to −1 and predict-and-audit to −2, for −32, and is still last
but one. Both alternatives are named here rather than given columns because
neither changes the ordering.

**The `Measured prize` row is the finding, not a tiebreak.** Nothing scores
above +1, and the five options that score +1 do so on an *unmeasured*
plausibility — that the task is the axis, that `origin` separates cheap from
dear, that a classifier reads prose better than a rule, that a run's phases
differ, that the person asking knows. `00-problem.md` measured the axis that
actually explains the money and it is none of these: the spread is fourteen
times at one model. A criterion on which nothing separates is worth carrying in
the table precisely so that it is visible that nothing separates.

## Reading the interesting cells rather than the totals

**Option I is the only positive on unpriced, on loudness and on predict-and-audit
at once**, and all three come from the same property: a person is standing there.
A refused string fails the spawn in front of whoever typed it seconds earlier;
an accepted-but-unpriced one is warned about at the input by `isKnownModel`
(`src/lib/pricing.ts:135`, no call site anywhere today) and then rendered on the
run's own page. Every other option puts distance between the typing and the
consequence, and two of them — F and G — put a machine there instead.

**Option D's +3 on precedence is the largest single cell in the table**, and it
is the only one that *restores* something rather than adding it. `buildArgs`
emits `--model` whenever `run.model` is truthy (`src/lib/orchestrator.ts:4843`)
and an explicit `--model` outranks a selected agent's pin, measured on the pin
(`src/lib/agents.ts:99`–`110`) — so on any install with the Settings box filled
in, `SavedAgent.model` is unreachable while the agents page goes on offering the
field (`src/app/agents/page.tsx:279`–`292`). D is the option that ends that. It
scores 0 on drift because it adds no place: the record, the column, the encoder
and the form are all built.

**Option F's −41 is not a rounding of "complicated".** Three cells carry it.
Silently inert on a stock install: every ceiling in `DEFAULTS` is `null`
(`src/lib/settings.ts:602`–`605`) and `guardFraction` is null exactly when
`fraction` is (`src/lib/windows.ts:351`–`:365`), so with no ceiling configured
and no provider reading the router has no input and looks exactly like one that
decided not to act. Guards at −2: it closes a feedback loop over `costGuardUSD`,
the one figure this app keeps apart from what it displays — route onto an
unpriced model and the window fills *faster* in the number the router reads
while the dashboard the operator is watching shows less. And predict-and-audit
at −3: a run's model depends on what the rest of the fleet spent while it was
working.

**Option G's −3 on "where taken" is a hard failure rather than a cost.** The
classifier is asynchronous, so it cannot run inside `createRun`
(`docs/agent/concurrency-and-ownership.md:10`) and has to run at each of the six
call sites (`grep -rn "createRun({" src/`, outside the tests:
`src/app/api/runs/route.ts:229`, `src/lib/chat.ts:933`,
`src/lib/workflows.ts:3243`, `:4295`, `:4720`, `:5441`). One of those six is
inside workflow instantiation, which is "topological, one synchronous pass, all
or nothing" (`CLAUDE.md`) — so on the workflow path the option is not available
as written, and would have to classify before instantiation begins or not at
all.

**Options H and J score −3 on loudness for opposite reasons and it is the same
sentence twice.** H's cache question — whether switching model on a `--resume`
keeps the conversation's cached context — is unmeasured, and 83% of this
install's bill is exactly that context (62.1% cache reads, 20.9% one-hour cache
writes, `00-problem.md`). If a switch invalidates it, the cheap second pass
re-writes the whole conversation at 2.0× input before doing any work, and
nothing anywhere reports anything unusual. J's is worse still: on the *offered*
path every violation of the `--agents` payload is silent — "no error, no warning
and a zero exit" (`src/lib/agents.ts:360`–`366`) — so a member's `model` that no
longer governs a delegated turn produces an install where the setting page says
one thing, the money says another, and no exit code changes.

**Option A's +6 is entirely build cost**, and the table is at its least useful
here. Doing nothing scores 0 on loudness and 0 on predict-and-audit because it
*is* the baseline, but the baseline has two live silent failures — an
unpriced-but-accepted string that bills real money and displays $0, and a text
box last edited months ago deciding every run since with no page that would show
it — plus one dead field and one wrong sentence beside it
(`src/app/agents/page.tsx:282`, describing the meaning `--agent` removed). Those
are in `02-option-do-nothing.md` and cannot be in the table, because a table
whose zero is "today" cannot score today.

## Which half of the split, side by side

`01-constraints.md`'s first section says an option must answer this and that the
answer is load-bearing. The ten answers are not evenly distributed, and the
distribution is itself informative:

- **Neither half — a third kind of thing.** A, D, H, J. D is the only one that
  can cite rather than argue: `src/lib/agents.ts:45`–`57` enumerates what an
  agent may not hold and the list *is* the "what an agent may do" half, while
  `:110`–`113` places the model outside it as cost.
- **The person-wrote half, on a settings-shaped record.** B, and E when the
  rules are operator-authored. Neither puts the model inside `RunGuards`
  (`src/lib/settings.ts:489`–`:493`), which is the thing that would make it one
  of the three fields a template, a chat proposal and a workflow node all
  resolve from.
- **The "what an agent may do" half, by force.** C alone, and not because a
  model is capability: a template holds only that half, so a column there puts
  the model beside `permissionMode`, `isolate` and `budget` whether the option
  wants it to or not.
- **The "what it is asked to do" half.** I, and it is the reason that half is
  available for a model at all. `src/lib/settings.ts:480`–`488` names the run
  form explicitly as a source of the *guard* half, and the other half comes
  "from whatever asked for the work" — which, for `origin: "form"`, is the same
  person in the same act as the prompt beside it. That is
  `10-option-run-form-override.md:52`–`64`'s argument and it holds; what the
  comment does not do is enumerate the second list, so this reading is an
  inference from the one origin rather than a quotation.
- **Cost rather than capability, argued rather than cited.** F and G. F has the
  strongest claim to a third kind of thing and pays for it: the value is derived
  from a measurement and written by nobody, which makes it the first thing in
  this app besides a guard to change what a run does because of what a window
  says.

"It is a third kind of thing" was available to every option and is spent by the
four that took it. C is the only one that had to give it up, and giving it up is
the price of the column rather than an objection to it.

## Two things every option owes, and what it costs to leave them out

Both come from `01-constraints.md`'s "What the operator must still be able to do
by hand", and neither is routing.

**Read-back.** `RunDTO.model` is on the wire (`src/lib/apiTypes.ts:559`) and
rendered on no page: the run detail page renders the *agent's* model
(`src/app/runs/[id]/page.tsx:1329`–`1333`) and the review card the *review's*
(`src/components/RunReview.tsx:44`). Every option in this survey inherits the
obligation to fix that, and three of them — F, G, H — cannot ship without it,
because a decision the operator did not make is one they can only audit after
the fact. Only I makes it half the deliverable.

**A warning at the point of typing.** `isKnownModel` exists and has no call site
(`grep -rn "isKnownModel" src/` returns its own definition and nothing else). It
must stay a warning: narrowing to a list this build knows would refuse the model
that ships next week (`src/lib/agents.ts:116`–`119`), and the price table
refuses catch-all prefixes on the same principle (`docs/agent/metering.md:20`).
Every option that adds a place to type a model string adds an exposure, and C
and D add the two that repeat unattended — a schedule firing a template, an
agent reused across many runs.

## One option the survey did not have, and why it is not added

A **model on the `runs` row, editable after creation** — "change it and pick it
back up" — is the shape a reader will reach for after Options C and I, and
`01-constraints.md`'s fourth obligation names it. It is not given a file here
because it is not a routing option: it is a change to `startRun`'s frozen read
(`src/lib/orchestrator.ts:6278`) and a second route to the model on a *running*
run, which is the objection `reopenRun` already refuses on its own account
(`docs/agent/agents-and-templates.md:18`; `grep -rn "SET model" src/` returns
nothing). Options F and H each already contain it as a consequence, scored
there, and neither is recommended. If it is ever wanted on its own, it belongs
in a proposal about `reopenRun` rather than in one about who picks the model.
