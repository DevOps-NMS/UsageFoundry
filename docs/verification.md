# Verified

[← Documentation index](README.md)

Built and exercised against real transcripts:

- Cost math cross-checked by hand — `$12.843618` computed independently vs
  `$12.8436175` from the API, on 54 input / 83,517 output / 12,072,025 cache-read
  / 471,941 cache-1h tokens.
- Dedup verified (99 → 31 records).
- **Dedup resolution measured across 1,011 transcript files / 40,885 turns**, on
  2026-08-21: every turn's lines share one `requestId` (0 exceptions), the last
  line carries the largest `output_tokens` in 27,228 of 27,228 multi-line turns,
  and `input_tokens`, `cache_read_input_tokens` and `cache_creation` are
  identical on every line of a turn (0 differ). Corpus output under first-seen
  29.61 Mtok against 38.80 Mtok under highest-output — understated 15.6% on CLI
  2.1.226, 60.1% on 2.1.233, 74.4% on 2.1.234, 74.9% on 2.1.238. Worst single
  turn recorded 4 output tokens against an actual 40,199.
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

  **Those measurements are of a layout that no longer exists below 768px**, and
  the entry stays for the method rather than for the readings: the sweep was run
  before the source list became a drawer and before seventeen tables started
  stacking at `md`, so every width it reports under that line describes a table
  being scrolled sideways rather than what is drawn there now. The harness is the
  thing worth keeping — a production build, fabricated API responses covering
  each status, twelve widths, both themes, and the geometry read back out of the
  DOM rather than looked at. Re-running it is the entry under *Not yet verified*
  below.

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
  existing path was refused rather than overwriting it. Seven of those are the
  unit tests in `backupRestore.test.ts`; replacing `VACUUM INTO` with
  `fs.copyFileSync` in the script fails them, which is what says they are
  measuring the mechanism rather than the file's existence.
  The seventh was added last and was **seen to fail first**: a restore whose
  copy dies part-way, induced with `ulimit -f 200` against a 512KB backup —
  `EFBIG` where a full volume gives `ENOSPC`, the same unhandled throw out of
  the same `copyFileSync`. Against the unguarded copy the scratch data directory
  afterwards held only `usagefoundry.db.superseded-<stamp>`, a name nothing had
  printed, and no `usagefoundry.db` at all; with the copy staged under
  `usagefoundry.db.partial` it exits 1 saying the database *is untouched*, and
  the file is still at its own path with all 2,000 of its rows. What was **not**
  executed is the other half of the incident — that the next boot creates a
  database at the empty path and comes up green — which follows from
  `src/lib/db.ts`'s unconditional `new Database(DB_PATH)` and wants a container.
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
- **`UF_BIND_ADDRESS` off loopback, and the two settings that fail silently
  beside it.** Against a running container recreated with
  `UF_BIND_ADDRESS=0.0.0.0`, `UF_AUTH_TOKEN` set, `UF_ALLOW_NO_AUTH` blank and
  `UF_COOKIE_SECURE=0`: `docker compose ps` reported `0.0.0.0:3000->3000/tcp`
  rather than `127.0.0.1:3000->3000/tcp`, and requests to the host's own LAN
  address (not `localhost`) answered `/api/health` **200**, `/` **307** to
  `/login`, `/api/usage` **401** with no credential and **200** under
  `Authorization: Bearer $UF_AUTH_TOKEN`. `POST /api/login` with the token
  answered 200 and its `Set-Cookie` read
  `uf_session=…; Path=/; Expires=…; Max-Age=86400; HttpOnly; SameSite=lax` —
  **no `Secure`**, which is the flag whose presence would have made that sign-in
  succeed and every request after it anonymous. The recreate matters and is part
  of what was checked: a port binding is fixed when the container is created, so
  `docker compose restart` leaves the old one in place.
  What this does **not** establish is in the next section.
- **Go in the image, and the cache volume that has to outlive a rebuild.**
  `docker compose build` on an arm64 host: the release tarball downloaded, the
  digest fetched from `dl.google.com/go/…` and `sha256sum --check` passed, and
  the image answered `go version go1.26.6 linux/arm64` with `go env` reporting
  `GOPATH=/home/node/go`, `GOMODCACHE=/home/node/go/pkg/mod`,
  `GOCACHE=/home/node/go/build-cache` and `GOTOOLCHAIN=auto` — so one volume
  covers both caches. The entrypoint's half was driven against a fresh named
  volume with `UF_AGENT_UID=1001`: the first boot took the volume from
  `1000:1000` to `1001:1001`, the second left it alone (the `stat` guard, which
  is what keeps a populated cache off the boot path), and a `go build` run
  `--user 1001:1001` against that volume compiled and ran, leaving 35 MB of
  build cache behind in it. The `/data` warning printed by that last run is the
  pre-existing one — `--user 1001` is not root — and not this.
  What that leaves unchecked: the **amd64** branch of the arch case and its
  digest, since the build ran on Apple silicon; and a real agent mid-cycle
  building a Go repository, as opposed to a shell in the same image.
- **A sandbox that could not start, on this install, unnoticed for thirteen
  hours.** Not a probe: a production failure, and the only end-to-end reading of
  `UF_SANDBOX=1` anything here has. `UF_SANDBOX=1` and
  `UF_SANDBOX_ENFORCEMENT=refuse` were set, `docker-entrypoint.sh` wrote
  `/etc/claude-code/managed-settings.json` correctly, and `docker-compose.yml`'s
  `security_opt` block was — as it ships — commented out, so bubblewrap could not
  create a namespace. **The CLI did not refuse to start.** Its availability probe
  `access(X_OK)`s the `bwrap` and `socat` binaries and never runs one, so
  `getSandboxUnavailableReason()` was undefined, `failIfUnavailable` never fired,
  and every `Bash` command was wrapped in a `bwrap` that exited 1 before reaching
  the command. **214 failed `Bash` calls across 10 runs, 2026-08-18 18:12:12 UTC
  to 2026-08-19 09:38:51 UTC** — fifteen and a half hours, and the last of them
  landed 22 minutes after the failure was diagnosed, because the fleet kept
  going. Those ten runs record $407.26 and 260.5M tokens between them; the
  figure is what they spent while degraded rather than what the degradation
  cost, and the first reading taken during the incident said 170 calls across 8
  runs for $210, which is worth keeping here as an illustration of what a
  snapshot of a live fleet is worth. The most expensive (`6052f120`, $139.12)
  finished by parsing `.git/index` by hand to enumerate the files it could not
  list. **UsageFoundry reported none of it**: `run_events` holds 484 `tool_error`
  rows all time and **zero** `sandbox` rows, ever, and the only `ops_events` row
  in the window was an unrelated boot reconciliation. The three `bwrap:` markers now in
  `src/lib/sandbox.ts` are that transcript read back out.

  Two things this settles that were open below. The generated policy does
  **not** short-circuit to an unwrapped command on this build — every `Bash`
  call came back as `bwrap`'s own stderr, which is a wrapper that was built.
  And a required-but-unstartable sandbox has a **third** outcome besides the two
  `scripts/sandbox-probe/probe.sh:521` allows for: not a refusal, not an
  unconfined run, but a session that starts, reports nothing, and fails every
  command inside a sandbox that was never built. Nothing observes it from the
  inside — the CLI's own availability check is satisfied by the binaries
  existing, and this app had no marker for `bwrap`'s stderr, so the only signal
  was 170 tool errors that each looked like a command that went wrong.
- **`uf-seccomp.json` applied to a real daemon, and the one bubblewrap operation
  it does not buy.** On Docker Engine 29.7.2, kernel 6.12.76-linuxkit:
  `bwrap --dev-bind / / --unshare-user --unshare-pid true` fails
  `No permissions to create new namespace` with rc=1 **as root and as uid
  1000**; with `--security-opt seccomp=./uf-seccomp.json` it exits 0 at both
  uids. The daemon genuinely applies it — the profile is inlined in
  `HostConfig.SecurityOpt`, and `Seccomp_filters` inside the container is still
  1, so this is a narrowed profile and not `seccomp=unconfined`.
  `/proc/sys/user/max_user_namespaces` is 31734: the kernel was never the
  blocker, Docker's default profile was. `uf-seccomp.json` is byte-for-byte
  reproducible from moby v28.5.2's default profile with
  `scripts/make-seccomp-profile.py`'s patch applied — but the regeneration
  command printed in `docker-compose.yml` **404s on this engine**, because moby
  publishes no `v29` tag; the shipped file has to stay the newest tagged default
  until it does, and 29.7.2 accepts it.

  What the profile does **not** fix is the operation the CLI's default sandbox
  needs. Under it, `--ro-bind`, `--tmpfs`, `--dev`, `--unshare-pid`,
  `--unshare-net` and binding the existing `/proc` all succeed; `--proc /proc`
  is the only failing one — `bwrap: Can't mount proc on /newroot/proc: Operation
  not permitted`, as root as well — because Docker's masked `/proc`
  over-mounts trip the kernel's `mount_too_revealing` check. The pinned CLI
  builds exactly two bubblewrap argv shapes, switched on the managed setting
  `sandbox.enableWeakerNestedSandbox`: the default pushes
  `--unshare-user --cap-drop ALL --proc /proc`, the weaker one
  `--unshare-user --bind /proc /proc`. Both shapes were read out of the binary
  and then **run verbatim as `bwrap` command lines**: the default fails under
  the profile, the weaker exits 0 as uid 1000. That is what
  `docker-entrypoint.sh` now writes the key for — and it is a measurement of
  `bwrap`, not of the CLI choosing a shape, which nothing has watched.
- **`jq` in the image, and reachable from inside a bubblewrap namespace.** The
  runner stage installs it — 1.6, Debian bookworm's pin, ~1.2 MB with `libjq1`
  and `libonig5`. Measured on 2026-08-25 in a throwaway container off the
  rebuilt image, as uid 1000 and with `--security-opt seccomp=./uf-seccomp.json`:
  `jq` parses stdin and exits 0 unwrapped, and inside **both** bubblewrap shapes
  the entry above names — `--dev-bind / / --unshare-user --bind /proc /proc
  --new-session --die-with-parent`, which is the weaker-nested shape the managed
  policy asks for, and `--ro-bind / / --dev /dev --unshare-user`. Nothing had to
  be configured for the sandboxed case: bubblewrap binds the root filesystem,
  and the managed policy's `denyRead` names only `/data` and `/backups`, so
  nothing on `/usr/bin` is confined away. Same limit as the entry above — this
  is a measurement of `bwrap`, not of the CLI wrapping a real `Bash` call, which
  nothing here has ever watched succeed.
- **That this install's agents have never had `Grep` or `Glob`.** The pinned CLI
  (2.1.226) drops both from the tool list whenever `Bash` is present — the gate
  read out of the binary is `searchToolsOptIn` false and `CLAUDE_CODE_ENTRYPOINT`
  not `local-agent` — and its refusal text tells the model to use `grep`/`find`
  through the shell instead. Measured against this install's own records rather
  than inferred: **zero of 469 recorded `system:init` events have ever carried
  `Grep`**, going back to 2026-08-10, five days before a sandbox existed here —
  so this is not the failure above wearing a second face — and all five `Grep` /
  `Glob` calls an agent ever attempted failed. In a throwaway container on the
  pin, passing `--allowedTools Grep Glob` puts both back in the tool list and
  changes nothing else in it; the opt-in is set by the CLI from the
  `--allowedTools` values themselves, so naming them is the whole of it. That is
  one `system:init` event on a throwaway container, not a work cycle — what the
  flag does to a real run is in the list below.
- **A sandbox that starts, and confines. The first on this project.** Three
  `claude` invocations against the recreated container on 2026-08-19, as uid
  1000, with `security_opt` applied from `docker-compose.override.yml` and the
  managed policy carrying `enableWeakerNestedSandbox: true`. Billed: $0.51 in
  total, and the figures are on each line below because a probe that is not
  worth its cost should be argued about with the cost in front of it.

  First, that the wrapper is built and the command survives it. `claude -p`
  told to run `echo … > /tmp/uf-probe.txt && cat /tmp/uf-probe.txt` under
  `--permission-mode acceptEdits` returned `UF-SANDBOX-PROBE-OK` from the tool
  and `DONE` from the model, in 3.0s for $0.298 — no `bwrap` line anywhere in
  the stream, where the same call before the profile produced nothing else. The
  `system:init` event on that same invocation lists `Glob` and `Grep`, from
  `--allowedTools Grep Glob` and nothing else on the argv, which is
  `SEARCH_TOOLS` measured against the real binary rather than a throwaway.

  Second, and the one that separates a policy from a decoration: the credential
  deny **denies**. `/home/node/.claude/.credentials.json` is 509 bytes and
  readable by uid 1000 from a plain `docker exec`; the same file through a
  sandboxed `Bash` call in the same container, as the same uid, came back
  `wc: /home/node/.claude/.credentials.json: Permission denied`, exit 1
  ($0.099 — an earlier attempt at the same question cost $0.115 and answered
  nothing, because a compound command is held for an approval a `-p` child has
  nobody to give). So the policy is enforced on a file the uid otherwise owns,
  which no reading of a settings file could have told anyone.

  What it does not settle. The refusal arrives as an ordinary `EACCES`, exactly
  as `src/lib/sandbox.ts` says a policy denial does — so this is also the
  measurement behind that module refusing to match one, and there is still no
  way to tell a denied path from a missing one inside a tool call. Nothing here
  exercised the per-run `--settings` overlay (these had none), the `denyRead`
  paths, the network allowlist, or a work cycle doing real work; the write set
  and everything else below stay on the list.
- **The vault reader against a real 773-note Obsidian vault, and all four of its
  routes.** On 2026-08-21, against a live vault bind-mounted read-only at
  `/workspace2` — the operator's own, edited by other runs while this ran, and
  written to by nothing here. The compiled `knowledge.ts` indexed 773 notes into
  19,438 edges over 885 nodes (773 notes, 95 tags, 17 phantoms), finding 20
  orphans and 212 broken links, untruncated. A cold scan took **303ms** and the
  next call **9ms**, returning the identical object — which is the whole of the
  cache claim, measured rather than reasoned. The four routes were driven as
  functions off a scratch `tsc` build with `DATA_DIR` and `WORKSPACE_ROOTS`
  pointed at throwaways: `PUT /api/settings` refused `knowledgeBaseMountId:
  "nope"` and a `../escape` subpath with 400 and accepted the real mount;
  `/status` answered those counts; `/graph?kinds=note,phantom,tag` answered
  885 nodes uncapped; `/note?path=…` answered a note with 13 frontmatter keys,
  100 outgoing and 14 incoming links and its frontmatter block stripped from the
  body; `/note?path=../../../etc/passwd` answered **404**, which is the
  containment argument working as stated — the path is a key in a map, not a
  join; and `/search?q=terraform` ranked an exact title first.

  What it settles is that the parser and resolver are right about *this* vault's
  conventions, which is what caught the defect worth naming: frontmatter tags
  were not becoming tag nodes, and since 747 of the 773 notes carry every tag as
  a property and not one writes a `#tag` in the body, the reader reported a
  fully organised vault as having **zero** tags — a figure an operator reads as
  a fact about their vault. What it does not settle is anything through a
  browser: the Knowledge base settings section has been typechecked and built,
  never looked at, and no `docker compose up --build` was possible in the
  environment this landed from. Both are on the list below.
- **That `--plugin-dir` actually delivers a skill, and that the generated
  SKILL.md is one the CLI accepts.** On 2026-08-21 against the pinned CLI
  (`claude --version` → `2.1.226`), billed **$0.00**: the API call was pointed
  at a local sink on `127.0.0.1` that answers 400, which is enough because every
  plugin and skill load happens before the first request and the request body is
  then readable in full. Two things were being asked, and this is the route the
  whole feature rests on, so it was measured before anything was built on it.

  First, that the route works at all. `claude -p --plugin-dir <dir> …` against a
  directory holding `.claude-plugin/plugin.json` and
  `skills/knowledge-vault/SKILL.md` logged `Loaded inline plugin from path:
  usagefoundry`, `Checking plugin usagefoundry: skillsPath=exists`, `Loaded 1
  skills from plugin usagefoundry default directory`, and `Sending 13 skills via
  attachment (initial)`. Second, and the part a debug line does not settle: the
  captured request body carries the skill in the model's own skills block as
  `usagefoundry:knowledge-vault: Search the knowledge vault at …` — the exact
  text `renderVaultSkill` produced, from the compiled module rather than a
  hand-written stand-in. The body of the SKILL.md is **not** in that request:
  only `name: description` is sent up front and the body loads when the Skill
  tool fires, which is why the description is three sentences and not the
  operator's paragraph of topics.

  Two details fell out that are load-bearing elsewhere. Skills are namespaced by
  their plugin, so this one cannot shadow — or be shadowed by — a same-named
  skill in the operator's own `~/.claude/skills`; the container this was run in
  has exactly that, and both were offered. And `--add-dir <dir>` immediately
  followed by another flag parses correctly, the variadic not swallowing it,
  which is what makes its position in `buildArgs` safe. The published sandbox
  policy on a session given `--add-dir` lists the directory under
  `write.allowOnly`: **it is not a read-only grant**, which is why the skill's
  own text is where "never write to the vault" has to live, and why the settings
  copy says the same.

  The same debug log reproduced, live, the breakage `plugins.ts` documents and
  this feature is shaped around: the container tried to read
  `/Users/…/.claude/plugins/marketplaces/…` out of the shared `~/.claude` mount
  and logged `marketplace-load-failed`, exit 0, nothing else said. That is the
  silent failure that rules out installing into `~/.claude/skills`, observed
  rather than quoted.

  What it does not settle is on the list below: nothing here ran under
  privilege separation, so the ownership and mode of the generated directory are
  reasoned from `chat.ts`'s precedent rather than measured, and no model has yet
  been asked a question and answered it out of a real vault.
- **The Knowledge page's server half, and its Markdown renderer over every note
  in a real vault.** On 2026-08-21, against the same read-only `/workspace2`
  mount as the entry above, through a scratch `next dev` on a spare port. The
  routes the page calls answered: `/status` with no mount configured, then the
  four browse figures once one was — **785 notes, 35 folders, 95 tags, 7 note
  types** — a folder filter narrowing the list, `/health` with **19 orphans, 183
  broken links and 25 notes missing frontmatter**, `/note?path=…` 200 for a real
  note and **404** for one that is not, and `GET /knowledge` itself 200 carrying
  its `<h1>` and the words *Read-only*, with no Next error overlay in the HTML.
  Those counts differ from the 773/20/212 measured the day before because the
  vault is live and other runs edit it, which is the point of not hard-coding
  any of them.

  The renderer was measured separately and harder, because that is where a
  silent failure lives: the compiled `Markdown` was driven over all 785 notes
  with the page's own resolver wired in, and it found **213 of the vault's
  13,100 wikilinks reaching the DOM as literal `[[…]]` text** — every one of
  them inside `**bold**` or `*italic*`, which the inline scanner took whole.
  After the fix that rescans emphasis content, 13,076 render as links and **24**
  remain, and all 24 are vault content rather than renderer bugs: truncated
  links in generated index notes with no closing `]]`, and empty `[[]]`
  placeholders in templates.

  Nothing under `/workspace2` was written, and that is proved rather than
  asserted: every probe brackets its own run with a `sha256` over
  `find /workspace2 -printf '%T@ %s %p\n' | sort`, and every run printed the two
  digests equal.

  Two environment facts worth keeping. `NODE_ENV=production` is inherited in
  this container and `next dev` under it 500s every request — an `EvalError:
  Code generation from strings disallowed` out of the edge instrumentation, a
  `globals.css` parse failure and a missing `.next/required-server-files.json`;
  `NODE_ENV=development npx next dev` is the whole fix, and none of the three
  symptoms points at it. And `/api/settings` takes a **PUT**, not a POST — a
  POST answers 405.

  What it does not settle is everything that needs a browser, which is on the
  list below.

- **The graph view's server half and its arithmetic, at the real vault's size —
  and nothing about its picture.** On 2026-08-22, against the same read-only
  `/workspace2` mount as the two entries above, through a scratch `next dev` on
  a spare port with `WORKSPACE_ROOTS=Vault=/workspace2`. The exact URL the
  canvas fetches — `/api/knowledge/graph?kinds=note,phantom,tag,attachment&limit=5000`
  — answered **200 in 605ms with 7,330,042 bytes**: **893 nodes** (785 note, 95
  tag, 13 phantom, 0 attachment), **19,995 edges**, `truncated:false` and
  `capped:false`, so nothing on this vault reaches either of the reader's two
  caps. Sixteen of those nodes carry no edge at all and the largest hub carries
  **1,082**, which is the shape the repulsion has to hold apart. `GET /knowledge`
  answered **200** carrying the graph region and its panel — *Whole vault*,
  *Existing files only*, *Orphans*, *Arrows*, *Label fade*, *Repel force*, *Link
  distance*, *Add group*, *Reset to defaults* — with no `__next_error__` in the
  HTML and nothing logged.

  The layout was then measured in Node 22.23.2 against **that payload**, not a
  synthetic one, by stepping the simulation from `alpha = 1` until `step()`
  returns `false`. Whole vault with tags on, 893 nodes and 19,995 edges: it
  settles in **251 frames / 374ms**, at **1.49ms mean per step** (median 1.31,
  p95 3.07, worst 4.50). Notes only, which is what the default filters show —
  785 nodes, 16,610 edges: **1.36ms mean** (median 1.12, p95 2.55). With Repel
  at the slider's maximum: **1.23ms**. The draw loop's own JS — the viewport
  cull plus the two path calls per surviving link, with a stub standing in for
  the rasteriser — is **0.137ms a frame**, with **10,712 primitives past the
  cull** at 1200x640 and `k = 1`. So the part of a frame this repository
  controls is about **1.6ms of a 16.7ms budget** at this vault's size.

  Barnes-Hut earns its place by measurement rather than by argument: at 893
  nodes it is **0.901ms a frame against all-pairs' 2.393ms, 2.7x**, and the gap
  is what the caps are set against — at the same edge density the step costs
  **1.47ms at 1,000 nodes, 3.35ms at 2,000, 4.32ms at the 2,500 the renderer
  caps at, and 7.67ms at the 4,000 the API caps at**. The 2,500 cap therefore
  leaves roughly 12ms of every frame for rasterisation at the worst graph this
  app will draw.

  **What none of that settles is the picture**, which is on the list below: no
  browser will start in this container, so no frame rate has been observed, no
  gesture has been made, and nothing has been seen drawn.

- **The Markdown renderer's Obsidian surface, over every note in the real
  vault.** On 2026-08-22, against the `/workspace2` mount, by driving the
  compiled `Markdown` over all **785 notes** with a resolver of the page's own
  shape and counting markup that reached the reader as punctuation — the same
  method as the wikilink measurement above, widened to every construct.

  What it found first is the size of the gap the change closes: **760 of the
  785 notes carry a callout, 621 carry a table, 524 carry a task list**, 764 a
  blockquote and 81 a footnote definition, and before this every one of those
  rendered as the literal characters the author typed. That is the whole of why
  the page reads as unrendered — it was already rendering markdown, and almost
  nothing a note is actually written in was in the subset it knew.

  After: **0 notes leak a callout marker, a task box, a table row, a highlight,
  a strikethrough, a footnote definition, a wikilink, a bold run or a comment**,
  across 785 notes rendered with **0 throwing**. Two renderer bugs were found by
  this pass and only by it, both invisible from the desktop: a table's stacked
  `label` was handed the raw head string, so every cell on a phone showed
  `**bold**` and `[[wikilinks]]` in a table that read correctly above `md`; and
  `- [ ]` with nothing after it — the row every template in this vault leaves
  for the reader — was a bullet whose text was `[ ]` rather than a checkbox.
  Both have a test. One leak remains and is content rather than a bug:
  `[link](url)` in a template, a schemeless URL the allowlist declines to make
  clickable, which is the same refusal that keeps `javascript:` inert.

  The unconditional strip of a trailing `^block-id` was checked rather than
  assumed, because it is the one rule here that *removes* text and a report is
  not a note: the pattern occurs **11 times in the vault**, all of them genuine
  block ids, and **0 times in this repository's own prose**, which is the
  closest available stand-in for what a model writes into a cycle report.

  Unlike the two entries above, this mount is **read-write** — proved by a
  `touch` that succeeded, and the probe file was removed in the same minute. The
  probe itself writes nothing, which is measured rather than asserted: a
  `sha256` over `find /workspace2 -printf '%T@ %s %p\n' | sort` is identical
  either side of a full 785-note run. A digest taken across a *longer* window
  did differ, and that is the vault being live rather than this touching it —
  the same reason the note counts above drift between entries.

  What it does not settle is every pixel, which is on the list below.

- **What removing `--autocompact` gave up, and what replaced it.** The flag was
  removed on 2026-08-24 and `contextPruning.ts` stands in its place, at the same
  167,000 it fired at, ending the cycle and pruning rather than summarising in
  place. **The entry below stays on this page unchanged and is now a record of
  the cost of that decision rather than a reason for the flag**: turns past the
  cap cost 0.45× per turn and 0.50× per 1,000 output tokens, between the two arms
  of a natural experiment over 1,147 transcripts. Nothing about that measurement
  has been retracted or re-derived; what changed is that an operator chose the
  other mechanism knowing it. A later reading must be able to tell a decision
  from a regression, which is the whole reason this paragraph sits above rather
  than replacing it.

  The two open terms below are unchanged and one of them now cuts the other way:
  a compaction's own summariser call — roughly 168,000 in and 6,300 out, billed
  and invisible to `scanUsage()` — is a cost the replacement does not pay, and it
  was never counted against the flag.

