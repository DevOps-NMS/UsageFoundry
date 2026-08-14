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
quota, burn rate, projected exhaustion, and breakdowns by model, project, agent,
skill and reasoning effort.

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

## Agents

An **agent** is a saved role a run takes: a name, a description, a prompt, and
optionally a model. Start a run as one and the saved prompt *is* the run's own
system prompt — same process, same working directory, same permission mode, same
limits, same cost, but doing the work as your reviewer or your tidier rather
than as Claude Code's ordinary self.

It reaches the CLI as two flags that travel together: `--agents` defines the
agent and `--agent` selects it. Both are needed, because a name is only
selectable once something has defined it — `--agent` resolves against Claude
Code's own built-ins, whatever is in your `~/.claude/agents/`, and whatever the
same command line defined. Send only the name and the run fails at the spawn.

The description is what *you* read on the picker when you choose. The prompt is
what makes the run different from the one that would have happened anyway.

**Starting a run as an agent changes who the run is. It never changes what the
run may do.** That is the line the whole feature is built on, and it is enforced
by absence: a saved agent has no tool list, no permission mode, no budget, no
folder and no isolation choice — there are no columns for them, so there is
nothing on the wire that could carry one. The permission mode, the isolation
grant of `git add`/`git commit`, the `pkill` deny list and the self-hosting
notice that explains it are all decided elsewhere and are untouched by the flag;
the unit tests assert each of them again with an agent selected. So everywhere
this app names an agent it is stated *beside* the guards and never among them.
Being the run rather than a helper inside it makes that a larger fact than it
was — it does not make it the kind of fact a guard row is.

The one thing an agent holds that a template deliberately does not is a
**model**, and it is the one field whose meaning changed when the flag did. It
used to be the model a delegated sub-turn ran on; selected, it is the session's.
What stops that being a second place to set the run's model is that an explicit
`--model` outranks it, so it fills a gap you left rather than overruling a choice
you made. It moves cost, not capability, and every cost guard already covers it.

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

Three things are refused when you save, because Claude Code will not register
such an agent at all — which means `--agent` cannot select it, so a run started
as one dies at the spawn on every work cycle, with the reason nowhere but the
CLI's own stderr:

- **No description**, or **no prompt**. Either one and the member is not
  registered. Measured: `claude --agents '{"uf-nodesc":{"prompt":"p"}}' --agent
  uf-nodesc -p hi` answers `--agent 'uf-nodesc' not found` and exits 1, before
  any API call.
- **No name**, which registers as an empty entry rather than as an error. That
  one was measured while the flag was still `--agents` alone and has not been
  re-checked since; what it would select is the empty string.
- **A name Claude Code already answers to** — `claude`, `Explore`,
  `general-purpose`, `Plan`, `statusline-setup`. Such a member shows up **once**
  in the CLI's own list of available agents, not twice, so `--agent Explore`
  selects *an* Explore and nothing says whether it is yours or the built-in.
  That is the difference between a run being the agent you wrote and a run being
  something else entirely, under a name you chose.

A fourth is this tool's own decision rather than the CLI's: **a `tools` list**.
`--agents` members accept one and this refuses to store one, because what a run
may do comes from a guard set you wrote and not from a role you picked. The
singular flag makes that firmer, not looser: a tool list on a helper inside a run
would at least still sit under that run's own mode and lists, where a tool list
on the definition the run *is* would be a statement about the whole session —
inside a record a chat proposal or a workflow block can name. It is refused by
name rather than dropped, so nobody ends up believing their agent is narrowed
when it is not.

`model` is free-form — an alias (`sonnet`), a full id, or omitted to inherit
whatever the run has. Blank means inherit; it is never sent as a JSON `null`,
which is a fifth thing the CLI will not register, measured the same way as the
first two.

### Where one can be chosen

| Surface | What it names | When it is resolved |
|---|---|---|
| New-run form → *Agent* | what the run is started as | at *Start run* |
| Settings → *Default agent* | what the run form starts on | pre-filled, and you can change or clear it |
| A template | what the run form starts on when you load it | at load |
| Workflow block (a run block's run, or a deciding block's own turn) | what that block's child is started as | at each press of *Run* |
| A deciding block's emitted runs | one per run, by name, chosen by the block | as each run is created |
| Orchestrator chat | what the proposed run is started as | at *Approve* |

