# Verified

[← Documentation index](README.md)

Built and exercised against real transcripts:

- Cost math cross-checked by hand — `$12.843618` computed independently vs
  `$12.8436175` from the API, on 54 input / 83,517 output / 12,072,025 cache-read
  / 471,941 cache-1h tokens.
- Dedup verified (99 → 31 records).
- Incremental re-scan picks up records appended mid-session.
- Budget refusal returns `blocked` with 0 iterations and 0 spend.
- Metric selection: cost ceiling wins when both are set; falls back to tokens
  when cost is cleared; null when neither is set.
- Budget guard evaluated against the cost fraction — allowed at an 80% guard,
  refused at 5% with the window at 11.2%.
- Unpriced-model guard fallback, 17 assertions against the compiled modules: a
  window of 90M output tokens from an unknown model still reports `$0` and
  `fraction = 0` (so the pre-fix guard could never fire) while `guardFraction`
  reads 45× a $100 ceiling and the guard blocks with `weekly_fraction`. A fully
  priced window keeps `guardFraction === fraction` exactly, an under-threshold
  window is still allowed, and a fraction guard with no ceiling still refuses
  with `no_ceiling` rather than being satisfied by the fallback.
- Model-ID canonicalisation: `us.anthropic.claude-opus-5-20260101-v1:0`,
  `anthropic.claude-sonnet-4-5`, and `claude-sonnet-4-5@20250929` all resolve;
  `claude-nextgen-9` stays unknown; `claude-opus-4-1` keeps its own $15/$75.
- A zero-token turn (`<synthetic>`) no longer counts as an unpriced model, and
  incurs no fallback charge.
- **5-hour boundaries no longer rounded to the hour.** That resets are not
  hour-aligned was established from the shipped CLI itself: it reads
  `anthropic-ratelimit-unified-reset` off each API response, and its own
  formatter emits the minutes whenever they are non-zero — dead code if a reset
  always landed on `:00`. That the instant is unreadable locally was established
  the same way: no transcript record carries it (the assistant record's fields
  were enumerated across 205 files), no file under `~/.claude` holds it, and the
  CLI's OTLP export defines eight metrics and six event names, none of them
  rate-limit state. The effect on 4,663 real deduped turns: the four derived
  windows moved from a `17:00 / 22:00 / 03:00 / 08:00` grid onto the turns that
  actually opened them (`17:17:14 / 22:17:24 / 03:29:12 / 08:31:16`), the
  current window's reported reset moved 31 minutes later, and **86 turns moved
  back into the window that was really open** — at 22:00 the old rule showed a
  fresh empty session, and re-armed the session guard, 17 minutes before
  Anthropic's window closed.
- Attribution tables against real transcripts: effort, sub-agent, and skill each
  reconcile to the window total to within a rounding error ($138.3639 over 998
  turns), every turn lands in exactly one bucket per breakdown (998 = 998), and
  the `groupBy` refactor left `byModel` / `byProject` reconciling as before.
- **Calendar periods against 9,200 real deduped turns from 303 files**, in
  `Europe/Berlin` while the machine ran UTC. Every day boundary landed on local
  midnight (`00:00:00` Berlin, i.e. `22:00` UTC the day before under CEST), all
  three granularities were contiguous with no gap between adjacent buckets, and
  every turn in each series' span landed in exactly one bucket (9,200 = 9,200,
  three times). Pro-rating checked against a $700 weekly ceiling: a day read
  $100.00 and a 31-day August read $3,100.00. The weekly bucket's total matched
  the weekly meter's exactly ($1,228.79), the `limitBasis` was `weekly` for
  weeks and `prorated` for the other two, and the day series was three buckets
  rather than fourteen because the transcripts start on 10 August. Nine unit
  tests cover the same ground plus the DST case, an anchored week, and the
  no-ceiling case (`fraction === null`, never `0`).
- Stop path, end to end against a stub CLI that ignores SIGTERM: the run now
  reaches `stopped` about 8s after the stop (5s escalation + 2s drain grace),
  where it previously stayed `running` indefinitely. Two independent causes
  were needed — the `!child.killed` test made the SIGKILL escalation dead code,
  and even once SIGKILL was delivered, an orphaned grandchild still holding the
  inherited stdout pipe kept `close` from ever firing, so the iteration is now
  settled from `exit` as well.
- Operator stop records `stopped` with the interrupted-cost note in
  `stop_reason`, not `failed`.
- Child environment, dumped from a real spawned process: 97 variables reach the
  agent with `PATH` and `HOME` intact, while a sentinel `ANTHROPIC_ADMIN_KEY`,
  `UF_AUTH_TOKEN`, and every `OTEL_*` are absent.
- Normal accounting path unaffected: a stub emitting a `result` event records
  $0.42 / 35 tokens, completes on `DONE`, and adds no interrupted-cost note.
- OTLP ingest over HTTP: a captured batch inserts 1 row, replaying it inserts
  0, a garbage body yields `seen: 0`, and a non-JSON body still returns 200 so
  the exporter does not retry it forever. The stored row has no column for
  `user.email` or any account UUID.
- OTLP transport captured from a real headless `claude -p` run on CLI v2.1.226,
  not taken from the docs. Telemetry *does* initialise under `-p`; a base
  endpoint of `/api/otlp` receives `POST /api/otlp/v1/logs` and
  `/api/otlp/v1/metrics`, so the CLI appends the signal suffix itself; the body
  is uncompressed `application/json`. The docs name the event
  `claude_code.api_request`, but on the wire that string is the record *body*
  and the `event.name` attribute is the bare `api_request` — the parser accepts
  both. `OTEL_RESOURCE_ATTRIBUTES` lands on the resource *and* on each record,
  and the parser merges both so run attribution does not depend on which.
- OTLP parser run against those captured payloads, 13 assertions: extracts the
  priced request with its `req_…` id, first-party cost, tokens and run id;
  drops `user.email` / `user.account_uuid` at the parser; a redelivered batch
  inserts 0 rows (delivery is at-least-once); an unknown run returns null
  rather than a zero row; and malformed or null payloads return empty instead
  of throwing, since a rejected batch would be retried forever.
- The dashboard's **Live from runs** card, against a real database with batches
  pushed through the live ingest route: the window total counts only the five
  requests inside the 5-hour window and attributed to a run, so a record seven
  hours old, a record carrying no `uf.run_id`, and a redelivered `request_id`
  are each left out; per-run rows carry the run's real status from the `runs`
  join (`running`, `completed`, and `—` when no row matches) and are ordered
  heaviest first; eight runs in the window list six and still report `runCount`
  8; `workingRunCount` counts the one `running` row, which is what switches the
  poll to 5s. The transcript-derived `session.costUSD` in the same response
  contains none of it, and the card disappears entirely when *Agent
  self-reporting* is switched back off.
- That card's own rendering (`npm test`, 5 cases): the first-party figure never
  renders without all three sentences that stop it being read as an addend to
  the meters; a list capped by `TOP_RUNS` names the number of runs it left out
  and a complete list claims no omission; a telemetry row with no matching
  `runs` row renders `—` rather than inventing a status; and nothing is
  described as "working" when `workingRunCount` is 0.
- Plan detection reads `Claude Max 20x` from `.credentials.json` with no email,
  name, or account UUID crossing the wire; caches for 60s including misses (the
  CLI writes these files lazily); and degrades to "plan unknown" with no error
  when the config directory holds neither file. The legacy `~/.claude.json` is
  consulted only while the config directory is still the default — a redirected
  `CLAUDE_HOME` reports no plan rather than the wrong one.
- Path traversal rejected in every form tested: `../` escape, absolute path
  outside all mounts, a symlink pointing out of the tree, a folder belonging to a
  *different* mount, an unknown mount id, an unmounted workspace, and a path
  inside a workspace slot that is configured but disabled.
- Multiple workspaces: slots parse and are listed independently, a disabled slot
  is skipped, a missing one is reported as unavailable rather than empty, and a
  run's folder maps back to its workspace even when the mount is reached through
  a symlink.
- Folder collision (`npm test`, 8 cases): a folder collides with itself, not with
  a sibling, with its own parent and child in both directions, with the same
  directory reached through a second workspace, and with a name differing only in
  case; a nested mount reached through an alias keeps its parent-relative prefix,
  so the one directory named two ways still collides and the parent mount still
  contains it; two isolated checkouts do not collide with each other or with the
  repository, but all of them collide with a run on the whole workspace.
- Concurrency, against a real database with a stub agent: two runs on one plain
  folder → the second queues and is promoted automatically when the first ends;
  a run on a different folder starts immediately; a run on the workspace root
  queues behind both and still runs rather than being starved; `session_id` is
  persisted.
- Isolation, against a real repository with uncommitted work and a gitignored
  `.env`: two runs on one repo both start, in different slots, each on its own
  `uf/…` branch; the seeded `.env` is present in the checkout; the operator's
  modified file and current branch are untouched; `.uf-worktrees/` does not
  appear in `git status`.
- Restart recovery: a row left `running` is closed out as `failed` with the
  `claude --resume <id>` command in its stop reason, freeing the folder.
- Concurrency limit and stopping: with the limit at 1, runs on two further idle
  folders queue rather than being refused, and exactly one is promoted when a
  slot frees; stopping a live run records `stopped` rather than `failed`, and a
  run whose agent leaves a grandchild holding its output still terminates.
- The **standalone** build (what the container runs) boots and serves, native
  SQLite binding included.
- **One real billed run**, end to end: 1 iteration, exit 0, stopped at the
  iteration cap, $0.067 / 13,983 tokens accounted correctly.
- Reserved headroom: 50% reserve halves the effective ceiling ($200 → $100),
  doubling the reading (13.8% → 27.5%) and converting a 20% guard from allow to
  refuse. Out-of-range input (400%) clamps to 95%.