- **What winnow actually removes, measured against a real transcript.** Measured
  2026-08-24 against one 2.0 MB transcript from this container
  (`f2de6d64-…jsonl`, 716 messages) with winnow at `b49fceb`, installed into
  `/opt/winnow` and run as `winnow safe run -- treat … -rx standard`. Four
  findings, and three of them changed what was built.

  **Its own token figure is unusable.** The report said `Saved 0 tokens (0.0%)`
  for a prune that removed 28% of what is actually sent. The figure comes from
  the transcript's historical `usage` frames, which record what was billed and
  cannot change when content is edited, so it structurally cannot express a
  delta. `contextPruning.ts` recomputes from `message` content instead, before
  and after, and that difference is the only figure this app reports.

  **Bytes freed overstate the saving by 3.4×.** 970 KB of file freed against
  290 KB of API-visible content — 1,018,946 bytes of `message` before, 729,376
  after, ≈254,736 → 182,344 tokens at `BYTES_PER_TOKEN`, so **72,392 removed**.
  The gap is `tool-use-result-strip`, whose own description says it removes an
  envelope field "never sent to API". Bytes freed is what every other pruner
  reports and it is the figure this app refuses to render.

  **`gentle` removes nothing.** 0 bytes on the same transcript. Its one strategy
  that fires on an ordinary session is `metadata-strip`, which orchestrator-safe
  mode excludes by name. So the settings control offers two positions rather than
  three.

  **A second transcript, same shapes.** `06510dfb-…jsonl`, 2.4 MB, same tier and
  same argv: 1,448,627 bytes of `message` before against 892,033 after, so
  ≈402,396 → 247,787 tokens and **154,609 removed — 38.4% of the context**. The
  file-bytes overstatement here is 2.0× rather than 3.4×, which is the useful
  part of the second sample: the ratio is a property of how much `toolUseResult`
  a particular session accumulated, not a constant, so no fixed correction factor
  could be applied to the byte figure. Measuring `message` content is the only
  reading that holds.

  **The prune runs as the server, not as the agent uid, and it has to.** Caught
  by running the exact argv under `setpriv`: on this install the transcripts are
  `0600 root` and `DATA_DIR` is `0700 root`, so a child at `UF_AGENT_UID` raises
  `PermissionError` on `WINNOW_DATA_DIR` before it ever reaches the file it was
  meant to prune. `spawnPrune` therefore omits `childCredentials()` — the only
  spawn in this app that does — and says why at the call site.

  **Two smaller ones.** No receipts were written anywhere even with
  `WINNOW_NO_RECEIPTS` cleared, so this app measures before and after itself
  rather than reading the tool's own ledger. And every prune writes a full-size
  `.bak` beside the transcript — `create_backup=True` is hardcoded at all three
  of winnow's call sites with no flag in front of it — which lands inside the
  bind-mounted `~/.claude`; `removeBackups` deletes it, matched on winnow's own
  naming and filtered by mtime so a backup left by anything else survives.

  **Verified against four real prunes, 2026-08-24.** All four fired from the
  early-end path at `aggressive`, at 167,326-169,283 tokens, removing 29.1-52.8%.
  The displayed figures were recomputed independently from the transcripts and
  matched the API to the cent (257 turns, 266,683 tokens, `+$4.39212`), which
  establishes the plumbing. Against *ground truth* the two sides came out
  differently, and only one of them was right.
  
  **Removal is accurate to about 3%.** Claimed 266,683 tokens against 274,619
  observed as the drop in resident context across the restart, per-receipt errors
  +1.2% to −6.5%. That is the estimator working as designed: `BYTES_PER_TOKEN`
  carries a systematic offset, and a *difference* between two readings of the
  same file cancels it.
  
  **The invalidation was understated by 16.6% and has been corrected.** It was
  charged against `tokens_after` — 405,049 across the four — where the resumes
  actually wrote 485,828. The gap is everything the context holds that the
  transcript's `message` fields do not: system prompt, tool definitions,
  `CLAUDE.md`, the three appended notices. Being an absolute rather than a
  difference, no offset cancels, and it overstated the net by roughly 15%
  (`+$4.39` displayed against `+$3.58` corrected). `netReceipt` now prices the
  resume off the first *billed* turn's own `cache_creation_input_tokens` instead
  — a measurement rather than a model — falling back to the estimate only until
  that turn exists. The all-zero record the CLI writes at a restart has to be
  skipped explicitly: taken as the first turn it reports the invalidation as
  $0.00, which is how the first pass at measuring this went wrong.
  
  **Also confirmed here:** the dedupe matters. Raw assistant records after the
  four prunes number 93/129/82/57 against 61/91/58/47 deduped on
  `messageId:requestId`, and billing is per request, so the deduped figure is the
  right one and is what `scanUsage` supplies.

  **Not yet verified by hand:** no *boundary* prune has run at all — all four
  observations are the early-end path, because each run finished within one
  effective cycle, so the loop broke before reaching the boundary call. The
  corrected invalidation has unit tests and has not itself been re-observed
  against a fifth prune. The subprocess, the token measurement, the tier behaviour and the
  backup were all exercised directly against a copied transcript; the boundary
  call site, the early-end interrupt and the KPI arithmetic have unit tests and a
  clean `npm run build`, and nothing more. The netted figures on the dashboard
  have never been read against a real run.

- **What winnow's intake filter is worth, and how far it contaminates the prune
  figure.** Measured 2026-08-24 against the real ledger at
  `/home/node/.winnow/filter.jsonl`, the ledger's path at the time, and this
  install's real transcripts. Two
  questions, and the second is the one that decided a line of code.

  **The filter's saving was not already in the meters, and is not a double
  count.** Every window here is priced from `usage` frames, and a `usage` frame
  is the API's report of the request it *received* — which is the filtered one.
  The money the filter saved is therefore already absent from every meter, so a
  figure beside them is new information. Nothing in this app read the ledger
  before this change; `contextPruning.ts`'s receipts come from a different
  mechanism and carry nothing from it. This is an argument from where the
  numbers come from rather than a measurement, and it needed none.

  **The prune figure is contaminated in the opposite direction, by 4.06% of
  removed tokens.** `contextTokens()` measures the transcript on disk; the
  filter never touches the transcript. So when the pruner removes a result the
  filter had already replaced with a pointer on the wire, `tokensRemoved` counts
  tokens that were never in the cached prefix and `cacheSavedUSD` prices
  re-reads that were never going to happen. Winnow's own
  `docs/COZEMPIC.md` §3.5 records this as the one hard conflict. Measured by running the real
  `winnow treat -rx standard --execute` over this install's ten largest
  transcripts and classifying every removed block by whether the filter's rules
  would already have taken it: per-file phantom share **0.46%, 9.92%, 0.01%,
  0.00%, 0.13%, 2.35%, 1.56%, 5.62%, 9.09%, 1.54%** — unweighted mean 3.07%,
  corpus-weighted **4.06%** (305,292 phantom bytes ≈ 84,803 tokens against
  2,086,369 tokens removed), range 0.00%–9.92%.

  It is an **upper bound**, twice over: the reconstruction ignores
  `keep_newest`, so the newest match of each rule is counted as phantom when the
  filter would have deferred rather than dropped it, and it counts blocks the
  filter may never have seen at all. Four structural reasons keep it small, each
  checked against the corpus: `tool-use-result-strip` dominates and removes
  `toolUseResult`, an envelope `contextTokens()` already excludes;
  `thinking-blocks` is next-largest and is not tool results at all;
  `tool-output-trim` needs >8 KB or >100 lines where the filter takes from 2,048
  bytes up; `tool-result-age` counts **user prompts**, and a UsageFoundry work
  cycle is one user prompt (median 1, p90 3, max 28 across 1,343 transcripts,
  with only 6 reaching the mid-age threshold of 15); `mega-block-trim` (>32 KB)
  matched zero blocks in the whole corpus.

  **The arithmetic was left alone, deliberately, and the card says why.** Not
  because 4.06% is small — because the correction is *not available today*.
  Identifying which transcript blocks the API never saw needs a `tool_use_id` on
  each ledger line, and **every line this install has written carries none**
  (15 of 15 results on the `(session, tool, rule, bytes)` fallback key). The only
  alternative is reimplementing winnow's `rule_for`, `LOCATOR_TOOLS`,
  `VERIFICATION_RE`, `min_bytes` and `keep_newest` in TypeScript against a Python
  module in another repository, which is a large fragile duplication *and* still
  an approximation, because `keep_newest` depends on per-request state the
  transcript does not record.

  The card **adds them anyway**, and prints the error. Held apart for one
  revision, the two figures answered every question except the one the card is
  for — what context control has been worth — and no reader can add two numbers
  whose overlap is unstated. Added, the headline is high by a bounded, measured,
  known-sign amount with that amount named under it, and the split survives as a
  share beneath each span. The number is in `apiTypes.ts`'s DTO comment,
  `intakeFilter.ts`'s module docblock and `ContextControl.tsx`'s, and on the card
  itself, so nothing on screen is a figure shown here to be wrong without saying
  so.

  **The live readout, at 125 ledger lines (2026-08-24T21:12Z).** 125 requests,
  372 drop/defer occurrences, 1,239,748 gross bytes — **15 distinct results,
  15,144 tokens, a 24.8× overstatement had the file been summed**. That factor
  is not a constant: it is roughly how many requests a result survives, so it
  grows with session length, which is why the de-dupe is a module and not a SUM.
  Netted: cache write avoided `+$0.05627`, the one uncached send `−$0.028135`,
  re-reads avoided over 84 later turns `+$0.0379325`, **net `+$0.0660675`**.
  Every figure is a **floor**: 82 of the 125 requests joined no main-thread
  turn — the filter's B2 rule fires hardest on exactly the tool-heavy sub-agent
  turns the join excludes — 6 of 15 results were priced, and 3 were deferred and
  never dropped, which the ledger cannot prove escaped the cache because it does
  not record `breakpoint_moved`. All three counts are on the wire and on the
  card.

  **Not yet verified by hand:** the cross-check against `winnow savings --json`
  **could not be run — that subcommand does not exist in this container.**
  `/workspace/winnow` at `f9f8e4b` offers `list, current, diagnose, treat,
  strategy, reload, team, guard, init, uninstall, doctor, guard-watchdog,
  formulary, completions, remind, nudge, digest, dashboard, safe` and argparse
  rejects `savings` outright; `src/winnow/cli.py` has only `safe`, `inspect` and
  `filter`. So this reading has been checked against its own unit tests and
  against the raw ledger counted a second way in Python, and against no
  independent implementation. Nothing here was rendered in a browser and no
  container was started — see the standing entry below.

  The **windowed** halves of the filter figure — `session` and `weekly`, added
  when the card began leading with a combined weekly total — have unit tests on
  the slice (`resultsSince`, boundary and undated) and a clean `npm run
  typecheck`, and nothing more. They have never been read against a real ledger,
  and the one thing to check when they are is that a 5-hour figure is not
  permanently `—` on this install: 82 of 125 requests joined no main-thread turn
  and an unjoined result is excluded from both windows by design, so the window
  shares are a floor by much more than the total is.

  **The card had been reading a path nothing writes since 2026-08-25, and read
  as `missing` the whole time.** The ledger moved to `/data/winnow/filter.jsonl`
  when the entrypoint stopped writing it to the container's writable layer, and
  `intakeFilter.ts`'s literal did not move with it. Observed on the live
  container: `GET /api/usage` returned `intakeFilter.ledger: "missing"` with
  every figure zero — total, 5-hour and weekly alike — while
  `/data/winnow/filter.jsonl` held 212 lines. A missing path is a legitimate
  state on that DTO and renders as a sentence rather than as an error, so
  nothing anywhere said the reading had stopped.

  Measured against the ledger at its real path on 2026-08-25, by replaying the
  join in Python over the same 1,366 transcript files: **215 of 217 request ids
  joined, every one of them on the main thread**, all `claude-opus-5`, all
  within the day. That is the opposite of the 82-of-125 unjoined reading above
  and it moves the caveat rather than removing it — this ledger's lines were
  written by main-thread requests, so the two window shares have real figures
  here rather than a permanent `—`, and how much of a ledger joins is a property
  of what the fleet was doing rather than a constant.

  **Not yet verified by hand:** the corrected path has typecheck and the suite
  behind it and has **not** been read in the running app — the container was
  carrying a live billed run when the fix was written and a rebuild would have
  killed it. What to check on the next rebuild is what has never been seen at
  all: the card's own figures against a real ledger, in a browser.

- **The two context measures, and the 65,000 tokens between them.** Measured on
  the live container on 2026-08-25 by replaying `contextTokens` and
  `apiContextTokens` over every frame of run `a75a7cb7`'s session
  (`4b47c32c-…jsonl`), around the crossing the cycle ceiling acted on. The last
  request before the prune carried **183,214 prompt tokens** plus 501 of output
  — 183,715, which is the `183.7k` the run log printed — while the transcript's
  own turns came to **118,776**, the receipt's `tokens_before`. The prune took
  50,319 off that, and the **first request after it carried 120,595**: a real
  reduction of 62,619 against the 50.3k reported, and a remainder 52,138 above
  the "leaving 68.5k" the same log line printed.

  Both readings are honest and neither bounds the other. The fixed part was read
  off that session's own first request, which carried **57,819 tokens against
  2,759 tokens of conversation** — the system prompt, the tool list, this
  repository's `CLAUDE.md`, the appended notices and the skills, none of which is
  in a transcript and none of which a prune can reach. The intake filter was live
  throughout (`WINNOW_FILTER=1`; 43,604 bytes dropped on that cycle's last
  request) and pushes the other way, which is why `apiContextTokens`' own note
  records the same two measures ~69,000 apart in the **opposite** direction on
  two other runs the same day.

  So the ceiling was reading correctly and the prune line was reporting a
  different quantity in the same units, one line below it. The line now reports
  the prune in the ceiling's currency — `apiContextTokens` at the prune, minus
  what came out. **What that derivation is worth, on this crossing:** it gives
  132.9k against a real 120.6k, high by 12.3k, because `contextTokens`
  understates what was removed; high is the direction that never claims more was
  freed than was. `contextAfterPrune`'s ratio applied to the same numbers gives
  105.6k, low by 15.0k, because it scales the fixed ~55,000 down along with the
  conversation.

  **What moved on the back of this measurement.** `contextAfterPrune` now
  subtracts rather than scaling, on the arithmetic above. `CYCLE_CONTEXT_CEILING_TOKENS`
  went from 167,000 to 300,000 and then, the same day, to **200,000**: at the
  old value the ~55,000 of fixed prompt left ~112,000 tokens of prunable
  conversation, and the run measured here was back over the ceiling **five
  minutes** after its own prune, stopped from cutting again only by
  `PAYBACK_HORIZON_TURNS`. Nothing in the models bounds either figure here — the
  same transcript sweep that produced the figures above found a single request
  of **752,172 tokens** on `claude-opus-5`, the largest of 678 transcript files,
  with `claude-haiku-4-5` peaking at 32,846 and `claude-sonnet-5` at 26,016.

  **The 300,000 lasted hours and is not measured.** It was lowered to 200,000
  on the operator's reading that the runs carried at that ceiling showed the
  cost — every turn carrying the whole prompt at the cache-read rate, roughly
  1.8× per turn against 167,000 — and no return. No `prune_receipts` or
  `netReceipt` comparison was taken across the two settings, so this entry
  records a judgement and not a result. 200,000 keeps the part of the raise that
  *was* measured: ~145,000 tokens of prunable conversation under the fixed
  ~55,000, against the ~112,000 that put a run back over the ceiling five
  minutes after its own prune.

  The `statSync` gate in front of the ceiling check was removed in the same
  change. It skipped any transcript under `ceiling x BYTES_PER_TOKEN` bytes on
  the argument that message content is a subset of the file — sound under
  `contextTokens`, unsound under `apiContextTokens`, since ~55,000 tokens of the
  prompt are in no transcript at all. It had held because a transcript's
  envelopes run **1.74x** its message bytes here (663 KB of file against 380 KB
  of `message`), but that is a property of how tool-heavy a run is, not a bound,
  and raising the ceiling widened the blind spot with it.

  **Not yet verified by hand:** none of this has been read in the running app —
  the container was carrying a live billed run when it was written, and a rebuild
  would have killed it. Specifically unobserved: a crossing at the ceiling as it
  now stands, the new log line, and the per-tick cost of reading every live run's
  transcript with no size gate in front of it (bounded by a read and a `split`
  per run per minute, not measured).