In the chat, type `@` in the composer to insert a name — Tab inserts, Enter still
sends. The mention is ordinary text; what makes it work is that the chat can read
the registry and proposes the run under the agent you named. The proposal card
says which agent the run will be started as, outside the guard line. The chat's
*own* turn is never started as one, and that is deliberate rather than an
omission: it is the one child here bounded by nothing but its own prompt, so
making some saved prompt its role is exactly the thing that prompt prevents.

A **merge block** is the one place naming an agent is refused rather than
ignored: it starts no child at all, so there is nothing for the agent to be.

**An agent that has been deleted, or that has decayed into something Claude Code
will not register, is refused by name at every one of those doors — never quietly
replaced with none.** You started the run that said "as the reviewer"; a run that
silently is not the reviewer is indistinguishable afterwards from a run that was
never given one, and that is the failure the whole registry exists to prevent.
The single exception is the Settings default: if the agent it names is deleted
later, the new-run form starts as no agent and *says so*, because the alternative
is a page nobody can start a run from until they visit Settings.

A run keeps a **copy** of the definition it was started with, so editing or
deleting the agent afterwards cannot reach a run already in flight, and picking
that run back up months later still starts it as what it was. That matters more
than it looks: a run spawns a child per work cycle, so an id here would leave the
cycle after a deletion selecting a name nothing defines. Everything that is form
input — a template, a workflow block, a chat proposal, the Settings default —
keeps a **reference**, so fixing your reviewer's prompt reaches the next run
started from it.

### The agents you already have

Your own `~/.claude/agents/` is mounted into the container, so anything defined
there already reaches every run, chat turn, deciding block and review this app
spawns — and always has, since before this feature existed. An isolated run's
checkout carries the repository's own `.claude/agents/` for the same reason.
Naming a saved agent **merges** with that set rather than replacing it, and
`--agent` resolves its name against the merged set — the CLI's own refusal line
lists the built-ins, whatever it found on disk and the agent this app defined,
all together. So starting a run *as* your reviewer withdraws nothing.

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

There is a second one, and this app does not yet say it anywhere: your
`settings.json` can name a session agent too. `claude --help` describes `--agent`
as overriding "the 'agent' setting", and on the pin that setting is real — an
`agent` key in `~/.claude/settings.json` starts the session as that agent, with
no flag involved. Because the same `~/.claude` is mounted, it reaches every child
this app spawns. Measured on 2.1.226, with a probe agent whose whole prompt was
"reply with exactly BANANA":

| | |
|---|---|
| `agent` key set, no flag | `BANANA` — the setting selects the session's agent |
| key absent | an ordinary greeting |
| key set, `--agent other` | the other one — the flag wins, as the help says |
| key set, `--agents` only | `BANANA` — the plural flag does **not** override it |
| key naming an agent that does not exist | an ordinary greeting, exit 0 — silently ignored, where the same name on `--agent` exits 1 before any API call |

What that means here: a run, block or chat turn this app starts **as** an agent
is unaffected, because it passes `--agent` and the flag wins. Anything this app
starts as *nobody* — an agentless run, every chat turn, a review — is started as
whatever that key names, and no page in this app knows. It is not declared, and
the reason is under [Not yet verified](docs/verification.md): saying it would be
a new read, a new field on `/api/agents`, a second argument threaded through the
one sentence four pickers share — and the sentence would be false on the picker
that carries it, since choosing an agent there is exactly what overrides the key.
If you use it, know that clearing an agent picker in this app does not mean the
run has none.

### What it costs, and where that shows up

Being an agent costs a run nothing extra and buys it nothing extra. The run's
own spend limit, cycle cap, window guards and workflow budget are the same
numbers they would have been; there is no separate ceiling for an agent and no
way for one to extend a run. The only thing it can move is the model, and only
where you left the run's own blank.

The three places below are about turns a run **delegates** — which is a
different thing from the agent the run *is*, and still happens: your
`~/.claude/agents/` reaches every run whatever you started it as. None of this
machinery reads which agent the session is.

**The run log.** A sub-agent's output is forwarded into the run's stream and set
apart — indented behind a rule, under the sub-agent's name — so it can be read
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
Whether a run started as an agent files its own turns under that agent's name or
under *(main thread)* is Claude Code's bookkeeping and has not been checked; this
app never guesses a name, so the card will say whichever the transcript says.

