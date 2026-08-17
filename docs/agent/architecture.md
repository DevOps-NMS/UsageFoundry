# Architecture

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/ generally — the three data sources, the module map, how events flow.**

## Architecture

**Three** data sources now, still **never summed or mixed in the UI**. The third is Claude Code's own OTLP export (`otlp.ts` → `otlp_requests`), gated on `settings.telemetryForRuns` with one exception below, covering only runs this app spawns. It is first-party per-request cost — no price table, no dedupe key, no file polling — and it is the only way to account for a work cycle killed before the CLI's `result` event. It renders as its own card on the run page and its own card on the dashboard, and must never reach `buildSnapshot()` or `runs.spent_usd`. It reaches a budget decision through exactly one door — `telemetrySpendSince` → a `*Guard*` figure — and that door is narrow on purpose: one run, one cycle, the guard half of a split whose display half stays transcript- and `result`-derived. Two callers go through it and no more: a live run's own spending limit via `RunProgress.spentGuardUSD`, described under the enforcement modes below, and a workflow instance's own budget via `instanceSpend` → `InstanceProgress.spentGuardUSD`, which reads each `running` member's current cycle bounded by `runs.active_started_at`. Same bound, same destination, and neither ever reaches `runs.spent_usd`. It cannot replace transcripts: no backfill, no `cwd`, and `cache_creation_tokens` collapses the 5m/1h split. Wire details were captured from a live CLI, not read from the docs — the docs' `claude_code.api_request` is the record *body*, while `event.name` is the bare `api_request`, and `OTEL_RESOURCE_ATTRIBUTES` lands on both the resource and each record. The payload carries `user.email` and account UUIDs; the parser drops them and the schema has no column for them. `request_id` is the primary key because OTLP delivery is at-least-once, and the ingest route always answers 200 — a batch exporter retries failures, so rejecting a malformed record would cost that batch on a loop.

The two original sources:

| | Subscription view | API-account view |
|---|---|---|
| Source | `~/.claude/projects/**/*.jsonl` | Anthropic Admin API |
| Code | `transcripts.ts` → `windows.ts` | `adminApi.ts` |
| Route | `/api/usage`, `/api/calibrate` | `/api/account` |
| Nature | exact volumes, **estimated** percentages | authoritative |

The subscription pipeline:

```
transcripts.ts  scan + dedupe → UsageEntry[]      (incremental byte-offset reads)
pricing.ts      per-model rates, cache multipliers → costUSD per entry
settings.ts     limitConfig() applies reserved headroom → LimitConfig
planUsage.ts    GET /api/oauth/usage → the account's own utilisation, cached
windows.ts      buildSnapshot() → 5-hour blocks, weekly rollup, burn, projection
                buildPeriods()  → calendar day/week/month history, display only
budget.ts       evaluateBudget(policy, snapshot, progress) → allow / block + code
                evaluateInstanceBudget(...) → the same verdict for a whole
                press of Run on a workflow, sharing readWindowGuard with it
orchestrator.ts the run loop: guard → spawn claude → parse stream-json → repeat
git.ts          the one way this app runs git — argv only, env scrubbed
diff.ts         <base>...<branch> as a rendered, budgeted file list + patches
review.ts       one-shot Claude calls outside the loop: review, conflict resolve
land.ts         merge preview, AI conflict resolution, landing, deletion, inventory
templates.ts    saved run configurations — form input, never a run
agents.ts       saved agents — form input, never a run: the role a run itself
                takes, carried onto a spawn by sessionAgentArgs as an --agents
                definition *and* an --agent selection, built on the one encoder
                every spawn site that can carry one uses. It holds no tool list
                and no permission mode, and it also reads the ambient
                definitions this app did not write, so a surface can say the
                registry is not the whole set. A run, a
                template, a chat proposal, a workflow block and the new-run
                form's own default may each name one: the run by a frozen copy
                on runs.agent, everything that is form input by id, and every
                door refuses a deleted one by name rather than falling back to
                none — the id-keyed doors through one shared agentRefusal, and
                the two that were shown a name (planEmission, createEmitted) in
                their own words, because a name is what those were shown
workflows.ts    saved graphs of run blocks — form input, never a run; one press
                of Run becomes one createRun per block, wired in topological order,
                one press of Stop halts every member through stopInstance, and a
                workflow-wide budget halts it through the same door between blocks.
                A block may instead be an *orchestrator* block: one headless turn
                that decides what to create next, whose runs then start with no
                approval — planEmission bounds what it may ask for, and
                planInstanceStep decides what happens to the blocks behind it.
                A block may also be a *merge* block: no agent at all, it puts
                each predecessor's branch onto the target that branch's own run
                recorded, through mergeQueue.enqueue, with an optional
                per-graph authorisation to pay for a conflict resolution
schedules.ts    when a saved workflow presses its own Run — the recurrence, the
                one timer, and decideSchedule: fire, skip, missed or nothing
canvasGraph.ts  the workflow canvas's own model — client-safe and pure: where
                a block sits, which is not in the graph, and the draft the
                validate and save routes are sent
chat.ts         the orchestrator chat: a conversation that proposes runs —
                ordered against each other, and whole workflows, none of which
                starts anything until a person approves it
repoSpend.ts    what each repository cost, over a span — a rollup of
                runs.spent_usd keyed by conflictKey's own mount identity.
                Reporting and never a guard: it reaches no meter, no snapshot
                and no verdict
fleet.ts        the three controls that act on the whole install — stop
                everything, hold new work, pick several runs back up. It owns no
                transition of its own: it composes stopInstance, stopRun,
                blockWaitingRun and reopenRun, and the hold is one settings row
                four creation sites read
workspace.ts    the folder walk, shared by /api/folders and the chat's tools
cycles.ts       the event stream segmented into work cycles — client-safe, and
                the only reader of where one cycle's output ends
ops.ts          what the two background timers last did, and how often they
                failed — in memory, because it answers "is *this* process
                making progress" and a counter that outlived it would not
requestLog.ts   one durable line per mutating request: method, path, status,
                the id it named, which credential class, from where — and
                deliberately no body, no query string and no credential
health.ts       what /api/health answers with, and the one thing it is for:
                being false when this server cannot do its job
status.ts       what /api/status answers with — gauges for a monitor rather
                than a person, behind a read-only credential of its own
db.ts           SQLite: runs, run_deps, run_events, run_reviews, run_templates, agents,
                settings, chat_sessions, chat_messages, chat_proposals,
                workflows, workflow_instances, workflow_instance_runs,
                workflow_instance_blocks, workflow_schedules, ops_events,
                request_log
```

