<h1 align="center">UsageFoundry</h1>

<p align="center">
  <strong>A self-hosted dashboard and headless run orchestrator for Claude Code.</strong><br>
  See where your Pro/Max allowance is going, then spend it deliberately —
  agents that run to a budget and stop.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: source-available" src="https://img.shields.io/badge/license-source--available-blue"></a>
  <img alt="Docker" src="https://img.shields.io/badge/deploy-single%20container-2496ED?logo=docker&logoColor=white">
  <img alt="Next.js 15" src="https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Self-hosted" src="https://img.shields.io/badge/data-stays%20local-brightgreen">
</p>

<!-- SCREENSHOT: a dashboard shot belongs here — it is the single biggest thing
     still missing from this page. Same image as the repo's social preview. -->

---

## What it does

**Track the allowance.** Parses Claude Code's own transcripts (`~/.claude/projects/**/*.jsonl`)
into exact token volumes and costs, and reads your real utilisation percentage
from the same first-party endpoint `claude /usage` calls. 5-hour window, weekly
quota, burn rate, projected exhaustion, and breakdowns by model, project,
sub-agent, skill and reasoning effort.

**Spend it deliberately.** Point a run at a folder, give it a task and a budget,
and it drives `claude -p` headlessly in a loop — re-checking the guard before
every work cycle and stopping when the money, the cycles, the clock or the
window runs out.

**Keep runs out of each other's way.** Each run gets its own git worktree and
branch, so several agents work one repository at once. Review the diff, resolve
conflicts, and merge from the UI when you're ready.

**Chain the work.** Saved workflows are graphs of run blocks — including blocks
that *decide* what to run next, and blocks that land what the ones before them
built. Run one on a schedule, under a budget that covers the whole graph.

Everything runs on your machine, in one Docker container. No account, no
telemetry back to us, no third-party service.

---

## Quick start

```bash
git clone https://github.com/Xapicc/UsageFoundry.git
cd UsageFoundry
cp .env.example .env
# edit .env:  UF_WORKSPACE (required — the code you want agents to work on)
#             UF_AUTH_TOKEN (recommended: openssl rand -hex 32)

docker compose up --build
open http://localhost:3000
```

The dashboard works immediately. **Runs need one extra step** — the `~/.claude`
mount carries your transcripts but not your credentials, so sign the container
in once:

```bash
docker compose exec -it usagefoundry claude   # then: /login
```

That login is what every run bills against, and an agent can read it: a work
cycle runs as the uid that owns the mounted `~/.claude`, which is the only way
it can authenticate at all. The server runs as a *different* uid from the agents
so that the app's own secrets — `UF_AUTH_TOKEN`, `ANTHROPIC_ADMIN_KEY` — are out
of their reach, but your Claude account, every mounted workspace and
`UF_GITHUB_TOKEN` are inside the trust boundary of anything you run unattended.
**[docs/security.md](docs/security.md)** sizes all of it.

Full setup, including Linux `UF_UID`, multiple workspaces and GitHub access, is
in **[docs/install.md](docs/install.md)**.

---

## Read this before you trust a number

Your 5-hour and weekly limits are **shared across every Claude surface**, but
only Claude Code writes local transcripts. Work done in Claude Desktop, the web
app, or Cowork spends the same allowance and is **invisible here** — so every
locally-derived figure is a *floor* on real consumption, and a guard set at 80%
can start a run that overruns the real limit.

Two things soften that. The utilisation *percentage* is read from Anthropic's
own endpoint and therefore covers the whole account, including surfaces this
tool cannot see. And **Settings → Reserved headroom** holds back a slice of
every window for the rest, so guards trip early instead of late.

Where a number is exact, where it is estimated, and where it is a guess with a
name on it: **[docs/limits-and-accuracy.md](docs/limits-and-accuracy.md)**.

---

## Specialists

A **specialist** is a saved agent: a name, a description, a prompt, and
optionally a model. Attaching one to a run offers it to that run's Claude, which
may hand a subtask to it — a diff to review, a migration to write out, a search
to run — and gets back the specialist's answer. The delegated turn happens
*inside* the run: same process, same working directory, same permission mode,
same limits, same cost.