**The dashboard's by-agent breakdown**, which says where each name's definition
lives: *saved* for one in this registry, *on disk* for one only your `~/.claude`
has, *name clash* for both. Unmarked is the ordinary case — a Claude Code
built-in, a repository's own `.claude/agents`, or an agent since deleted — and
the card says so in a footnote. The bucket a turn lands in is whatever Claude
Code recorded on it; the mark is a fact about your registry, so renaming a saved
agent moves no money between rows.

### What has been measured

Seven probes against the pinned CLI (`@anthropic-ai/claude-code@2.1.226`), run
by hand, each one deciding a design question that would otherwise have been a
guess. The first four refuse before any API call, which is how the built-in list
was derived in the first place.

**That `--agent` can select a definition supplied on the same command line.** The
whole shape of this feature turned on it: if it could not, wiring it would have
meant writing agent files into your mounted `~/.claude` or into a checkout.

```bash
claude --agents '{"uf-probe-agent":{"description":"…","prompt":"…"}}' \
       --agent uf-probe-typo -p hi
# --agent 'uf-probe-typo' not found. Available agents: claude, Explore,
# general-purpose, Plan, statusline-setup, typescript, uf-probe-agent
```

That line also settles the ambient question from the other side: `typescript` is
not a built-in, it is a definition on that machine's disk, so the set `--agent`
resolves against is the built-ins *and* what is on disk *and* what this argv
defined, merged.

**That an unregistrable member fails the spawn rather than being dropped.** Same
command with a member missing its `description`, named on `--agent`, answered
`--agent 'uf-nodesc' not found` and **exited 1** — identically for a missing
`prompt` and for a `model` of JSON `null`. This is the one place the move to the
singular flag made the failure *better*: each of those used to cost a run the
agent it was given at exit 0, with nothing anywhere saying so.

**That a member named after a built-in still shows once, not twice.**
`--agents '{"Explore":{…}}'` listed one `Explore`, so `--agent Explore` would
select *an* Explore with nothing saying which. Refused at the door for that.

**That `--append-system-prompt` still reaches a `--agent` session.** An agent
whose prompt told it to answer with a secret word stated only in the appended
text answered `BANANA ZEBRA`. That flag carries the self-hosting notice — the
`pkill` deny list's explanation *and the safe recipe that replaces it* — so had
the agent's own prompt swallowed it, a run started as an agent would have been a
run never told why a name-matched kill is denied or what to do instead.

**That `--agent` survives `--resume`.** The same probe resumed answered
`BANANA ZEBRA` again with a success subtype. An agent that reached only the first
cycle would be a run that silently stopped being what it was started as.

**That the run's own `--model` outranks the agent's**, read off the `system`/`init`
event before any request: the definition alone reported `claude-opus-5[1m]`,
`--agent uf-m` reported `claude-sonnet-5`, and `--model opus … --agent uf-m`
reported `claude-opus-5`. This is what keeps an agent's model from being a second
place to set the run's.

**That a name with a space in it registers and resolves** —
`--agents '{"uf spaced":{…}}' --agent "uf spaced"` — which is only true because
nothing here goes through a shell.

### What has not been checked

**No `claude` child has ever been spawned with either flag from this app**, and
no browser has rendered the run form's *Agent* row, the Settings default, the
canvas inspector, the chat's `@` popover, the *Agent work* card or the
dashboard's marks. The probes above were run by hand, outside this app.

- **The two remaining drops**, both measured under `--agents` alone and not
  re-checked since the singular flag: an empty name registering as an empty
  entry, and a `--agents` value that is not JSON being ignored outright. If
  either is wrong the refusal is stricter than it needs to be, which is the safe
  direction and still a form saying no for a reason that has stopped being true.
- **Whether a `--agent` session records its own name on the turns it produces.**
  The *Agent work* card and the dashboard's by-agent column both read whatever
  Claude Code wrote to the transcript, and nothing here infers a bucket — so this
  changes what those cards say and no code branches on it.
- **Whether a `--agent` session delegates at all.** If it does, the forwarding
  and the by-agent split cover it exactly as before; if it does not, that
  machinery goes quiet rather than wrong.
