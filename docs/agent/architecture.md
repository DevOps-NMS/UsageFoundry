# Architecture

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/ generally — the three data sources, the module map, how events flow.**

## Architecture

**Three** data sources now, still **never summed or mixed in the UI**. The third is Claude Code's own OTLP export (`otlp.ts` → `otlp_requests`), gated on `settings.telemetryForRuns` with one exception below, covering only runs this app spawns. It is first-party per-request cost — no price table, no dedupe key, no file polling — and it is the only way to account for a work cycle killed before the CLI's `result` event. It renders as its own card on the run page and its own card on the dashboard, and must never reach `buildSnapshot()` or `runs.spent_usd`. It reaches a budget decision through exactly one door — `telemetrySpendSince` → a `*Guard*` figure — and that door is narrow on purpose: one run, one cycle, the guard half of a split whose display half stays transcript- and `result`-derived. Two callers go through it and no more: a live run's own spending limit via `RunProgress.spentGuardUSD`, described under the enforcement modes below, and a workflow instance's own budget via `instanceSpend` → `InstanceProgress.spentGuardUSD`, which reads each `running` member's current cycle bounded by `runs.active_started_at`. Same bound, same destination, and neither ever reaches `runs.spent_usd`. It cannot replace transcripts: no backfill, no `cwd`, and `cache_creation_tokens` collapses the 5m/1h split. Wire details were captured from a live CLI, not read from the docs — the docs' `claude_code.api_request` is the record *body*, while `event.name` is the bare `api_request`, and `OTEL_RESOURCE_ATTRIBUTES` lands on both the resource and each record. The payload carries `user.email` and account UUIDs; the parser drops them and the schema has no column for them. `request_id` is the primary key because OTLP delivery is at-least-once, and the ingest route always answers 200 — a batch exporter retries failures, so rejecting a malformed record would cost that batch on a loop. A **fourth file** is now read and it is deliberately **not** a fourth source: `/data/winnow/filter.jsonl`, the intake filter's own ledger, read by `intakeFilter.ts`. Every agent this container spawns talks to `ANTHROPIC_BASE_URL`, which the entrypoint points at winnow's loopback proxy, and the proxy appends one line per request it rewrote. What the ledger describes is money that was **never spent**, so it is a counterfactual in `byAgent.counterfactualUSD`'s sense rather than a reading of spend — the windows are priced from `usage` frames, and a `usage` frame reports the *filtered* request, so the filter's saving is already absent from every meter. It reaches no meter, no guard, no window, `buildSnapshot()` or `runs.spent_usd`. The path is a literal in `docker-entrypoint.sh`, copied into `intakeFilter.ts` rather than derived from `DATA_DIR`, which the entrypoint does not read — the two once disagreed, after the ledger moved off the container's writable layer onto the named volume, and the reading fell silently to `missing`; missing, unreadable and empty are three separate states on the DTO because they call for three different actions, and none of them renders as `$0.00`.

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
mergeQueue.ts   several branches landed one after another — rows in merge_queue,
                one worker per repository (that Set is the mutual exclusion),
                and nothing on the path carrying a clock
templates.ts    saved run configurations — form input, never a run
plugins.ts      Claude Code plugins found in the mounts, switched on per install
                and carried onto every work cycle as --plugin-dir. Deliberately
                *not* `claude plugin install`: compose binds the operator's
                ~/.claude onto /home/node/.claude, so the CLI's own registry is
                one file shared by host and container and it records absolute
                paths — whichever side installs last silently breaks the other,
                since a plugin path that does not resolve is skipped with a
                warning and exit 0. So this app owns the list, in its own
                settings row (never a key of Settings — the settings form sends
                the whole blob on Save, and this decides what code every agent
                loads). Two invariants, both silent when broken: the flag goes
                on **every** cycle's argv because --plugin-dir does not survive
                --resume, and a stored path is proved contained in a mount again
                at *use* time, not just when it was switched on, because what it
                becomes is a directory whose hooks the container executes. An
                enabled plugin that stops resolving reaches the run's own log
                rather than being dropped