- **The fixed ~55,000 was 17,229 tokens of the intake filter, and the entry
  above measured it without knowing that.** The `57,819 tokens against 2,759 of
  conversation` recorded there is not what a run costs to start; it is what a run
  costs to start *through the proxy*. Pointing `ANTHROPIC_BASE_URL` anywhere but
  the API turns the CLI's **tool deferral** off — deferred loading sends a tool's
  name and withholds its JSON schema until the model asks through `ToolSearch`,
  and with a custom base URL the CLI stops offering `ToolSearch` at all and every
  schema rides every request.

  Measured 2026-08-27 in the running container, on the live run's own argv read
  out of `/proc/<pid>/cmdline` and replayed with one variable changed and nothing
  else — same worktree, same model, same trivial prompt:

  | | prompt tokens |
  | --- | --- |
  | bare `claude -p`, Haiku, `/workspace` | 17,084 |
  | same, from the worktree (this repo's `CLAUDE.md`) | 20,883 |
  | switched to `claude-opus-5[1m]` | 28,518 |
  | the app's whole argv — agents, notices, plugin dirs, sandbox settings | 30,845 |
  | **`ANTHROPIC_BASE_URL=http://127.0.0.1:8789`** | **48,074** |
  | the same, plus `ENABLE_TOOL_SEARCH=1` | 30,849 |

  So the fix restores the direct-to-API figure to within four tokens rather than
  introducing a mode: `ENABLE_TOOL_SEARCH=1` is exported beside the base URL in
  `docker-entrypoint.sh`, inside the same `winnow_up` branch, because it is only
  ever wrong when that export did not happen. Confirmed on Haiku the same way,
  34,161 against 20,828. The 19 tools it puts back behind `ToolSearch` are named
  in the transcript's own `deferred_tools_delta` — `Cron{Create,Delete,List}`,
  `DesignSync`, `EnterWorktree`, `ExitWorktree`, `Monitor`, `NotebookEdit`,
  `PushNotification`, `RemoteTrigger`, `SendMessage`, `Task{Create,Get,List,
  Output,Stop,Update}`, `WebFetch`, `WebSearch`. `Task` itself is **not** among
  them, so `DELEGATION_NOTICE`'s advice stays one call away. `ENABLE_TOOL_SEARCH=auto`
  was measured too and does nothing here: 34,302, the un-deferred figure.

  The corpus dates the regression. Across 591 fresh container sessions, 528
  carry a `deferred_tools_delta` before their first request and opened at a
  median **36,597**; the 63 that carry none opened at **51,388**. The earliest
  session with none is `2026-08-24T14:05:19`, and the `/workspace` sessions —
  whose prompts are ~50 tokens and never change — step from 30,558 to 51,106 at
  that same timestamp. That is when `WINNOW_FILTER=1` was first switched on.

  **What this costs against what the filter saves is not netted anywhere.**
  `intakeFilter.ts` prices what the filter keeps off the wire; nothing prices
  the 17,229 tokens it added to every request to do it — paid once at the write
  rate and then at the cache-read rate on every turn of the cycle. The two
  belong beside each other on `ContextControlAside` and are not there yet.

  **Not yet verified by hand:** the entrypoint change has not been through a
  rebuild — the container was carrying a live billed run. What to check on the
  next `docker compose up --build`: that a real run's first request lands near
  30,800 rather than 48,000, that `deferred_tools_delta` appears in its
  transcript, and that a run needing `WebSearch` or `WebFetch` reaches it through
  `ToolSearch` without stalling.

- **`--autocompact`'s sign, and what the flag actually does.** Measured
  2026-08-22 over 1,147 transcripts through this app's own `scanUsage()`,
  `parseCompactionBoundary()` and `pricing.ts`, and settles issue #156. Read the
  three findings in order, because the second is the one that changes what the
  flag is understood to be.

  **The flag does not lower a threshold. It creates the only one there is.**
  Splitting container sessions at `ee93684`'s commit instant: **before the flag,
  604 sessions, 246 of which carried more than 167,000 tokens, produced zero
  `compact_boundary` records, and one request reached 752,172 tokens**; after
  it, 53 sessions produced 42 boundaries and the largest prompt anywhere is
  167,623. The mechanism is in the pinned bundle — `dQe(e,t){return
  Nq(e,t).source!=="auto"}` gates the check and a window resolving to
  `source:"auto"` at or above `1e6` refuses auto-compaction outright — so this
  install's model never compacts on its own. That is a natural experiment and
  not a randomised one: same container, same pin, same model, same `sdk-cli`
  entrypoint, but different calendar periods and different workloads.

  **The threshold is `min(asked, window) − min(maxOutput, 20,000) − 13,000`.**
  Read off the 2.1.226 bundle: `SCe(e,t){let r=Math.min(cbr(e),eZu); … return
  o-r}` with `eZu=20000`, and the fire point is `SCe(…)-WQu` with `WQu=13000`.
  So `--autocompact 200000` fires at **167,000**, not the 180,000 that
  `effectiveWindow` alone predicts. Observed median `preTokens` is 168,072, with
  **30 of 42 boundaries within ±3,000 of 167,000 against 2 of 42 within ±3,000
  of 180,000**. The same 13,000 reconciles the survey's own captured debug line,
  where `effectiveWindow=80000` is refused against `threshold 67000`.

  **The sign is positive, measured between the two arms** at the point each
  session reaches the cap — for the uncapped arm the first turn past 167,000,
  for the capped arm the first turn after its first boundary, because a capped
  session never exceeds the cap and the two predicates cannot be the same:

  | | sessions | turns | cache $/turn | $/1k output | output/turn |
  |---|---|---|---|---|---|
  | Uncapped | 227 | 15,933 | $0.1656 | $0.1849 | 896 |
  | Capped | 16 | 1,541 | $0.0742 | $0.0930 | 798 |

  **0.45× per turn and 0.50× per 1,000 output tokens.** The second denominator
  is the one that matters: a within-session ±K-turn measurement of the same
  corpus gives −18.6% at K=10 and −23.2% at K=20, and **that figure is a phase
  contrast rather than an effect size** — per-turn cost is monotone in position
  within a compaction cycle, so it measures the down edge of a saw-tooth and
  never the up edge. A placebo comparing the first K to the last K turns of the
  same *uncompacted* ramp reproduces about 87% of it; re-denominated per output
  token it flips to +30% to +47%; and the net across a full cycle is −2% to −6%
  by three methods. Do not quote the ±K figure as a saving.

  **No thrash-breaker trip.** Every line in the corpus matching `circuit breaker
  tripped` is `type: "user"`, `"assistant"` or `"result"` — a person or an agent
  quoting the issue — and **zero are `type: "system"`**. The file count rose from
  5 to 12 *while this measurement ran*, so the check is a record-type filter and
  never a file count; a bare `grep -rl` returns a number that grows with every
  investigation of it. This is the same self-pollution class
  `proposals/ContextControl/19-validation.md` found with `system-reminder`.

  **Decision: `AUTOCOMPACT_WINDOW_TOKENS` stays at 200,000**
  (`src/lib/orchestrator.ts:4802`, pushed at `:4984`). The issue's "consider
  150000" is **declined**, and the reason is its own floor clause: 150,000 fires
  at 117,000, the observed firing spread is roughly ±12,000 around nominal, and
  that lower tail reaches the 100,000 floor where the CLI's breaker lives. No
  test is owed — `src/lib/orchestrator.test.ts:2074` already asserts the flag
  survives `--resume` and pins the CLI's accepted range rather than the value,
  which is the right shape and leaves this file as the only record of the number.

  **What this does not establish.** That 200,000 is *optimal* — there is one arm
  and no dose-response, so nothing here measures what another value would do.
  That the firing arithmetic generalises to another model: it is model-dependent
  through `min(cbr(model), 20000)` and through whether the window resolution
  reaches `source:"auto"` at all. And **the summariser's own call is not in any
  ledger**: all 42 `isCompactSummary` records carry no usage block and no
  assistant-with-usage record sits between a boundary and its summary, so a call
  of roughly 168,000 in and 6,300 out — order $0.24 to $1.84 per compaction — is
  billed and invisible to `scanUsage()`. It does not threaten the between-arm
  result, and it is the largest unmeasured term here. Both are on the list below.

- **What this app puts on the wire, and what it spends answering — measured
  against the running container, and every figure a *before*.** Taken on
  2026-08-23 by asking the container as it was then running, ahead of the
  changes that answer them. `GET /api/runs` answered **696,197 bytes**
  for 100 rows, of which **522,541 — 75.1% — was prompt text**, for a column the
  table clips at 56 characters. `GET /api/runs/[id]` answered **591,574 bytes**,
  of which **582,469 was an events array no caller reads**, on a three-second
  poll. `GET /api/knowledge/graph` answered **9,864,990 bytes**;
  `GET /api/branches` **254,752**; `GET /api/workflows` **30,290** for two saved
  workflows, of which the node graphs — task prompts, drawn by neither reader —
  were **28,934**. `GET /api/storage` took **5.3–7.4 s warm to answer 585
  bytes**, and two concurrent readers each paid it in full. The runs page pulled
  **10.5 MB a minute from an idle browser**, none of it compressed.

  Three of those were profiled rather than only weighed, which is what says
  where the time goes. Of the storage route, **5,981 ms was one serial `lstat`
  walk of 88,325 entries / 2.62 GB** — the two `COUNT(*)`s beside it are 0.05 ms
  and 0.01 ms — against **1,750 ms** for the same walk with 64 stats
  outstanding. Of a **1.13 s** `/api/branches`, **1.12 s was eight serial `git
  status` probes at 140 ms each** against a 15,082-entry worktree, and the cap
  of twenty puts the worst case at 2.8 s. And `listTranscriptFiles` recursing
  serially measured **105–121 ms** of a 165 ms `/api/usage` against **49 ms**
  for a level-parallel walk of the same tree, where everything it feeds is
  trivial beside it (1,174 `fs.stat` 9 ms, the dedupe 8, the sort 3).

  **The figures after each change are computed, not curled.** No server was
  asked a second time. The graph payload's **734,233 bytes** as pairs of
  positions — from 9,864,990 whole, 4,601,846 with the eight unread edge fields
  dropped and the ids kept, 1,056,865 as `{from, to}` objects — and the workflow
  list's **471 bytes** are re-serialisations of the captured payloads under the
  new shapes: arithmetic over a measurement rather than a second measurement.
  The distinction matters more than usual here because the sixteen changes were
  made in parallel against one baseline capture, so the readings do not compose
  — the compression entry below prices an 8.8 MB graph body that the
  link-position change had already made smaller.

- **Why no `/api` response was compressed, which is not what the audit that
  found it guessed.** HTML and JS from this same server came back gzipped and no
  route handler's answer ever did. The guess was that route handlers flush their
  own headers past Next's `compression` hook. They do flush, in
  `pipe-readable.js`, and it makes no difference: the flush goes through the
  patched `writeHead` and the hook fires normally. The mechanism is one step
  further out. `sendResponse` copies a handler's headers across with
  `NodeNextResponse.appendHeader`, which stores **every** value as an array, so
  the raw response holds `content-type: ['application/json']`; `compression`'s
  default filter asks `compressible()` about that value, and `compressible()`
  returns false for anything that is not a string. Every app-router route
  handler in this version is filtered out of compression by a one-element array.

  Reproduced rather than reasoned: against Next 15.5.23's own `sendResponse` and
  its own bundled `compression`, with `DEBUG=compression` printing
  `[ 'application/json' ] not compressible` and then `no compression: filtered`
  for the handler path, and `gzip compression` for a plain `res.end()` of the
  same body on the same server. The tell that led there is worth keeping too:
  what was missing was `Vary`, not `Content-Encoding` — the hook sets `Vary`
  *before* it checks the size threshold, so a response missing it never reached
  the threshold at all.

  Two things measured beside it. The small-body break-even: 111→120, 169→178,
  283→215, 374→264 and 586→336 bytes through `gzip -6`, so below roughly 250
  bytes the answer comes back larger than it went in. And that `gzipSync` on the
  8.8 MB graph body blocks the loop **30.6 ms and fires zero timer callbacks**
  while it does, against 43 in an idle 50 ms, where the promisified form costs
  the same wall clock (28.7 ms) and spends it on the threadpool — which is the
  whole reason this process, which carries the fleet's guards on that loop, does
  not take the synchronous call. The four before/after pairs (graph 8.8 MB →
  488 KB, `/api/runs` 699 KB → 174 KB, `/api/branches` 255 KB → 76 KB,
  `/api/usage` 52 KB → 10 KB) are gzip run over bodies captured at the start of
  this pass, so they price what those routes answered that morning rather than
  what they answer now.

- **Where this fleet's money goes, over the whole recorded corpus.** Measured
  2026-08-23 through this app's own `scanUsage()` and `pricing.ts` over 1,194
  transcripts — **49,038 deduped turns, $6,537, 12.3 days**. Most of the bill is
  carrying context rather than generating anything: **58% cache read and 20%
  cache write**. Two readings of that split were taken separately in this pass
  and they do not agree to the point — `readGuard.ts` records 58/20 and
  `fileCostNotice.ts` records 60.5% read / 26.5% write / 13.0% output / 0.1%
  input over the same corpus — so the split is good to a few points and no
  better, while the direction is not in doubt. Both levers that landed in this
  pass rest on the direction alone, which is the only reason the disagreement is
  recorded here rather than resolved.

  Split on the transcripts' own `isSidechain` flag, a tool call costs **13.55c
  on a main thread against 5.01c in a sub-agent**, and within a thread it climbs
  with position: **12.0c over turns 1–10 against 20.4c past turn 200**. The
  first of those is confounded and the second is not — sub-agents are handed the
  self-contained errands precisely because those are the ones worth delegating,
  and easier work costs less per call in any context, whereas the gradient is
  the same threads doing the same work further along. Count tool calls from
  every assistant record rather than the deduped ones: Claude Code writes one
  line per content block sharing a message id and a usage block, so the dedupe
  that makes the cost right drops every `tool_use` after the first and triples
  the apparent price per call.

  **What is in those contexts, denominated in characters and never in money.**
  Over the weekly window, **29,707 tool calls placed 97,970,351 characters**, of
  which **`Read` is 57.1% and `Bash` 38.2%** — 95.3% between them. Characters
  because a `tool_result` carries no usage block at all, so attributing a share
  of the bill to one would be inventing it. Denominated in tokens instead:
  **114,686,394 were placed into a context and re-read 30.6 times on average**,
  which is **$26.53 per million placed** against Opus's $5/M list input. That
  price is a **floor**, and knowably so — a re-written cache prefix counts twice
  in the denominator, which understates the multiple and therefore the price.

  **And the counterfactual, which is not a forecast.** Every one of this
  install's 327 runs is Opus. Repricing each recorded turn at sonnet-5's rate on
  the day it ran takes **$3,043.09 to $1,241.30**: **0.408×, not the 0.60× the
  rate table implies today**, because Sonnet's introductory price runs to
  2026-09-01. It is arithmetic over the tokens that were actually produced, so
  it does not know that the same task on a smaller model may take more turns,
  and the card that renders it says so in the same breath.

- **Four things read out of the pinned CLI bundle rather than run.** All four
  decide the shape of something that shipped in this pass, and all four fail
  silently if they are wrong, which is why they were read rather than assumed —
  and reading a bundle is not running one, so each stays on this footing until a
  billed run says otherwise. `PreToolUse` hook output is validated against a
  discriminated union keyed on `hookSpecificOutput.hookEventName`, carrying
  `permissionDecision` of allow/deny/ask/defer: a deny missing the event name is
  not a refusal, it is output the CLI discards without a word. A plugin's
  `hooks/hooks.json` takes the wrapper shape
  `{"hooks": {"PreToolUse": [{matcher, hooks: […]}]}}`, which is not the
  settings-file shape, and the wrong one registers nothing — again silently.
  `agent_id` appears on hook stdin **only inside a sub-agent**, which is what
  lets a hook tell the two apart at all. And the CLI's own whole-file read is
  capped at **25,000 tokens** and truncated to the **first 2,000 lines** ("was
  too large and has been truncated to the first 2000 lines"), which is why a cap
  on a read measures the read rather than the file: a long thin file never
  reaches a cap it would otherwise be refused for.

- **That `--plugin-dir` registers a plugin's *hooks*, observed at last** — the
  thing the entry below used to say had never been seen here. Read off the live
  install's own `run_events` on 2026-08-23, from a third-party plugin
  (`/workspace/winnow/plugin`) sitting in `plugins.enabled` beside `orient`: 213
  `hook_response` rows, `hook_name` `SessionStart:startup` (93),
  `SessionStart:compact` (88) and `SessionStart:resume` (32), each `exit_code:
  0` with the hook's own `Cozempic: guard active` as `stdout`, and each followed
  by a `log` row reading `SessionStart:… hook added this to the agent's
  context`. So the flag delivers hooks as well as skills, a resumed cycle gets
  them (`--resume` restores no flags, and this is the flag being on the argv
  doing its work), and an autocompact fires `SessionStart` a second time inside
  one cycle.

  **What this does not establish, and the reason is in the CLI rather than in
  the data.** Only `SessionStart` was ever *seen*, and that is not evidence
  about the others: `hook_response` is emitted through `zRo(hookEvent)`, whose
  allowlist is `JKy = ["SessionStart","Setup"]` with everything else behind
  `CLAUDE_CODE_REMOTE`. `PostToolUse`, `PreCompact`, `PostCompact` and `Stop`
  therefore run — or do not — entirely unobserved from here, and this plugin
  registers all four. `readGuard`'s `PreToolUse` is in that unobserved set, so
  what it inherits from this is the general claim and not its own.

  And what was running was the hook *shell*, not the plugin: `cozempic` was
  absent from the image the whole time — no `pip`, no `ensurepip`,
  `EXTERNALLY-MANAGED` — so every command in every one of those hook bodies fell
  through its `|| true` having done nothing. The `echo` sits outside those
  chains, which is exactly what makes it evidence: it proves the body executed
  and proves nothing about what the body does. 213 sessions were told a guard
  was active with no guard present. `UF_PY_TOOLS` is the answer to that half.

- **The outbound webhook delivers, and the signature it sends verifies against
  two implementations that are not this one.** Measured on 2026-08-23 with a
  throwaway `node:http` listener outside the checkout, driving the real
  `notifyLifecycle` through the compiled module rather than a paraphrase of it.
  Four events in, two POSTs out — exactly the ones the filter names: a
  `needs-review` status, and a `stopped` preceded by a `budget` verdict, with a
  `completed` and an unaccompanied `stopped` (an operator's own cancel) sending
  nothing. Both requests arrived `POST /api/webhook/uf-proof` with
  `content-type: application/json`, `user-agent: UsageFoundry/0.1.0` and a
  `content-length` equal to the bytes read off the socket. The body of the first
  was 156 bytes:

  ```
  {"install":"büro","event":"run.needs_review","run_id":"r-proof-1","status":"needs-review","at":1700000000000,"url":"https://uf.example.com/runs/r-proof-1"}
  ```

  `JSON.parse` of it gives exactly `["install","event","run_id","status","at",
  "url"]` and nothing else; `ü` arrived as `c3bc`, so the body is UTF-8 on the
  wire, and the trailing slash on `UF_PUBLIC_URL` was stripped rather than
  doubled. The header was
  `sha256=3ec1124f7004e3b8b1d4280bb050e9ec7dee1199429e029c51a66e0fef564b6e`, and
  the raw bytes were written to a file and re-hashed by `openssl dgst -sha256
  -hmac` and by Python's `hmac` — both agree with the header, on both bodies. So
  what a receiver verifies is checked by something other than the code that
  produced it, which is the whole point of freezing the vectors in
  `notify.test.ts`.

  Two more things were exercised the same way. A real external POST to
  `https://httpbin.org/post` returned **200** and was recorded as such, so egress
  from this environment works and the delivery path is not only a loopback story
  — though httpbin's echo was discarded by `deliver`, so byte-level fidelity is
  established over the local listener and not over the internet. And a POST at an
  unreachable receiver (`http://127.0.0.1:9/uf`) logged
  `webhook.delivery … http_status: 0, ok: false, message: "fetch failed"` at
  `warn` and left `webhookHealth()` reading `consecutiveFailures: 1`, which is the
  path `/api/status`'s alert row depends on.

- **Discord's 400, the in-container relay, and the credential it does not
  hand on.** 2026-08-24, against a real Discord channel webhook and a real
  container on Docker Desktop.

  The generic six-field body posted to a live Discord webhook answered **400**
  with `{"message": "Cannot send an empty message", "code": 50006}`, and a
  `{"content": …}` control to the same URL answered **204**. So the claim that
  a Discord URL cannot be a receiver is now a request this project sent rather
  than a reading of Discord's documentation, and the URL was proved live in the
  same pass — the two failure modes that look identical from here.

  A real run loop produced a real notification. Run `2ed6f591`, `completed` under
  `UF_NOTIFY_ON_SUCCESS=1`, wrote `webhook_deliveries` `event: run.completed,
  http_status: 0, ok: 0, error: "fetch failed"` — the emit, the filter, the body
  and the recording all exercised by an actual ending rather than a constructed
  `PersistedRunEvent`, with the failure being the receiver that was not running.

  `scripts/discord-relay.mjs` then ran **inside the container**, started by
  `docker-entrypoint.sh` off `DISCORD_WEBHOOK_URL`, listening on
  `127.0.0.1:8787`. A correctly signed body sent from inside that container to
  the `UF_WEBHOOK_URL` the *server process* holds was answered `204` and logged
  `forwarded run.completed`, and the message arrived in the channel. The relay
  also refused an unsigned body with `401`, a wrong signature with `401`, a `GET`
  with `405` and a signed unparseable body with `400`.

  The unset was measured on the right process, which took three attempts and is
  the reason this paragraph exists. `docker compose exec` starts a process from
  the container's *configured* environment and `/proc/1/environ` is `tini`'s —
  both still carry `DISCORD_WEBHOOK_URL`, and both are the wrong probe. The
  server is the process the entrypoint `exec`s into: its environ carries
  `UF_WEBHOOK_URL`, `UF_WEBHOOK_SECRET` and `UF_NOTIFY_ON_SUCCESS` and **no
  `DISCORD_*` at all**, which is what `orchestrator.ts` copies into an agent. The
  relay keeps the URL, runs as root, and `setpriv --reuid=1000` reading its
  `/proc/<pid>/environ` was refused.

- **Playwright renders a real page, as the uid an agent runs as.** 2026-08-24,
  inside the live `usagefoundry` container on Docker Desktop, arm64.

  `playwright install --with-deps chromium` at 1.62.1 pulled Chrome for Testing
  151.0.7922.34 (build `chromium-1234`), the matching headless shell and ffmpeg,
  and the 32 apt packages Playwright's own dependency list names — the X, mesa
  and font stack, `fonts-noto-color-emoji` and the CJK packs among them. Measured
  on disk: **641 MB** Chromium, **340 MB** headless shell, 3.3 MB ffmpeg, against
  a 1.94 GB image. So Debian 12 on arm64 is a platform Playwright ships a
  Chromium for, which is the thing that could have been false.

  `docker exec -u 1000 … playwright screenshot --viewport-size=1280,800
  http://127.0.0.1:3000/login /tmp/uf-login.png` then produced a correct 1280×800
  PNG of this app's own login page — right fonts, right colours, no tofu — run as
  uid 1000, which is what `UF_AGENT_UID` defaults to and therefore what an agent
  is. Chromium's own sandbox is unusable here for the reason `bwrap` is (`unshare`
  is EPERM under Docker's default seccomp profile), and it did not have to be:
  Playwright defaults `chromiumSandbox` to false, so neither the CLI nor an
  ordinary `launch()` asks for it.

  What was **not** verified: the `Dockerfile` and `docker-entrypoint.sh` changes
  that make this survive a rebuild. The install above was done by `docker exec`
  into a container holding a live run, so it sits in the writable layer at the
  default `$HOME/.cache/ms-playwright`, while the image build puts it at
  `/opt/playwright/browsers` behind `PLAYWRIGHT_BROWSERS_PATH`. Both were reasoned
  about, only the first was run. The build has not been executed.

- **`playwright install` fails inside the container, in two different ways, and
  rendering does not.** 2026-08-25, live `usagefoundry` container, arm64. The
  image has since been built from the block above — `chromium-1234`,
  `chromium_headless_shell-1234` and `ffmpeg-1011` are at
  `/opt/playwright/browsers` and `playwright --version` is 1.62.1 — which closes
  the "the build has not been executed" note above.

  With the sandbox off (`docker exec -u 1000`), `npx playwright install chromium`
  exits `Failed to install browsers / Error: EACCES: permission denied, open
  '/opt/playwright/browsers/.links/4aea…'`. Nothing was downloaded and nothing
  needed to be: `npx --no -- playwright --version` reports 1.62.1, so npx
  resolves the global install rather than fetching from the registry. What the
  command cannot do is rewrite the 67-byte link file naming
  `/usr/local/lib/node_modules/playwright/node_modules/playwright-core`, which
  was root-owned because the image chowned the directory and not its contents.
  That is what this commit's two `.links` chowns close. It matters because
  `playwright install` is also what an agent runs to *check* whether a browser is
  there, and the words it prints say the opposite of the truth.

  With `UF_SANDBOX=1` the ownership decides nothing. Measured through `srt` at
  0.0.71 with `enableWeakerNestedSandbox: true` and `allowWrite: ["/tmp"]`, a
  write under `/opt/playwright/browsers` is refused with **`Read-only file
  system`**: the sandbox's write model is allow-only and bubblewrap binds
  everything outside the allow list read-only. Adding `/opt/playwright/browsers`
  to `allowWrite` does reopen it — also measured — so a managed-settings change
  could make the install work under the sandbox. What was **not** measured is
  whether the CLI's own `filesystem.allowWrite` merges with or *replaces* the
  working-directory and `/tmp` defaults it adds, and a replacement would leave
  every agent unable to write its own worktree. Do not add that key on reasoning
  alone.

  Rendering is unaffected in both modes. `playwright screenshot` against a
  `data:` URL produced a correct PNG as uid 1000 unsandboxed, and again inside
  `srt` under the same policy.

  That second run failed first with `ENOENT: mkdtemp
  '/tmp/claude/playwright-artifacts-…'`, which looked like a fleet-wide problem
  and is **not** one — it is an artifact of driving `srt` by hand.
  `sandbox-utils.js` sets `TMPDIR` inside the sandbox to `CLAUDE_CODE_TMPDIR ??
  CLAUDE_TMPDIR ?? /tmp/claude`, creates none of the three, and says so in its
  own comment; a bare `srt` invocation carries none of those variables, so it
  lands on the fallback. The CLI sets one: `/tmp/claude-1000` exists in the
  running container, owned by `node`, holding `tsx-1000`, a `node-compile-cache`
  and one directory per project path — all written by real agent work under the
  sandbox. So the path nothing creates is the path nothing uses.

  **Do not create `/tmp/claude` in the entrypoint to "fix" this.** The CLI
  refuses a temp directory it does not own — `tempdir_owner_mismatch`, "Set
  CLAUDE_CODE_TMPDIR to a directory you control, or ask an administrator to
  remove it" — so a root-owned one would break the fallback rather than repair
  it, and an agent-owned one would sit there unread.

- **The runs list's `Pruning` column, rendered at two viewports.** Measured
  2026-08-25 against a production build served on a throwaway `DATA_DIR` with
  `CLAUDE_HOME` pointed at synthetic transcripts, so nothing here touched the
  real `~/.claude` or the install's database. Four seeded runs covering the
  three states the column can be in: two priced positive (`+$0.77`), one whose
  early end removed 5,000 tokens with two turns behind it and therefore nets
  **negative** (`−$0.07`, the invalidation outrunning the re-reads), and one
  with no receipts at all, which renders `—`. The wire agreed with the render in
  every case, and `prunedNetUSD` was **absent** rather than 0 on the run that
  never pruned.

  Both shapes were opened. At 1440px the column sits right of `Spent` in both
  the in-flight and the finished-in-24-hours tables and no column edge moved;
  below `md` the table stacks and each figure came out under a `Pruning` label,
  which is the whole of what names it there.

  **Two things this does not establish.** The figures came from seeded receipts
  against seeded transcripts, so what is verified is the plumbing and the
  rendering — not that pruning is worth what the column says on a real install,
  which is the prune entry above's open question. And the per-run figure is
  deliberately **unbounded in time**, unlike the dashboard's spans: a run old
  enough for its transcripts to have been swept prices at zero saving with any
  early-end invalidation still charged, so its column will drift towards a small
  negative. That is the same number its own page prints — the two must not
  disagree about one run — but it has not been observed on an aged run.

  Dev mode could not be used for this and is worth recording: `next dev` answers
  500 to every request here, `EvalError: Code generation from strings disallowed
  for this context` out of `edge-instrumentation`, before any of this change was
  involved. A production build and `next start` were the way in.

- **The orchestrator page bounded to the pane at `lg`, rendered at seven
  viewports.** Measured 2026-08-27 against `next dev` on a throwaway `DATA_DIR`
  with `CLAUDE_HOME` pointed at an empty directory, driven by Playwright's
  bundled Chromium, so nothing here read the real `~/.claude`, touched the
  install's database or started a `claude` process. The database was seeded
  directly: three chat sessions — so the side card shows its tab strip rather
  than the `CardTitle` a fresh install opens on — forty messages, twelve pending
  proposals and six decided.

  At 1440×1080, 1440×700 and 1024×700 the pane's own overflow
  (`main.scrollHeight − main.clientHeight`) is **0** in every combination tried:
  the notice's disclosure closed and open, with and without two error banners
  above the grid, and on each of the side card's three tabs. The thread reports
  3,079–3,653px of internal scroll and the proposals list 1,401–1,950px, which
  is where the length went. The composer's textarea ends at y=966 of 1,080 and
  y=586–621 of 700; the approve row at 1,011 and 631–692. The same script
  against the parent commit reads **3,180–5,024px** of pane overflow with the
  thread not scrolling at all — at `lg` the card dropped its cap and grew to the
  whole transcript, putting the composer at y=4,146 of a 1,080px window.

  Below `lg` the change is a **no-op, measured rather than argued**: at
  1023×700, 1023×1080, 900×900 and 500×900 this commit and its parent produce
  identical numbers — the same pane overflow (715 / 335 / 515 / 551), the same
  column height, the same 544px (34rem) cards, the same thread height and
  internal scroll, the same proposals scroll. The page still scrolls there,
  which is what the stacked layout is for.

  **Three things this does not establish.** No container was started — Docker is
  unavailable in the environment this was measured in, so the image's own
  stylesheet rests on `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build`
  (exit 0) plus a grep proving `lg:absolute`, `lg:inset-0`, `lg:min-h-0` and
  `lg:flex-1` are all in the emitted CSS, which is the failure Tailwind's
  `source(none)` exists to prevent and not the same as having seen it.
  `docker compose up --build` is still the run to make. The error banners were
  **injected into the live DOM** rather than produced by a failing poll, so what
  is measured is the height they take rather than the state that puts them
  there. And there is one case at `lg` where a scrollbar remains, which is
  arithmetic rather than a defect: the row's incompressible furniture is about
  186px — the composer, the approve row and the two cards' padding, none of
  which may shrink — so a 700px window carrying the read-only banner *and* the
  disclosure open *and* two error banners at once runs 71px short and the pane
  scrolls by exactly that, with the composer 22px under the fold. All four
  together is the only combination found that does it, and shortening any one of
  them fits.

- **A cycle's spend was the sum of two `result` events, and one of them already
  contained the other.** Measured on the live container on 2026-08-27 against
  run `075f7959` (session `ff106514-…`, one work cycle, 20.6 minutes, the
  `ts-coder` agent on `claude-opus-5`). The run row read **$16.355574 /
  5,915,907 tokens**; the telemetry card beside it read **$9.330155 / 8,481,166
  tokens** — 75% apart on money and 30% apart on tokens, in *opposite*
  directions, which is what made it worth chasing rather than filing as an
  export that had dropped a batch.

  Telemetry is the reading that reconciles. The session's transcripts hold 110
  unique `requestId`s — 56 in `ff106514-….jsonl` and 37/10/7 in the three
  `subagents/agent-*.jsonl` files — and `otlp_requests` holds exactly 110 rows
  totalling exactly 8,481,166 tokens. Token for token, so there is no room in
  the transcript for the extra $7 the run row claimed. Its per-class rates check
  out too: 1,458 / 57,607 / 5,709,769 / 147,073 at `pricing.ts`'s
  `claude-opus-5` with 1h cache writes comes to $5.773080, which is the `sdk`
  rows' total to six decimals.

  `run_events` held **two `result` rows at the same millisecond**
  (`1787852651348`): `{costUSD: 7.025419, numTurns: 60}` and `{costUSD:
  9.330155, numTurns: 9}`, and `orchestrator.ts` added them. Both are session
  running totals: $7.025419 is the cumulative telemetry at `1787852201959`
  exactly — an `sdk` request — and $9.330155 is the cumulative total at the last
  request of the run. The second contains the first. What produced two of them
  from one child is visible in the same feed: the agent's turn ended at
  `…201959` while the `Adversarially verify refactor fidelity` `Explore`
  sub-agent was still running, and when it answered at `…509306` the *same*
  session re-inited (`system:init` at `…509435`, same `session_id`) and ran 8
  more main-thread requests to a second terminal result.

  The token gap is the other half of the same event and does not have the same
  cause: `result.usage` is per-stretch, so summing it is right, but it is
  main-thread-only. 5,915,907 is exactly the 56 `sdk` requests, split
  4,798,457 / 1,117,450 across the two stretches; the 54 sub-agent requests
  (2,565,259 tokens, $3.557076) are absent from it entirely. That is the CLI's
  scoping, not this app's, and correcting it from telemetry would make
  `runs.spent_tokens` a mixture of two sources.

  **The shape is rare and the discriminator was checked**, which is why every
  other multi-`result` run reconciles: across 39 recent runs with more than one
  `result` and telemetry to compare against, drift is $0.000 for all but two.
  The rest are restarts — a first `result` of `error_during_execution`, then a
  new child with a CLI accumulator that starts at zero, so summing partitions
  correctly. The two that drift are this run (+$7.025) and `65252b8a` (+$29.082),
  both with two `success` results inside one cycle. `cycleCostAfterResult` is
  therefore scoped to one `IterationResult` and the run loop's `+=` across
  children is untouched.

  **Not yet verified by hand:** the fix has `npm run typecheck` (exit 0) and
  `npm test` (**1,816 tests / 268 suites / 0 failures**, of which 4 are the new
  `cycleCostAfterResult` cases) behind it and has **not** been read in the
  running app — the container was deliberately left alone rather than rebuilt.
  No `next build` was run either. What to check on the next rebuild is the thing
  no unit test can reach: a real two-`success`-result cycle, and that the run
  page's spend then agrees with its telemetry card rather than exceeding it. The
  two runs above are **not** retroactively corrected — `runs.spent_usd` is
  stored, not derived, so both rows keep their inflated figures.

## Not yet verified by hand

The live-enforcement and pause/resume paths typecheck, build (including the
standalone bundle), and are covered by the unit tests above, but the following
have **not** been exercised against a real CLI. They are the list to work
through before trusting this unattended:

> **Two conflict resolutions in one repository have never been run at once.**
> The aux resolve checkout is now named for the run — `<slug>-resolve-<id8>`
> rather than one `<slug>-resolve` the whole repository shared — and
> `resolveConflicts` holds a claim on the run from entry until `startAssist` has
> written the row `assistRunning` reads. What that rests on is `npm run
> typecheck` (exit 0), `npm test` (**1,906 tests / 281 suites / 0 failures**, of
> which 1 is the new `resolveCheckout.test.ts`) and that test driving two real
> `git worktree add`s through `resolveCheckout` in one store, which is the
> collision itself with no `claude` child standing in either checkout. What has
> **not** been exercised is the rest of it: two conflicting branches in one
> repository, the merge queue auto-resolving one while the operator presses
> Resolve on the other, both children running to completion, and the two
> `run_reviews` rows then describing work that is actually theirs. That needs
> Docker and two billed children. Nothing was read in the running app and no
> `next build` was run, since nothing under `src/app/` changed.

> **No real restart was taken over a live loop block.** `reconcileBlocksOnBoot`
> now spares a `looping` block whose instance kept a member across the boot,
> which is the same `bootBlockPlan` question its `waiting` sweep already asked.
> What is behind it is `npm run typecheck` (exit 0) and `npm test` (**1,909
> tests / 0 failures**, of which 4 are the new `bootBlocks.test.ts` cases — the
> two positive ones were seen to fail against the unfixed sweep, reporting
> `failed` where the block must read `looping`). What no test here reaches is
> the thing the fault was made of: a container restarted while a loop's pass is
> genuinely parked. On the next rebuild, park a pass inside `resumeGraceHours`,
> `docker compose restart`, and check that the loop block still reads as
> repeating on the instance page, that the sweeper resumes the pass, and that a
> further pass is created when it settles — and, for the other direction, that a
> loop whose pass the same boot failed still reads `failed` with the restart
> sentence on it.

> **The intake filter's uid drop was never booted.** `docker-entrypoint.sh` now
> starts `python -m winnow filter` through the same `setpriv --reuid` its `gh`
> and `uv` neighbours use, hands it an `env -i` allowlist rather than the
> entrypoint's whole environment, and writes its ledger and off switch to a
> named volume at `/var/lib/winnow` instead of `/data/winnow` — which is
> root-owned 0700 and so unreachable from `UF_AGENT_UID`. The run that made the
> change had **no Docker**, so the one observation that settles it was not made.
>
> What it does rest on: `dash -n docker-entrypoint.sh` (exit 0; `/bin/sh` in the
> image is dash), `npm run typecheck` (exit 0), `npm test` (**1,909 tests / 0
> failures**, of which 4 are the new `deployment.test.ts` group — seen failing
> against the unfixed entrypoint before the fix and passing after), and the
> branch under a harness: the real entrypoint executed with a recording
> `setpriv` and `uv` on `PATH` and four credentials in its environment, once
> with `UF_AGENT_UID=1000` and once without. The argv recorded was `setpriv
> --reuid=1000 --regid=1000 --clear-groups env -i …`, and the environment
> recorded was seven entries — `PATH`, `HOME`, `UV_PROJECT_ENVIRONMENT`,
> `UV_PYTHON_INSTALL_DIR`, `UV_PYTHON_PREFERENCE`, `WINNOW_FILTER`, `PWD` — with
> none of `UF_AUTH_TOKEN`, `ANTHROPIC_ADMIN_KEY`, `UF_GITHUB_TOKEN` or
> `UF_WEBHOOK_SECRET` among them. A recording `uv` is not `uv`, and none of it
> boots a container.
>
> The click-list, on a host with Docker and `WINNOW_FILTER=1` in `.env`:
>
> 1. `docker compose up --build -d`, then `docker compose exec usagefoundry ps
>    -o uid,cmd | grep 'winnow filter'`. The uid must be the agent's — 1000 by
>    default — and not 0. This is the whole of the defect.
> 2. `docker compose logs usagefoundry | grep winnow` must report the filter on
>    its port rather than failing to open it within 90s. That timeout is what a
>    virtualenv the agent uid cannot write looks like from outside.
> 3. `docker compose exec usagefoundry ls -ln /var/lib/winnow`: the directory is
>    root's 0755 and `filter.jsonl` is `0:<agent gid>` 0620.
> 4. Run one work cycle, then `docker compose exec usagefoundry wc -l
>    /var/lib/winnow/filter.jsonl` — it must grow. **A listening filter with an
>    empty ledger is the failure this move exists to prevent**, and the only
>    thing that would say so is `winnow: ledger not written:` on stderr:
>    `_append_ledger` swallows its own `OSError`, and the dashboard reads a
>    missing ledger as a legitimate state rather than an error.
> 5. `docker compose exec usagefoundry touch /var/lib/winnow/filter-off` must
>    stop the rewriting from the next request, and `rm` must resume it.
> 6. `docker compose exec -u 1000 usagefoundry touch /var/lib/winnow/filter-off`
>    must be **refused**. The switch is the operator's: a run that could throw it
>    could stop paying for its own transcript.
> 7. An install that had a ledger under `/data/winnow` before the upgrade should
>    find its lines carried over — the entrypoint copies them once, and only
>    when the new ledger is still empty.

> **`/app`'s ownership has never been read off a built image.** The Dockerfile
> stopped chowning `/app` to `node` (#200): it was handing the agent uid
> ownership of `server.js`, `.next/`, the standalone `node_modules/` and
> `scripts/discord-relay.mjs` — the last of which the entrypoint re-runs *as
> root* every five seconds — while the server itself runs as root. The change is
> the removal of one path from one `chown`, and `deployment.test.ts` pins the
> absence, but Docker was unavailable to the run that made it, so nothing has
> confirmed that the bundle actually lands root-owned or that the boot still
> works without the grant. Three commands settle it:
>
> ```bash
> docker compose up --build -d
> docker compose exec usagefoundry \
>   stat -c '%U %n' /app /app/server.js /app/scripts/discord-relay.mjs
> uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
> docker compose exec -u "$uid" usagefoundry sh -c 'touch /app/probe 2>&1; echo exit=$?'
> ```
>
> The `stat` must say `root` three times and the `touch` must fail with
> `Permission denied` and a non-zero exit. Then read the boot log for the
> ordinary lines — a healthy `/api/health`, the gh-extension and pytools blocks
> if they are configured, and the relay if `DISCORD_WEBHOOK_URL` is set — since
> what is unproven is not only the ownership but that nothing in the image
> quietly needed to write the bundle. The uid comes from the container, never
> from `-u 1000`, for the reason `docs/install.md`'s *Sign in once* gives.

> **The `canvasView.ts` extraction was not looked at.** The world/screen
> transform, hit testing, device-pixel sizing, the pan/zoom gestures, the
> `ResizeObserver` and the colour probe were moved out of
> `KnowledgeGraphCanvas.tsx` into `src/lib/canvasView.ts` by a run with **no
> Docker and no browser it could drive**. It is a refactor and behaviour is
> meant to be identical, and the one thing that would demonstrate that — that
> the graph still pans and zooms — is the thing that run could not check.
> Everything claimed for it rests on `npm run typecheck` (exit 0), `npm test`
> (**1,834 tests / 267 suites / 0 failures**, of which 22 are the new
> `canvasView.test.ts`) and `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run
> build` (exit 0). The unit tests cover the arithmetic and cover *none* of the
> DOM wiring: `observeCanvasSize`, `observeTheme`, `probeTokens` and
> `sizeCanvasToHost` have no assertions anywhere and are only known to compile.
>
> The click-list, at **Knowledge → the graph pane** (the vault must be mounted
> and a graph showing; the pane is the canvas beside the settings panel):
>
> 1. **Pan.** Drag from empty space. The graph must follow the pointer 1:1 and
>    stay where it is let go. Nothing may spring back.
> 2. **Zoom about the pointer.** Put the cursor on a *named* node away from the
>    centre and wheel both ways. That node must stay under the cursor at every
>    step — this is the assertion most likely to have been broken, because
>    `zoomAt` now returns a new view where the old code mutated one in place.
> 3. **Both clamps.** Keep wheeling in past the ceiling and out past the floor.
>    The zoom must stop and the graph must **not creep** while it is stopped.
> 4. **Hit targets.** Click a node: the note opens. Click two overlapping nodes
>    at low zoom: the one whose centre is nearer the cursor opens, not the other.
>    Click empty space 5–10px off a node's edge: nothing opens.
> 5. **Drag a node.** It must stay under the pointer, stay where dropped, and
>    still be there after changing a filter.
> 6. **Click versus drag.** Press on a node, move ~2px, release — the note opens.
>    Press, move ~20px, release — it does not.
> 7. **Device pixel ratio.** Load at dpr 1 and at dpr 2 (a HiDPI display, or
>    Chrome DevTools' device toolbar at 2×). Labels and node edges must be
>    crisp at both, and the graph must fill the pane rather than a quarter of it.
> 8. **Resize.** Drag the window narrow and wide, and collapse/expand the panel
>    beside the pane. The canvas must track the host's box and — the fault this
>    one is for — must **not ratchet**: made tall then narrow, it must come back
>    down rather than keeping the taller height.
> 9. **Theme.** Flip the theme toggle, then flip the OS scheme while the app is
>    on "Match system". The graph's colours must change on both without a
>    reload; the second is the one that has no React render behind it.
> 10. **The loop still stops.** Leave a settled graph alone and watch the CPU:
>    it must go to idle. Then touch anything — a slider, a drag — and it must
>    wake.
>
> Firefox is worth one pass for step 2 alone: `wheelZoomFactor`'s `deltaMode`
> handling is the one branch no other engine takes, and its own docblock says
> the 16px line height is an estimate nobody has held against a real mouse.

> **The map at `/runs/[id]/touched` has never been seen.** It was built and
> shipped without a browser: Docker is unavailable in the environment it was
> written in and no browser could be driven there, so every statement about it
> below is a statement about the code. It typechecks, `next build` registers the
> route, its reduction, its fold rule and its three empty states are unit-tested
> in `touchedMap.test.ts`, and every Tailwind class it uses was grepped out of
> the emitted stylesheet rather than assumed — which catches a spelling Tailwind
> would drop silently and catches nothing at all about whether the picture is
> legible. Nobody has looked at it.
>
> What *is* measured: the layout was run headlessly against the compiled
> modules — no DOM, no canvas, just `buildTouchTree` → `planTouchedMap` →
> `createSimulation`/`step` to settlement — over five shapes. It is not a
> substitute for looking, because it says nothing about colour, label
> collision or whether any of it is readable, but it does settle the two
> things that are arithmetic rather than taste.
>
> **The loop stops.** Every shape reached `step() === false` at 250 frames
> against a 2,000-frame cap, which is the cooling curve doing what
> `ALPHA_DECAY` says and is the failure that otherwise looks identical to
> success.
>
> **The clusters separate.** Mean directory-anchor-to-directory-anchor
> distance against mean file-to-its-own-anchor distance: **3.6×** on a
> reconstruction of the measured run (39 named files plus one changed-never-
> named, 15 directories, 55 nodes, 708×642 world units, nothing folded);
> **7.4×** at 400 files in ten directories; **1.8×** for 60 files that are
> all in one directory, which is the degenerate case and is right — there is
> only one cluster to separate. Closest two nodes edge to edge: 11.7 world
> units at 39 files, 7.1 at the 60-in-one-directory case, and **−1.1** at
> 400, so at that size one pair just touches. One file draws two nodes and
> does not divide by zero.
>
> **The fold is coarse at the bottom of its range.** 400 files against the
> shipped budget of 300 folds three directories, hides 120 files and draws
> 280 — the intended behaviour. Forced to a budget of 100 the cutoff falls
> to 0 and it draws *no* files at all, six nodes standing for four hundred:
> honest, announced, and one click from opening, but a step rather than a
> ramp. Nothing on this install is near enough to 300 for it to fire; if a
> real run ever lands between the two, that is the thing to look at.
>
> Open a settled run that changed something, take the **Files** tab, and press
> **Lay it out** on the "What it touched" card. At 1440×900:
>
> 1. **The shell.** Runs is still the lit row in the sidebar and the toolbar
>    reads "What it touched" — both were verified by running `activePane` and
>    `toolbarTitle` over `/runs/<id>/touched`, but only the functions were, not
>    the rendering. ⌘3 should still come back here.
> 2. **The first frame.** The map settles and *stops*. Watch a CPU meter for ten
>    seconds after it comes to rest: a canvas that keeps asking for frames is the
>    failure `forceLayout`'s cooling exists to prevent, and it looks identical to
>    one that has stopped. Then turn on "Reduce motion" at the OS level and
>    reload: the layout should arrive already settled, in one step, with no
>    visible animation at all.
> 3. **The arrangement.** Files should sit in clusters around a small ringed
>    directory node carrying the directory's name, and the clusters should be
>    separated rather than one mass. This is the whole deliverable and the thing
>    least likely to be right first time: `FORCES` in `RunTouchedMap.tsx` is the
>    graph panel's defaults with `linkDistance` dropped from 90 to 70, chosen by
>    reasoning about a rosette rather than by looking at one. If files crowd
>    their directory or clusters overlap, that constant is the dial.
> 4. **What a node says.** Against the legend beside the canvas: a read-only file
>    is grey, a written one is accent blue, one that is both is accent with a grey
>    core, and a file that changed with no tool call behind it is hollow with a red
>    edge. A ring in the foreground colour means the branch diff lists it; a dashed
>    amber ring means outside the checkout. Check the accent-and-grey core is
>    actually distinguishable from plain accent at the smallest node on screen — it
>    is a disc at half radius and nobody has seen it below about 5px.
> 5. **Labels.** Directory names are always drawn; file names ramp in above about
>    0.75 scale, and appear immediately on whatever the pointer is over. Zoom out
>    far: the file names should go, the directory names should stay.
> 6. **The gestures.** Drag the background to pan, wheel to zoom — the point under
>    the cursor should stay under it — drag a node and it should stay where it was
>    dropped. Click a file: the inspector on the right fills in with its path,
>    counts, tools and callers, and the node takes a `--tint` halo well clear of
>    its own edge — check that halo actually reads as *selected*, since the ring
>    it has to be told apart from is the foreground-coloured one meaning "in the
>    diff". Click empty space: it clears. Then repeat this whole step with "Reduce
>    motion" on: the integrator never runs there, so the drag writes the position
>    itself, and a drag that appears to do nothing — or a node that jumps
>    somewhere later — is that path being wrong.
> 7. **A run with one work cycle.** This is the common case on this install and
>    the map is deliberately built without a time axis, so it must not look broken
>    or half-empty: the header says "… across 1 work cycle" and nothing else on the
>    page mentions cycles at all. Confirm there is no empty column, axis or legend
>    entry waiting for a second one.
> 8. **A run whose events were swept.** Find or make a run older than
>    `eventRetentionDays` whose branch still exists. The card on the Files tab
>    offers no "Lay it out" button at all — the link is only drawn over a report —
>    so the route has to be typed. It must say the events were removed on the
>    *N*-day horizon and that the changes are still on the Files tab. It must not
>    render an empty canvas. Same check for a run that named no file (an idle
>    sentence, not a blank picture) and for an id that does not exist.
> 9. **A run with no diff.** Delete a finished run's branch and reload the map.
>    The changed ring must disappear from every node, the legend must drop its
>    "ringed" row, and each file's inspector must read "Unknown — there is no diff
>    for this run" rather than "Not changed".
> 10. **Folding.** The budget is 300 drawn files and no run on this install is near
>    it, so this needs a run that touched a few hundred files or a temporarily
>    lowered `MAX_DRAWN_FILES`. A folded directory draws as one larger node with
>    its name and "N files" under it, the notice above the canvas gives the total
>    folded, and clicking one opens it — the files inside appear *beside it*
>    rather than flying in from the middle of the map, the surrounding layout does
>    not jump, and the inspector then describes the directory that just opened
>    rather than clearing. Open a second fold afterwards: nothing already on
>    screen may change position except by settling, including a directory the
>    budget closes again to pay for the one you opened. Nothing should ever
>    vanish.
> 11. **Both themes and the OS switch.** Toggle light/dark with the map open; the
>    node colours must re-probe without a reload. Then leave the app on "Match
>    system" and change the OS appearance, which is the boundary that fires no
>    React render.
> 12. **Narrow.** At 390px the split stacks, the canvas keeps its 24rem height, and
>    dragging on the canvas pans rather than scrolling the page.

> **The four frontend reachability fixes — the paged runs list, quick open's
> search, the run log's filter and the settings field search — were written on
> branch `uf/usagefoundry-721638d11c0b-1-41e5e190` by two runs, and a third that
> only wrote documentation. **Between them they opened no browser, drove nothing
> at any viewport and started no container.** Everything claimed for them rests on
> `npm run typecheck` (exit 0), `npm test` (**1,660 tests / 245 suites / 0
> failures**), `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` (exit 0)
> and, for the runs query only, SQLite driven directly against throwaway
> databases. Those commands were re-run on the branch head `a34e56b` and the
> results above are that run's output, not a repeated claim.
>
> **Roughly 900 lines of interactive page code were added and not one of them was
> rendered by anything** — `+286` `src/app/runs/page.tsx`, `+243`
> `src/app/settings/page.tsx`, `+185` `src/app/runs/[id]/page.tsx`, `+130`
> `src/components/shell/QuickOpen.tsx`, from `git diff main...HEAD --stat`. There
> are still zero page tests, no jsdom and no browser in CI, so the two entries
> below are the whole of what stands between these controls and an operator, and
> `proposals/GapRegister/01-frontend.md`'s F5 is the row that says so. The
> narrow-viewport entries further down this list predate all four controls and
> cover none of them.

- **The paged runs list and quick open's search, in a browser.** `/api/runs`
  now reads `offset`, `limit`, `status`, `q` and `settledBefore`, the runs page
  drives all five from the Older runs fold, and quick open asks the route for
  typed text 250ms after the last keystroke. What *is* checked: `typecheck`,
  `npm test` (`normalizeRunListQuery`, `clampRunOffset` and `isRunStatus`, 13
  cases), the standalone build, and the query itself driven against a throwaway
  SQLite database with seven planted rows — paging, the offset clamp past the
  end, the `created_at`/`id` tiebreak holding across a page edge, `?q=50%` and
  `?q=a_b` matching only the rows that hold those characters literally, and
  `settledBefore` correctly leaving out a `queued` run created three days ago.
  None of that needed a browser and none of it is the page.

  The query's cost was measured rather than assumed, because a paged list adds a
  `COUNT(*)` and an `ORDER BY` tiebreak to the answer a four-second poll already
  asks for. Against 50,000 planted rows in groups of 25 sharing a millisecond, on
  this container: unfiltered first page **0.23ms** with the `id DESC` tiebreak
  and 0.14ms without it, the unfiltered `COUNT(*)` **0.01ms** (a covering index
  scan), a `status` page at offset 20,000 **7.8ms**, and a `LIKE` over `prompt`
  **4.1ms**. The tiebreak needs no index of its own — the plan is `SCAN runs
  USING INDEX idx_runs_created` plus `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`,
  so SQLite sorts only inside each equal-`created_at` group, and a dedicated
  `(created_at DESC, id DESC)` index brings 0.23ms to 0.15ms. **No schema change
  was made**, and neither of the slower shapes is on the poll: the poll is the
  unfiltered first page. What this does *not* measure is a 50,000-run install's
  behaviour in a browser, only the SQLite time behind one request.

  What a person has to open and click, in order:

  1. `/runs`, with more than one page of history on the install. Open **Older
     runs**: the count on the fold is the server's `total` over the whole table
     rather than what arrived, and `1–100 of n` sits under the list with
     Previous/Next (100 is the route's default page, unchanged from what the
     page showed before). Page forward and back and confirm no row appears twice and
     none is skipped — that is what the `id DESC` tiebreak is for and a fleet
     admitting several runs inside one millisecond is what tests it.
  2. The status segments. **Failed** must now show failed runs from the whole
     history rather than the failed runs among the newest hundred, which is the
     bug this change exists to fix and the one that looked identical to working.
     Check the count moves with the segment, and that the sentence claiming the
     route does not page beyond a hundred is gone.
  3. The **Search** box in that fold. Type part of a task, a folder name and a
     run id; each should narrow the list, and the request should land once after
     typing stops rather than once per keystroke (the network panel is the only
     place that shows it). Then **Clear filters** from the empty state, which is
     the one way back out of a filter that matched nothing — the fold holds its
     own controls, so a fold that vanished with its filter would strand you.
     With a screen reader on, the count should be announced when the list is
     replaced: nothing moves focus, so that announcement is the only signal a
     reader gets that the filter did anything.
  4. The two sections above the fold. A run that settles must appear under
     **Finished in the last 24 hours** and, once the boundary steps past it, move
     into the fold — appearing in exactly one of the two at any moment. This is
     the shared `boundary` and it is the subtlest thing in the change: if the two
     sides ever read different instants, a run at the 24-hour mark is drawn twice
     or drawn nowhere, and neither says anything. The boundary is quantised to
     the minute, so a run can sit one bucket too high for up to 60 seconds by
     design — that is the interval at which the fold re-requests, and confirming
     it is a network panel showing one request a minute rather than one every
     four seconds.
  5. `⌘K`, and type the task text of a run older than the newest hundred. That
     run must come back — it could not before, and the empty list it used to
     give read as "no such run exists". Each row now reads `id · task`. Confirm
     the placeholder list still offers the six newest runs with nothing typed,
     and that a failed read still leaves the panes listed.
  6. A 400 nobody can reach from the UI but a URL can: `/api/runs?status=nope`
     answers `{"error":"Unknown run status: nope"}` rather than every run. The
     opposite choice — falling back to "all" — is what makes a miss read as an
     absence, which is the whole subject of this entry.

- **The run log's filter, and the settings field search, in a browser.** Both
  are client-only and neither has been rendered by anything: zero page
  components in this repository are under test, so nothing catches a visual or
  interactive regression in either. What *is* checked: `typecheck`, `npm test`
  (`matchesLogFilter` and `logFilterActive`, six cases — that a `tool_error`
  stays under **Tool calls** as well as under **Warnings and failures**, that a
  parked `status` row counts as a problem, that the two halves apply together,
  and that whitespace is not a query), and the standalone build. The settings
  search has **no unit test at all**, deliberately: it reads `textContent` off
  the rendered page, so there is nothing pure to test — which also means every
  one of its failure modes is a browser away.

  What a person has to open and click, in order:

  1. A run page with a long log — a few hundred lines, ideally one that hit the
     replay cap. Type into **Find in this log**: the header count becomes
     `n of m lines`, and with a screen reader on that same count is announced,
     because the log narrows in place and nothing moves focus.
  2. The **Show** picker, all five options. **Tool calls** must include the
     calls that *failed* — that is the one thing the unit test pins and the one
     an operator would misread as "nothing failed here". **Warnings and
     failures** must catch a parked run's status line, not only tool errors.
  3. A run whose replay was truncated (the log carries the `… n earlier events
     not shown` line). With a filter on, a warning-toned hint must appear under
     the field naming that count. Without a filter, it must not. This is the
     one thing on the register that the filter could otherwise imply and must
     not: that the array it searched is the log.
  4. Autoscroll, which the filter shares state with. Scroll up in a filtered
     log, let new lines arrive, and confirm **Jump to live** counts only the
     lines the filter keeps. Then clear the filter: the badge must **not** jump
     to the number of lines the filter had been hiding.
  5. `/settings`, and **Find a setting**. Type `weekly`, `plugin`, `retention`,
     `prompt`. Each result names its section on the right; pressing one scrolls
     the field into view, focuses its control (the app's one focus ring is the
     only highlight) and fills that section's chip. A match inside one of the
     four **Prompts** folds must open the fold — `textContent` reads a closed
     one, so a result could otherwise name something invisible.
  6. A one-letter query, which matches most of the page: at most eight rows,
     with `8 of n matches` under them. A capped list that does not say it is
     capped reads as the whole answer.
  7. That the search did not break what the page already did. Edit a field —
     the margin rail and the bar's unsaved count must still appear; `⌘S` must
     still save; **Discard** must still restore the saved baseline (the button
     is `Discard`, at `src/app/settings/page.tsx:3702`; an earlier draft of this
     entry called it Revert, which is not a control on that page). Then check a
     field whose description interpolates its own value (any of the ceilings):
     changing the value must change what the search finds, because the corpus
     is the rendered page rather than an index built once.
  8. The unsaved guard. With an edit pending, reload the page and close the tab
     — the browser's own dialog must appear both times. Save, then reload: no
     dialog. This is the half that fails in the direction that trains the
     operator to dismiss it. A **client-side** navigation (a press on the
     sidebar) still prompts nothing and cannot, which is stated in the code and
     is the known gap.
  9. At **390×844**: the filter's text box and picker wrap onto two lines above
     the log rather than squeezing it; the settings search box and its results
     stay inside the viewport with no horizontal scroll; each result row is at
     least 44px tall. The narrow-viewport entries already on this list predate
     both controls and cover neither.

- **The background-task panel on the run page's log tab, in a browser.**
  `src/components/RunTasks.tsx` renders `runTasks.ts`'s rows over the events
  already in the page's client state — no route, no poll, no schema change — and
  **nothing rendered it**. Docker is not available in the container it was
  written in, and an attempt to boot `npm run dev` against a seeded throwaway
  database was refused before it started, so not one of these rows has been drawn
  by a browser at any viewport. What *is* checked: `npm run typecheck` (exit 0),
  `npm test` (**1,705 tests / 251 suites / 0 failures**, of which 18 cases are
  `runTasks.test.ts`), and `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run
  build` (exit 0). The reducer is therefore well covered and the component is
  not covered at all — there are still zero page tests and no jsdom.

  Run `eadfe9f2-ac96-4c44-b59a-fbb3c9341871` has real `system:task_*` events in
  it and is the run to open. What a person has to look at, in order:

  1. `/runs/eadfe9f2-ac96-4c44-b59a-fbb3c9341871`, **log** tab. A
     `Background tasks (n)` fold must appear above the Find/Show row, with one
     row per task, each naming the task, its `task_type`, a state badge and how
     long it ran.
  2. Any run that backgrounded nothing — most runs. The panel must render
     **nothing at all**: no empty box, no heading, no fold.
  3. Type into **Find** and change **Show**. The rows above must not narrow —
     the filter owns the feed below and nothing else. Scroll the log: the panel
     must stay put rather than scrolling away with it.
  4. A run whose replay was cut (`droppedEvents > 0`, the same condition the
     log's own truncation line reads). A warning must sit above the fold saying
     a task that started in the dropped events is missing here. This is the one
     that cannot be checked without such a run, and a partial list presented as
     complete is the failure the entry exists for.
  5. A run with a task still going — the badge reads `running` and the fold is
     open by default. On a **stopped** run with a task that never reported an
     ending, the duration must read `—` rather than a clock still counting up,
     and the line under the table must say no ending reached the log.
  6. At **390×844**: the table stacks (it is a `Table stack` and every `Td`
     carries a `label`), each value is named, and nothing scrolls sideways.

- **Context pruning inside a live run.** The whole feature. The winnow
  subprocess, the token measurement, all three prescriptions and the `.bak` it
  leaves were exercised directly against a copied transcript in the running
  container, and those numbers are recorded above. What has **not** run is any of
  the wiring: no boundary prune has fired at the end of a real work cycle, no
  cycle has been ended by the context ceiling, and no netted figure on the
  dashboard or a run page has been read against a real run. That now includes
  the tile beside the window meters — now `ContextControlAside`, carrying both
  mechanisms: its six pruning states (a bounded span, an unbounded one, either
  window empty, partially priced, nothing priced at all, a negative net) were
  rendered through `renderToStaticMarkup` and read as markup, and the grid rule
  behind the two-column split is present in the emitted production CSS, but no
  browser has displayed either — this container has no headless browser — and
  the money on it came from hand-written DTOs rather than a real
  `prune_receipts` table.

  ~~**The context occupancy series has never been written by a real run.**~~ **Withdrawn — measured on 2026-08-27; see the entry below.** Every
  claim about it comes from unit tests over hand-written transcript fixtures
  (`contextSamples.test.ts`): no `context_samples` row on this install was
  produced by `liveGuardTick` against a live child, so the cadence the series
  actually gets — which is the ticker's period filtered by how often the last
  `usage` frame moves — is reasoned about rather than measured, and so is what a
  real run's turn-to-turn growth looks like. Two things are specifically
  unmeasured. The **cost of the scan**: the turn count walks back to the previous
  sample's frame instead of stopping at the first `usage` frame, which is a few
  more lines in the steady state and up to a megabyte of JSON on a run's *first*
  sample, and neither has been timed here — the 23 ms figure above is a
  whole-file read and split, not a parse. And the **`turns_exact` false branch**:
  it needs a transcript larger than `TAIL_SCAN_BYTES` at the moment of a run's
  first sample, which the fixtures construct and no run here has produced. The
  retention half is exercised (`retentionSweep.test.ts` pins that a blank horizon
  sweeps none of it) but no sweep has removed a real sample, and no run has
  reached `CONTEXT_SAMPLES_PER_RUN`.

  **The series has now been written by real runs, and its cadence measured — it
  is not the ticker's.** 198 rows across 10 runs on this install, all on
  2026-08-27 between 16:42 and 20:03 UTC, read out of `/data/usagefoundry.db` in
  the running container with `liveGuardIntervalSeconds` at its default 60. Of
  the 188 consecutive pairs, **159 are one tick apart** (under 90 s), 22 are
  more than two minutes apart, 5 are more than five, and **the widest is 1,320 s
  — 22 minutes**. Every gap is an exact multiple of 60 s and every row's
  timestamp lands on the ticker's own phase second, which is what separates the
  two candidate explanations: the ticker never ran late, and the gaps are
  deduplication refusing to write an unchanged frame. Readings ran 34,495 to
  317,477 tokens. The **`turns_exact` false branch is no longer unmeasured** — 16
  rows across two runs carry it — and neither is the ticker's write path under a
  live child. Still unmeasured: the `transcript` fallback basis (0 of 198 rows;
  every reading found a usage frame), the cost of the scan, `CONTEXT_SAMPLES_PER_RUN`
  (the largest single run holds 38 rows), and any retention sweep over real rows.

  **What the widest gap was, and what the panel said about it.** Run
  `fc491479` at 18:15:59 called the `Agent` tool; from 18:16 to 18:38 every frame
  its transcript gained was a sub-agent's, which this measure excludes exactly as
  the ceiling does, so no row was written for 22 minutes. Context across that gap
  went 186,989 → 197,286. The panel, which had only the newest row's timestamp,
  rendered "read 22m ago" — and the figure it was labelling was correct
  throughout, because a parent's context does not grow while a sub-agent works.
  That is the report `lastCheck` and `liveTickPlan` were written against.

  **Not yet verified by hand:** the freshness split has `npm run typecheck`
  (exit 0), `npm test` (**1,902 tests / 0 failures**, of which 16 are new) and
  `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` (exit 0) behind it, and
  the container was **not** rebuilt — so no browser has seen the new line. What
  to read on the next rebuild, on a live run: that the age moves every tick
  rather than every turn, that "unchanged for" appears on a run inside a
  sub-agent and *not* on an ordinary one, and that a restart mid-run drops the
  age back to the point's own rather than inventing a fresh one. `guardScanDue`'s
  stand-down has never been exercised at all on this install, because it does
  nothing at the default interval: it needs `liveGuardIntervalSeconds` above 120
  to have any effect.

  **The occupancy panel that draws that series was rendered by a browser, and
  the run page it sits on was not.** Correcting the entry two above: this
  container *does* carry a headless Chromium on `PATH`, and it was used here.
  `ContextOccupancy` was compiled by `tsconfig.test.json`, put through
  `renderToStaticMarkup` in four states — a 64-point run with two cuts, an
  18-point run with one, a single reading, and a run with a prune and no
  readings at all — and each was laid out in a 336px box (the inspector
  column's `21rem` less `Card`'s padding) against **the production CSS the
  build emitted**, in light and again under `:root[data-theme="dark"]`.
  Screenshots were read back. What that establishes: every token class the
  panel uses resolves in both schemes, including `fill-surface` on the
  fallback-basis markers, which have to be opaque against the card to read as
  hollow; the sawtooth is legible at that width with the prune rules landing on
  the cliffs rather than beside them; the ceiling rule and the baseline are both
  distinguishable from the series; and the hatched no-reading state is visibly
  not a zero fill. The legend's worst case — all three items, ceiling and prunes
  and a fallback count — fits on one line at that width without wrapping.

  What it does not establish. The series was **synthetic** — a generated
  sawtooth, not `context_samples` rows a run wrote — so this says nothing the
  entry above does not already withdraw about the data. The panel was rendered
  **in isolation**, never inside `runs/[id]`: its placement in the `Against its
  limits` region, its spacing under the `Guards` block, and the way it behaves
  when the poll replaces the DTO every three seconds have not been seen. And
  nothing was driven at a narrow viewport, where the inspector stacks above the
  pane. A human opening a real run should look at those four things: the block's
  position and spacing in the inspector, the figure and the fill moving together
  as the poll lands, the panel at one column, and whether the caption's length
  is right beside the blocks around it — it is the longest paragraph in that
  region and only the isolated card has been looked at.

  **The intake-filter half was rendered as markup and it caught a defect.**
  Eight filter states — read, ledger missing with the filter off, ledger missing
  with it on, unreadable, empty, nothing priced, a read ledger nothing is
  appending to, and a bounded span — were put through `renderToStaticMarkup`
  against both components and both pruning states, 24 cases, each asserted to
  name the card and to contain no `$0.00`. Twenty-three passed first time. The
  twenty-fourth did not: with `pricedResults` at 0, `FilterSavingsRows` guarded
  only on `ledger !== "read" || results === 0`, so a fully-unpriced read fell
  past `noFigureReason` into the money table and printed `Net +$0.00` — the one
  claim the reading has never observed, under a real token count that makes it
  look measured. The four money rows are now omitted whole in that state and
  replaced by a sentence saying what is unknown; the token row, which *is* a
  measurement, stays. Nothing but a typechecking branch would have shown this,
  and the type checker had already passed on it. The harness was a throwaway and
  is not in the tree: it needed a `Module._resolveFilename` shim for `@/`, which
  `.test-build` has no path mapping for, so it cannot run under `npm test`.

  Rendering is not display. No browser has shown any of it, this container has
  no headless one, and every DTO in those 24 cases was hand-written rather than
  read off a real `/api/usage` response. What *has* been exercised against real
  data is the reader behind it — the real ledger, the real transcripts — and its
  arithmetic through 13 unit tests. `readFilterSavings`' TTL and single-flight
  are read, not raced: no two concurrent callers have been observed sharing one
  pass, and no cache miss on a changed `from` has been observed either.

  **The tile's headline is now the total rather than the 5-hour window, and
  nothing about that span has been measured.** `/api/usage` reads one span
  bounded at the transcript horizon, prices it once and sums three nested spans
  out of it — so what a real install shows depends on receipts older than a
  window, which no run here has produced: every prune receipt on this machine
  was written inside one session. Unverified specifically: that the `total`
  really is a superset of both windows on an install whose
  `transcriptRetentionDays` is shorter than a week (the `Math.min` clamp against
  `snapshot.weekly.startsAt` is the only thing holding it, and it has been read,
  not run); that a receipt whose transcript has been swept is excluded rather
  than priced at zero saving with its invalidation still charged; and that the
  single-read-three-sums path is faster than the two `pruneSavings` calls it
  replaced — it does strictly less work by inspection, and nothing was timed. The
  Docker build that
  bundles winnow has also never completed — the repository was private when this
  was written, so the `git fetch` in the image fails and the feature reports
  itself unavailable. Two things to watch first: whether the transcript reader's
  shrink detection (`transcripts.ts:396`) picks up the rewrite as intended, and
  whether the loop's `continue` after a `prune` interrupt re-enters cleanly with
  the session still resumable.

  **This is also the only thing bounding a work cycle now**, since
  `--autocompact` was removed in the same change, so an install where it silently
  does not run has nothing stopping a long cycle at all.

- **A real receiver.** Nothing here has been pointed at a Home Assistant
  instance, an ntfy topic or anything else an operator would actually run. The
  automation in `docs/install.md` is written from Home Assistant's documented
  webhook trigger and has not been loaded, so its field names (`trigger.json.*`,
  `allowed_methods`, `local_only`) are unconfirmed against a running install; the
  claim that endpoint accepts arbitrary JSON is the vendor's, not this project's.
  The Discord **400**, the relay running in the container and a notification
  produced by a real run loop have since been measured and moved to the section
  above; what stays here is every *other* receiver, and the endings other than
  `completed`. Only a `completed` ending has been driven through
  `notifyLifecycle` by an actual run — the events behind `needs-review`,
  `blocked`, `failed`, a guard-caused `stopped` and the 429's first rung were
  constructed, so the shape of a real `PersistedRunEvent` at those five is
  unproven, not the filter's answer to it. Nor has any single run gone the whole
  way to a Discord message: the run that fired predates the relay, and the body
  the relay forwarded was signed by hand. The relay's mention (no
  `DISCORD_MENTION_USER_ID` has been configured, so no ping has ever been
  produced) and its one 429 retry are both unexercised.

- **What `--autocompact` costs to run, and what another window would do.** The
  flag's sign is measured and is in the *Verified* section above; two things it
  could not reach stay here, and both need a billed run rather than a query.
  **The summariser's own call has no price anywhere.** All 42
  `compact_boundary` summaries carry no usage block, so a call of roughly
  168,000 in and 6,300 out is billed and invisible to every source this app
  reads; only out-of-band accounting — the account's usage view, an OTLP export,
  or `--max-budget-usd` straddling a compaction — can bound it. **And one value
  has ever run.** Comparable work at another window is the only thing that turns
  keeping 200,000 from a default into a choice, and until then no claim that it
  is the right number is available. A cheap intermediate step exists and has not
  been taken: the CLI emits `effectiveWindow` on its own debug channel, so one
  Docker run with that logging on prints the operating point directly instead of
  inferring it from the bundle.

- **A compaction notice arriving on a run log, and the metadata field names on
  any CLI but `2.1.226`.** `readCompactions`/`parseCompactionBoundary`
  (`transcripts.ts`) and `injectionFates`/`compactionNotice`
  (`orchestrator.ts`) are unit-tested against a record copied verbatim off this
  machine, and the run loop reads the transcript after every cycle — but **no
  compaction has been driven end to end here**, so nobody has seen the notice on
  a run's own log. Nothing in this repository's probes reaches a *completed*
  compaction without a live model: the 23 records above were all written by
  other agents' work, not by a probe, and this container has no `docker` to run
  the app under. Two things are unverified, and they fail differently.
  - The wiring: whether the notice appears at all. It is a `log()` call on a
    path that already ran, so its failure mode is silence — an empty read on a
    transcript that had not flushed, or a session id the reader could not match
    to a file. To check it: `docker compose up --build`, start a run whose
    prompt is long enough to compact (or set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
    low in `.env` — which the run's own first log line will then name back), and
    watch for `Claude Code compacted this run's conversation` on `/runs/<id>`.
    That is the line the code actually writes (`orchestrator.ts:5291`); this
    entry named a string that exists nowhere in `src/`, which is exactly the
    failure it was written to catch. Everything below the run loop's call site
    *has* been driven against a real boundary off this machine — the reader
    matched the session, and `compactionNotice` rendered the full text with its
    hypothesis wording and one line per injected thing — so what is untested is
    only whether the call site fires with a session id and window that match.
  - The field names: whether `preTokens`, `postTokens`, `durationMs` and
    `trigger` keep those names on another CLI. `parseCompactionBoundary` reads
    every one defensively, so a rename does not throw — it renders as a real
    figure of zero. "180,694 tokens summarised down to 0" is what that looks
    like on a run log, and there is nothing on the page to check it against.
    The pin is `2.1.226` (`Dockerfile:215`) and all 23 records came from it, so
    the names are pinned to exactly one version and to nothing else.

  Separately and by design, the survival table those notices quote — which parts
  of a window a compaction keeps — is **not** a measurement of this install and
  must never be presented as one. It is Anthropic's documentation, self-pinned
  to Claude Code `v2.1.198`; this install pins `2.1.226`, so `compactionNotice`
  words every line as a hypothesis whenever the record's own `version` differs
  from `SURVIVAL_TABLE_CLI_VERSION`, which today is always. Measuring it would
  mean reading a real post-compaction window, which is a different piece of work
  from anything here.

- **A second machine actually reaching a LAN-published install, and a browser
  staying signed in to it.** Every check in the entry above was made *from the
  host running the container*, at its own LAN address. That proves Docker
  published on a non-loopback interface and that the gate and the cookie flags
  are right; it says nothing about whether anything else on the network can open
  the socket, because an access point isolating its clients sits entirely
  outside what a request to yourself traverses. (`lsof -nP -iTCP:3000
  -sTCP:LISTEN` did show Docker on `*:3000` rather than `127.0.0.1:3000`, and
  the macOS application firewall was confirmed disabled, so the two host-side
  causes are ruled out — the network between the two machines is not.) Nor has a browser
  completed the flow — the `Secure`-flag failure this is guarding against is
  specifically one `curl` cannot see, since curl returns the cookie either way
  and only a browser enforces the rule. Before trusting it: from a different
  machine, `curl -sf http://<host>:3000/api/health`, then open the app, sign in
  with the token, and reload a page — a redirect back to `/login` after an
  apparently successful sign-in means `UF_COOKIE_SECURE` is `1` (or blank behind
  something setting `X-Forwarded-Proto: https`) and not `0`.
- **The stacked tables at 390px — and, uniquely on this list, the three
  commands themselves.** `Table`'s `stack` turns seventeen of the app's twenty
  tables into one block per record below `md`: `/runs` (both lists), `/branches`
  (the inventory and the checkout-slot table), `/agents` (saved and on-disk),
  the five on the dashboard, all six across the three workflow pages, and
  `/account`'s rate limits. The three left flat are the settings page's storage
  report and `RunAgentCost`, both out of the scope this landed under, and
  `/account`'s daily cost — which has no `<thead>` at all, so it has no column
  name to lose and a date beside a dollar figure already fits.
  `src/components/ui/Table.test.tsx` pins the two halves that fail
  silently — that a stacked cell names its own field and keeps the ARIA roles
  `display: block` strips, and that a table which did **not** ask to stack emits
  no `md:`-prefixed rule at all, which is the whole of the "1440px is unchanged"
  claim in one assertion. What has not happened is anything else. The run that
  wrote this had **no working shell at all** — every command, `git` included,
  died in the sandbox with `bwrap: No permissions to create new namespace`, which
  is the failure recorded under *Verified* above and whose cause is settled
  there — so
  `npm run typecheck`, `npm test` and `env -u __NEXT_PRIVATE_STANDALONE_CONFIG
  npm run build` were **not run**, and neither was a browser.

  **That gate is now discharged.** The change landed as `d8c711d`, and all three
  commands have since been run in a worktree with a working shell: `npm run
  typecheck` exit 0, `npm test` exit 0 (1335 pass, 0 fail, 210 suites) at
  `c9d0b3c`, and `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0
  with `.next/standalone` written at `a294ed2` — two documentation-only commits
  above the same source. **What is still open is the browser**, which is the rest
  of this entry and none of it was run. At 390×844: every page that holds one of
  them read top to bottom with **no horizontal scroll**, every figure still
  `tabular-nums` and every unknown reading still hatched, the branches selection
  bar starting at the window's left edge rather than 224px in with its Land,
  Clear and strategy picker all reachable, and the reserved spacer under it
  (`max-md:h-80`, chosen by arithmetic rather than measurement) actually taller
  than the bar — a bar taller than its spacer hides the last row of the table.
  The workflow instance page is the one worth opening first: its two run tables
  are one `RunTableHead` and one `RunRows`, so they are also the proof that the
  context carries `stack` across a component boundary rather than only down one
  file's JSX. Two Tailwind spellings
  are load-bearing and emit nothing at all if wrong: `md:contents` on the value
  wrapper, whose loss is a silent *desktop* change in all seventeen, and
  `max-md:last:border-b-0` on the row, whose loss is one doubled hairline.
  The cheap form of both is a grep of the emitted stylesheet after a build —
  but it has to be spelled the way Tailwind writes a selector, which escapes
  every `:`. Use `-F` and escape the colons, or the pattern cannot match at all:

  ```sh
  grep -cF 'md\:contents' .next/static/css/*.css                # expect ≥ 1
  grep -cF 'max-md\:last\:border-b-0' .next/static/css/*.css    # expect ≥ 1
  ```

  The unescaped `grep -c 'md:contents'` this entry used to prescribe returns
  **0 on a build where the class is present** — measured, not reasoned: on a
  build at `a294ed2` the emitted `da7ba9cfe258a729.css` contains
  `.md\:contents{display:contents}`, the unescaped pattern matched nothing and
  the `-F` form above matched. Any check written as `grep '<variant>:<utility>'`
  against built CSS has that defect by construction.

  The right form of it is the harness already in *Verified* above — a production
  build in a headless browser against fabricated API responses, both themes,
  geometry read out of the DOM rather than looked at. Its readings now describe a
  layout that is gone below 768px, so re-running it is what replaces them, and it
  is the only thing that can check the two claims a human eye is bad at: that
  **no** page scrolls sideways at 380px, and that every box at 1440px is where it
  was before.
- **The mobile form pass — and two of its three defects cannot be observed
  without a real iOS device.** Every text control gained `max-md:text-[16px]`
  (once, in `CONTROL_BASE`, which `Input`, `Select`, `Textarea` and `LimitField`
  all concatenate; plus the legacy layer's element selectors, and the two
  hand-written controls that carry their own `text-sm` and so beat that layer —
  the chat composer and the branches page's strategy `select`. Every
  `page.tsx` under `src/app/` and every file in `src/components/` was read to
  establish that those were the only two. **The density pass has since made it
  one**: the strategy `select` is now the kit's `Select` inside a `Field`, so it
  takes the floor from `CONTROL_BASE` like everything else, and the chat
  composer is what is left. The device check below is unchanged either way —
  it is about whether the class reached the stylesheet, not about how many call
  sites state it.) `CONTROL_LINE`, `Toggle`,
  `ListRow`, `QuickOpen`'s result rows, the settings section chips and the run
  form's link-shaped button took `max-md:min-h-11`, `SegmentedControl`'s segment
  a `max-md:min-w-11` beside it, and `Switch` a 44×44 `::after` overlay.
  `ListRow` learned to wrap (`max-md:flex-wrap` with `max-md:min-w-32` on the
  label deciding when, and `max-md:justify-end` so a wrapped control does not
  change edges). Three `<summary>` elements took `max-md:py-3.5` rather than a
  min-height, for the reason the runs list already gives; the four in the run
  detail pane are the one gap left, and are that run's files. `AppShell`
  publishes `--keyboard-inset` from
  `visualViewport`; the shell's height, `--pane-h`, `Sheet`'s panel cap and the
  branches page's `fixed` selection bar all subtract it — the last two because
  they sit outside `AppShell`'s box and so owe the edge themselves. All of it was reasoned from documented platform behaviour. **None
  of it was watched.**

  **The run that wrote this had no working shell either** — every command died
  with `bwrap: No permissions to create new namespace`, `git` included, from the
  same cause as the entry above and settled under *Verified* — so `npm run
  typecheck`, `npm test` and `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run
  build` were **not run** and no browser was driven.

  **The work is committed and the three commands pass.** The change is
  `d8c711d`, with `2e68820` above it; `git status --porcelain
  --untracked-files=no` is empty, so there is no uncommitted worktree to go
  looking for. `npm run typecheck` and `npm test` (1335 pass, 0 fail) were run at
  `c9d0b3c` and the build at `a294ed2`, all exit 0. **The browser was still not
  driven**, which is what the rest of this entry is about and is where the two
  device-only defects still sit.

  Narrowing a desktop window is not a substitute for either device-only check.
  **The zoom**: on real iOS Safari at 390px, tap into any field on `/runs/new`
  and the page must not scale — if it does, the class did not reach the emitted
  stylesheet. **The keyboard**: on the same device, focus the chat composer and
  confirm the composer, the run form's save bar and a `Sheet`'s Cancel/confirm
  pair all stay above the keyboard rather than behind it; then blur the field
  and confirm `--keyboard-inset` returns to `0px`, which is what a shell left
  stuck at two-thirds height would be reporting. **The targets** can be measured
  anywhere: at ≤767px every control's border box ≥44px in both axes, and
  `Switch`'s is its `::after` and not the pill.

  Five spellings are load-bearing and emit nothing at all if Tailwind does not
  know them: `max-md:text-[16px]` (the zoom), `max-md:min-w-32` (without it a
  `ListRow` never wraps and a `w-72` select squeezes its label to nothing),
  `max-md:min-w-11` (an icon-only segment still 38px wide), and
  `max-md:after:-inset-y-[11px]` / `-inset-x-[3px]` (a switch still 38×32).
  The cheap form of the first two is again a grep of the built stylesheet, and
  again it has to be spelled for what Tailwind emits rather than for what the
  class says:

  ```sh
  grep -cF 'max-md\:text-\[16px\]' .next/static/css/*.css   # expect ≥ 1
  grep -cF 'max-md\:min-w-32' .next/static/css/*.css        # expect ≥ 1
  ```

  Grepping the *declaration* instead is the trap this entry fell into. It used
  to prescribe `grep -o 'font-size:16px\|min-width:8rem'`, and the second half
  can never match: Tailwind v4 emits `min-width:calc(var(--spacing) * 32)`, not
  a resolved `8rem`. Measured on the same build at `a294ed2` —
  `font-size:16px` twice, `min-width:8rem` never, and the two class-name
  patterns above once each. The 1440px claim
  needs the harness above: the only unprefixed edits are `AppShell`'s root
  height (`h-dvh` → an inline `calc(100dvh - var(--keyboard-inset, 0px))`),
  `--pane-h`'s extra term, `Sheet`'s panel cap and safe-area padding, and the
  branches bar's inline `bottom: var(--keyboard-inset, 0px)` — each
  identical while the variable and the insets are `0px`, which is every desktop,
  but identical *by argument* rather than by measurement.
- **Checkout-slot exhaustion end to end, and the store inventory behind it.**
  `resolveIsolation`'s refusal is unit-tested in both directions (it was seen to
  fail against the old downgrade and to pass against the refusal), and
  `npm run typecheck` and `npm test` pass — but no run has met a real exhausted
  store. Filling one needs a workspace mount and 64 dirty checkouts, and Docker
  was not available where this was written, so `allocateSlotPath`'s census
  counts, `checkoutStores`' directory walk and the Branches table it feeds have
  never seen a real `.uf-worktrees`. Before trusting it: on a real deployment,
  make `<mount>/.uf-worktrees/<slug>-1` … `-64` dirty for one repository (start
  and hard-kill isolated runs, or write a file into each checkout), confirm the
  Branches page lists them with their uncommitted path counts and `0 of 64`
  free, then submit an isolated run on that repository and confirm it is
  **refused with the sentence** rather than started — and that `git status` in
  your own checkout is unchanged afterwards. Then free one slot and confirm the
  next run starts in it. Read the sentence itself while you are there: since the
  admission stops asking git after `MAX_SLOT_PROBES_PER_ADMISSION` checkouts, on
  a full store it names some slots as ones it never examined rather than as
  uncommitted work, and which of the four counts it prints has only ever been
  seen in a unit test.
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
- **The whole UI density restructure — every surface of it, at every width.**
  Five build runs regrouped `/settings`, `/runs/new`, `/runs/[id]`, the three
  workflow surfaces, the dashboard, `/runs`, `/branches`, `/chat` and
  `/account` against `docs/agent/ui-density-audit.md`, and built two primitives
  (`ui/Disclosure`, `ui/ListView`) that every fold and every list box in the app
  now goes through. What *has* been checked, on the last of the five runs and
  reported with its output: `npm run typecheck` clean, `npm test` 1335 passing
  across 210 suites, and `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build`
  compiling and emitting the standalone bundle. Every class spelling the last
  run wrote was then looked up **in the emitted stylesheet** rather than
  assumed, which is how the one silent defect in it was found and fixed before
  it shipped: Tailwind emits a numeric utility's values ascending, so
  `.mb-0{` sits at byte 10980 of the sheet and `.mb-3\.5{` at 11276, and a
  caller's `className="mb-0"` on a `Field` is a no-op. (**The same read says
  three landed `CardTitle className="mb-0"` call sites are also no-ops** —
  `page.tsx`'s *Where it went*, `RepoSpendCard` and `UsagePeriods`. Left alone
  deliberately: fixing them is a desktop spacing change nothing asked for, and
  it is recorded here rather than quietly made.)

  **No browser was opened and Docker is not available in this container**, so
  `docker compose up --build` — half this repository's real verification loop —
  was not run by any of the five.

  > **A later completion pass did open a browser, on the host, at a wide
  > desktop width — see `docs/agent/ui-density-audit.md` §9.** It closed the six
  > items §8 left open, and it moved four of the readings below out of this
  > list: eleven surfaces were opened and read; every `Disclosure` on
  > `/settings` was seen opening by itself with its count when its contents
  > differ from their defaults; the dashboard's three bands were read as
  > rendered; and every arbitrary-value class the pass wrote was looked up in
  > the stylesheet the running page loads. It also found that **`CardTitle`'s
  > no-op was seven call sites and not three**, that every table in the app was
  > drawing its fixed columns at a third of their declared width, and that
  > `npm test` had been failing on macOS all along for a reason unrelated to
  > any of this. All of it is at a wide width: **nothing below about 390px was
  > seen**, because the browser refused to resize, so every narrow-viewport
  > entry on this list stands exactly as written.

  Nothing below has been *seen*:

  - Every restructured page top to bottom at **390×844** with no horizontal
    scroll, and at **1440px** with nothing moved that the audit did not name.
    The audit authorises exactly four deliberate desktop changes — the
    dashboard's and the run inspector's region headings, the dashboard's card
    emphasis, and the one line on `/branches` that grows to `text-sm` while
    auto-resolve is on — and every other new class carries `max-md:`/`md:`.
    That claim is by argument, not by measurement.
  - The **dashboard's three bands**: that a card sits under exactly one of
    them, that nothing draws a figure at band level, and that the three
    statements read as provenance rather than as headings for a total.
  - The **`Land N branches` confirmation**: that the sheet opens only with
    *Have Claude resolve conflicts* on, opens with **Cancel** focused, and that
    pressing Land with the toggle off still queues immediately with no dialog.
  - The **land-strategy picker in the fixed bar** at both widths: the wrapper's
    `-mb-3.5 self-end` is what keeps a labelled `Field` aligned with the
    buttons beside it in a row `ButtonRow` centres, and that is arithmetic
    rather than a reading. At 390px it goes full width above the buttons; the
    reserved spacer (`max-md:h-80`) has to stay taller than the bar, and the
    bar has grown by one label line.
  - Every migrated **`Disclosure`** opening and closing, and the branches
    history one still fetching on open rather than on mount — the closed case
    staying cheap is what keeps an idle install off `?history=1` every three
    seconds.
  - The **chat approval correspondence** through a real thread: that Approve
    still sends exactly the ids the panel displayed. Nothing in this pass
    touched the approve path, the selection state or the row that renders it,
    so the correspondence is preserved by *absence of change* rather than by a
    new test — and one gap it already had is worth naming while somebody is
    looking: `selected` is not pruned against `pending` when the poll answers,
    so a proposal decided in another tab leaves a stale id in the set that the
    next press sends. The route refuses it by id; nothing on the page says so.
    **The completion pass fixed that prune** (§9.2) without touching the approve
    path, so the correspondence is still preserved by absence of change and this
    entry still needs a real thread to settle it.
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
- **Setting a run aside, in a browser.** `fleet.test.ts` drives all three doors
  against a real database: `reopenFleet` refuses a set-aside id by name while
  picking up the one beside it, `restartClosedRuns` drops it from the notice and
  restores it when the run is put back, and `reopenRun` clears the mark. `npm run
  typecheck` and `npm test` both pass. What has **not** happened: no browser has
  rendered either button, and **Stop and set aside** has never been pressed on a
  run with a live `claude` child — the stop is `stopRun`'s existing path reached
  through a new route, but the *ordering* that matters (mark, then signal) has
  only been read, not watched. `docker compose up --build` was not run. Before
  trusting it: stop a cheap run with **Stop and set aside**, confirm the Fleet
  count excludes it and the restart notice does too, then press **Resume** on its
  page and confirm the chip is gone and the counts include it again.
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
  `/tmp` and is owned by `UF_CHAT_GID`, a group only the chat and block child
  is in; the telemetry exporter carries a per-run capability instead of
  `UF_AUTH_TOKEN`. `npm run typecheck` and `npm test` pass, the decision
  (`resolveChildCredentials`), the compose/Dockerfile pair, the capability file
  and `telemetryEnv` are all unit-tested, and **no container has been built or
  started**: the run this was written in has no Docker at all. Nothing below is
  reasoning about a design — it is reasoning about whether the design runs.

  Build and start it, then:

  ```sh
  docker compose up --build -d
  docker compose logs usagefoundry | grep 'privilege separation'
  # expect "on: children run as 1000:1000, chat and block turns as 1000:65533,
  # server as 0" — a line naming no chat gid is the capability boundary absent

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

  # #87 — and the read itself, which the group is what refuses. Prints modes
  # and a byte count only: the file carries a live bearer token.
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c '
    for p in $(ls /proc | grep "^[0-9][0-9]*$"); do
      cfg=$(tr "\0" "\n" < /proc/$p/cmdline 2>/dev/null |
            grep -A1 -x -- --mcp-config | tail -1)
      case "$cfg" in /run/uf-mcp/*)
        echo "pid $p -> $cfg"
        if [ -r "$cfg" ]; then echo "BAD-readable, $(wc -c < "$cfg") bytes"
        else echo "ok: not readable"; fi ;;
      esac
    done'
  # expect "ok: not readable", and `ls -ldn` of the directory to show group
  # 65533 rather than the agents' gid. A run that finds no --mcp-config argv at
  # all has proved nothing: the window is one turn, so send the chat message
  # first and probe while it is still working.

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

  One thing is known-not-closed rather than unverified, and is in
  `docs/security.md` rather than here: an agent can still read
  `~/.claude/.credentials.json`, because it is what a work cycle bills against,
  and only a per-run credential Claude Code does not have would close it.

  The MCP capability *path* is still readable out of `/proc/<pid>/cmdline` and
  always will be — what changed is that the file it names is owned by
  `UF_CHAT_GID` and mode 0040, so the path leads somewhere the reader cannot
  open. That is a group check rather than a second Claude credential, and it is
  unit-tested at `chat.test.ts` ("hands the config to a group…") and
  `privsep.test.ts` (`resolveChatGid`) — but a unit test in one process has one
  uid and **cannot observe the refusal**, which is why the probe above exists and
  why this bullet is on this list rather than in the verified section.

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
  `mem_limit: ${UF_MEM_LIMIT:-10g}`, a `memswap_limit` equal to it,
  `pids_limit: ${UF_PIDS_LIMIT:-2048}`, `cpus: ${UF_CPUS:-0}` and the server's
  own `NODE_OPTIONS` heap ceiling beside them. `deployment.test.ts` pins the
  heap ceiling against the memory limit and `memswap_limit` against `mem_limit`,
  but not one of them has been applied by a real Docker: the runs that added
  them had no Docker at all, so what is here is the compose file parsing
  correctly by eye and nothing more. The per-child memory figures README's
  sizing table is built from are **estimates** and not measurements — the
  reasoning is that a `claude` child is a Node process and a work cycle's agent
  starts builds inside the same cgroup, which sets the shape of the arithmetic
  but not its constants. Before trusting the numbers, that they are in force at
  all:

  ```bash
  docker compose up -d --build
  docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}' usagefoundry
  docker exec usagefoundry cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max
  docker stats --no-stream usagefoundry
  ```

  `memory.max` reading `max` means the limit is not in force — most likely
  cgroup v1, where `mem_limit` lands at `/sys/fs/cgroup/memory/memory.limit_in_bytes`
  instead. That `cpus: ${UF_CPUS:-0}` is accepted as "no quota" rather than
  refused as a value is the one syntax question here, and it fails loudly at
  `docker compose up` either way. Then start runs up to the configured cap and
  watch `docker stats` for the real per-run footprint. The recovery half is
  worth exercising once too — that the kill is confined to this container, and
  that what comes back closes its runs out:

  ```bash
  docker exec usagefoundry node -e 'const a=[];for(;;)a.push(Buffer.alloc(1<<26))'
  docker inspect -f '{{.State.OOMKilled}}' usagefoundry   # expect true
  dmesg | tail                                            # expect no host process named
  ```

  `Buffer.alloc` on purpose: it allocates outside V8's old space, so this tests
  the cgroup limit rather than the `--max-old-space-size` ceiling above it. Then
  confirm `restart: unless-stopped` brought the container back and that
  `reconcileOnBoot` closed out the runs it was carrying rather than leaving
  folders claimed.
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
- **Everything about the multi-repository sweep that needs Docker or a second
  repository.** Four changes landed together (#77, #76, #70, #67);
  `npm run typecheck` and `npm test` pass and each carries a regression test that
  was watched failing before the fix. What has **not** happened:
  - `docker compose config` and `docker compose up` with a fifth workspace slot
    in `.env`. The refusal is unit-tested from the app's side and
    `deployment.test.ts` pins `MOUNTED_WORKSPACE_SLOTS` against the volume lines,
    but no compose has interpolated `UF_UNMOUNTED_WORKSPACES`. Run
    `cp .env.example .env`, fill `UF_WORKSPACE`, add `UF_WORKSPACE_5_NAME=Extra`,
    then `docker compose config | grep UF_UNMOUNTED_WORKSPACES` (it should carry
    the name) and `docker compose up` (the container should exit naming it).
    Then unset it and confirm a four-slot install boots exactly as before, and
    that the `docker-compose.override.yml` recipe in `docs/install.md` — which
    clears that variable — really does mount a fifth slot.
  - A nested seed pattern reaching a real checkout. `planSeedCopies` is pure and
    tested against a fabricated tree; no `git worktree add` has been followed by
    a copy of `apps/web/.env`. Start an isolated run on a monorepo with
    `apps/web/.env` gitignored, confirm the file arrives and the log names it,
    then remove the pattern and confirm the log says *nothing seeded* and counts
    the gitignored files it did not match — rather than the old silence.
  - A per-repository GitHub token authenticating. The selection is pure and
    tested; no `git push` has been attempted with one. With two throwaway
    repositories and two fine-grained tokens, confirm a run in A can push to A
    and cannot push to B, and that with `UF_GITHUB_TOKEN` blank a repository no
    entry names gets no credential at all.
  - Two repositories' branches landing at once. The selector is driven against a
    real database and the ordering within one repository is pinned, but no two
    `landRun` calls have overlapped. Queue a conflicting branch with auto-resolve
    on in one repository and a clean branch in another, and confirm the second
    lands while the first is still resolving — and that two branches in *one*
    repository still land strictly one after the other.
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
- **The three words an unhalted instance now reads as, in a browser.**
  `instanceStatus` is unit tested pure, and the count it decides from — over
  member runs *and* the ledger of blocks that are not runs yet — is tested
  against a real database in `instanceReading.test.ts`, including a graph whose
  runs have all settled while a deferred block is still to wake. What has not
  happened is anyone seeing the workflow page render them: `working`,
  `finished` and `blocked` replaced a single green `started` badge in one table
  cell, and the cell is now one lookup pair plus `outcomeDetail` rather than
  four conditional blocks. Nothing here can start or stop an agent, so the
  failure available is cosmetic — a badge tone that reads wrong, or a clause
  that renders empty. What a human should check, on the workflow's own page:
  a graph mid-flight says `working` with a count, the same graph after its last
  block settles says `finished` with no clause, and a graph whose `on-success`
  dependent was written off says `blocked` with the number that never ran.
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
- **Everything about the server lock that needs two live processes.** The
  decisions are pure and unit-tested — `lockVerdict`, `heartbeatVerdict`,
  `ownershipRefusal` — and `dataDirClaim.test.ts` drives the real `claimDataDir`
  and the real `heartbeat` against a temporary data directory. What has **not**
  been run is two servers sharing one `DATA_DIR`: that a non-owner boots,
  serves every page, answers 503 on `/api/health`, shows the banner and refuses
  Start, Run, Approve and Land; and that a `SIGSTOP`/`SIGCONT` on the owner for
  longer than `STALE_MS` ends with the stalled process reporting the loss and
  refusing to write rather than restamping the lock. Both need Docker, or two
  terminals and a shared directory.
- **`STALE_MS` against a measured stall.** It is now derived from
  `GIT_SYNC_TIMEOUT_MS` rather than chosen, and a unit test pins that it exceeds
  one synchronous git call — but the multiplier (six) is reasoned from how many
  git children one admission can make, not measured against a profile of a busy
  server. Nothing has been timed under 25 concurrent runs.
- **The shutdown reconciling its cycles under Docker.** `shutdown.test.ts`
  drives a real run to `running` against a stubbed child, calls the real
  `shutdownRuns`, and asserts the estimate landed and the active-cycle columns
  cleared — but with a fake `spawn`, so what it cannot show is a real
  `docker compose restart`: whether `stop_grace_period: 30s` is enough for the
  ladder plus a transcript scan on a large history, and whether a real Claude
  Code handling `SIGINT` prints its `result` event (which would make the cycle's
  cost measured rather than estimated). Run `docker compose up -d`, start a run,
  `docker compose restart`, and read `spent_usd_est`, `active_iteration` and
  `status` out of the database.
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
- **The sandbox reporting, all of it except the three markers a failure wrote.**
  `sandboxRefusal` and `sandboxArrangement` are unit-tested in both directions
  and `npm run typecheck`, `npm test` and `next build` all pass. One provenance
  changed on 2026-08-19 and only one: the three `bwrap:` markers were read off
  this install's own `run_events` after the thirteen-hour failure in *Verified*
  above, so those three are transcribed rather than guessed. The CLI's own six
  were **read out of the pinned binary with `strings` and have still never been
  executed** (`proposals/Sandboxing/10-validation.md`, "What this validation did
  not check"). Three separate things are unverified, and the first is the one
  that matters:

  **Whether the strings the detector matches are the strings the CLI actually
  emits into a tool result.** Nothing here has seen one, and the failure above
  did not change that: what it produced was `bwrap`'s own stderr, from a `bwrap`
  the CLI spawned and which exited before doing anything, and not a single
  sandbox message written by the CLI itself. The rest of Phase 2 of
  `proposals/Sandboxing/09-implementation-sketch.md` — bubblewrap, `socat`, the
  seccomp `security_opt` and a managed policy — now exists and has been started;
  capture the real text before trusting the table:

  ```sh
  # A command the policy refuses, read off the wire rather than off a page.
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c '
    claude -p "run: touch /etc/uf-probe" --output-format stream-json --verbose' \
    | jq -r 'select(.type=="user") | .message.content[]?
             | select(.is_error == true) | .content'
  ```

  Then compare what it prints against `MARKERS` in `src/lib/sandbox.ts` and add
  what is missing. Expect the common case — a path outside the allowlist — to
  come back as a bare `EACCES`/`Permission denied` with nothing sandbox-shaped
  in it at all: that is why the matcher deliberately does not match those words,
  and closing that gap needs whatever distinguishing text this command actually
  shows, not a looser matcher.

  **Whether the event reaches the two places it is supposed to.** The emit is on
  the same path as `tool_error` and the rendering is a case in the same switch,
  so both are ordinary — but neither has been watched, and the one chance this
  install had at it went by: across the thirteen-hour window above, `run_events`
  took 484 `tool_error` rows and **zero** `sandbox` rows. That is a matcher with
  no `bwrap:` needle in it at the time rather than an emit path that failed, and
  the three needles are what closes it *next* time — but no `sandbox` row has
  ever been written by anything. With a policy in place, start a run whose first
  command the policy refuses and confirm both:

  ```sh
  docker compose logs usagefoundry | grep run.sandbox_refusal   # one JSON line
  sqlite3 "$DATA_DIR/usagefoundry.db" \
    "SELECT kind, count(*) FROM run_events WHERE kind IN ('tool_error','sandbox')
       GROUP BY kind;"     # expect the tool_error row to still be there too
  ```

  and that the run page shows a `sandbox` line *beside* the failed call rather
  than instead of it.

  **The image's three sandbox dependencies, the generated policy and the
  seccomp profile — built, started and applied at last, and still not one
  confined tool call.** The image now carries `bubblewrap` and `socat` on the
  apt line and `@anthropic-ai/sandbox-runtime` pinned beside the CLI;
  `docker-entrypoint.sh` writes `/etc/claude-code/managed-settings.json` when
  `UF_SANDBOX=1`; `docker-compose.yml` carries a commented `security_opt` line
  and `uf-seccomp.json` beside it. What is measured, all of it on 2026-08-18/19
  and all of it in *Verified* above: the image builds and boots with
  `UF_SANDBOX=1`, the policy file is written correctly, both binaries are
  present and executable (the CLI's own `access(X_OK)` probe passing is what
  says so), the profile is accepted by a real daemon and lets `bwrap` build a
  namespace, and the CLI does wrap `Bash` in one. What is **not** measured is
  any of it working together: every `bwrap` this app has caused to run exited 1
  without executing anything, so no policy has confined a tool call, no
  allowlist has been consulted by a kernel, and the reporting above is still
  unexercised. What was checked before any of that, and is what could be:
  `npm run typecheck`, `npm test` and `next build` pass, `sh -n` and `dash -n`
  accept the entrypoint, the policy generator was lifted out and run under
  `dash` against a temporary directory once per branch it has — off, on,
  `warn`, a domain list, a rejected domain, an unrecognised `UF_SANDBOX`, and
  the removal on the way back down — and `@anthropic-ai/sandbox-runtime@0.0.71`'s
  published tarball really does carry `vendor/seccomp/arm64/apply-seccomp` and
  `.../x64/apply-seccomp`.
  **Docker was not available in the container this section was written in** — no
  `docker` binary, no `/var/run/docker.sock`, `apt-get` needing a root it had
  not got, and `unshare --user` answering `Operation not permitted` — which is
  why it stood unexecuted as long as it did. Two of the commands below now have
  answers and are marked with them; **the rest have not been run**, and neither
  has anything in `scripts/sandbox-probe/`, which the entry below on the CLI's
  own sandbox carries and which runs the sketch's questions 0-8 outside this
  app's own wiring:

  ```sh
  # 0. are the two apt packages installable in this image at all? Dockerfile:92
  #    removes the apt lists, so this could not be answered from inside one.
  #    ANSWERED 2026-08-19: yes — both are in the shipped image and executable,
  #    which is what the CLI's own access(X_OK) probe passing establishes.
  apt-get update && apt-cache policy bubblewrap socat

  # 1. does bubblewrap work under the relaxed profile? (uncomment security_opt)
  #    ANSWERED 2026-08-19, both uids: BWRAP-BLOCKED without the profile,
  #    BWRAP-OK with it, on Engine 29.7.2 / kernel 6.12.76-linuxkit. `--proc
  #    /proc` still fails under it, which is what enableWeakerNestedSandbox is
  #    for — see Verified.
  docker compose exec usagefoundry \
    bwrap --unshare-user --ro-bind / / --dev /dev true && echo BWRAP-OK

  # 2. Phase 2's own four, from proposals/Sandboxing/09-implementation-sketch.md
  docker compose up --build
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'echo x >> /etc/claude-code/managed-settings.json'   # expect denied
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'echo x >> ~/.claude/settings.json; rm -f ~/.claude/settings.json'
                                                               # expect both denied
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'ls ~/.claude/projects >/dev/null && touch ~/.claude/projects/.probe'
                                                               # expect BOTH to work
  docker compose logs usagefoundry | grep -i sandbox           # expect the boot line
  ```

  The second of those four **fails on a stock install and is not a regression**:
  making `~/.claude` root-owned while handing back the entries the CLI writes is
  a second switch, `UF_LOCK_CLAUDE_HOME`, and it is off unless the operator sets
  it — see the entry on it below, which carries that check and three more. With
  it off, `~/.claude/settings.json` is writable by the agents and is an honored
  source for `sandbox.filesystem`, so a run can widen the filesystem half of the
  policy from inside itself. It cannot widen the credential deny (a separate
  list), and it cannot widen the domain list once `UF_SANDBOX_ALLOWED_DOMAINS`
  names one, because that also sets `allowManagedDomainsOnly`.

  **Whether the generated policy resolves to a sandbox at all.** This is the
  failure that would be quietest of the lot, and it is unverified in both
  directions. The CLI hands a command back **unwrapped** when the whole policy
  amounts to nothing — read out of the pinned binary as
  `if(!n&&!M&&!N&&!D&&!U) return t;`, where the five terms are a network
  restriction, a read deny or masked file, a write config, an env-var change
  and a git-safe-directory list — and `failIfUnavailable` does not catch it,
  because a sandbox nothing was asked of is not one that failed. The policy
  generated here always names a `credentials.files` deny and two `denyRead`
  paths, both of which feed that second term, so on this reading it can never
  short-circuit. **Narrowed on 2026-08-19 and not closed**: through the failure
  in *Verified*, every `Bash` call came back as `bwrap`'s own error, which is a
  wrapper the CLI built rather than a command it handed back — so this policy
  does not short-circuit on this build, at least for `Bash`. What that says
  nothing about is the deny working, since no `bwrap` this app has caused ever
  reached an `exec`. Confirm the rest from the outside rather than by re-reading
  the binary:

  ```sh
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'cat ~/.claude/.credentials.json'   # expect denied, with the session
                                              # still billing on the next cycle
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'cat /data/usagefoundry.db > /dev/null'          # expect denied
  ```

  A `cat` of the credential that **succeeds** from inside a run while the
  policy is in place is the whole signal: it means the wrapper short-circuited
  and no `bwrap` ran, whatever the boot line says.

  **Three things about the policy's content that are reasoning, not
  measurement.** It writes `denyRead` and never `allowWrite`/`denyWrite`,
  because a write config of any kind makes the CLI bind `/` read-only and
  rw-bind only the allow set — so a deny-write list with no allow list is a
  read-only filesystem and a fleet that fails on its first `npm install`. It
  sets `allowUnsandboxedCommands: false`, whose documented default is `true`,
  on the grounds that a model able to pass `dangerouslyDisableSandbox` makes
  the rest advisory. And it always writes `failIfUnavailable` explicitly,
  because the binary says two different things about its default — the settings
  schema documents `false`, the normaliser rewrites an enabled policy that
  omits it to `true`. All three are readings of one build.

  **A fourth, added on 2026-08-19 and the newest of them.**
  `enableWeakerNestedSandbox: true` is now written unconditionally, because the
  argv shape the CLI builds without it cannot mount a procfs in this container.
  What that rests on is in *Verified*: `bwrap` run by hand with each of the two
  shapes read out of the binary. **No `claude` has ever read that key** — no
  session has chosen a shape, no namespace has been built by the CLI, and the
  name is honest about the price whenever one is: the sandboxed command sees
  this container's `/proc`, so a sibling agent's processes are visible in it.

  **The seccomp profile, applied to a daemon at last and still short of what it
  is for.** `uf-seccomp.json` is generated by
  `scripts/make-seccomp-profile.py` from Docker v28.5.2's own default profile
  with six syscalls ungated — `clone`, `clone3`, `unshare`, `mount`, `umount2`,
  `pivot_root` — and the three rules that exist only to constrain
  `clone`/`clone3` for a container without `CAP_SYS_ADMIN` removed, so the
  resulting filter does not depend on how libseccomp merges a narrow rule with a
  wide one. That much is mechanical, was checked by re-reading the generated
  file, and is now also byte-for-byte reproducible from that source (*Verified*).
  Three of the four things that were unverified after it are now measured: Docker
  accepts the profile and applies it as a narrowed filter rather than as
  `unconfined`, `bwrap` starts under it at both uids, and the six are enough for
  every operation the CLI's two argv shapes ask for **except** `--proc /proc` —
  which ungating a seventh syscall would not fix, because `mount` is already
  ungated here and the refusal comes from the kernel's `mount_too_revealing`
  check over Docker's masked `/proc` rather than from the filter;
  `enableWeakerNestedSandbox` is the way around it. What is still unverified:
  that nothing *else* in the image needs a syscall this profile's *unmodified*
  rules withhold, since nothing but `bwrap` and a boot have been exercised under
  it; and the forward case, a bubblewrap reaching for `open_tree`/`move_mount`
  instead of the classic mount API 0.8 uses, which would fail loudly and need
  them added. One trap in the regeneration line, and it is measured: `python3
  scripts/make-seccomp-profile.py "v$(docker version --format '{{.Server.Version}}')"`
  **404s on any 29.x engine**, because moby publishes no `v29` tag. The shipped
  file has to stay the newest tagged default until it does.

  **What the boot line and the Settings row say once there is something to
  report.** Only the `none` reading has ever been *read*, which is every stock
  install and is why it is the one that had to be right. An install with
  `/etc/claude-code/managed-settings.json` present has since run for thirteen
  hours (*Verified*), so the other readings were reachable — but nobody recorded
  what its boot line or its Settings row said, which leaves this exactly as
  unmeasured as it was and is the cheapest of the gaps here to close. The other
  three are reasoning: `docker compose logs usagefoundry | grep '\] sandbox:'` should
  change wording as soon as `/etc/claude-code/managed-settings.json` exists, an
  `{"sandbox":{"enabled":true}}` with nothing under it should read **enabled but
  empty** on Settings rather than on, and a file that is present and unparsable
  should read **unknown** rather than none. All three are one `docker compose
  exec` and a reload apiece, and none of them costs a billed cycle.

- **The per-run write set, which nothing has ever honoured.** `sandboxSettings`
  and `sandboxArgs` (`src/lib/orchestrator.ts`, beside `buildArgs`) name what
  each `claude` child may write — the work cycle's own checkout and its
  repository's `.git`, the reviewer's nothing-at-all, the conflict resolver's
  throwaway checkout, the chat's every mount — and `CLAUDE_CONFIG_DIR` in all
  four, because that is the metering path. They are unit-tested in
  `orchestrator.test.ts` for the three assertions
  `proposals/Sandboxing/09-implementation-sketch.md` names (the run's own
  checkout writable, a **sibling run's** not, `CLAUDE_CONFIG_DIR` writable) plus
  the two ways the overlay can be a boundary that is not there — a path the
  CLI's Linux filter would drop as a glob, and a set that resolved to nothing —
  and `npm run typecheck` and `npm test` pass. Both assertions were watched to
  fail before they passed: dropping `CLAUDE_CONFIG_DIR` from the set fails the
  metering case and the reviewer's, and naming the checkout *store* instead of
  the checkout fails the sibling case.

  What has **not** happened is any of it against a sandbox that ran. No
  `--settings` overlay has ever confined anything: the only `bwrap` processes
  this app has ever caused are the ones in *Verified* that exited 1 before
  executing a command, and the ones run by hand outside it. So the by-hand check
  that `09-implementation-sketch.md` asks for — two concurrent runs, A asked to
  write into B's checkout, the tool call fails — is **unrun**, and these are its
  commands:

  ```sh
  # With UF_SANDBOX=1, the security_opt line uncommented, and the image built.
  docker compose up -d --build
  docker compose logs usagefoundry | grep '\] sandbox:'   # expect "on", not "none"

  # Start two isolated runs on one repository, then from run A's task:
  #   ls /workspace/.uf-worktrees/                 # find B's slot
  #   touch /workspace/.uf-worktrees/<B-slot>/probe    # expect the tool call to fail
  #   touch ./probe                                    # expect this one to work
  # and from B's, the same two the other way round. Then, on run A's page,
  # confirm the failed call is on the log rather than only in the transcript.
  ```

  Two things to read the result against before believing it. A denial from a
  mount namespace comes back as a bare `EACCES`, which `sandboxRefusal`
  deliberately does not match, so the log line to expect is `tool_error` and not
  `sandbox` — a run whose write into a sibling merely *fails* is the whole
  signal. And a `touch` that **succeeds** does not by itself mean the overlay was
  ignored: see the two open questions below, either of which produces exactly
  that.

  **The dependency this does not close, and nothing should be read as a boundary
  until it does.** `~/.claude/settings.json` is an honored source for
  `sandbox.filesystem` and is writable by `UF_AGENT_UID` on a stock install
  (`10-validation.md`, finding 1), so a run can append
  `{"sandbox":{"filesystem":{"allowWrite":["/"]}}}` and every later session — its
  own and every sibling's — is confined to nothing. Root-owning `~/.claude`
  itself and handing back the entries the CLI writes has since landed, as
  `UF_LOCK_CLAUDE_HOME=1` in `docker-entrypoint.sh` — **off by default**, because
  it runs against a bind-mounted host directory the operator also uses outside
  the container, and every entry missed shows up as a dashboard of zeros rather
  than an error. With it off, which is every stock install, the per-run overlay
  still narrows a policy a run can widen from inside itself. The probe is two
  lines and costs no billed cycle:

  ```sh
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
    'echo "{\"sandbox\":{\"filesystem\":{\"allowWrite\":[\"/tmp/uf-probe\"]}}}" \
       >> ~/.claude/settings.json'                  # expect denied only with
                                                    # UF_LOCK_CLAUDE_HOME=1
  ```

  The entry below carries that check and the rest of what that switch needs.

  **And the question nobody has answered either way: whether the CLI's sandbox
  wraps the session or only Bash** (`09-implementation-sketch.md`, Phase 1
  question 3, never executed). If it is Bash-only, a model using `Edit` against a
  sibling's path is unconfined whatever the write set says — and that is a
  likelier shape for a confused run than a shell command is. The evidence points
  both ways: the Bash tool's own prompt text says "your command will be run in a
  sandbox", and a `getFsReadConfig` export is the shape a *file tool* consults
  (`10-validation.md`, #19). Nothing in this app asserts either answer. The check
  is the same two runs as above, with the write into B's checkout made once
  through `Bash` and once through `Write`.

  **Three smaller unknowns of the same kind.** Whether `--settings` as JSON on
  the argv *merges* with `/etc/claude-code/managed-settings.json` rather than
  standing in for other sources — read out of the binary's source list
  (`flagSettings` beside `userSettings` and the managed file), never executed.
  Whether the write set is wide enough for a cycle to *work*. It named the
  checkout, the repository's `.git` and the config directory and nothing else,
  which left `/tmp`, `$HOME/.npm` and `$GOPATH` outside it; all three are in it
  as of 2026-08-19 — `/tmp` for every child, beside `CLAUDE_CONFIG_DIR`, because
  the CLI writes its shell snapshots and temporary files there and a child that
  cannot write it has a `Bash` tool failing for a reason unrelated to the task;
  the two caches for the two children that build, the work cycle and the
  conflict resolver. **That is an argument about where a toolchain writes, not a
  measurement**: no `npm install` and no `go build` has ever run inside a
  sandbox that started, the binary still binds `/` read-only and rw-binds only
  the allow set once any write config exists, and a set that is still too narrow
  shows up the same way it would have before — inside a tool call, in a run the
  loop reads as ordinary work. It remains the first thing to run after the
  sibling check above. And whether the overlay's paths survive a rename: they
  are the row's own recorded paths, so a
  checkout moved underneath a live run would be confined to where it used to be.

- **`SEARCH_TOOLS` on a real spawn from this app.** That naming `Grep` and
  `Glob` on `--allowedTools` puts both back in the tool list is measured
  (*Verified*) — on two `system:init` events, one in a throwaway container and
  one on the real image in the live container, both with nothing but the two
  tool names on the flag; a third, in a throwaway container, adds the two
  `Bash(git …:*)` grants in front of them and still lists both, and a fourth
  does the same under `--permission-mode plan`. What none of them is, is a
  spawn from this app.
  `src/lib/orchestrator.ts` now carries them on one `--allowedTools` at every
  `claude` spawn: `buildArgs` after `ISOLATED_GIT_TOOLS`, `review.ts`'s
  `spawnAssist` before the operator's list, and `chat.ts`. `npm run typecheck`
  passes and the argv is unit-tested in `orchestrator.test.ts`. Two things
  nobody has watched. The mixed list and `plan` mode are settled above for the
  *tool list*; what is not is whether the mixed list still grants the two git
  **commands** it also names, which is the isolated work cycle's argv and the
  one the git grant was measured without. Whether they appear in a
  `bypassPermissions` chat turn, where the flag has no prompt to skip and is
  there purely for the opt-in. And whether `--resume` keeps them at cycle 2, the
  way `--plugin-dir` does not — it is on every cycle's argv either way, so a
  drop would be invisible rather than harmful. The cheap check is the
  `system:init` event of any real run, which is where the 469 above were
  counted:

  ```sh
  sqlite3 "$DATA_DIR/usagefoundry.db" \
    "SELECT payload FROM run_events
       WHERE kind='log' AND payload LIKE '%system:init%'
       ORDER BY id DESC LIMIT 1;" | grep -c Grep
  ```

  One thing this deliberately does not claim: the removal of `spawnAssist`'s
  emptiness guard is safe because the list can no longer be empty, which is a
  statement about this codebase and not about the CLI.

- **Root-owning `~/.claude`, which no container has ever done and which changes
  a directory on the operator's own host.** `UF_LOCK_CLAUDE_HOME=1` makes
  `docker-entrypoint.sh` give `$CLAUDE_CONFIG_DIR` and its `settings.json` to
  root, after handing back the entries the CLI writes (`projects sessions todos
  shell-snapshots history.jsonl .credentials.json .claude.json backups`). It is
  off by default and skipped when `UF_AGENT_UID` is unset.

  What was checked, and it is all short of the thing itself: `npm run typecheck`
  and `npm test` pass (neither reads a shell script, so they say nothing about
  this); `sh -n` and `dash -n` accept the file; and the block was driven under
  `dash` through **eighteen scenarios** with `chown`, `stat`, `id` and `setpriv`
  replaced by stubs that record what *would* have been changed — off with an
  untouched home, on with everything already the agent's, a missing `projects/`,
  a root-owned entry that hands back, one that cannot, a directory chown that
  fails after `settings.json` was taken (the revert), an agent that can no
  longer write `projects/` or read `settings.json` (the undo, including the case
  where `settings.json` was root's from an earlier boot rather than this one), a
  chown that reports success while the agent can still write (the `fakeowner`
  case), a `setpriv` that cannot run at all (the lock is kept and the boot line
  says it was never checked), no `settings.json` at all, not running as root, no
  `UF_AGENT_UID`, a value that is not `1`, off after a lock, off against a
  `~/.claude` that is root's all the way down, and a hand-back on the way down
  that fails. Every branch printed
  what it should and no branch chowned anything it should not have. **That is a
  control-flow harness and not a kernel**: no ownership was changed anywhere, by
  anything, at any point — the container was never built and never started,
  because this run had no `docker` binary, no `/var/run/docker.sock`, no root
  for `apt-get`, and `unshare --user` answering `Operation not permitted`.

  Three things about the CLI *were* measured, against the pinned 2.1.226 with a
  throwaway `CLAUDE_CONFIG_DIR`, and they are why the list above is what it is.
  A session start creates `.claude.json`, `backups/`, `projects/` and
  `sessions/` at the top level of that directory before it has authenticated —
  `.claude.json` lands *inside* it precisely because `CLAUDE_CONFIG_DIR` is set,
  which is not where it sits on a host that has not set it. A session started
  against a config directory whose **top level is not writable** but whose
  entries exist runs to the API and fails only on the credential, creating
  nothing and complaining about nothing. And the binary's own atomic writer —
  temp file, then rename — falls back to an in-place `O_TRUNC` write when the
  rename fails with `EACCES`, which is why rewrites of top-level files the
  agents still own survive a directory they no longer do.

  What none of that touches is whether a real container comes up, whether the
  ownership reaches the kernel that enforces it, and whether a work cycle still
  meters. Every command below is for a human and **none has been run**:

  ```sh
  # 0. the shipped state first — with UF_LOCK_CLAUDE_HOME unset, nothing changes
  docker compose up -d --build
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME    # expect nothing
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
    'test -w ~/.claude/settings.json && echo BAD-writable'       # expect BAD-writable

  # then set UF_LOCK_CLAUDE_HOME=1 in .env, add the line docs/install.md names
  # to docker-compose.yml's environment: block, and restart
  docker compose up -d
  docker compose exec usagefoundry sh -c 'echo "[$UF_LOCK_CLAUDE_HOME]"'
  # expect [1]. Compose forwards by name and has no env_file, so a missing line
  # there is a switch that is set, read by compose, and never seen by the boot
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME
  # expect "…is root-owned: a run cannot rewrite or replace its settings.json…"
  # a refusal instead names the entry, the owner it wanted and the owner it saw

  # 1 + 2. the two the sketch names (09-implementation-sketch.md:274–283)
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'echo x >> ~/.claude/settings.json'                    # expect denied
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'rm -f ~/.claude/settings.json; ls ~/.claude/settings.json'
                                              # expect denied, and still listed
  # if the append *succeeds*, the lock is not in force and your settings.json is
  # no longer valid JSON — remove the stray line before the next session reads it

  # 3. and the half that is not a permission check — the metering path
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'ls ~/.claude/projects >/dev/null && touch ~/.claude/projects/.probe'
                                                          # expect BOTH to work
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'cat ~/.claude/settings.json >/dev/null'   # expect it to work: hooks,
                                     # permission rules and env are in that file
  docker compose exec --user "${UF_UID:-1000}" usagefoundry \
    sh -c 'rm -f ~/.claude/projects/.probe'                  # tidy up after it
  ```

  Then the part no permission check reaches: **run a real work cycle** and
  confirm the dashboard's figures move. `projects/` is `transcripts.ts`'s scan,
  so a hand-back that half-worked is a fleet that looks idle rather than an
  error — the two together (a cycle that commits, and a window that grows) are
  the only evidence this did not break metering. A chat turn and a review are
  worth one pass each for the same reason.

  **The check the sketch does not name, and this change makes necessary: your
  own Claude Code, on the host, outside this container.** `~/.claude` is a bind
  mount of your home directory, so this changes what your own tools may do
  there. From a host shell, not `docker compose exec`:

  ```sh
  ls -ld ~/.claude ~/.claude/settings.json
  # Linux: expect root:<your gid> 0750, and root:<your gid> 0640 on the file
  ls ~/.claude/projects >/dev/null && echo ok      # expect ok — still yours
  claude -p 'say hi'                               # expect a normal answer
  touch ~/.claude/probe                            # expect Permission denied
  ```

  What you have given up, and it is not nothing: you can no longer create
  anything at the top level of `~/.claude`, and you can no longer edit
  `~/.claude/settings.json` — including through `/config`, which will fail — from
  your own account. `sudoedit ~/.claude/settings.json` is the way to change it
  while this is on. If your host `~/.claude` is *fresh* rather than one Claude
  Code has been using, expect breakage instead: a directory it has not created
  yet (`todos/`, `statsig/`, `file-history/`, whatever the version wants) cannot
  be created under a root-owned parent, and the failure will be inside a tool
  call rather than on your screen. The boot names the ones it knows about, once.

  The way back, which should also be exercised once before you need it:

  ```sh
  # clear UF_LOCK_CLAUDE_HOME in .env, then
  docker compose up -d
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME
  # expect "off — gave /home/node/.claude back to <uid>:<gid>"
  ls -ld ~/.claude                                 # expect your own uid, 0700
  # and if that ever fails to run — two paths, no -R, because nothing below
  # them was taken:
  sudo chown "$(id -u):$(id -g)" ~/.claude ~/.claude/settings.json
  sudo chmod 0700 ~/.claude && sudo chmod 0600 ~/.claude/settings.json
  ```

  **On macOS this may do nothing at all, in either direction.** Docker Desktop
  emulates bind-mount ownership (`fakeowner` on every mount here —
  `10-validation.md`, finding 14), so the `chown` may not reach the host files
  and may not confine the agents. The entrypoint asks an agent's own uid, with
  `setpriv`, whether it can still write the directory and the file, and prints
  `…the ownership change did not reach the kernel that enforces it…` when the
  answer is yes. Read that line before believing any of this is in force; the
  `echo x >> ~/.claude/settings.json` above is the check that settles it.

  One thing that is **not** closed by this and should not be read into it: a run
  can still read `~/.claude/.credentials.json` (it is the credential it bills
  against),
  and every other entry under `~/.claude` — `CLAUDE.md`, `agents/`, `rules/`,
  `plugins/` — keeps the owner it had, which is the agents'. This closes the
  file the CLI resolves a *sandbox policy* from, and the hooks and permission
  rules beside it in that same file. It does not make `~/.claude` read-only.

  **And an open question this raised, which nothing here answers and nothing
  here acts on.** Two more server-pushed files sit in that directory and stay
  the agents' under this: `remote-settings.json` (`{"channelsEnabled":true}` on
  the install this was written on) and `policy-limits.json` (`restrictions`,
  `compliance_taints`). The first is reachable from the *managed* source list
  the sandbox policy is built from — the binary's provider resolver has a
  `remote` branch beside `helper`/`plist`/`hklm`/`file` — but the loader in
  front of it reads `if(!ije()&&yrs!==!0)return null` with `ije(){return}`, so
  it yields nothing unless an internal flag is set, and what sets it was not
  traced. If it is ever live, it is a *managed*-tier source that an agent owns,
  which would outrank the file this locks. Root-owning it was deliberately not
  done: the CLI refreshes it from the server as the agent's uid, so taking it
  would break org-managed settings on exactly the installs that have them, to
  close a hole nobody has shown is open. `policy-limits.json` was not traced at
  all. Both are worth an hour against a live binary before anyone calls the
  policy surface closed.
- **The CLI's own sandbox — read out of the binary, and executed in exactly two
  places.** `proposals/Sandboxing/02x-option-cli-sandbox.md` establishes that the
  pinned CLI (2.1.226) implements a bubblewrap sandbox configured by `sandbox.*`
  settings keys, and `08-recommendation.md` recommends adopting it. All of that
  was read out of the binary's strings with `strings`, and until 2026-08-19 not
  one line of it had been run. What has been run since is narrow, is in
  *Verified* above, and is three things: `bwrap` itself, with and without the
  seccomp profile and with each of the two argv shapes the binary contains; one
  install that ran fifteen hours with `UF_SANDBOX=1` and a sandbox that never
  started; and three hand-run `claude -p` calls against one that did, of which
  one ran a shell command through it and one was refused the credentials file
  its own uid owns. **No work cycle has run inside a sandbox that started** —
  nothing this app spawned has met a live policy, so no per-run `--settings`
  overlay has ever been honoured and the network allowlist has never been
  exercised at all. What depends on those answers is the wiring in the entries
  above and whatever gets built after it. No stock install enables a sandbox either: `UF_SANDBOX=1` is opt-in and
  off unless the operator sets it.

  The harness is `scripts/sandbox-probe/` — a throwaway image on the same base
  and the same CLI pin, a seccomp profile that is Docker's default plus user
  namespaces, and one script that runs questions 0-8 of
  `proposals/Sandboxing/09-implementation-sketch.md:134`-`200` and prints one
  transcribable line each. `scripts/sandbox-probe/RUNBOOK.md` is the ordered
  list of what to run, on which machine, and what each answer decides; steps 4
  and 5 are billed. Its own answer logic is exercised against stubs by
  `scripts/sandbox-probe/probe.test.sh` (37 assertions, no Docker and no
  money) — which measures the harness and says nothing about the CLI.
  **Nothing in that directory has been run against a container**, and one of its
  questions is now known to be under-specified: `probe.sh:521` gives Q2 two
  outcomes, `REFUSED` and `RAN-UNSANDBOXED`, and production showed a third — a
  session that starts, reports nothing, and fails every command inside a `bwrap`
  that exited first. The probe cannot reach it, because it asks Q2 in an image
  with **no** bubblewrap, which is the one kind of unavailability the CLI's
  `access(X_OK)` check does detect. An installed `bwrap` the kernel refuses
  reads to that check as available.

  **Three rows below are answered, none of them by this script**, and the rest
  are not. Fill those in from the script's last block, and record the CLI,
  bubblewrap and kernel versions it prints with them:

  | Question | Answer | Recorded |
  |---|---|---|
  | Q0 — are `bubblewrap` and `socat` installable in this image? | **Yes** — both ship in the image and are executable | 2026-08-19, this install; inferred from the CLI's own `access(X_OK)` probe passing |
  | Q1 — does bubblewrap start under the relaxed profile? | **BWRAP-BLOCKED** without `security_opt`, at both uids; **BWRAP-OK** with `uf-seccomp.json`. `--proc /proc` fails either way | 2026-08-19, Engine 29.7.2 / kernel 6.12.76-linuxkit |
  | Q2 — does the CLI refuse to start when it cannot sandbox? | **Neither refused nor unsandboxed** — it starts, reports nothing, and every `Bash` call dies inside `bwrap`; `failIfUnavailable` never fires | 2026-08-18/19, production, 170 failed calls across 8 runs |
  | Q3 — is the sandbox around the session or only around Bash? | *(unmeasured — narrowed on one side: `Bash` is wrapped, `Edit`/`Write` unknown)* | |
  | Q4 — does a credentials deny entry stop a shell reading the token? | *(unmeasured)* | |
  | Q5 — does a user-settings write widen a managed policy? | *(unmeasured)* | |
  | Q6 — what does one sandboxed command cost in tasks? | *(unmeasured)* | |
  | Q7 — does the CLI's sandbox unshare PID? | *(unmeasured)* | |
  | Q8a — which bubblewrap, and does it carry `--tmp-overlay`? | *(unmeasured)* | |
  | Q8b — does `--unshare-pid` plus `--tmp-overlay` work here? | *(unmeasured — narrowed: `--unshare-pid` alone exits 0 under the profile; `--tmp-overlay` has never been tried)* | |
  | Q8c — does one bubblewrap start inside another? | *(unmeasured)* | |
  | Q8d — does the CLI's own bubblewrap start inside one we started? | *(unmeasured)* | |

  Q3 and Q8d are the two that decide the shape rather than refine it: together
  they say whether the vendor's sandbox stands alone, is replaced by a wrapper
  this app puts around the whole `claude` process, or composes with one. The
  others each move a phase of the plan; RUNBOOK.md's table says which. The three
  answered rows do not make the script redundant: Q8a is the one thing above
  that nothing has recorded — nobody has read the bubblewrap version this image
  actually carries — and the script prints it beside every other answer, which is
  what makes a re-reading of this table possible on the next pin.

- **Whether a real agent uses the `NEEDS_REVIEW` sentinel when it should, and
  withholds it when it should not.** The `needs-review` ending is decided
  entirely by a token in the agent's own final text, so what the wording of
  `NEEDS_REVIEW_NOTICE` actually produces is the whole feature — and nothing in
  this repository can measure it. The matcher, the precedence, the prompt
  composition, the loop stop and the edge semantics are unit-tested; the model's
  *behaviour* against them is reasoned from `COMPLETION_NOTICE`'s measured
  precedent (251 runs) and from `DEFAULT_DONE_PUSHBACK_PROMPT`'s stated failure
  mode, and reasoned is not measured. Two directions to watch on the first real
  one, and they fail differently: an agent that reports it under-generously
  spends its whole cycle cap against a wall exactly as before, which is the
  status quo and costs money; an agent that reports it cheaply — because a task
  is large, unclear or tedious — turns completions into a queue of questions for
  a person, which costs more than money. The reason string is the evidence
  either way: a good one names a thing and a fix, a bad one has tried nothing.
  Also unmeasured, and cheaper: the collision, where a run whose *task* discusses
  this feature carries the literal token and ends in one cycle. That is bounded
  by design rather than closed — the sentinel is spelled unlike the stored
  status and must be alone on its line — and it costs one run ending early with
  its own text recorded, visible and reopenable in one click.
- **Everything on the `needs-review` path that needs a browser or a running
  container.** No `claude` child has ever reported the sentinel to this app. Not
  rendered: the amber badge and its glyph on the runs list, the run page, the
  workflow instance page and the dashboard telemetry card; the **Needs review**
  filter segment; the agent's own reason under the state card; the warn-toned log
  line for the transition. Not exercised against a database: that the ending
  stamps `finished_at` and frees its folder so a queued run starts, that a second
  run may be created to continue such a run's branch, that Resume accepts one and
  clears its reason, that neither bulk pick-up offers it, and that Land, Delete,
  Purge and a conflict resolution are all still permitted on its branch. Docker
  was unavailable in the container this was implemented in, so the
  `docker compose up --build` half of the real verification loop has not been run
  against any of it.
- **The Knowledge base settings section in a browser.** The section, its mount
  picker, its subpath field and the figures panel typecheck and build, and the
  route behind them is measured in the entry above — but nothing has rendered
  them. Four states are drawn and none has been seen: nothing configured, a
  mount that is gone (the picker keeps the stored id as *Folder no longer
  mounted* and Save then refuses it by id), a vault that scanned, and a walk
  that hit its cap. The third of those is also the only place `truncated` shows,
  and no vault reachable from here is large enough to produce it — the cap is
  5,000 notes and the vault measured above holds 773 — so the `≥` prefix and the
  Truncated badge have never been on screen. Docker was unavailable in the
  container this landed from, so the `docker compose up --build` half of the
  loop was not run against any of it.
- **Every part of the Knowledge page that needs a browser.** The entry above
  measured its routes and its renderer; no pixel of it has been seen, and the
  parts that carry the most behaviour are exactly the parts a server response
  cannot show. Specifically unverified: that a click on a wikilink is caught by
  the delegated handler on the page's wrapper and opens that note rather than
  navigating away; that a modified click (⌘, ctrl, shift, middle) is still let
  through to the browser; that **Back** returns to the previous note, which
  rides on `popstate` and on nothing else; that the 250ms search debounce feels
  like a search box rather than a stutter; that the note column and its
  links/frontmatter column sit side by side above `md` and stack below it; that
  the browse table's `Table stack` fallback actually stacks with a label on
  every cell rather than becoming a column of unnamed figures; and that the
  not-configured branch renders as a warn Notice above a Settings link — the
  route half of that state answered correctly, but the branch that draws it has
  never run. The Obsidian constructs added on 2026-08-22 are unseen in the same
  way and the measurement above is explicitly *not* a substitute: it counts what
  reached the DOM, so it says a callout is a box with the right border token and
  says nothing about whether four tones are distinguishable at 8% tint, whether
  a `<summary>` inside a callout looks like a fold, whether a note's table
  actually stacks below `md` rather than scrolling, whether a disabled checkbox
  reads as "not yours to press" or as broken, or whether three levels of list
  nesting stay legible in the note column's width. The graph region's `min-h-[20rem]` is gone with the placeholder
  that earned it: the canvas and both of its empty states are `aspect-[4/3]`,
  so what used to be "dropping a canvas in must not reflow the page" is now
  "the box is the same shape before and after the vault loads, at every width".
  That is a stronger claim and it is unseen in exactly the same way — the box's
  height now follows the pane's width, and nobody has looked at what 4:3 comes
  out as on a wide window, where it is taller than the `32rem` it replaced.
  Docker was unavailable in the container this landed from, so the
  `docker compose up --build` half of the loop was not run against any of it.

  The chrome pass of 2026-08-22 puts five more behaviours on this same list, and
  a build can see none of them. **That opening a note brings it to the reader**:
  the note is now the page's first block, and a click on a list row, on a
  wikilink inside a body or on a graph node scrolls that block into view and
  moves focus onto it. What wants looking at is whether the smooth scroll from
  the health cards at the bottom of the page reads as travel rather than as a
  jolt, whether `scroll-mt-4` is enough to clear the pane's top edge, and
  whether a focus ring around a whole region is feedback or noise. A mouse click
  should draw no ring at all, because `:focus-visible` is heuristic on a
  programmatic focus and nothing here overrides it, but that heuristic is the
  browser's and it has not been watched in one. **That the reduced-motion branch
  is taken**, which is the one place on this page that reads the query in script
  rather than in CSS, because the blanket in `@layer base` cannot reach a
  `scrollIntoView`. **That 180ms is the right threshold** before a second read
  admits itself with a spinner in the heading: long enough to stay silent on a
  local read, short enough that a slow one does not read as unanswered. Both
  ends of that are reasoned from `--motion-base` and measured against nothing.
  **That the frontmatter list stacks** key over value below `md`, where it was a
  fixed 10rem column whose keys were truncated. And **that a tag reads as a
  chip**: `Badge` uppercases visually, and a vault's tags are lowercase
  hierarchical paths, so whether `#TOPIC/ENGINEERING/STANDARDS` in a table cell
  scans or shouts is a judgement nobody has made with their eyes. All five are
  `/knowledge` only; the pass touched no other page and no kit component.
- **A run actually answering out of the vault, and the generated directory's
  ownership under privilege separation.** The delivery is measured — the entry
  above shows the skill reaching the model's skill list from `--plugin-dir`, and
  three `buildArgs` cases pin that it is on the argv on a first cycle and a
  resumed one — but no work cycle has been spawned with it and no model has been
  asked a question it should have answered from a vault. The three behaviours
  that matter are all *inside* the model and none of them can be typechecked:
  that it invokes the skill rather than answering from its own knowledge, that
  it **stops and reports** when the path cannot be read instead of quietly
  answering anyway, and that it carries the confidence grade through into what
  it says. The first two are the whole point of the feature and the second is
  the one that fails invisibly.

  The other half is `writeVaultSkill`'s claim about ownership. The generated
  directory is written root-owned and 0755 so that every agent uid can read it
  and none can write it — a sibling able to rewrite a SKILL.md could put words
  into another run's mouth — and that is reasoned from `chat.ts`'s `/run/uf-mcp`
  precedent, not measured: nothing here ran with `UF_AGENT_UID` set, so the
  fallback to `os.tmpdir()` is the only branch that has ever executed. Before
  trusting this unattended, on a separated install: `stat` the directory under
  `/run/uf-skills`, read the SKILL.md as the agent uid, and try to write it.
  Docker was unavailable in the container this landed from, so the `docker
  compose up --build` half of the loop was not run against any of it, and the
  vault-skill switch in Settings has been typechecked and built but never
  rendered — including the state that matters most, which is the switch refused
  and disabled with no knowledge base configured.
- **Every part of the graph view that needs a browser, which is all of it that
  is visible.** The entry in the section above — the graph view's server half
  and its arithmetic — measures the route, the payload and the simulation
  against the real vault, and stops exactly where a canvas begins.
  Chromium was installed into a scratch directory and refused to launch —
  *Host system is missing dependencies to run browsers* (libnss3, libnspr4,
  libgbm1, libasound2) with no `sudo` and no package index to install them
  from — so **the frame rate the feature is specified in terms of has not been
  measured, only the arithmetic underneath it**. Nothing here has been seen
  drawn. Specifically unverified, and each fails in its own quiet way: that
  the colour probe returns an `rgb(...)` a 2D context accepts rather than the
  `light-dark()` source text `getComputedStyle` hands back for a custom
  property — the failure is a canvas that renders in whatever colour was last
  set, not an exception; that the probe re-runs on a `data-theme` change and on
  a `prefers-color-scheme` change, which is the only thing keeping the graph
  from staying in the old theme's palette until something else forces a
  rebuild; that the device-pixel backing store makes the lines crisp rather
  than soft; that the two batched `stroke()` calls draw the same picture as the
  ten thousand separate ones they replaced, apart from the loss of
  self-compositing that was accepted deliberately; that the rAF actually stops
  when the layout cools, which is a warm laptop rather than a wrong picture;
  that a wheel zooms about the pointer, a drag pans, a dropped node stays
  dropped, and a hover dims what it should; and that the labels ramp in at the
  fade threshold instead of the whole vault's titles appearing between one
  wheel notch and the next. Before trusting it: open `/knowledge` in a browser,
  watch the frame counter in the devtools performance panel through a settle
  with tags on, then drag, drop, zoom out past the fade threshold and switch
  the theme.

  **Two things about the wheel are newer than the rest of this entry and
  unmeasured in their own right.** The listener is registered natively with
  `{ passive: false }` rather than through React's `onWheel`, because React
  attaches `wheel` at the root as a passive listener and discards a
  `preventDefault()` from a synthetic handler — so before the change the
  gesture zoomed the graph *and* scrolled the pane behind it, and after it the
  canvas is supposed to take the gesture whole. Nothing has confirmed either
  half: that the page no longer moves under a wheel over the canvas, or that
  the pane still scrolls normally the moment the pointer leaves it. And
  `LINE_HEIGHT_PX` is an estimate — Firefox reports a mouse wheel in
  `DOM_DELTA_LINE` and everything else in pixels, and 16 is a plausible line
  box at this app's 13px body rather than a figure read off an engine. **The
  two zooms have never been held side by side**, so what is unknown is whether
  a notch travels the same distance in Firefox as it does in Chrome — a wrong
  constant here is a zoom that feels twitchy or sluggish in one browser only,
  which is invisible from the other. **The 7.3MB payload is the other thing a browser would price**:
  the route was not changed for this and its shape is the shape the reader
  already published, but decode and parse of that JSON is a cost nothing here
  has measured, and it is paid once per page load rather than per frame.

  **The box now takes the row's height rather than a fixed ratio, and that is
  three CSS claims nothing here has watched resolve.** The canvas column was
  4:3 while the panel beside it is taller than that at every width the two fit
  side by side, so a few hundred pixels of empty card sat under the graph and
  the row's height was being decided by a column of sliders. The card is now a
  one-cell grid holding a `self-start aspect-[4/3]` sizer and the graph in the
  same cell. Unverified: that a lone auto row really does stretch to a card
  taller than its content (`align-content: normal` behaving as `stretch`),
  which if it does not leaves the box exactly where it was and the change is
  merely inert; that the sizer's ratio still floors the row when the panel is
  the *shorter* column — every width below `lg` stacks, so this is the wide
  window with the panel collapsed, and a failure there is a graph squashed to
  the panel's height; and that the `ResizeObserver` redraws at the new size
  rather than leaving the old backing store stretched, which is a soft picture
  and not a missing one. The canvas element was moved to `absolute inset-0` in
  the same change and that one is a *fix* for a fault the layout would
  otherwise have introduced rather than a new risk: the observer writes the
  measured height back as an inline `style.height`, so an in-flow canvas is a
  child holding up the host's intrinsic height and the box would have ratcheted
  — growing with the panel and never coming back down. Nothing has watched it
  come back down either. To check all four: open `/knowledge` wide, switch the
  graph between **Whole vault** and **This note** (which adds and removes four
  panel rows), and narrow the window past `lg`.

  **The tag seed writes to `localStorage` once and has no second chance.** The
  colour groups now seed themselves from the vault's most-used tags, and the
  moment is exactly one: nothing stored, and the first graph fetch has just
  come back with something in it. `graphTags`, `tagGroups` and the query they
  write are unit-tested; the *timing* is not testable here and is what can fail
  quietly. Three orderings to watch, all in a browser with the key
  `uf.knowledge-graph` cleared: that a first visit lands seven `tag:` groups
  and the graph opens painted; that a second visit with every group removed by
  hand comes back with them still removed rather than reseeded, which is the
  whole reason the flag reads storage rather than the group list; and that a
  first visit whose graph fetch *fails* still persists a slider moved
  afterwards — the persist is held back while a seed is owed, and the error
  branch is the only thing that releases the hold.

- **The whole of the 2026-08-23 pass, because none of it ran against a real
  agent or a rebuilt container.** The entries in the section above are
  measurements of the container as it *was*, of the transcript corpus, and of
  the CLI bundle. Nothing after them was executed: no `docker compose up
  --build`, no browser, no billed run. Five things follow, and they fail
  differently.

  - **That `--plugin-dir` registers a plugin's hooks is now observed** — see the
    entry above, which supersedes what stood here — **but only for
    `SessionStart`, and `readGuard`'s hook is `PreToolUse`.** The general claim
    the read guard rested on has held; its own event has still never been seen
    to fire, and cannot be seen from here, because the CLI emits a
    `hook_response` for `SessionStart` and `Setup` alone. So the guard may still
    do nothing whatever when an operator switches it on, and the symptom is
    indistinguishable from the setting being off — which is how it ships.
    Settling it costs the same one billed run it always did, now narrowed:
    switch `readGuard` on, spawn a cycle that reads one file twice, and confirm
    the second read is refused. A refusal is the only channel this hook has that
    the stream does not filter out.
  - **The fresh-start lever's saving is unmeasured, and the measurement that
    would settle it is a specific one.** `freshStartContextTokens` opens a cycle
    without `--resume` past a threshold, trading tokens for re-discovery; the
    prices either side of that trade are measured (a two-cycle run averaged
    $19.19 against $10.05 for one; 12.0c a call early against 20.4c late) and
    the *net* is not. What would settle it is a matched pair of runs on one
    task, one arm each way, compared on total spend **and** on whether the task
    finished. Never a within-run before/after: cost per call climbs with
    position all on its own, so the second half of any run is dearer than the
    first whatever this setting says — the same trap the `--autocompact` entry
    above records as a phase contrast.
  - **The file-cost notice has never been seen on a real argv, and not one
    avoided read has been measured.** What is measured is the price of the reads
    it is trying to prevent — `orchestrator.ts` at ~116,000 tokens read 496
    times across 78 runs, `workflows.ts` 68,000 over 185 — and the arithmetic
    that one avoided full read of the first is worth about $3.19 in the re-reads
    and cache writes behind it. That an agent handed a price list reads less is
    the claim, and it is untested. Its opposite failure is cheap to check and
    has not been checked either: that `runs.file_cost_notice` is byte-identical
    on cycle 1 and cycle 2 of one run, since a notice that drifted inside a run
    would cold-start a 190,000-token prefix and cost far more than it could
    save.
  - **No page has been rendered from this build.** The new dashboard card
    (*What filled the context*) and the counterfactual column beside the agent
    breakdown, the narrower runs-list and workflows-list payloads, the run
    page's poll standing down on a terminal row, and the Land row's wrapped
    select are verified by types and arithmetic only. The Land fix has one
    measurement under it and it is of the stylesheet rather than of the row:
    `.w-auto` is emitted at byte 15178 and `.w-full` at 15197 with the same
    specificity, so the later one won and the select resolved to 100% whatever
    the call site passed. Nobody has seen the button come back onto its row.
  - **The graph route's "after" byte figure is computed from the new code**,
    as the entry above says, rather than curled from a server — and the same is
    true of the workflow list's. Both are the arithmetic that justified the
    change, not a reading of the change.

- **The Files tab's touched/changed reconciliation, in a browser.** New:
  `src/lib/runTouchScan.ts` (the `run_events` scan), `src/lib/runTouches.ts`
  (the pure reconciliation), `GET /api/runs/[id]/touched`,
  `src/components/RunTouches.tsx`, rendered under `RunDiff` on the run page's
  tab — whose label is now **Files** rather than Changes, the `RunTab` value
  still `"changes"`. **No browser was opened and no container was started**, so
  nothing below has been *seen*.

  What **is** checked, and it is more than types for once: the scan's SQL was
  run against a real SQLite database — `better-sqlite3` in process, an in-memory
  `runs`/`run_events` pair loaded with ten hand-written `kind: "tool"` payloads
  — and it returned what the design claims. `/w/repo/src/a.ts` and
  `/w/.wt/repo-1/src/a.ts` collapsed to one `src/a.ts` row with `calls: 3`,
  which is the worktree-relativisation working; a `NotebookEdit` came back as
  `nb.ipynb` from `$.input.notebook_path`; `/tmp/scratch.txt` came back with
  `outside: 1`; a `Bash` carrying only `command` and a `Grep` carrying `path`
  (a *directory*) were both excluded, as was a `kind: "log"` row; and
  `subagent`/`parentToolUseId` survived. That was a throwaway script, not a
  committed test — `runTouches.test.ts` covers the pure half only, nine cases.
  Plus `typecheck` (exit 0), `npm test` (**1,805 tests / 266 suites / 0
  failures**) and `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` (exit
  0, `/api/runs/[id]/touched` listed at 270 B).

  The click list, at 1280px and again at 390px, where `Table stack` takes over
  and the column heads leave the screen:

  1. Open a finished, worktree-isolated run's **Files** tab. The tab is labelled
     Files, not Changes; the strip still has its five labels in their order.
  2. Under "What changed" there is a second card, **What it touched**, whose
     header prints a distinct-file count and a work-cycle count and says a call
     was *attempted*. **Write both numbers down** — they are what the deferred
     file-by-cycle grid in `proposals/SessionFlow/` is waiting on, and nothing
     else in this app prints them.
  3. Groups appear in the order: changed-but-never-named, then named-and-changed
     (behind a closed `Disclosure`), then named-not-changed, then outside the
     checkout. An empty group is absent rather than an empty box.
  4. A row with no calls at all — anything in the first group — shows an em dash
     in Reads and Writes, never `0`. At 390px each figure is named by its own
     `Td` label and the path is the unlabelled headline.
  5. A run that delegated shows a sub-agent's name in **By**; a file both the
     main thread and a sub-agent reached shows both, comma-separated.
  6. Open a **non-isolated** run's Files tab: the diff is the folder's current
     state, and the reconciliation should still render against it.
  7. Open a run whose branch is gone (`kind: "none"` from the diff route). The
     card still renders — its two figures and its empty states are facts about
     the events, not about the diff — but it drops to **two** groups, named by
     a tool call and named outside the checkout, with a warn notice carrying the
     diff's own reason. Neither "changed, never named" nor "named, and not
     changed" may appear: the changed set is *unknown* there rather than empty,
     and either label over it is the reconciliation asserting the thing it was
     built to check. This is the entry most likely to be wrong, because it is a
     condition on a prop rather than anything the route answers.
  8. Set `eventRetentionDays` low, let the sweep run, reopen a terminal run past
     the horizon: the card says its tool events were removed on the horizon and
     does **not** draw an empty list. The diff above it is unaffected — a
     checkout is kept on its own clock.
  9. A run that made only `Bash` calls says "No tool call in this run's log
     named a file", which is a different sentence from 8.
  10. Watch the network panel: `/api/runs/[id]/touched` is fetched **once** on
      opening the tab and never again. It must not join the 3-second poll.

- **The whole of `ask_operator` — the server half of a chat that asks the
  operator a question.** **No CLI was run, no browser was opened and no
  container was started**, so nothing below has been *seen*. Docker is not
  available in the container this was written in, which means the
  `docker compose up --build` half of the verification loop could not be
  attempted at all rather than having been skipped. What was run, on this
  branch: `NODE_ENV=development npm ci --include=dev` (exit 0),
  `npm run typecheck` (exit 0) and `npm test` (**1,824 tests / 272 suites / 0
  failures**). `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` was
  **not** run, so the new route file has never been through the Next.js build —
  only through `tsc`. There is also no UI — that is a separate run continuing
  this branch — so no question has ever been rendered and `POST
  /api/chat/[id]/questions` has never been called by anything but a unit test.
  **The tool is on the wire before the panel is**, which is a real state a live
  install can be in: a chat that asks now leaves a row nothing draws, and the
  operator sees only the reply saying what was asked. It does not jam — the
  next ordinary message supersedes every open question, so the five-question
  cap cannot be reached and held — but until the panel lands the answer reaches
  the model only as whatever the operator types next, without the question
  quoted above it.

  **Both of the paragraph above's gaps are closed by the entry below it**, which
  is the run that built the panel: the build was run (exit 0), and the card has
  now been rendered and clicked. Everything else in this entry stands — in
  particular the two load-bearing unknowns, which are about a model and a CLI
  and which no amount of rendering can settle.

  **The load-bearing unknown is whether the pinned CLI stops when it is told
  to.** A tool call cannot block on a click: `CHAT_TIMEOUT_MS` is ten minutes
  and an overrunning turn is killed with its answer discarded, so `ask_operator`
  records its rows and returns at once. Everything that then makes the turn
  *end* is prose — the tool description, and the result text saying in as many
  words that no answer is coming back through it. Neither is a mechanism, and
  what a model that reads it the other way does is call the tool again, which
  the pending-question cap turns into a refusal rather than a loop but which
  still spends the turn. That is the same class of assumption as "an
  unrestricted chat stays an orchestrator" further up this list, and it wants
  the same test: ask the chat something under-specified, watch whether it asks
  once and stops.

  **The second is whether the next turn knows what it is answering.** A question
  asked in one turn and answered in the next is the same conversation to the
  model only if `--resume` carries the tool call, which has not been measured
  here. The answer message quotes each question above the answer to it
  *precisely* because it might not — but that quoting has never been read by a
  real child, so what is unverified is whether the model treats it as its own
  question or as the operator narrating one.

  Four smaller things, none of them measured. `MAX_OPEN_QUESTIONS` (5) and
  `MAX_QUESTION_CHOICES` (8) are argued from `MAX_PENDING_PROPOSALS`' reasoning,
  not from watching anyone answer anything. What an exchange *costs* is
  unknown and is not free — a question is a whole extra turn each way, against
  `chatTurnBudgetUSD` twice. The `chat_questions` statement is a
  `CREATE TABLE IF NOT EXISTS` and `SCHEMA_VERSION` was deliberately not bumped,
  which follows `db.ts`'s own rule for an additive migration but has only been
  run against databases this suite created. And a stranded turn whose capability
  is still live can in principle write a question into a chat the row already
  says is idle; the answer path is idempotent against it and the pending cap
  bounds it, but that window has not been reproduced.

- **The operator's half of `ask_operator` — the card in the thread, the chat
  list's marker, and the paragraph telling the model when to ask.** **No
  container was started and no `claude` child was ever spawned on this path**;
  Docker is not available in the container this was written in, so the
  `docker compose up --build` half of the loop could not be attempted at all
  rather than having been skipped. Run on this branch:
  `NODE_ENV=development npm ci --include=dev` (exit 0), `npm run typecheck`
  (exit 0), `npm test` (**1,832 tests / 272 suites / 0 failures**) and
  `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` (exit 0, with
  `/api/chat/[id]/questions` listed and `/chat` at 11.4 kB).

  Unlike the entry above, this one **was rendered**, and it is worth saying how,
  because the arrangement is reusable and none of it is the shipped one. A
  scratch `DATA_DIR` was seeded with five threads by hand, `next dev` was run
  against it on a spare port, and Chromium was driven over it with Playwright at
  1440×1000 and again at 390. Two environment facts had to be worked around and
  neither is in `CLAUDE.md`: `NODE_ENV=production` is set in this container and
  makes `next dev` answer **every** request with an `EvalError` out of the edge
  runtime's instrumentation chunk — a blanket 500 with nothing on the page, and
  a third member of the same family as the two traps that file already records
  — and `UF_AUTH_TOKEN` is set both in the environment and in `.env`, so
  `UF_ALLOW_NO_AUTH=1` does *not* open the app: `middleware.ts` gates purely on
  the token being non-empty, and exporting it **empty** is what turns the gate
  off. That is why every screenshot carries the red "Authentication is off"
  banner.

  What was seen: a single open question with three choices and a text field; a
  three-question card with hairlines between the questions; an
  answered-and-overtaken pair sitting directly above the `Answers to your
  questions:` message that settled it; a question asked while its own turn was
  still running, with every control out and the reason said; a question with no
  choices and no typed answer, saying so and pointing at the composer; a refused
  answer drawn on the card rather than under the composer, with every control
  released again; and the thread list showing `asked you` and `asked you 3`.
  Dark and 390px both hold, and all four text controls on the card measure 16px
  below `md`, which is the platform floor `CONTROL_BASE` exists for.

  The click wiring was exercised with `POST /api/chat/[id]/questions`
  **intercepted in the browser**, deliberately, because the real route reaches
  `sendChatMessage` and spawns a billed child. Asserted against the captured
  request bodies: one press of a choice on the only open question sends exactly
  `{"answers":[{"id":…,"answer":"pnpm"}]}` and nothing else; the same press
  beside two open siblings sends **nothing at all** and only marks the button
  `aria-pressed`; the row's own button then sends all three in the order they
  are drawn; and Enter inside one question's field answers that question alone
  and does not also send the composer's draft.

  **What that arrangement cannot show is the half that spends money.** No answer
  has ever reached a real turn: `answerChatQuestions` → `sendChatMessage` →
  `claude -p` is driven only by the unit tests, so the first real proof that an
  answer resumes the session and that the model reads the quoted questions as
  its own is still the one the entry above is waiting for. Nothing here
  discharges it. Nor has any model ever *called* `ask_operator` — the
  system-prompt paragraph added by this run (only what the operator alone knows;
  prefer a stated assumption; one is a question where four is a form) is written
  against the same reasoning as `MAX_OPEN_QUESTIONS` and is equally unmeasured,
  which matters more than usual because it is paid for on **every** turn and its
  failure in the other direction — a chat that stops proposing and starts
  interviewing — looks like the feature working. Three smaller things went
  unchecked: no screen reader was run over the card, so `aria-pressed` and the
  transcript's `role="log"` announcing a card's arrival are reasoned rather than
  heard; the shared `busy` flag disabling the composer and the approve row while
  an answer is in flight was never seen against a slow response, only against an
  instant stub; and the `prefers-reduced-motion` path was not exercised, on the
  grounds that nothing on this card moves — `ui-transition` and `Button`'s busy
  ring are both already under `@layer base`'s blanket.

  The click list, at 1440px and again at 390:

  1. Ask the orchestrator something genuinely under-specified — "propose a run
     to fix the flaky tests" in a repo whose lockfile and CI disagree. Wait for
     the turn. A card headed **Waiting on you** appears at the foot of the
     thread, *below* the reply, never above it.
  2. Press a choice. It sends on that one press. The thread carries on, the card
     stays where it is showing **You answered …**, and the message it produced
     sits directly beneath it quoting the question. Both are meant to be there —
     the card is the question as asked, the message is the text the model was
     sent.
  3. Ask something that produces two or more questions. Now a press does **not**
     send: it marks the choice, and the button at the foot of the card reads
     `Answer 2`. Leave one blank and send: the message says `(not answered)`
     against it and its row reads **Overtaken by what you said next**, in muted
     grey and never in red.
  4. With a question open, type an ordinary message into the composer and send
     it. The footer said what would happen; check it did — every open question
     goes to *overtaken*, not to answered, and no card is left pressable.
  5. Reload with a card on screen in a second tab, answer it there, then press a
     choice in the first. The refusal appears **on the card**, in red, and every
     button on it comes back enabled.
  6. Open the **Chats** tab. A thread with questions open says `asked you` (or
     `asked you 3`) in accent beside its time, distinct from the `N waiting`
     chip, which counts proposals.
  7. Watch the network panel with a question open and nothing else happening:
     the poll stays at **10 seconds**. It must not speed up — nothing on the
     server can answer — and it must not stop, because another tab can.
  8. At 390px: the chips wrap rather than overflowing, the hairlines still
     separate the questions, and tapping the text field does not zoom the page
     in and leave it there.

- **A process that does not own the data directory no longer closes out the
  owner's runs on its way out.** `shutdownRuns` was registered as the
  `SIGINT`/`SIGTERM` handler outside `instrumentation.ts`'s ownership branch and
  carried no gate of its own, so the second process — the dev server an agent
  starts against an inherited `DATA_DIR`, restarted by `next dev` on every file
  change — ran the entire shutdown reconciliation against the owner's database
  on each exit: a `shutdown` event and its outbound webhook for every `running`
  row install-wide, `restart_closed = 1`, and `active_started_at` cleared on
  cycles whose agents were still working and still billing. The last of those
  fails **open**, which is why this was worth a fix rather than a note —
  `installBudget` and a workflow instance's budget both bound
  `telemetrySpendSince` below by that column, so a stray dev server widened two
  ceilings at once with nothing on any page saying so. The gate is
  `mayWriteDataDir()` at the top of `shutdownRuns`, read at the write like every
  other writer in the app rather than captured at boot, returning
  `{ signalled: 0, closed: 0, recovered: 0 }`; `killAllAgents` is still
  unconditional, because those children are this process's whatever the lock
  says.

  **Not verified by hand:** no two-process reproduction was run and no container
  was built — this checkout has no Docker, and the second server is only worth
  watching against a real billed agent in the first. What was run, on this
  branch: `NODE_ENV=development npm ci --include=dev` (exit 0),
  `npm run typecheck` (exit 0) and `npm test` (**1,906 tests / 281 suites / 0
  failures**), the last of which includes a new fourth case in
  `shutdown.test.ts`. That case was run against the unfixed function first and
  observed to fail on its first assertion, with `shutdownRuns` returning
  `closed: 1, recovered: 1` and the seeded row's `restart_closed`,
  `active_started_at` and `spent_usd_est` all rewritten by a process that had
  been refused the directory. It makes itself a non-owner the way a real second
  server becomes one — a lock file naming a live pid that is not ours, then
  `claimDataDir()` — rather than by stubbing the gate.

There is no linter run in this repo, and `npm test` covers a deliberately short
list: the folder-collision predicate, which queued runs may start, the budget
policy, how a provider refusal is classified and backed off from, which prompt a
work cycle spawns with, the GitHub credentials handed to a work cycle, that a
work cycle started as a saved agent both defines and selects it and moves none of
what bounds the run, how a
run's diff is parsed and budgeted, whether a saved graph of run blocks can run at
all and the order its runs are created in, when a branch may be landed, what a
queued merge does with the branch it reaches, what counts as a conflict marker — both
for deciding whether one was really resolved and for deciding what to show, what
the orchestrator chat may ask its operator, what an answer to it settles and where
a question is drawn in the thread that shows it — and
the two renderings that would lie quietly about a number: an unconfigured
ceiling, and a first-party figure shown beside the meters. Two entries are
neither a function nor a rendering: the order a chat's thread renders in, driven
against a real database because what it pins is in the SQL rather than in any
function — as is what an operator's message does to a question the chat left
open, which is the same table and the same argument; and that the image leaves the data volume writable by whatever uid
compose runs the container as, which is otherwise checked by nothing here and
fails only on Linux, only under a non-1000 `UF_UID`, and only by refusing every
data route. A third is the backup round trip, which is neither of those either:
it drives the two shipped scripts against a real database with a write
transaction open, because a snapshot that quietly omits the newest runs opens
cleanly and passes every other check there is. `npm run typecheck`
plus a `docker compose up --build` smoke test is still the real verification
loop, and the list above records what was checked by hand.