- **That a delegated turn is bound by the run's own guards.** Reasoned from the
  delegation happening inside the same process, not measured. The deny list is
  the one to check first: deny is verified to beat `--permission-mode` for the
  main thread and has never been watched applying to a sub-agent's turn — which
  is also why a `tools` list is refused rather than stored and narrowed.
- **A forwarded sub-agent line off a real stream.** No `parent_tool_use_id` has
  been parsed from a live CLI. Two things to watch on the first real delegation:
  that the forwarded text is set apart under the sub-agent's name rather than
  folded into the run's own report, and that a sub-agent writing `DONE` on a line
  of its own does not end the run.
- **`/api/agents` against a running server.** No request has created, edited or
  deleted a row over HTTP — which matters more than usual here, because those
  routes are the only way to define an agent at all.

The [verification log](docs/verification.md) carries the same split.

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
| **[Security](docs/security.md)** | What the container holds, and what is scoped away from whom |
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

## Continuous integration

Two workflows, both under [`.github/workflows/`](.github/workflows).

**[`ci.yml`](.github/workflows/ci.yml)** runs on every push and every pull
request, on **linux/amd64 and linux/arm64 in parallel**, and fails on a
non-zero exit from any of `NODE_ENV=development npm ci --include=dev`,
`npm run typecheck`, `npm test` and `npm run build`. Both architectures rather
than one, because the project nominates no deployment platform: the
`Dockerfile` branches on `dpkg --print-architecture` and `better-sqlite3`
either finds a prebuild or compiles from source, so which of the two you are on
is a real difference and it is the operator's host that decides it. A separate
job runs `npm audit`, prints every advisory unconditionally, and gates on
`critical` — the three current high-severity advisories are inside `next`'s own
subtree, are fixed only by a `next@16` major, and the reasoning for accepting
them is written out in full beside the step rather than left implied.

**[`docker.yml`](.github/workflows/docker.yml)** runs `docker compose build` on
both architectures, weekly and on any change to `Dockerfile`,
`docker-compose.yml`, `.dockerignore`, `package.json` or `package-lock.json` —
not on every push, because `ci.yml`'s `npm run build` is the same command the
builder stage runs, so a source change that would break the image already fails
there. What this covers is what that command cannot see: the apt layers, the
`gh` release fetch and its checksum, the pinned Claude CLI, and the build
context.

### What it does not cover

CI **never starts the container and never exercises a run.** It does not sign
in, does not touch a transcript, does not spawn `claude`, and does not merge
anything. Nothing here can tell you that a guard fires, that a window boundary
lands where it should, or that an isolated run commits to its own branch — the
[verification log](docs/verification.md), and in particular its *"Not yet
verified"* list, stays the record for everything a human checked by hand. A
green tick means the tree typechecks, the unit tests pass and both artefacts
build. It means nothing beyond that.

There is no lint step, because there is no linter: `eslint.ignoreDuringBuilds`
is on and no config exists to run.

> **A build failure that is not a build failure.** If `npm run build` fails for
> you with `[TypeError: generate is not a function]` while CI is green, the
> shell is the difference and not the tree. `.next/standalone/server.js` line 14
> does `process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)`,
> so every child process of a *running* standalone server inherits it —
> including an agent this app spawns, which is where five separate audits hit
> this and concluded the build was broken. Next's `loadConfig` then early-returns
> `JSON.parse` of that string instead of merging defaults; JSON cannot carry a
> function, `generateBuildId` is the only function-valued default, and
> `getBuildId` calls it unconditionally.
> `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` is the check, and it
> exits 0 on this tree.

---

## Contributing

Issues and discussion are welcome. Before opening a PR, read
[`CLAUDE.md`](CLAUDE.md) — it records *why* the load-bearing decisions were made,
and most of them encode a failure that was measured rather than a preference.

CI runs the same four commands you should run locally, and nothing more — see
[Continuous integration](#continuous-integration) above for what that leaves to
a human.

---

## License

Source-available, not open source — see [LICENSE](LICENSE).

You may use, self-host, modify and study it for your own personal,
non-commercial purposes. **Distributing it, and using it commercially or inside
an organisation, both need written permission** — ask, and it may well be given.

Releases before this change were MIT, and this does not withdraw rights anyone
already has in a copy they received under those terms.