- Budget policy and guard ordering (`npm test`, 11 cases): `normalizePolicy` is
  idempotent across a JSON round trip for every field, an explicit `null` cycle
  cap survives while blank / zero / negative / missing all still mean one cycle,
  a string `"false"` for `continueAfterDone` reads as off, and an unknown
  enforcement mode degrades to `between-cycles`. `evaluateBudget` refuses
  `no_terminus` ahead of every other check, parks on the 5-hour window only
  under `live-resume` and never on the weekly one, **ends** rather than parks a
  run that is also out of time, still refuses a fraction guard with no ceiling,
  and blocks on reconciled spend that `spent_usd` alone would have missed.
- Provider refusals (`npm test`, 18 cases): `isUsageLimit` matches both the
  wording the CLI renders and the wording in its own error taxonomy, including a
  model label it has never seen; leaves `Not logged in`, a spend cap and a
  credit balance to fail as themselves; and treats a 429, an overloaded upstream
  and a plain rate limit as transient rather than as an exhausted allowance —
  money and blips are the two things that must not be waited out.
  `isTransientApiError` picks those blips back up: all five stream-truncation
  sentences the CLI can render, the statuses and `error.type` names the provider
  documents as retryable, and a connection that never reached a status — while
  leaving a bad key, a malformed request and an empty credit balance to fail as
  themselves, and reading neither `Wrote 500 lines` nor `429 tests passed` as a
  status. `refusalResumeAt` waits for a window still open, backs
  off 20/40/60 minutes for one already passed or invisible, never re-spawns
  inside five minutes, and never holds a folder past six hours.
- Reviewing and landing, exercised end to end against real scratch repositories
  (the compiled modules driven directly, with a stub CLI standing in for
  `claude` so nothing was billed):
  - A diff over a change containing an edit, a rename, a binary file and a
    filename containing a tab: file list, statuses, line counts and per-file
    patches all correct, and the tab-containing name survives intact.
  - Landing refused while the checkout was dirty, and refused again while it was
    on a different branch — naming both branches. A clean fast-forward landed and
    the tree matched.
  - A conflicting branch: previewed as conflicting in `f.txt` with nothing
    written, and the merge attempt refused with the checkout left clean and HEAD
    unmoved.
  - A squash land: one commit on the target, the run's task as its subject, and
    the branch then deletable by tip comparison — with its worktree removed
    first, and refused while that worktree held uncommitted work.
  - A run predating target recording: the target deduced from the base commit and
    flagged as inferred.
  - The branch inventory reporting merged/ahead state, and `branch -d` after it.
  - The review path with a stub CLI: prompt assembled with the task and the whole
    diff, `--output-format json --permission-mode plan` on the command line, cost
    and tokens recorded to `run_reviews`, `running`/`completed` events emitted,
    and a second concurrent review refused.
  - Conflict resolution, both ways, with stub CLIs: one that resolves the
    markers — the branch gained a merge commit, the preview went from
    *conflicts* to *fast-forward*, the temporary checkout was removed, the
    operator's tree stayed clean throughout, and the branch then landed — and
    one that reported success without touching anything, which was caught, the
    merge rolled back, the branch left byte-identical, and the cost still
    recorded.
  - The run page, the branches page and the land/delete actions driven through
    the browser against that fixture.
- Parsers and budgets under `npm test` (24 further assertions): NUL-separated
  numstat and name-status records including renames, binaries and a tab in a
  filename; patch splitting that does not split on a `diff --git` line *inside* a
  hunk; the size budget naming what it left out; `merge-tree` output read as
  clean, conflicting, or undetermined-on-an-old-git; and every `landRefusal`
  branch.
- The merge queue, against a five-branch scratch repository on a live dev server,
  with the stub CLI standing in for the resolver. Three branches queued in an
  order that was not the list's — one clean, one conflicting, one clean — landed
  in exactly that order: the conflict was resolved in a throwaway checkout, its
  $0.07 recorded on the queue row and never on the run, and the two clean merges
  went either side of it. With the resolver toggled off, the conflicting branch
  failed with its own reason and the branch behind it still landed. With the
  operator's checkout deliberately dirtied, both queued branches were skipped
  with one reason between them, nothing was written, and the conflicting one was
  **not** paid to be resolved — the checkout is tested before the conflict
  precisely so that a merge which was going to be refused is never billed for
  first. Driven through the browser as well as the API, including the selection
  order badges and the inventory re-reading itself once the queue stopped.
- The conflict display, against a scratch repository with a content conflict and
  a modify/delete conflict in the same merge, on git 2.50. `merge-tree
  --write-tree -z` was run for real and its output fed through
  `parseMergeTree`: both files listed once, `contents` and `modify/delete` read
  off the informational records, git's explanation kept only where it says
  something the type and the path do not, and the `<<<<<<<` block read back out
  of the merged tree. Then the same fixture through a live dev server and a
  browser: the conflict list, the type, the clash count and the block itself all
  render on the run page, with the modify/delete file showing git's sentence and
  no block.
- The resolution display, from a `run_reviews` row written straight into SQLite
  with the merge commit of a by-hand resolution: `GET /api/runs/<id>/land`
  returned the resolution's own diff against the branch's pre-merge tip,
  restricted to the recorded conflicted paths, and the run page rendered it under
  the model's prose. The row was seeded rather than produced by a real agent —
  which the *Not yet verified* list below already covers.
- Run templates against a live dev server on a scratch workspace: create, list
  (ordered by name, case-insensitively), update, and delete, with a second
  delete answering 404. Every refusal came back as a 400 with the sentence the
  form shows — a duplicate name differing only in case, a blank prompt, an
  unknown permission mode, and the no-cycle-limit-and-no-time-limit pair that
  `POST /api/runs` refuses. Read-time narrowing was checked by writing a row
  straight into SQLite with `permission_mode = 'bypassEverything'` and a corrupt
  budget blob: it comes back as `plan` (the only mode that cannot write) and one
  work cycle, rather than as a wider permission or a throw. `normalizeTemplateInput`
  and `rowToTemplate` also have 20 assertions under `npm test`.
- The GitHub credential block, driven into a real `git` (2.39.5) in a scratch
  repository rather than only asserted in a test: `git credential fill` for
  `github.com` returns the token even when the repository's own config names a
  helper the image does not have (`osxkeychain`), which is the reset entry
  earning its place; `store`/`erase` are accepted as no-ops; both
  `git@github.com:owner/repo` and `ssh://git@github.com/owner/repo` rewrite to
  HTTPS under `ls-remote --get-url`; and a request for `gitlab.com` gets no
  credential at all and fails immediately instead of prompting. Plus six
  assertions in `npm test` on the block itself — the count matching its pairs is
  the silent one, since git discards the whole block if it does not.
- Layout, measured rather than eyeballed: every page of the production build
  rendered in a headless browser against fabricated API responses (each status a
  run can hold, a conflicting land preview, a working merge queue) at twelve
  widths from 1440px to 380px, in both themes, with the geometry read back out of
  the DOM — box intersections between in-flow siblings, boxes escaping their
  parent's padding box, and the document scrolling sideways. Three defects were
  found this way and are fixed here: the run page's accounting row sat at a 0px
  gap from the card above it where every other block on that page has 24px (the
  legacy `section + section` rule cannot see the component-kit cards that were
  inserted above it); the merge queue's *Cancel the N still waiting* button left
  its card by 92px at 380px wide and took the horizontal scrollbar with it (a
  card heading is a flex row and a button will not shrink below its own label);
  and the settings save bar was translucent over the card it floats across,
  which in dark mode read as a card torn in half. After the fix no card heading
  overflows at any tested width, no page scrolls sideways, and the run page's
  vertical rhythm is 24px throughout. The remaining reported intersections are
  inline text boxes wrapping inside a paragraph, and the save bar overlaying the
  page as a sticky bar is meant to.

- **The orchestrator chat, end to end against the real CLI.** A template was
  saved, a chat asked to list what it could see and propose one run, the
  proposal was approved, and the resulting run started and completed — $0.22 for
  the chat turn, $0.165 for the run. The chat's own tool calls landed on
  `/api/mcp` (the hand-written `initialize` / `tools/list` / `tools/call`
  handlers answer the pinned CLI 2.1.226 correctly), `list_folders` identified
  the repository's GitHub remote, and the proposal recorded the right template
  and folder.
- **The order a chat thread renders in** (`npm test`, 3 cases, against a real
  database under a temporary `DATA_DIR`): a reply and the denial note that
  annotates it, appended under a frozen clock, come back in that order rather
  than by the coin toss the random `id` was; ten messages written in one
  millisecond come back in insert order, and still do after the connection is
  closed and reopened; and rows carrying a null `seq` — the state a deployed
  database is in between the `ALTER TABLE` and the backfill — come back in the
  order they were written, with a message appended afterwards landing below them
  rather than among them. The migration itself was driven separately against a
  hand-built database file predating the column, using the three rows read out
  of the live deployment: it gains `seq`, they backfill to 1/2/3 in insert
  order, and the assistant reply that used to render *below* the denial note now
  renders above it.
- **That the chat could not write, under the configuration it had then.** Asked
  directly, in the same turn, to create a file inside the workspace, it reported
  `No such tool available: Write. Write is disabled for this session, in
  subagents as well as here.` and the file did not exist afterwards. That
  measurement stands as a measurement of `manual` plus an allowlist, and **no
  longer describes what ships**: the chat now runs `bypassPermissions` with no
  tool list, and what keeps it out of a checkout is the system prompt. The
  equivalent question — whether an orchestrator told to look and not build
  actually leaves files alone when a fix is one edit away — has not been
  measured and is in the list below.
- **That `--permission-mode plan` cannot be used for this.** Measured, not
  assumed: the first attempt ran the chat in plan mode and every MCP call came
  back `Cannot call mcp__uf__list_templates while in plan mode`, which would
  have left the chat able to read GitHub and not this app. That is why the
  read-only-looking mode is not an option here, and why removing the allowlist
  left nothing mechanical in its place.