The description is what the model reads when it decides whether this is the agent
for a subtask, so an agent without a good one never gets chosen. The prompt is
what makes it different from the Claude that would have done the work anyway.

**Naming a specialist changes who does part of the work. It never changes what
the run may do.** That is the line the whole feature is built on, and it is
enforced by absence: a saved agent has no tool list, no permission mode, no
budget, no folder and no isolation choice — there are no columns for them, so
there is nothing on the wire that could carry one. Everywhere this app shows a
specialist it is stated *beside* the guards and never among them, because a row
inside that group would be claiming to bound something it does not.

The one thing an agent holds that a template deliberately does not is a
**model**. It is not the same field: a template's would be a second place to set
the *run's* model, where this is the model one delegated turn runs on, which is
the whole reason to keep a cheap specialist for the mechanical half of a job. It
moves cost, not capability, and every cost guard already covers it — a delegated
turn's spend arrives on the run's own `result` event like any other.

### Defining one

**There is no page for this yet.** The registry is read by four surfaces and
written by none of them, so every picker below is empty until you create a row
by hand:

```bash
curl -sX POST localhost:3000/api/agents \
  -H 'content-type: application/json' \
  -d '{
    "name": "reviewer",
    "description": "Reviews a diff for correctness bugs. Use before landing.",
    "prompt": "You review changes. Report what is wrong and nothing else.",
    "model": "claude-sonnet-5"
  }'
```

`GET` lists them, `PUT /api/agents/<id>` replaces one, `DELETE` removes one. With
`UF_AUTH_TOKEN` set, send it as a bearer token like any other route.

Three things are refused when you save because Claude Code accepts them
**silently** and then behaves as though you had named no agent at all — exit 0,
nothing on stderr, nothing in the run log, and a run that is bit-for-bit one that
was never given a specialist:

- **No description**, or **no prompt**. Either one and the member is dropped.
- **No name**, which registers as an empty entry rather than as an error.
- **A name Claude Code already answers to** — `claude`, `Explore`,
  `general-purpose`, `Plan`, `statusline-setup`. Such a member either does
  nothing while you believe it is in play, or replaces a built-in the main thread
  delegates to, and nothing says which.

A fourth is this tool's own decision rather than the CLI's: **a `tools` list**.
`--agents` members accept one and this refuses to store one, because what an
agent may do comes from the guard set on the run it is delegated inside.
Accepting it would put a capability inside a record that a chat proposal or a
workflow block can name, which is exactly the line above. It is refused by name
rather than dropped, so nobody ends up believing their specialist is narrowed
when it is not.

`model` is free-form — an alias (`sonnet`), a full id, or omitted to inherit the
run's. Blank means inherit; it is never sent as a JSON `null`, which is a fifth
thing the CLI drops without a word.

### Where one can be chosen