**Four kinds of agent child process, from four modules, and no more — and two numbers bound how many of them exist at once.** (A fifth kind of child exists and starts no agent: `claudeAuth.ts`'s, argued out further down this paragraph.) `settings.maxConcurrentRuns` bounds the work cycles in `promoteQueued` and `settings.maxConcurrentAssists` bounds the other three at `assistRefusal`'s door; the invariant beside `maxRunCostUSD` below argues out why they are two numbers and why neither ships null. `git.ts` holds the git primitives (`gitSync` for the admission decision, `git` for everything else); `orchestrator.ts` spawns the agent; `review.ts` spawns the one-shot invocations that are not work cycles — a review, or a conflict resolution (`run_reviews.kind`); `chat.ts` spawns the orchestrator chat. All go through an argv array and never a shell. A workflow's orchestrator block is **not a fifth kind**: it is the fourth one invoked without a thread, through `runOrchestratorChild` — the same argv, the same environment, the same capability token, the same MCP config file. That function exists rather than a second `spawn` call site precisely because two of those would be two sets of flags to keep in step, and the flags are what bound the child; what differs between the two callers is a subject, a system prompt and a cwd. The review spawn was the deliberate third and differs from the agent in every way that matters: it is never automatic, it runs `--permission-mode plan` so it cannot write, its cost lands in `run_reviews` and never in `runs.spent_usd`, and it gets no telemetry env even when `telemetryForRuns` is on — `otlp_requests.run_id` is compared against the run's own spend, and a review's requests in that comparison would make an accounted-for run look unaccounted-for. Adding a fifth kind is a decision, not a detail, and one has been added: `claudeAuth.ts` spawns `claude auth status --json`, `claude auth login` and `claude auth logout`, so that signing the container in and out is a page rather than a `docker compose exec` into a shell the app otherwise never needs. What makes it a kind of its own rather than a variant of the other four is that it is the only child spawned for its **effect on disk** instead of for its output: it rewrites the credential the other four authenticate with. Everything the two concurrency numbers bound is therefore absent from it — no prompt, no context window, no repository, no cost, no telemetry env, no `run_events` and no row anywhere — so `maxConcurrentAssists` does not apply and would mean nothing if it did; what bounds this one is that **at most one login may be pending per install**, held on `globalThis` like every other long-lived handle here, because the CLI keeps a login's PKCE verifier in the memory of the process that printed the link and a second link would issue codes the first process cannot redeem. Two properties are load-bearing rather than incidental. `childCredentials()` is dropped for the *opposite* reason it is dropped everywhere else — not to keep an agent out of what the server can reach, but because the credential is written 0600 owned by the writer and the uid that must open it afterwards is the agent's, so a login taken with the server's authority would leave the page reporting an account in good standing while every work cycle failed on `Not logged in`. And the pasted code reaches the child on **stdin**, never in argv, which is what keeps the one value a person types into a child process from being able to mean anything but one answer to one prompt. A **named agent** is not a fifth kind either, and is not a sub-kind of one: it changes what a child *is*, never how many of them there are. It travels as two flags that go together — `--agents` defines the member, `--agent` selects it, both emitted by `sessionAgentArgs` — and the session it starts is the same process under the same permission mode, the same allow and deny lists and the same cost destination as the same child started with no agent. Three modules, four callers, and two of the four carry one today; both of those *select* it, a work cycle taking the run's own frozen copy and an orchestrator block taking its node's. The other two are decisions rather than gaps. `runTurn` withholds one (see the chat invariant below). `spawnAssist` is the one caller left on the plural flag alone, and it stays there: a review is not a run and has no operator-chosen role to take — what it is is fixed by `--permission-mode plan` and its own prompt, and selecting somebody's saved agent would replace exactly that — and no caller supplies one anyway. There is one encoder (`agentsFlagValue`, which `sessionAgentArgs` is built *on* rather than beside) rather than one per site, for the reason that paragraph gives about `runOrchestratorChild`: several copies of a shape whose every violation is unreported would be several sets of flags to keep in step. What the singular flag changed is the direction of the failure, and it is the one place this move made the app's behaviour better rather than merely different — a member the CLI will not register used to cost a run its specialist at exit 0 with nothing on stderr, and named on `--agent` it now fails the spawn outright, exit 1 before any API call. The encoder is worth more for it, not less: the one remaining silent way to get this wrong is a definition and a selection that disagree, which no run would report either. **What each child may *write*** travels the same way and for the same reason: `sandboxSettings`/`sandboxArgs` beside `buildArgs` are one encoder for the three `claude` spawns that start an agent — a work cycle's own checkout and its repository's `.git`, a reviewer's nothing at all, a resolver's throwaway checkout, the chat's every mount, and `CLAUDE_CONFIG_DIR` in all of them because that is the metering path — so the difference between the sets is an argument a reader can see beside the others rather than a fourth code path that drifted. It configures a sandbox the managed policy switched on and never switches one on, is withheld entirely from an install whose reading is `none`, and is narrower than it looks: `docs/verification.md` carries the two open questions that decide whether it confines anything at all.

`orchestrator.ts`'s loop calls `currentSnapshot()` (a fresh transcript scan, shared with every other caller that asks while it is running — see the invariant below) *before every iteration*, evaluates the budget, then spawns one `claude -p … --output-format stream-json --verbose` child in the run's working directory. Iteration 2+ uses `settings.continuationPrompt` and `--resume <sessionId>`; the run ends on `DONE`, the iteration cap, a guard, or a non-zero exit.

Several runs can be in flight at once. `createRun` admits a run or leaves it `queued`; `promoteQueued()` starts whatever is startable, and is called after creation and again in `startRun`'s `finally`. A run on a git repository defaults to its own worktree (`work_dir` ≠ `folder`), which is what lets two runs share a project; a run anywhere else takes the folder exclusively.

Events flow: `emit()` writes to `run_events` **and** publishes on a `globalThis` EventEmitter → `/api/runs/[id]/stream` replays persisted history first (honouring `Last-Event-ID`), then tails live. Persist-then-publish is what makes reconnect and late page loads lossless — keep that order. A third sink sits *after* the publish and never before it: `logLifecycle` writes one JSON line to stdout for the handful of kinds that describe a run's life, because at 25 unattended runs the run page is not where anyone finds out that a guard tripped. It **projects** named fields rather than serialising the payload, and that is the whole reason it is a function — `iteration` carries the entire prompt, the creation `status` carries the folder, and `assistant` carries the model's own output, and container stdout is a different audience with a different lifetime from `run_events`. The noisy kinds are deliberately left off it; dropping them is what keeps the stream readable, and `run_events` still has all of them.