- **That an isolated run under `acceptEdits` could not commit, and now can.**
  Found in the wild rather than reasoned about: four runs finished `completed`
  on their own branches with nothing on them and their whole change sitting
  uncommitted in the worktree. The transcripts say why — seven `git add` / `git
  commit` attempts across five phrasings, every one answered `This command
  requires approval`, which in a `-p` child nobody can give. `acceptEdits`
  auto-approves edits and read-only shell and holds mutating git for a human, so
  the isolation preamble was ordering work the permission mode forbade.
  Confirmed in the same transcripts that the other 59 Bash calls *did* run, so
  this is specifically mutating git and not "acceptEdits blocks the shell".

  The fix was then verified against the real CLI for $0.02, in a throwaway
  repository: `--permission-mode acceptEdits --allowedTools "Bash(git add:*)"
  "Bash(git commit:*)"` wrote the file, committed it, and had its `git push`
  refused — which establishes all three things it needed to. The grant works,
  it grants only what it names, and `--allowedTools` is *additive* rather than
  exhaustive when the mode is not `manual` (`Write` still ran, having never been
  named). The same run confirmed the `stream-json` `result` event carries
  `permission_denials`, with `tool_name: "Bash"` and the command under
  `tool_input.command` — which is why the log line names the command.

- **The two git formats behind committing and purging, read off git 2.39.5
  rather than the manual.** `git status --porcelain -z` was captured from a
  scratch repository holding an unstaged edit, a rename and an untracked file
  with a space in its name: the record is `XY <space> path NUL`, a rename's
  source follows as its **own** field with the current path first, and the
  leading space of `" M path"` is load-bearing. Passing that same output through
  `.trim()` — which every other caller of `git()` gets — silently drops the
  unstaged file from the list entirely, which is what `trim: false` exists for.
  Separately: `git worktree remove` refuses a checkout with modified *or*
  untracked files and a single `--force` removes it, and `git branch -d` refuses
  an unmerged branch where `-D` deletes it. Those four exit codes are the
  difference between Delete and Purge.
- **Workflows end to end against a live dev server**, on a scratch workspace with
  two throwaway git repositories and `CLAUDE_BIN` pointed at a stub that speaks
  `stream-json` — so every run below is a real run of the real loop, with no
  spend and no network. Saving refuses each case by name and in the operator's
  words: no blocks, a blank task, a template that does not exist, a workspace
  that is not mounted, a folder that does not resolve inside it, a link with no
  condition, and a loop (`B → A → B`). A four-block graph — two roots, one
  `on-success` link carrying the branch over, one `on-finish` link into another
  repository — created four runs in one pass: the two roots went straight to
  `running` in parallel, the two dependents sat `waiting`, and all four reached
  `completed`. The continuation landed on its predecessor's branch
  (`uf/repo-a-1-a89cd5db` for both, `continues_run` set on the second, and one
  branch in the repository rather than two). Pressing Run again while the first
  press was still going was refused with the count; deleting the workflow was
  refused the same way and succeeded once they had finished, taking the instance
  records and **no run** with it (the runs were still on `/api/runs`
  afterwards). Editing the workflow — renaming it and renaming a block — left
  the instance reporting the name and the block names it actually ran with, and
  an instance id requested under another workflow's id answered 404. The cascade
  was checked with a stub that exits non-zero: the root ended `failed`, its
  `on-success` dependent ended `blocked` with *"Set to start only after run
  274b3840 succeeded (on-success); it ended failed"*, and its `on-finish`
  dependent started anyway and failed on its own — which is exactly what the two
  conditions are for. All five pages compiled and answered 200.