| Surface | What it names | When it is resolved |
|---|---|---|
| New-run form → *Specialist* | the run's own | at *Start run* |
| Settings → *Default specialist* | what the run form starts on | pre-filled, and you can change or clear it |
| A template | what the run form starts on when you load it | at load |
| Workflow block (a run block, or a deciding block's own turn) | that block's child | at each press of *Run* |
| A deciding block's emitted runs | one per run, by name, chosen by the block | as each run is created |
| Orchestrator chat | the proposed run's | at *Approve* |

In the chat, type `@` in the composer to insert a name — Tab inserts, Enter still
sends. The mention is ordinary text; what makes it work is that the chat can read
the registry and proposes the run under the agent you named. The proposal card
says which specialist it will run under, outside the guard line. The chat's *own*
turn is never given one: what a specialist would change there is how the
orchestrator thinks, which is the one thing its prompt fixes on purpose.

A **merge block** is the one place naming a specialist is refused rather than
ignored: it starts no agent, so there would be nothing to hand a subtask to.

**A specialist that has been deleted, or that has decayed into something Claude
Code would drop, is refused by name at every one of those doors — never quietly
replaced with none.** You started the run that said "and hand the review to the
reviewer"; a run that silently has no specialist is indistinguishable afterwards
from a run that was never given one, and that is the failure the whole registry
exists to prevent. The single exception is the Settings default: if the agent it
names is deleted later, the new-run form starts with no specialist and *says so*,
because the alternative is a page nobody can start a run from until they visit
Settings.

A run keeps a **copy** of the definition it was given, so editing or deleting the
agent afterwards cannot reach a run already in flight, and picking that run back
up months later still gives it the specialist it ran with. Everything that is
form input — a template, a workflow block, a chat proposal, the Settings
default — keeps a **reference**, so fixing your reviewer's prompt reaches the
next run started from it.

### The agents you already have

Your own `~/.claude/agents/` is mounted into the container, so anything defined
there already reaches every run, chat turn, deciding block and review this app
spawns — and always has, since before this feature existed. An isolated run's
checkout carries the repository's own `.claude/agents/` for the same reason.
Naming a saved agent **merges** with that set rather than replacing it.

They are deliberately left in play. The only way to exclude them on this CLI is
`--setting-sources` with an empty value, and that flag governs settings *whole* —
it would take your `settings.json`, your hooks, your permissions and your
environment out of every run along with the agents, which is a much bigger change
than the one being made and one nothing would report. So instead the app
*declares* them: every picker says what else is in play beside it ("Your own
~/.claude also carries 5 agents (reviewer, tidier, docs and 2 more), in play
whatever you pick here"), and the chat's `list_agents` reports them as a group
that cannot be named.

One consequence worth knowing: if you save an agent under a name a file on disk
also uses, which definition Claude Code actually runs is **not established
here**. The app will not pick a winner; it marks the row *name clash* wherever
that name shows up in a cost table, because you are the only one who can resolve
it.

### What it costs, and where that shows up

A delegated turn is billed to the run that delegated it, and every guard already
covers it: the run's spend limit, its cycle cap, the window guards, the workflow
budget. There is no separate ceiling for a specialist and no way for one to
extend a run. Three places make the work visible.

**The run log.** A sub-agent's output is forwarded into the run's stream and set
apart — indented behind a rule, under the specialist's name — so it can be read
as somebody else answering a question the main thread asked. Without it a
delegation is a `Task` call followed by silence for as long as the sub-agent
takes. A sub-agent's words are never the run's own report and can never end the
run: the `DONE` test runs against the main thread only. Turn it off in
Settings → *Sub-agent output in the run log* if you would rather have the shorter
log.

**The run page's *Agent work* card.** What this run's turns cost, split by who
produced them, priced from your own transcripts for that run's session — so every
turn lands in a row and the rows add up. It is a *third* reading beside what the
CLI reported and what telemetry reported, never added to either: all three
measure the same work by different routes, so summing any pair double-counts it.
A run with no session yet reads as the hatched indeterminate meter, not as 0%.

**The dashboard's by-agent breakdown**, which says where each name's definition
lives: *saved* for one in this registry, *on disk* for one only your `~/.claude`
has, *name clash* for both. Unmarked is the ordinary case — a Claude Code
built-in, a repository's own `.claude/agents`, or an agent since deleted — and
the card says so in a footnote. The bucket a turn lands in is whatever Claude
Code recorded on it; the mark is a fact about your registry, so renaming a saved
agent moves no money between rows.

### What has not been checked

The three flags this rests on (`--agents`, `--agent`, `--forward-subagent-text`)
were read off the pinned CLI's own help, and every refusal above is unit tested
at each door that can name a specialist — but **no `claude` child has ever been
spawned with `--agents` from this app or by hand**, and no browser has rendered
the run form's *Specialist* row, the Settings default, the canvas inspector, the
chat's `@` popover, the *Agent work* card or the dashboard's marks. Everything
here follows from that one gap:

- **The five silent drops the whole module is shaped around** — no `description`,
  no `prompt`, a `model` of JSON `null`, an empty name, and a `--agents` value
  that is not JSON — were measured by the run that built the feature and have not
  been re-measured. If one of them is wrong the refusal is stricter than it needs
  to be, which is the safe direction and still a form saying no for a reason that
  has stopped being true.
- **That `--agents` merges with `~/.claude/agents/` rather than replacing it.**
  Same provenance. If it replaces instead, naming a specialist silently withdraws
  every ambient agent from that run — the opposite of what every picker says.
- **That a delegated turn is bound by the run's own guards.** Reasoned from the
  delegation happening inside the same process, not measured. The deny list is
  the one to check first: deny is verified to beat `--permission-mode` for the
  main thread and has never been watched applying to a sub-agent's turn.
- **A forwarded sub-agent line off a real stream.** No `parent_tool_use_id` has
  been parsed from a live CLI. Two things to watch on the first real delegation:
  that the forwarded text is set apart under the specialist's name rather than
  folded into the run's own report, and that a sub-agent writing `DONE` on a line
  of its own does not end the run.
- **`/api/agents` against a running server.** No request has created, edited or
  deleted a row over HTTP — which matters more than usual here, because those
  routes are the only way to define a specialist at all.

The [verification log](docs/verification.md) does not cover specialists yet; read
the list above as its honest boundary until it does.

---

## Documentation

| | |
|---|---|
| **[Installation and setup](docs/install.md)** | Docker, signing in, environment, multiple workspaces, GitHub access |
| **[Limits and accuracy](docs/limits-and-accuracy.md)** | What the two views measure, what they cannot see, and how exact each figure is |
| **[Runs](docs/runs.md)** | The run loop, budget policy, pausing and resuming, two runs on one project |
| **[Workflows](docs/workflows.md)** | Graphs of blocks, orchestrator and merge blocks, whole-graph budgets, schedules |
| **[The orchestrator chat](docs/orchestrator-chat.md)** | A conversation that proposes work; nothing starts without approval |
| **[Reviewing and landing](docs/review-and-land.md)** | Diffs, AI review, conflict resolution, the merge queue |
| **[Architecture](docs/architecture.md)** | Module map and how transcripts are parsed |
| **[Security](docs/security.md)** | Which uid runs the server and which runs the agents, what the container holds, and what an agent can still reach |
| **[Verification log](docs/verification.md)** | What has been checked by hand — **and what has not** |

That last one is not boilerplate. It carries an explicit *"Not yet verified"*
list, which is the honest boundary of what this has been exercised against.
Read it before running anything unattended.

---

## How it fits together

```
Claude Code transcripts ──► parse + dedupe ──► cost & token rollups ──┐
                                                                      ├──► Dashboard
Anthropic /api/oauth/usage ──► first-party utilisation % ─────────────┘
                                          │
                                          ▼
                                   budget guard ──► run loop ──► claude -p
                                                        │         (own worktree,
                                                        │          own branch)
                                                        ▼
                                              review · resolve · merge
```

Three cost sources, **never summed**: transcript-derived costs (the dashboard),
the Admin API (a separate Console-account page), and Claude Code's own OTLP
export (per-request cost for runs this app spawned). Each is shown as itself.

---

## Requirements

- Docker and Docker Compose
- A Claude Code subscription (Pro or Max) — the dashboard is about *subscription*
  windows
- Optionally an `sk-ant-admin01-…` Admin key for the separate Console-account page
- Optionally a GitHub token, if you want runs to open pull requests

---

## Contributing

Issues and discussion are welcome. Before opening a PR, read
[`CLAUDE.md`](CLAUDE.md) — it records *why* the load-bearing decisions were made,
and most of them encode a failure that was measured rather than a preference.

---

## License

Source-available, not open source — see [LICENSE](LICENSE).

You may use, self-host, modify and study it for your own personal,
non-commercial purposes. **Distributing it, and using it commercially or inside
an organisation, both need written permission** — ask, and it may well be given.

Releases before this change were MIT, and this does not withdraw rights anyone
already has in a copy they received under those terms.