vaultSkill.ts   the vault-lookup skill, delivered the same way and for the same
                reason: a plugin directory generated per spawn and passed as
                --plugin-dir, never installed into ~/.claude/skills, where it
                would break the operator's host sessions exactly as above. Its
                switch is its own settings row and is refused with no knowledge
                base configured. It is *generated* rather than shipped as a file
                because it must name the vault's absolute path as the child sees
                it, and whether that vault has a ranked search is discoverable
                only by looking — and it goes to /run/uf-skills rather than
                DATA_DIR, which is 0700 root and on the CLI's managed denyRead
                list, so a skill there is unreadable by the agent uid on exactly
                the hardened install this is for. The vault also needs --add-dir
                or the skill names a path the run may not read; measurement says
                that flag grants **write**, so the skill's own text is the only
                thing forbidding writes into the vault
readGuard.ts    the second *generated* directory on that same --plugin-dir list
                — which now carries three kinds of entry, the plugins found in
                the mounts, the vault skill and this — and the only one shipping
                hooks rather than a skill, so unlike the vault skill it puts
                nothing in the window and needs no --add-dir. It is a PreToolUse
                hook on Read that refuses a repeat of a read this session has
                already made (size and mtime unchanged) and a whole
                read past settings.readGuardMaxTokens. A *ranged* read is tested
                first and never refused, so nothing it says no to becomes
                unreachable — an agent stranded by a guard burns work cycles,
                which costs more than the tokens saved. /run rather than
                DATA_DIR for vaultSkill.ts's reason, root-owned so no agent can
                rewrite the script; the per-session ledger is a *sibling*
                directory the agents may write. Off by default: the savings it
                attacks are measured and that refusing a read produces them is
                not, and it is not confirmed that --plugin-dir registers a
                plugin's hooks as well as its skills
fileCostNotice.ts
                what a Read of this repository's largest files costs, ranked on
                tokens x how often this fleet has read each one, generated once
                at createRun and frozen on runs.file_cost_notice — the appended
                system prompt is part of the cached prefix, so a version of this
                text that differed between two cycles of one run would cold-start
                every token behind it. Every failure degrades to "", because a
                run that could not be created for want of a cost hint would cost
                infinitely more than the hint saves
toolComposition.ts
                what is *in* the contexts this machine paid for — a second reader
                over the same transcripts, in parseCompactionBoundary's shape,
                denominated in characters of tool output. Not a sixth breakdown
                and not a cost source: a tool_result carries no usage block, so
                it reconciles to itself and never to a window total, and its type
                is an object of rows so nothing written for the five compiles
                against it
intakeFilter.ts what winnow's intake filter kept off the wire, read from its own
                ledger at /var/lib/winnow/filter.jsonl — the one file here
                that no part of this app writes. A counterfactual, never a
                fourth cost source: the meters are priced from usage frames and
                a usage frame reports the request the filter had already
                rewritten, so this money is already absent from every figure
                beside it. The filter is stateless and re-drops the same result
                on every later request still carrying it, so a ledger line is a
                *request* and not a removal — de-duplicating on tool_use_id, or
                on (session, tool, rule, bytes) for lines written before winnow
                carried one, is what separates 14 results from 334 and is the
                whole of why this is a module rather than a SUM. It joins
                request_id to UsageEntry.requestId for the clock, the model and
                the turns that followed, so it is bounded by the transcript
                horizon exactly as the prune total is, and it is read behind a
                minute-long TTL with single-flight because the dashboard polls
                every ten seconds and the ledger grows with every request the
                fleet makes. That join is also what windows it: session and
                weekly are three nets off one pass, sliced by resultsSince on
                the anchor turn's instant, and a result that joined to nothing
                is left out of both rather than guessed into one — so the two
                window figures are a floor by much more than the total is
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
retention.ts    what expires and what never does — no runs row is ever deleted,
                the evidence behind one goes on three separate horizons, and
                every sweep asks the database what is live rather than asking
                a file its age