- **The canvas's live check, against a dev server on a real workspace.**
  `POST /api/workflows/validate` was driven through every refusal the canvas
  exists to surface, and each came back as `normalizeWorkflowInput`'s own
  sentence with a 200: no name, no blocks, a link with no condition (*"“B” needs
  a condition for starting after “A”: on-success or on-finish."*), a loop
  (*"…B → A → B."*), a template that has been deleted, a workspace that is not
  mounted, a folder that does not resolve inside its mount, a block with no
  task, and an orchestrator block with no fan-out cap. A two-block graph with an
  `on-success` link answered `{"ok":true}`. `/workflows`, `/workflows/new`,
  `/workflows/<id>` and `/workflows/<id>/edit` all answered 200, and the
  canvas — the palette, the empty state and the selection panel — is in the
  server-rendered HTML of `/workflows/new`.
- **Backup and restore, end to end against a live writer**, on a real database
  written by `migrate()` rather than an imitation of it. A background process
  committed a row every 20ms and, from the two-second mark, held a second
  connection's write transaction open with ten rows that were never committed.
  Taken at that instant: `cp` of `usagefoundry.db` gave **25 runs**,
  `scripts/backup-db.mjs` gave **386** — the same 386 the live database held —
  and *both files passed `integrity_check`*, which is the whole argument for
  this existing. None of the uncommitted rows are in the snapshot. Restored into
  an empty directory standing in for a fresh volume, the file matched the
  quiesced source object for object out of `sqlite_master` and row for row in
  every table. The refusals were driven too: a restore under a heartbeating
  `server.lock` was refused and wrote nothing, a restore over an existing
  database moved it and its `-wal` aside as `.superseded-<stamp>` rather than
  deleting either, a SQLite file with no `runs` table was refused by name, a
  file that is not a database at all was refused as one, `--keep 2` deleted only
  files matching this script's own name pattern, and a second backup to an
  existing path was refused rather than overwriting it. Six of those are the
  unit tests in `backupRestore.test.ts`; replacing `VACUUM INTO` with
  `fs.copyFileSync` in the script fails them, which is what says they are
  measuring the mechanism rather than the file's existence.
- **The two agent flags, probed by hand against the pin
  (`@anthropic-ai/claude-code@2.1.226`).** Seven probes, each deciding a design
  question rather than confirming one. Four of them refuse before any API call,
  which is how `BUILT_IN_AGENTS` was derived in the first place.
  - `--agent` **can select a definition supplied on the same argv** by
    `--agents`, which is what made the feature wirable at all — the alternative
    was writing agent files into the operator's mounted `~/.claude` or into a
    checkout. `claude --agents '{"uf-probe-agent":{…}}' --agent uf-probe-typo -p
    hi` answered `--agent 'uf-probe-typo' not found. Available agents: claude,
    Explore, general-purpose, Plan, statusline-setup, typescript,
    uf-probe-agent`. That same line settles the merge from the other side:
    `typescript` is not a built-in but a definition on that machine's disk, so
    the resolution set is the built-ins *and* the disk *and* this argv.
  - **An unregistrable member fails the spawn rather than being dropped.**
    `--agents '{"uf-nodesc":{"prompt":"p"}}' --agent uf-nodesc -p hi` answered
    `--agent 'uf-nodesc' not found` and **exited 1**, identically for a missing
    `prompt` and for `"model": null`. Under the plural flag each of those cost a
    run its specialist at exit 0 with nothing on stderr; named on `--agent` the
    failure is loud. The empty name and the non-JSON payload were **not**
    re-measured — see below.
  - **A member named after a built-in shows once, not twice.**
    `--agents '{"Explore":{…}}'` still listed a single `Explore`, so
    `--agent Explore` selects *an* Explore with no way to tell whose.
  - **`--append-system-prompt` still reaches a `--agent` session.** An agent told
    to reply with a secret word stated only in the appended text replied
    `BANANA ZEBRA`. That flag carries `SELF_HOSTING_NOTICE` — the `pkill` deny
    list's explanation and the safe recipe that replaces it — so the alternative
    was a run started as an agent that had never been told either.
  - **`--agent` survives `--resume`**: the same probe resumed replied
    `BANANA ZEBRA` again, `subtype=success`. Without it a run would stop being
    what it was started as at cycle 2.
  - **The run's own `--model` outranks the agent's**, read off the `system`/`init`
    event before any request: the definition alone reported `claude-opus-5[1m]`,
    `--agent uf-m` reported `claude-sonnet-5`, `--model opus … --agent uf-m`
    reported `claude-opus-5`, `--model haiku …` reported
    `claude-haiku-4-5-20251001`.
  - **A name with a space registers and resolves** —
    `--agents '{"uf spaced":{…}}' --agent "uf spaced"` — which holds only
    because nothing here goes through a shell.
- **The `agent` key in `settings.json` selects a session agent, and this app
  neither passes it nor says it exists.** `claude --help` describes `--agent` as
  overriding "the 'agent' setting"; nothing here had established whether that
  setting was real, and the operator's own `~/.claude` is bind-mounted into every
  child this app spawns. Four probes on the pin against a throwaway
  `CLAUDE_CONFIG_DIR` holding a copy of the real credentials, one ambient
  definition (`uf-set-probe`, whose whole prompt was "reply with exactly the
  single word BANANA"), a second (`uf-set-probe2`, CHERRY) and the same prompt
  each time, `-p "Say hello." --max-budget-usd 0.20`:

  | settings.json | argv | answer |
  |---|---|---|
  | no `agent` key | — | `Hello! 👋 What can I help you with today?` |
  | `"agent": "uf-set-probe"` | — | `BANANA` |
  | `"agent": "uf-set-probe"` | `--agent uf-set-probe2` | `CHERRY` |
  | `"agent": "uf-set-probe"` | `--agents '{"uf-offered":{…}}'` | `BANANA` |
  | `"agent": "uf-set-typo"` | — | `Hello! 👋 …`, exit 0 |

  So the key is real, the flag outranks it as documented, the **plural** flag
  does not, and an unresolvable value is *silently ignored* — the opposite
  direction from `--agent`, which answered `--agent 'uf-set-typo' not found.
  Available agents: claude, Explore, general-purpose, Plan, statusline-setup,
  uf-set-probe` and exited 1 before any API call against the same directory.
  What that leaves: every door in this app that names an agent emits `--agent`
  and wins, so what the key reaches is every child started as *nobody* — an
  agentless run, every chat turn, every review (`spawnAssist` is the plural-flag
  caller), and an orchestrator block whose node names none. It is recorded rather
  than declared; see the entry below for why and for what declaring it would
  take.

## Not yet verified by hand

The live-enforcement and pause/resume paths typecheck, build (including the
standalone bundle), and are covered by the unit tests above, but the following
have **not** been exercised against a real CLI. They are the list to work
through before trusting this unattended:

- **The audit trail in a browser and in SQLite.** All five creation paths and
  the request wrapper are driven under `npm test` against a throwaway database
  — including that a body, a query string and a cookie holding a token leave
  nothing behind — but nothing has been read off a *running* install. What has
  not happened: the origin line rendered on a run page, and the query the issue
  names run against a real database. Before trusting it:

  ```
  sqlite3 "$DATA_DIR/usagefoundry.db" \
    "SELECT origin, count(*) FROM runs GROUP BY origin;"
  sqlite3 "$DATA_DIR/usagefoundry.db" \
    "SELECT ts, method, path, status, subject, actor, address FROM request_log
       ORDER BY id DESC LIMIT 20;"
  ```

  and confirm no row of the second carries anything that is not on that list.
  Runs created before this landed read `origin` NULL, and the run page says so
  in words rather than guessing.
- **`/api/status` against a real fleet, and the structured lines on real
  stdout.** The route is driven by `npm test` against a seeded database — the
  counts, the documented keys, the read-only credential, the absence of prompts,
  paths and tokens, and a checkout store's bytes — but every one of those is a
  throwaway directory with six rows in it. What has **not** happened is a poll
  against an install with runs in flight, so the cost of the snapshot and the
  checkout walk at that size is reasoned from the cap and the five-minute cache
  rather than measured. Nor has any browser rendered the restart banner on the
  runs page, and no monitoring system has scraped a single JSON line. Before
  trusting it:

  ```
  curl -s -H "Authorization: Bearer $UF_STATUS_TOKEN" \
    http://127.0.0.1:3000/api/status | jq .
  docker logs usagefoundry --since 1h | grep '^{' | jq -c .
  ```

  and confirm that no line carries a prompt, a folder path or a token, and that
  `stores.partial` is false (or that the figure is understood as a floor when it
  is not).
- **The container's `HEALTHCHECK`.** `GET /api/health` is driven in both
  directions by `npm test` — 200 with counts, and 503 with the database handle
  throwing — and `src/lib/deployment.test.ts` pins the `HEALTHCHECK` directive
  against the route it names. What has **not** happened is Docker running it:
  the container was never built, so no `docker inspect` has reported a health
  status and the `${PORT}` expansion inside the `CMD` has not been watched
  working. Before trusting it:

  ```
  docker compose up -d --build
  docker inspect --format '{{json .State.Health}}' usagefoundry     # expect Status "healthy"
  curl -sf http://127.0.0.1:3000/api/health | jq .
  docker exec usagefoundry sh -c 'kill -STOP 1'                     # wedge it
  docker inspect --format '{{.State.Health.Status}}' usagefoundry   # expect "unhealthy" within ~3 min
  ```

  Note what the last step does *not* do: Docker Engine surfaces the unhealthy
  state and does not act on it — `restart: unless-stopped` restarts on process
  exit only. Wiring a restart to it is the operator's own supervisor or
  orchestrator, and the Dockerfile comment says why that is left to them.
- **Every install-wide control, in a browser or against a real fleet.**
  `fleet.test.ts` drives `stopFleet` against a real database — the four live
  statuses, the ordering that blocks a waiting run before the run it waits on is
  stopped, and the `fleet` halt cause on the instance row — and a case per
  creation site proves the hold suppresses `promoteQueued`,
  `releaseDependents`, `emitBlockRuns` and `tickSchedules`. `npm run typecheck`
  and `npm test` both pass. What has **not** happened is any of it against a
  live child: no run with a real `claude` process has been signalled by
  `stopFleet` (the test process registers no children, so every live run there
  answers `cancelled` rather than `signalled`, and the kill ladder itself is
  `stopRun`'s existing path reached through a new caller), no browser has
  rendered the Fleet card or its two sheets, and the bulk pick-up has never
  reopened a real run. The run it was written in has no Docker, so
  `docker compose up --build` was not run either. Before trusting it: start two
  or three cheap runs, press **Stop everything**, and confirm each run page says
  it was stopped *with every run in flight*; then press **Hold new work**,
  submit a run, and confirm it sits `queued` with the dashboard saying so in
  words; then **Resume new work** and confirm it starts without a restart.
- **Per-repository cost, in a browser.** `groupRunSpend` is unit-tested for the
  two cases that fail silently — two mounts onto one host directory rolling up
  as one repository, and a run with no repository landing in its own bucket
  rather than being dropped — plus that the rows add to the total over the same
  span. No browser has rendered the card, and the figures have never been read
  against a real multi-repository install. Before trusting them to apportion
  anything: check the card's total against the sum of `runs.spent_usd` for the
  same span (`sqlite3 .data/usagefoundry.db "SELECT SUM(spent_usd) FROM runs
  WHERE created_at >= …"`), and confirm a run started outside a git repository
  appears in `(not a repository)` rather than nowhere.
- **The branches page's filter and pager, against a database past 400 runs.**
  `selectBranchCandidates` is unit-tested for the count over the whole set, for
  paging by branch rather than by run, for a chain collapsing to one row before
  the slice and for the cap holding whatever is asked for. What has not
  happened is a request against a real inventory: no browser has rendered the
  repository picker or the Previous/Next pair, and the claim that the
  per-request git cost is unchanged rests on the cap in the code rather than on
  a measurement. Before trusting it: `curl -s
  'localhost:3000/api/branches?offset=60' | jq '.branches | length, .total,
  .notShown'` against a database with more than sixty branches, and the same
  with `repo=` set to one of the roots in `.repos`.
- **The whole privilege split, which is every part of it that matters.** The
  server now runs as root and drops each child to `UF_AGENT_UID`; `/data` is
  root-owned 0700 and reclaimed by an entrypoint; the MCP capability leaves
  `/tmp`; the telemetry exporter carries a per-run capability instead of
  `UF_AUTH_TOKEN`. `npm run typecheck` and `npm test` pass, the decision
  (`resolveChildCredentials`), the compose/Dockerfile pair, the capability file
  and `telemetryEnv` are all unit-tested, and **no container has been built or
  started**: the run this was written in has no Docker at all. Nothing below is
  reasoning about a design — it is reasoning about whether the design runs.

  Build and start it, then:

  ```sh
  docker compose up --build -d
  docker compose logs usagefoundry | grep 'privilege separation'
  # expect "on: children run as 1000:1000, server as 0"

  # #79 — the server's environment
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
    'tr "\0" "\n" < /proc/$(pgrep -f "next-server" | head -1)/environ | grep -c UF_'
  # expect a permission error, not a count

  # #80 — the database, on a fresh volume and on an upgraded one
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
    'test -w /data/usagefoundry.db && echo BAD-writable || echo ok'
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
    'test -w /data/server.lock && echo BAD-writable || echo ok'

  # #87 — a capability in flight, with a run working and a chat turn sent
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
    'ls /tmp/uf-mcp-* 2>/dev/null; ls /run/uf-mcp 2>/dev/null; echo "exit=$?"'
  # expect nothing from the first and a permission error from the second

  # #83 — with UF_AUTH_TOKEN set and a run under live enforcement
  #   task the agent with:  env | grep OTEL_EXPORTER_OTLP_HEADERS
  # expect a bearer that is not UF_AUTH_TOKEN, and telemetry still on the
  # run page and the dashboard card
  ```

  Then the half that is not a permission check, and is the way this breaks if
  it breaks: **a run still has to work**. Start an isolated run on a git
  repository and confirm it commits — that is `git worktree add`, the
  `.uf-worktrees` store and `seedWorktree`'s copies all going through
  `chownForChild`, and a `git commit` inside the operator's own `.git` as the
  dropped uid. Then a non-isolated run in a plain folder, a review, a chat turn
  and a merge from the queue. The specific unknown worth naming: **macOS Docker
  Desktop**, whose bind-mount ownership remapping was written for a container
  whose *process* is the mounted uid, and which now sees a root process
  spawning children that are not. If writes fail there, the arrangement to
  compare against is `user: "${UF_UID:-1000}:${UF_GID:-1000}"` with
  `UF_AGENT_UID`/`UF_AGENT_GID` cleared, which is the previous behaviour whole
  and which the app detects and reports at boot.

  Two things are known-not-closed rather than unverified, and are in
  `docs/security.md` rather than here: an agent can still read
  `~/.claude/.credentials.json` (it is what a work cycle bills against), and a
  sibling agent can still read a live MCP capability's path out of
  `/proc/<pid>/cmdline`. Both need a second Claude credential to close.

  One thing that is *not* on this list and used to be: `npm run build` failing
  on a clean tree with `TypeError: generate is not a function`. That is the
  inherited `__NEXT_PRIVATE_STANDALONE_CONFIG` trap described further down, not
  the privilege split and not this repository — build with `env -u
  __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` before reading a build
  failure here as evidence about anything above.
- **The work-cycle deadline against a real `claude`.** What *is* pinned is the
  mechanism: `src/lib/cycleDeadline.test.ts` drives `runIteration` against a real
  child that prints nothing and never exits, and asserts that the promise settles,
  that the child was signalled rather than left to its own way out, and that the
  reason reaches the run log — with a control that keeps a child printing every
  100ms alive past the same deadline, which is what says the clock is silence
  rather than wall time. Both were watched to fail with the watchdog disabled.
  What has **not** happened is any of it against Claude Code itself: no real
  `claude` has been observed hanging, so whether one that does is reaped by
  `SIGINT` (and still prints its `result` event, which is the difference between
  the cycle's cost being measured and being reconciled) or only by the `SIGKILL`
  eight seconds later is unknown, and the 120-minute default has been reasoned
  about rather than measured against a real workload's quiet stretches. Docker is
  not available in the environment this was written in, so the container path is
  unrun: `docker compose up --build`, then start a run whose task blocks — a task
  that runs `sleep 100000` inside a tool call is the shape it was written for —
  with **Silent cycle limit** set to five minutes, and confirm the run ends
  `failed` naming the deadline, that its folder frees, and that a queued run
  behind it starts.
- **The container's own resource limits.** `docker-compose.yml` now declares
  `mem_limit: ${UF_MEM_LIMIT:-10g}` and `pids_limit: ${UF_PIDS_LIMIT:-2048}`,
  and neither has been applied by a real Docker: the run that added them had no
  Docker at all, so what is here is the compose file parsing correctly by eye
  and nothing more. The per-child memory figures README's sizing table is built
  from are **estimates** and not measurements — the reasoning is that a `claude`
  child is a Node process and a work cycle's agent starts builds inside the same
  cgroup, which sets the shape of the arithmetic but not its constants. Before
  trusting the numbers: `docker compose up -d`, then
  `docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}' usagefoundry`
  to confirm the limits were applied at all, then start runs up to the
  configured cap and watch `docker stats` for the real per-run footprint. The
  recovery half is worth exercising once too: set `UF_MEM_LIMIT` deliberately
  low, fill the fleet, and confirm the container is OOM-killed, restarted by
  `restart: unless-stopped`, and that `reconcileOnBoot` closes out the runs it
  was carrying rather than leaving folders claimed.
- **The process budget refusing a real child.** `liveAssistChildren`,
  `assistBudgetRefusal` and the deferral of a workflow block are covered by
  `src/lib/assistBudget.test.ts` against a real database, and `npm run
  typecheck` and `npm test` pass — but no browser has seen the refusal, and no
  workflow block has actually been deferred and then woken. The wake is the part
  worth watching: a block over the budget is left `waiting` rather than failed,
  and what un-sticks it is `advanceInstances` being called when a review or a
  chat turn settles. Before trusting it: set *Other Claude processes at the same
  time* to 1, start a workflow whose orchestrator block is behind something
  slow, open a chat and send a turn, and confirm the block sits `waiting` while
  the chat is thinking and starts deciding within a moment of the chat settling.
- **A failed tool result reaching the run page.** `toolResultFailures` is unit-
  tested and `npm run typecheck` passes, and the `user`/`tool_result` shape it
  reads was taken from real transcripts written by the pinned CLI (2.1.226) —
  both the string `content` and the array-of-blocks one, with `is_error: true`
  on each. What has **not** happened is a live `stream-json` stream reaching
  this branch: transcripts are the *persisted* form of those messages, so that
  `parent_tool_use_id` sits on the envelope of a forwarded one is still the
  assumption the `subagent` branch already makes, and no browser has rendered a
  `tool_error` row. Before trusting it: start a run whose task fails a command
  on purpose (`git push` to a repository the token cannot reach is the case it
  was written for) and confirm the log shows one danger row naming the tool,
  the command and the error — and that a run whose commands all work gains no
  new rows at all.
- **The whole of "The agent's own report" above — including that it compiles.**
  It was written by a run whose permission allowlist carried no `npm`, so
  `npm run typecheck`, `npm test` and `npm run build` were never executed against
  `src/lib/cycles.ts`, `src/components/Markdown.tsx`,
  `src/components/RunOutput.tsx` or their two test files. They were read for type
  errors by hand and by nothing else, and no browser has rendered the card. The
  same run could not reach `gh`, so the issue it was written from was never read
  either — what is here follows the task text's summary of it. Run the three
  commands and open one finished run's page before trusting any of it.
- **Every part of a workflow schedule that is not the decision function.**
  `decideSchedule`, `nextOccurrence`, `normalizeScheduleInput` and
  `scheduleRefusal` are unit-tested — including a missed window, an overlap
  refusal, a paused schedule and both DST boundaries in Europe/Berlin — and
  `npm run typecheck`, `npm test` and `npm run build` all pass. What has **not**
  happened is a clock reaching a fire time: no schedule has ever actually
  started a workflow, no browser has rendered the schedule card or its form, and
  `reconcileSchedulesOnBoot` has not been watched closing out a real missed
  window across a container restart. The run it was written in has no Docker, so
  the restart path in particular is reasoning plus a unit test and nothing else.
  Before trusting it unattended: set a schedule a few minutes out on a cheap
  workflow, watch it fire once, then stop the container over the next occurrence
  and confirm the card says *missed* and that nothing started on boot.
- **The Usage by period card in a browser.** The rollup behind it was exercised
  against 9,200 real turns (see *Verified*) and `npm run typecheck` and
  `npm test` both pass, but no browser has rendered it: the sandbox it was
  written in cannot execute Next's edge runtime at all (`EvalError: Code
  generation from strings disallowed`, the same limitation noted below for
  `/api/mcp`), which takes `next build` and every page request with it. What
  has not been seen is the layout — the tab strip beside the card title at a
  narrow width, a fourteen-row daily table, and a meter reading 798% of a
  pro-rated day, which is a real figure from those transcripts and clamps to a
  full bar.
- Whether `claude -p` flushes its `result` event on `SIGINT`. If it does, an
  interrupted cycle keeps its measured cost and the transcript reconciliation
  becomes a fallback rather than the norm.
- **A work cycle actually stopping at its `--max-budget-usd` ceiling.**
  `buildArgs` now hands each cycle what is left of `maxRunCostUSD`, and the loop
  ends the run on `result.subtype === "error_max_budget_usd"`. The argv is
  unit-tested in both directions and `npm run typecheck` and `npm test` pass,
  but no billed cycle has been run into the ceiling. Two things are reasoned
  rather than measured: that the pinned CLI honours the flag on a `-p` run at
  all — evidenced by `chat.ts` passing it to the same binary, and by the subtype
  already being named in this repository as one it emits — and *how far past*
  the ceiling a cycle gets before the CLI notices, which the acceptance
  criterion assumes is one model turn and which nothing here has watched. Also
  unseen: what the CLI writes into `result.result` when it stops for this
  reason. Nothing depends on that text — the subtype is what the loop reads,
  deliberately, and it is read before `isUsageLimit` ever sees the sentence —
  but it is what the operator ends up reading in the run log. Set
  `maxRunCostUSD` to something small on a task that will exceed it in one cycle,
  and confirm the run ends `stopped` naming the spending limit rather than
  `failed`, and that it does not park.
- **The chat's `/api/mcp` middleware exemption under an actual `UF_AUTH_TOKEN`.**
  The end-to-end run above was done with auth off, because the sandbox it was
  done in cannot execute Next's edge runtime at all (`EvalError: Code generation
  from strings disallowed`), which takes `middleware.ts` out of the picture along
  with the exemption. The capability check in the route itself is what was
  exercised — every tool call carried one and was accepted. What has *not* been
  watched is a token-protected deployment letting an unauthenticated `/api/mcp`
  request through to that check. Worth ten minutes with `UF_AUTH_TOKEN` set
  before trusting it, since the failure mode if the exemption is wrong in the
  other direction is a chat whose every tool call 401s.
- **The chat against a repository with a large number of open issues.**
  `MAX_PENDING_PROPOSALS` (25) and `MAX_REMOTES_READ` (25) were reasoned about
  rather than hit. What a chat does when it reaches the proposal cap mid-answer —
  whether it reports the refusal usefully or simply stops — has not been seen.
- **Ordered proposals and proposed workflows, against a real CLI.**
  `planApprovalBatch` (the creation order and what each proposal resolves to) and
  `planWorkflowProposal` / `summarizeProposedGraph` (what a graph becomes and
  what the card shows) are unit tested, including the cascade behind an
  unresolvable label, a loop among the proposals, a duplicate label and a
  template deleted between the proposal and the click. The storage round trip —
  the five columns `migrate()` adds and the JSON `proposalDeps` reads back — is
  pinned against a temporary database. What has not happened is a real turn:
  no CLI has called `propose_workflow` or passed a `dependsOn`, so the shape of
  the tool schemas is unproven in the one way that matters. Three things to
  watch. Whether the model reaches for `dependsOn` where the folder claim
  already serialises the work, which buys a slower queue for nothing; whether it
  proposes an orchestrator block where two run blocks would have done, since that
  is the one block whose runs nobody approves individually; and whether a
  workflow card with eight blocks is still read rather than scrolled past, which
  is the whole basis for letting a model write a graph at all.
- **The chat's inspection tools, and proposals with no template.** `get_run`,
  `get_run_diff`, `get_usage`, `list_proposals` and `save_template` answer from
  the same functions the pages already use, and they typecheck — but no real CLI
  has called one. Two things to watch. Whether a turn asked about three runs
  stays inside `chatTurnBudgetUSD` now that a single tool call can return 60KB
  of patch; and whether the untemplated path gets used where a template would
  have been better, since it is the branch with no form behind it and its guard
  set is the one thing on a proposal card an operator has to *read* rather than
  recognise.
- **That an unrestricted chat stays an orchestrator.** It now runs
  `bypassPermissions` with no tool list, so the only thing stopping it fixing a
  one-line bug itself — in a checkout you may also be working in — is the
  paragraph in `systemPrompt()` telling it that its job is to look and propose.
  That has not been tested against a real CLI, and it is the assumption this
  whole feature now rests on. Two things to watch, both of which show up as a
  dirty working tree rather than as an error: whether it edits when a fix is
  smaller than the proposal describing it, and whether it runs `git` writes
  while investigating (it has the credentials to push, since `githubEnv()`
  reaches this child).
- **Stopping a whole workflow instance against real runs.** `haltPlan` — which
  members a stop selects and what each becomes — is unit tested over an instance
  holding one running, one queued, one parked, one waiting, one completed and one
  failed block, plus a stop arriving mid-instantiation and a second stop on an
  instance already stopping. The writes around it typecheck and nothing else has
  been exercised: no child has been signalled by `stopInstance`, and the sandbox
  it was written in cannot run this app at all — `npm run dev` starts and every
  request 500s with `EvalError: Code generation from strings disallowed`, the
  same edge-runtime limitation noted above for `/api/mcp` and the period card,
  which takes `instrumentation.ts` and the middleware with it. What a human
  should run, against a scratch `DATA_DIR`, `CLAUDE_HOME` and workspace, with
  `CLAUDE_BIN` pointed at a stub that speaks `stream-json` and stays alive:

  ```bash
  docker compose up --build          # or: npm run dev, where the edge runtime works
  # Settings → 1 concurrent run, so one block queues behind another.
  # Save a workflow: a quick block, a slow one, a second slow one, and a fourth
  # set to start after the first slow one. Press Run, wait for one `running`,
  # one `queued` and one `waiting`, then press Stop all.
  ```

  Five things to watch, none of which the unit test can see. That the signalled
  child actually dies and its run lands `stopped` rather than `failed` — a
  SIGTERM'd child closes with a null code that reads as `-1`, and the `cancelled`
  check ahead of the exit-code test is what keeps a deliberate stop from being
  filed as a crash. That a killed cycle's spend arrives in `spent_usd_est` and
  not in `spent_usd`. That the block which was `waiting` reads `blocked` with a
  reason naming the workflow, and that nothing was promoted into `running` on the
  way out. That a stopped run's uncommitted work is still in its checkout
  afterwards, offered by the run page's Commit under that run's own branch. And
  that neither halted block can be restarted from its own run page: no *Try
  again* on the one that was waiting, no *Resume* on the one that was stopped,
  and `POST /api/runs/<id>/reopen` against either answers 400 naming the
  workflow. That last one is unit tested against the database — `stopInstance`,
  then `reopenRun` and `reviveBlockedDependents` — but the page's own gate is
  only typechecked.
- **A workflow-wide budget tripping against real spend.**
  `evaluateInstanceBudget` is unit tested over the cap unreached, reached
  exactly, reached only once a block's in-flight cycle is counted, reached on
  reconciled estimates alone with `spent_usd` still at zero, a fraction guard
  with no ceiling, a fraction guard satisfied by the provider's own percentage
  with no ceiling configured, a window that falls back under the guard after
  tripping, and the ordering that reports spend ahead of a window. What is *not*
  exercised is any of the machinery around it: no instance has been halted by a
  guard rather than by a person, and `instanceSpend` has never summed a real
  `otlp_requests` row. Same sandbox limitation as the entry above. What a human
  should run, on the same stub setup:

  ```bash
  # Save a two-block workflow with a workflow spending limit of about half
  # what one block costs, and both blocks set to several work cycles.
  # Press Run and watch the instance page.
  ```

  Four things to watch. That the second block never starts, and that the first
  one is halted at a cycle boundary with the instance recording *stopped by its
  budget guard* rather than *by you*. That the guard's figure on the instance
  page moves **during** a cycle and the measured one does not — that gap is the
  telemetry door, and a guard reading zero because nothing arrived looks exactly
  like a guard that was never reached. That `runs.spent_usd` still sums to what
  the CLIs reported, with the estimate beside it and not inside it. And that a
  workflow saved with a fraction guard and no ceiling is refused **at Run**, by
  name, rather than starting and halting a moment later.
- **An orchestrator block, end to end.** Nothing about it has been run. The two
  decisions are unit tested — `planEmission` over the cap on both sides, a
  folder the mount check refuses, a spec graph that loops, a dependency naming a
  run outside the emission, and an empty emission; `planInstanceStep` over a
  block spawning, a block held while its runs are still going, the fan-in onto
  every run that was emitted, an empty emission cascading down a chain with one
  sentence per link, and a node that is already a run never being created twice
  — and `npm run typecheck` and `npm test` pass. Everything around them
  typechecks and has never executed: no `claude` child has been spawned by
  `startBlockTurn`, no `emit_runs` call has reached `/api/mcp`, and no run has
  been created by a block. Same sandbox limitation as the two entries above, and
  Docker is unavailable here as well. What a human should run, against a scratch
  `DATA_DIR`, `CLAUDE_HOME` and workspace:

  ```bash
  docker compose up --build          # or: npm run dev, where the edge runtime works
  # Save a workflow: one orchestrator block over a repo with a few obvious
  # small jobs in it, fan-out 2, under a template you trust; then one ordinary
  # block set to start after it. Press Run and watch the instance page.
  ```

  Six things to watch, none of which the unit tests can see. That the block's
  turn is offered `emit_runs` and *not* `propose_run` — `tools/list` is per
  subject, and a block that can propose is a block whose work stops at a card
  nobody will click. That what it emits actually starts, under the template's
  guards and not something else: check the run's permission mode and budget
  against the template rather than against the block's brief. That a folder
  outside the block's workspace comes back to the model as a sentence it can act
  on rather than as a failed run. That the block behind it is created only once
  every emitted run has settled, and is `blocked` with a naming reason if the
  block emitted nothing. That the block's own cost lands on the block row and in
  the instance total, and nowhere near `runs.spent_usd` or the dashboard meters.
  And that *Stop all* while the block is still deciding kills that child and
  leaves no run created afterwards — the guarded UPDATEs are what should refuse
  a late emission, and a run appearing after the page says *stopped* is the
  failure this whole ordering exists to prevent.

  Seventh, added after the first thing an operator hit was that a block ran,
  started nothing and left no account of it: that the block's **reply** is on
  the instance page, and that a refused `emit_runs` shows up there as its own
  line. `blockSettlement` is unit tested — the reply kept, a failed turn's text
  recorded as the failure rather than twice, a turn that emitted before failing
  *not* written off as `failed`, notes taken during the turn surviving the
  settle, denials deduplicated — and the two places that write a note during a
  turn have not executed. Worth checking against a real turn that the reply is
  non-empty (the CLI's `result` field, read by `parseTurnOutput`), and that a
  block given a folder outside its workspace ends with both the refusal line and
  whatever the model said about giving up.

  Eighth, and the same shape of gap one level on: that the runs a block started
  are **watchable** from the instance page. They were always listed, mixed into
  the graph's own blocks with a *started by* line; they now have their own table,
  each row carrying the folder the model chose within the block's mount, when the
  run started, and the cycle it has open — `fmtCycleInFlight`, without which a
  run tens of minutes into its first cycle reads `0/1` and `$0.00`, which is what
  a run that was marked running and never started reads. All of that typechecks
  and no browser has rendered it. Three things to watch against a real fan-out:
  that the folder line names the folder the run is actually in (an emitted run is
  the one case where that is not derivable from the saved graph), that a run
  working right now shows its cycle in flight and a finished one shows none, and
  that the count under *Runs* on the workflow page moves as the block emits — it
  is the number of runs the instance holds, which for a graph with an
  orchestrator block in it is not the number of blocks.
- **Stopping a chat turn, in either of its two forms.** `staleTurn` is unit
  tested and the rest typechecks, but no real CLI child has been signalled by
  `cancelChatTurn` and no sweep has fired against a live row. Two things to
  watch. Whether the SIGINT/SIGTERM/SIGKILL ladder actually reaches a chat
  child's whole process group the way it does an agent's — the chat spawns
  `detached` under the same `killProcessGroup` setting, so it should, but the
  agent path is the one that has been watched. And whether the sweeper ever
  fires on a turn that was merely slow: it waits a minute past the ten-minute
  bound, and the in-closure timer should have settled the row long before, so an
  entry saying the chat "did not answer within 10 minutes" that arrives with no
  preceding kill means the two paths disagree about when a turn began. Putting a
  row into `thinking` by hand (`sqlite3 $DATA_DIR/usagefoundry.db "update
  chat_sessions set status='thinking', turn_started_at=… where id=…"`) and
  loading `/chat` exercises the no-child half of both without spending anything.
- **The `chat_proposals` rebuild on a database that predates it.** Dropping the
  NOT NULL from `template_id` needs a table rebuild, which was exercised against
  SQLite directly — rows preserved, index recreated, foreign key and its cascade
  intact, a null `template_id` accepted afterwards — but not through
  better-sqlite3 in a running container, because the environment it was written
  in has a native module built for another platform. The first `docker compose
  up` on an existing `.data` is the test. What *is* now covered, through
  better-sqlite3 and the real `open()`/`migrate()` path, is the **interruption**:
  `schemaMigration.test.ts` drives the rebuild with a throw injected after each
  statement in turn and asserts every row survives, and it puts the on-disk
  residue of a pre-transaction crash (the renamed table) in front of a second
  boot and asserts the rows come back. The happy path on a real upgraded volume
  is still the part nobody has watched.
- **The derived 5-hour boundary against a live `/usage` reading.** Removing the
  hour rounding was argued from the CLI's own header handling and rendering, not
  from watching the two side by side, and what is left over — the opening turn's
  latency, and any window opened by a surface with no local transcript — has
  never been measured against the real reset time. A residual offset that is
  *steady* is the tell that the rule is still wrong somewhere; one that varies
  run to run is the invisible usage this app already documents. Until someone
  compares them, the override in Settings is the answer to a disagreement.
- **What a subscription-limit refusal actually says.** The `<synthetic>` marker
  is confirmed from a real record on this machine, but the only refusal ever
  seen here is `Not logged in · Please run /login`. The wording `isUsageLimit()`
  matches was read out of the shipped binary's own strings, not observed on the
  wire, and the `usage limit reached|<epoch>` form the ecosystem keys on is not
  in that binary at all. A refusal it fails to classify still reports honestly —
  it just fails instead of waiting. The `error` run event records the text, the
  exit code and whether the pattern matched, so the first real occurrence is
  enough to correct it.
- Whether a refusal ever arrives on stderr alone rather than as a `<synthetic>`
  assistant turn. `refusalInStderr` covers that case but has never fired.
- **What a dropped stream does to the cycle around it.** The five sentences
  `isTransientApiError` matches were read out of the shipped binary's own
  strings, and one of them (`Connection closed mid-response`) is confirmed from
  a real run — which this app then filed as `failed`. The binary also shows the
  CLI finalising a partial response and carrying on rather than aborting, which
  is why a cycle that still reports success is now treated as having recovered.
  What has not been watched end to end is which of the two paths that real run
  actually took, or whether `--resume` accepts a session a drop truncated
  mid-turn — and so whether a retry carries on or lands in the resume-failure
  ladder above. Every outcome is recorded either way: a recovery is a log line
  naming the error, each retry is an `error` event carrying its backoff, and the
  stop reason names the attempt count if all of them fail.
- Whether `claude --resume` accepts a session whose transcript was truncated by
  a mid-turn kill. The recovery ladder retries once and then stops, naming the
  command — it deliberately does not start a fresh session. That ladder now also
  covers a run picked up by hand rather than only one coming back from a pause,
  which makes this the failure an operator is most likely to meet: a run that
  cannot be resumed cannot be reopened into either, and the manual command is
  the only way out of it.
- **Switching threads in the Orchestrator, in a browser.** The proposal
  selection is now cleared where the "Earlier chats" button switches thread, and
  a batch whose ids are none of the target chat's is a 400 naming which of them
  belong to another thread rather than a 200 claiming they were already decided.
  The sentence that refusal is written with is unit-tested; the click that
  produces it, and the red banner the page then shows, have not been watched.
- **Which session id `claude -p --resume <id>` reports back.** Every cycle's
  stream is read for one and the run adopts it; a value differing from the one
  passed to `--resume` is written to the run log and otherwise treated as
  normal, because nothing here has watched a real resume on the wire. If it
  turns out the CLI always mints a fresh id, that line is noise and should
  become a debug-level detail rather than a log entry per resumed cycle.
- Whether a session id reported by an `init` event that is then killed seconds
  later is resumable at all. It is now persisted, so such a run is reopened as a
  continuation rather than a restart — which is the point — but the conversation
  it attaches to holds only the original task, and a continuation prompt that
  restates nothing is relying on that first user turn having been flushed.
- A run parking and resuming across a real 5-hour boundary, in the same
  worktree, on the same branch, with its commits intact.
- A paused run surviving `docker compose restart`, and a stale one being closed
  out once past `resumeGraceHours`.
- A parked run taking its folder back: that it stays parked while the run that
  took the folder is still working, and starts within a sweep of that one
  finishing. The hand-over in the other direction — a new run starting straight
  away instead of queuing — was reproduced against the live container.
- Resuming a finished run into a real agent: that `--resume` picks the session
  back up, and that an isolated one lands in its own checkout still on its own
  branch. The refusals around it — an exhausted cycle or spend limit, a checkout
  another run has taken — were checked against the live container.
- Picking a `completed` run back up with a follow-up message: that the note
  arrives as the next turn of the same conversation rather than as a new task,
  and that leaving it blank sends the DONE pushback only to a run whose agent
  really replied `DONE` — a run that merely used up its work cycles gets the
  continuation. The branch that decides this is unit-tested, and the column it
  reads was watched being written end to end against a *stub* CLI printing the
  two `stream-json` events the loop reads. Neither the recording nor the
  delivery has been through a real `claude`.
- `detached: true`: that Ctrl-C during `npm run dev` still kills the agent (via
  the new `instrumentation.ts` handler) and that a long command the agent
  started dies with it.
- **A review or a conflict resolution against the real CLI.** The spawn, the flags, the JSON result shape
  and the accounting were exercised with a stub that prints the same object the
  `stream-json` `result` event carries — but no real `claude -p … --output-format
  json --permission-mode plan` has been run through this path, so neither the
  quality of the review nor `plan` mode's behaviour in print mode is confirmed.
  The same goes for whether a real agent under `acceptEdits` resolves conflict
  markers well; that it cannot get a bad resolution *committed* is verified.
- Landing inside the container, where git is 2.39 rather than the 2.50 the
  scratch repositories above were driven with. `merge-tree --write-tree` and its
  conflict format both date from 2.38, and an older git is reported rather than
  guessed at, but that path has not been run against 2.39 itself. The conflict
  *types* are the part most likely to differ: they come from the `-z`
  informational records, whose field layout was captured from 2.50. A 2.39 that
  writes them differently loses the type and the explanation and still lists
  every conflicting file, because that list comes from the stage records — but
  which of those two happens on 2.39 is unconfirmed.
- A repository large enough to hit the diff's size budget in the wild.
- **Committing and purging through the app itself.** The two git formats they
  turn on are confirmed against 2.39.5 above, and the three decisions
  (`parseStatusZ`, `commitRefusal`, `purgeRefusal`) are unit-tested — but no
  branch has been committed to or purged through a running server, so the
  wiring in between is unconfirmed: whether the leftovers a real agent leaves
  come back as the list the card renders, whether the commit satisfies
  `ensureWorktree`'s reuse check on the next run into that slot, and whether a
  purged slot is re-created cleanly rather than tripping the "checkout is gone"
  guard for a run that had already worked in it. That entry used to add that
  `next build` could not be run at all, failing with `TypeError: generate is not
  a function` on the unmodified tree — which was true and was **not** about this
  repository. That error is `config.generateBuildId` being undefined, and it is
  undefined because a run started from inside a UsageFoundry container inherits
  `__NEXT_PRIVATE_STANDALONE_CONFIG` from the server supervising it: `loadConfig`
  returns that JSON verbatim instead of loading `next.config.ts` and applying
  defaults, and a serialized config cannot carry a function. `env -u
  __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` builds cleanly, standalone
  output included. Worth knowing before reading a build failure in any run this
  app spawns as evidence about the tree — the same class of trap as the bare
  `npm ci` that silently skips devDependencies under this image's
  `NODE_ENV=production`.
- **The Live from runs card in a browser, fed by a real telemetry-enabled run.**
  Its query was driven against a real database through the real ingest route and
  its markup was rendered and read, but the batches were synthesised from the
  captured payload rather than pushed by a live `claude -p`, and the card has
  not been *looked at* on the page. What that leaves unconfirmed is how it reads
  next to the meters — whether the separation is as plain on screen as it is in
  the copy — and whether the figure visibly moves during a single work cycle at
  the 5s poll.
- **The in-flight cycle line on a real run.** `runs.active_iteration` is written
  at the spawn and cleared when the cycle returns, and `fmtCycleInFlight` is
  unit-tested for every branch including the stale-row one — but no agent has
  been started through a running server to watch the card go from nothing to
  "cycle 1 of 2 in flight" and back to a plain count between cycles. Two things
  to watch: that the line disappears during the pre-cycle transcript scan rather
  than lingering over finished work, and that a run killed with the container
  down comes back reading `failed` with no cycle claimed. Start a run and open
  `/runs` during cycle 1.
- The new-run form's template UI driven through a browser: that loading a
  template fills every field, that *Start another like this* pre-fills from a
  run without the folder and settings loaders racing it, and that the two
  banners — a carried live-enforcement mode, a carried `bypassPermissions` —
  appear on load and clear when the control is touched. The routes underneath
  were exercised directly; only the client wiring is unconfirmed.
- The *Earlier chats* rows in a browser. Each one is now two lines — a
  truncating title, then the time and a *waiting* badge — because a single
  truncated line in the 360px column was all title. The metadata sits outside
  the truncating element and every utility it needs is in the built stylesheet,
  but no browser has rendered it at that width, so how the two-line rows read
  against the 6px gap between them is unmeasured.
- **The image with `gh` in it.** The install layer, the checksum check and the
  arch mapping have not been built — no Docker on the machine this was written
  on — so `docker compose up --build` is the first thing to run against this.
- A real agent using the token: a `git push` of a run's branch, and a `gh` call
  that needs authentication. The credential block itself was driven into a real
  git (above); what has not been watched is the CLI's own git picking it up out
  of the environment mid-run.
- The chat page recovering from a dropped request, in a browser. That a rejected
  `fetch` comes back as a result rather than a rejection is unit-tested, and the
  `finally` that clears `busy` is plain control flow — but nobody has stopped the
  server, pressed Send, and watched the composer, Approve, Reject and Select-all
  stay usable with the reason on screen.
- **The chat page's failed-poll notice in a browser.** A poll that fails now
  puts a sentence on the page and stops the thread claiming to be thinking, and
  the sentence itself is unit-tested — but no browser has been pointed at a
  stopped server or at a `UF_AUTH_TOKEN` deployment with the `uf_session` cookie
  deleted, which are the two reproductions. What that leaves unconfirmed is the
  client wiring rather than the copy: that the notice appears within one poll,
  that it clears on the next successful one, and that a page opened while the
  server is down recovers by itself once the server is back.
- The chat page's "Earlier chats" list going stale-free in a browser. The route
  it polls now answers with the list, and that is unit-tested against the
  handler itself — what has not been watched is the sidebar picking up a title
  and a waiting count on the 10s poll without a reload.
- **That a fresh `usagefoundry-data` volume is writable under a non-1000
  `UF_UID`.** The image marks `/data` mode 0777 so that Docker copies a
  world-writable root onto the volume when it first creates it; that Docker does
  copy the mount point's mode and not only its ownership is the step this rests
  on, and no `docker build` has been run since the change — Docker was not
  available on the machine it was made on. `src/lib/deployment.test.ts` pins the
  image and compose halves against each other, which is a different claim. The
  check is four commands, on a Linux host where `id -u` is not 1000:

  ```bash
  UF_UID=1001 UF_GID=1001 UF_PORT=3100 UF_CONTAINER_NAME=usagefoundry-uidtest \
    docker compose -p uf-uidtest up --build -d
  docker compose -p uf-uidtest exec usagefoundry ls -ld /data   # expect drwxrwxrwx
  curl -fsS localhost:3100/api/usage >/dev/null && echo OK      # with UF_AUTH_TOKEN blank
  docker compose -p uf-uidtest down -v
  ```

  `UF_PORT`/`UF_CONTAINER_NAME` are there because `container_name` is *not*
  namespaced by the compose project, so without them this collides with an
  instance already running. Run it a second time with the two uid variables
  unset to confirm the 1000 default is unchanged.
- **The workflow canvas in a browser.** `/workflows`, `/workflows/new`,
  `/workflows/<id>` and `/workflows/<id>/edit` each answered 200 in `next dev`
  and the canvas is in the server-rendered markup; `/api/workflows/validate` was
  driven by hand through every refusal it exists to surface (see *Verified*).
  What no browser has done is *touch* it, and that is the whole of this feature:
  the drag, the link gesture, the keyboard routes and the layout that is stored
  per browser are all unexercised. Five things to try first — dragging a block
  off the palette and dropping it; dragging from one block's *Link* handle onto
  another; doing the same two with the keyboard only, which is the claim most
  worth disproving; pressing Delete on a link's control; and reloading the page
  to confirm the arrangement came back. Every graph the canvas can produce is
  still checked by the same function *Save* checks it with, so the risk here is
  a gesture that does not work, not a graph that should not have been saved.
- **A workflow saved before the canvas, opened on it.** The layout for one is
  derived rather than stored, and the derivation is unit-tested, but no
  pre-canvas row has been opened in a browser and saved back. What to confirm is
  that the links are all still there afterwards: nothing migrates the graph, so
  they should be, and that is exactly the claim worth checking once.
- **A workflow instantiated against the real CLI.** Every run in the *Verified*
  entry above came from a stub, deliberately: it is the loop, the folder claims,
  the dependency wiring and the branch hand-over that were being tested, and a
  real agent adds spend without adding coverage of any of them. What a stub
  cannot show is a real work cycle's timing — in particular whether the
  `on-success` dependent's first `git log` shows its predecessor's commits, since
  the stub committed nothing. Run a two-block workflow with a branch hand-over
  and read the second run's opening prompt.
- **Backup and restore inside Docker.** Everything above was driven against real
  databases and the real scripts, but never through the container — Docker is
  not available where this was written, so what has *not* been exercised is the
  packaging: that the runner image carries `scripts/` and can resolve
  `better-sqlite3` out of the standalone bundle, that `sqlite3` is on the PATH,
  that `/backups` is writable by the uid compose runs as (Docker creates a
  missing bind source owned by root, which the repository's shipped `./backups`
  is there to avoid), and that a restore through `docker compose run` reaches a
  volume the app is not holding. `deployment.test.ts` pins the Dockerfile and
  the compose file against each other, which is as far as a test here can get.
  The four commands that check it for real:

  ```bash
  docker compose up -d --build
  docker compose exec usagefoundry which sqlite3
  docker compose exec usagefoundry node scripts/backup-db.mjs /backups
  ls -la backups/
  # then, with the app stopped:
  docker compose down
  docker compose run --rm --entrypoint node usagefoundry \
    scripts/restore-db.mjs /backups/usagefoundry-<stamp>.db
  docker compose up -d
  ```

  Worth doing the destructive half at least once on an install you do not mind
  losing: `docker compose down -v` between the backup and the restore is the
  case the whole path exists for, and it is the only way to find out that the
  fresh volume's permissions are right.
- **The rollback path.** It is written to be unreachable — the graph, the
  templates, the mounts, every folder and both ends of every branch hand-over are
  checked before the first `createRun` — and nothing contrived reached it in
  testing, so the stop-everything-and-record-`failed` branch has never actually
  run. The cheapest way to exercise it is to delete a mount from
  `WORKSPACE_ROOTS` between the pre-flight and the pass, which is not a thing an
  operator can do; short of that, read it rather than trust it.
- **That a transcript's filename is its session id.** The retention sweep takes
  the session id from the file's basename, which is how the pinned CLI (2.1.226)
  names one — checked against every `.jsonl` in a real `~/.claude/projects`, not
  read from a specification, and it is the id the file's own first record
  carries. What has *not* been exercised is a CLI that names one differently:
  the mtime horizon is what actually protects a session in use, so a basename
  that stopped matching would cost the extra protection for a session a live run
  or a chat still holds, not correctness of the age test. Before trusting the
  sweep on a moved pin, list the tree and compare a handful of basenames against
  `sessionId` in each file's first line.
- **A pruned transcript's run being reopened.** `sweepTranscripts` clears
  `runs.session_id` on the terminal runs whose file it removed, so the pick-up
  takes the documented restart path — `nextPrompt` with `priorWorkNotice` — and
  both halves are unit-tested separately. What has not happened is the whole
  sequence against a real CLI: prune, press **Try again**, and confirm the first
  cycle opens with the task and the branch notice rather than failing on a
  `--resume` into a session that is gone.
- **The `VACUUM` command in `README.md`.** Written against the compose file and
  the Dockerfile rather than executed — Docker was not available where it was
  added, the same gap as the backup entry above. Two things in it are the ones to
  check first: that `docker volume ls -q | grep usagefoundry-data` names exactly
  one volume on the reader's machine (compose namespaces it with the project
  name, and a second instance started under `docker compose -p` would give two),
  and that the `alpine` + `apk add sqlite` container leaves the database file's
  ownership alone — the runner image carries `sqlite3` for the restore script's
  sake, but this command runs with the app's own container stopped, which is why
  it reaches for a separate one.
- **Everything about a saved agent that is not one of the seven probes above.**
  No `claude` child has ever been spawned with either flag *from this app*: the
  probes were run by hand, outside it. No browser has rendered the run form's
  *Agent* row, the Settings default, the canvas inspector, the chat's `@`
  popover, the *Agent work* card or the dashboard's origin marks, and no request
  has created, edited or deleted a row over HTTP — which matters more than usual,
  because `/api/agents` is the only way to define one at all. Four specific
  things are still open, each of which changes what a page says rather than what
  it does:
  - **The two remaining drops.** An empty name registering as an empty entry, and
    a `--agents` value that is not JSON being ignored outright, were both
    measured under `--agents` alone and have not been re-checked under `--agent`.
    Wrong either way, the refusal is stricter than it needs to be — the safe
    direction, and still a form saying no for a reason that has stopped being
    true.
  - **Whether a `--agent` session records that agent's name on its own turns**,
    or leaves them in `(main thread)`. `byAgent` and `agentSpend` report whatever
    the transcript says and infer nothing, so this decides what the two cards
    read and no branch depends on the answer. Both now say so in words rather
    than waiting on it: the run's *Agent work* card names what the run was
    started as and states that the rows may sit wholly under that name or wholly
    under `(main thread)`, and the dashboard's column is *Agent* rather than
    *Sub-agent* with a footnote saying `(main thread)` is a turn carrying no
    agent name. Either answer leaves both correct, which is the point — what
    would have been wrong is a card whose wording only made sense under one.
  - **Whether a `--agent` session delegates at all.** If it does, the forwarding
    and the split cover it unchanged; if it does not, that machinery goes quiet
    rather than wrong. The ambient definitions reach it either way.
  - **Whether a member's own `tools` list would beat the `PROCESS_KILLERS` deny.**
    Deny is verified to beat `--permission-mode` for the main thread and has been
    watched against nothing else. It is why the field is refused at save rather
    than stored and narrowed, under either flag.
- **Declaring the `settings.json` `agent` key, which is measured (see *Verified*)
  and deliberately not built.** The fact belongs in the same sentence the ambient
  definitions get — the registry is a part of the set and not the whole of it —
  and it is more than a sentence, which is why it is written down instead. What
  it would take: a read of `$CLAUDE_CONFIG_DIR/settings.json` in `agents.ts`
  beside `listAmbientAgents` (try/catch to null, that function's rule, since it
  feeds copy rather than a decision); a field on `GET /api/agents` beside
  `agents` and `ambient`, and its DTO; a second argument on
  `describeAmbientAgents` and its four call sites. The awkward half is the copy
  rather than the plumbing: that sentence sits under a *picker*, and choosing an
  agent there is exactly what overrides the key — so it would have to be
  conditional on the control's current value to avoid being false half the time,
  while the two children where the key actually bites, a chat turn and a review,
  have no picker to hang it on. The cheap first move is probably not the picker
  at all but the Settings page, where the app already declares the ambient set
  once and where "your `~/.claude` starts every agentless child as *X*" is a true
  sentence with no control to contradict it.

There is no linter run in this repo, and `npm test` covers a deliberately short
list: the folder-collision predicate, which queued runs may start, the budget
policy, how a provider refusal is classified and backed off from, which prompt a
work cycle spawns with, the GitHub credentials handed to a work cycle, that a
work cycle started as a saved agent both defines and selects it and moves none of
what bounds the run, how a
run's diff is parsed and budgeted, whether a saved graph of run blocks can run at
all and the order its runs are created in, when a branch may be landed, what a
queued merge does with the branch it reaches, what counts as a conflict marker — both
for deciding whether one was really resolved and for deciding what to show — and
the two renderings that would lie quietly about a number: an unconfigured
ceiling, and a first-party figure shown beside the meters. Two entries are
neither a function nor a rendering: the order a chat's thread renders in, driven
against a real database because what it pins is in the SQL rather than in any
function; and that the image leaves the data volume writable by whatever uid
compose runs the container as, which is otherwise checked by nothing here and
fails only on Linux, only under a non-1000 `UF_UID`, and only by refusing every
data route. A third is the backup round trip, which is neither of those either:
it drives the two shipped scripts against a real database with a write
transaction open, because a snapshot that quietly omits the newest runs opens
cleanly and passes every other check there is. `npm run typecheck`
plus a `docker compose up --build` smoke test is still the real verification
loop, and the list above records what was checked by hand.
