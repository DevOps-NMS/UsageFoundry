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