health.ts       what /api/health answers with, and the one thing it is for:
                being false when this server cannot do its job
status.ts       what /api/status answers with — gauges for a monitor rather
                than a person, behind a read-only credential of its own
db.ts           SQLite: every table migrate() creates, and there are 22 —
                runs, run_deps, run_events, run_reviews, run_templates, agents,
                settings, chat_sessions, chat_messages, chat_proposals,
                chat_turn_spend, workflows, workflow_instances,
                workflow_instance_runs, workflow_instance_blocks,
                workflow_schedules, merge_queue, ops_events, request_log,
                otlp_requests, auth_sessions, login_attempts. The list is a
                completeness claim, so check it against
                `grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+'
                src/lib/db.ts | sort -u | wc -l` when adding one — a plain
                `grep -c` says 24 and counts two comments
```

**Four kinds of agent child process, from four modules, and no more — and two numbers bound how many of them exist at once.** (A fifth kind of child exists and starts no agent: `claudeAuth.ts`'s, argued out further down this paragraph.) `settings.maxConcurrentRuns` bounds the work cycles in `promoteQueued` and `settings.maxConcurrentAssists` bounds the other three at `assistRefusal`'s door; the invariant beside `maxRunCostUSD` below argues out why they are two numbers and why neither ships null. `git.ts` holds the git primitives (`gitSync` for the admission decision, `git` for everything else); `orchestrator.ts` spawns the agent; `review.ts` spawns the one-shot invocations that are not work cycles — a review, or a conflict resolution (`run_reviews.kind`); `chat.ts` spawns the orchestrator chat. All go through an argv array and never a shell. A workflow's orchestrator block is **not a fifth kind**: it is the fourth one invoked without a thread, through `runOrchestratorChild` — the same argv, the same environment, the same capability token, the same MCP config file. That function exists rather than a second `spawn` call site precisely because two of those would be two sets of flags to keep in step, and the flags are what bound the child; what differs between the two callers is a subject, a system prompt and a cwd. The review spawn was the deliberate third and differs from the agent in every way that matters: it is never automatic, it runs `--permission-mode plan` so it cannot write, its cost lands in `run_reviews` and never in `runs.spent_usd`, and it gets no telemetry env even when `telemetryForRuns` is on — `otlp_requests.run_id` is compared against the run's own spend, and a review's requests in that comparison would make an accounted-for run look unaccounted-for. Adding a fifth kind is a decision, not a detail, and one has been added: `claudeAuth.ts` spawns `claude auth status --json`, `claude auth login` and `claude auth logout`, so that signing the container in and out is a page rather than a `docker compose exec` into a shell the app otherwise never needs. What makes it a kind of its own rather than a variant of the other four is that it is the only child spawned for its **effect on disk** instead of for its output: it rewrites the credential the other four authenticate with. Everything the two concurrency numbers bound is therefore absent from it — no prompt, no context window, no repository, no cost, no telemetry env, no `run_events` and no row anywhere — so `maxConcurrentAssists` does not apply and would mean nothing if it did; what bounds this one is that **at most one login may be pending per install**, held on `globalThis` like every other long-lived handle here, because the CLI keeps a login's PKCE verifier in the memory of the process that printed the link and a second link would issue codes the first process cannot redeem. Two properties are load-bearing rather than incidental. `childCredentials()` is dropped for the *opposite* reason it is dropped everywhere else — not to keep an agent out of what the server can reach, but because the credential is written 0600 owned by the writer and the uid that must open it afterwards is the agent's, so a login taken with the server's authority would leave the page reporting an account in good standing while every work cycle failed on `Not logged in`. And the pasted code reaches the child on **stdin**, never in argv, which is what keeps the one value a person types into a child process from being able to mean anything but one answer to one prompt. A **named agent** is not a fifth kind either, and is not a sub-kind of one: it changes what a child *is*, never how many of them there are. It travels as two flags that go together — `--agents` defines the member, `--agent` selects it, both emitted by `sessionAgentArgs` — and the session it starts is the same process under the same permission mode, the same allow and deny lists and the same cost destination as the same child started with no agent. Three modules, four callers, and two of the four carry one today; both of those *select* it, a work cycle taking the run's own frozen copy and an orchestrator block taking its node's. The other two are decisions rather than gaps. `runTurn` withholds one (see the chat invariant below). `spawnAssist` is the one caller left on the plural flag alone, and it stays there: a review is not a run and has no operator-chosen role to take — what it is is fixed by `--permission-mode plan` and its own prompt, and selecting somebody's saved agent would replace exactly that — and no caller supplies one anyway. There is one encoder (`agentsFlagValue`, which `sessionAgentArgs` is built *on* rather than beside) rather than one per site, for the reason that paragraph gives about `runOrchestratorChild`: several copies of a shape whose every violation is unreported would be several sets of flags to keep in step. What the singular flag changed is the direction of the failure, and it is the one place this move made the app's behaviour better rather than merely different — a member the CLI will not register used to cost a run its specialist at exit 0 with nothing on stderr, and named on `--agent` it now fails the spawn outright, exit 1 before any API call. The encoder is worth more for it, not less: the one remaining silent way to get this wrong is a definition and a selection that disagree, which no run would report either. **What each child may *write*** travels the same way and for the same reason: `sandboxSettings`/`sandboxArgs` beside `buildArgs` are one encoder for the three `claude` spawns that start an agent — a work cycle's own checkout and its repository's `.git`, a reviewer's nothing at all, a resolver's throwaway checkout, the chat's every mount, and `CLAUDE_CONFIG_DIR` in all of them because that is the metering path — so the difference between the sets is an argument a reader can see beside the others rather than a fourth code path that drifted. It configures a sandbox the managed policy switched on and never switches one on, is withheld entirely from an install whose reading is `none`, and is narrower than it looks: `docs/verification.md` carries the two open questions that decide whether it confines anything at all.

`orchestrator.ts`'s loop calls `currentSnapshot()` (a fresh transcript scan, shared with every other caller that asks while it is running — see the invariant below) *before every iteration*, evaluates the budget, then spawns one `claude -p … --output-format stream-json --verbose` child in the run's working directory. Iteration 2+ uses `settings.continuationPrompt` and `--resume <sessionId>`; the run ends on `DONE`, the iteration cap, a guard, or a non-zero exit.

Several runs can be in flight at once. `createRun` admits a run or leaves it `queued`; `promoteQueued()` starts whatever is startable, and is called after creation and again in `startRun`'s `finally`. A run on a git repository defaults to its own worktree (`work_dir` ≠ `folder`), which is what lets two runs share a project; a run anywhere else takes the folder exclusively.

Events flow: `emit()` writes to `run_events` **and** publishes on a `globalThis` EventEmitter → `/api/runs/[id]/stream` replays persisted history first (honouring `Last-Event-ID`), then tails live. Persist-then-publish is what makes reconnect and late page loads lossless — keep that order. A third sink sits *after* the publish and never before it: `logLifecycle` writes one JSON line to stdout for the handful of kinds that describe a run's life, because at 25 unattended runs the run page is not where anyone finds out that a guard tripped. It **projects** named fields rather than serialising the payload, and that is the whole reason it is a function — `iteration` carries the entire prompt, the creation `status` carries the folder, and `assistant` carries the model's own output, and container stdout is a different audience with a different lifetime from `run_events`. The noisy kinds are deliberately left off it; dropping them is what keeps the stream readable, and `run_events` still has all of them.
