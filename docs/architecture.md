# Architecture

[← Documentation index](README.md)

```
src/lib/
  transcripts.ts   JSONL parser — incremental byte-offset reads, dedupe; and
                   `parseCompactionBoundary`/`readCompactions`, a separate pass
                   for the compaction records, off the metering path entirely
  windows.ts       5-hour block + weekly rollups, burn rate, projection,
                   calendar day/week/month history (display only)
  toolComposition.ts  what *filled* those contexts — tool calls paired with the
                   size of the result that answered them, denominated in
                   characters because a `tool_result` carries no usage block;
                   its own dedupe key and rollup, never a cost source
  intakeFilter.ts  what winnow's intake filter kept off the wire, read from its
                   own ledger — the one file here nothing in this app writes.
                   A counterfactual, never a cost source: the meters are priced
                   from `usage` frames, which report the request the filter had
                   already rewritten, so this money is already absent from every
                   figure beside it
  pricing.ts       per-model rates, cache-TTL multipliers, fast mode
  adminApi.ts      Admin API client (rate limits, usage, cost) w/ pagination
  budget.ts        policy evaluation
  orchestrator.ts  run loop, process spawn, stream-json parsing, SSE bus;
                   `contextShapingEnv` names the seven inherited variables that
                   change a run's context regime, and `injectionFates`/
                   `compactionNotice` say what a compaction took — read off the
                   cycle's own argv, quoting the vendor's table, acting on
                   nothing
  cycleInvocation.ts  what one work cycle *says* and how it is invoked — the
                   next prompt and every notice appended to it, `cycleEnding`'s
                   two contracts, and `buildArgs`. Lifted out of the file above,
                   which re-exports each name it used to own, so nothing that
                   imports `@/lib/orchestrator` moved
  runTasks.ts      the background tasks a run started, reduced from the
                   `system:task_*` events the loop above already stores — the
                   log feed drops every `system:` line on purpose, so this is
                   their only reader. Pure and client-safe, over the events the
                   run page already holds: no route, no poll, no new column.
                   Never a sub-agent delegation, which is its own event kind
  fileCostNotice.ts  what a `Read` of this repository's largest files costs,
                   generated once at `createRun` and frozen on the row, because
                   the appended prompt is part of the cached prefix
  readGuard.ts     an optional generated hook plugin (off by default) that
                   refuses a whole re-read and caps one read, delivered on the
                   same `--plugin-dir` list; root-owned code, agent-writable
                   ledger beside it
  notify.ts        the outbound webhook: one signed, vendor-neutral, six-field
                   JSON body per ending that needs a person, fire-and-forget
                   beside `logLifecycle` and never awaited; off unless the
                   environment names a URL and a secret
  git.ts           the one way this app runs git — argv only, environment scrubbed
  diff.ts          a run's <base>...<branch> as a budgeted file list + patches
  runTouchScan.ts  the files a run's `kind: "tool"` events named, as one indexed
                   range scan over `run_events` — `readCountsFor`'s own CASE,
                   unfiltered by tool name and keeping the rows it drops at its
                   `ELSE NULL`, which are the touches outside the checkout
  runTouches.ts    the pure half of the same feature: the touched set differenced
                   against the diff's file list, into four groups. Reaches
                   nothing, because `RunTouches.tsx` imports it — the split is
                   what keeps `node:fs` out of the browser bundle
  pathMap.ts       a path hierarchy as a drawable tree over any per-file
                   payload, and the fold plan under it: a depth cutoff when
                   over budget, never a top-N and never `capGraph`'s
                   degree-first prune, so no file is ever dropped. Holds no
                   map's vocabulary — the payload and its directory rollup are
                   the caller's — and reaches nothing, for `runTouches.ts`'s
                   own reason
  touchedMap.ts    `pathMap.ts`'s payload for the picture at
                   /runs/[id]/touched: those four groups as a directory tree,
                   the node set files and the layout the path hierarchy,
                   because tool → file is a star. Adds no field that could be
                   read as an outcome
  conflictMap.ts   `pathMap.ts`'s second payload, for the picture at
                   /runs/[id]/conflicts: a pending merge's conflicted files as
                   a directory tree, sized by clash count and filled by git's
                   conflict type. A file the preview never opened carries a
                   *null* count and never a zero, because `land.ts` reads the
                   merged content of only the first `MAX_CONTENT_FILES`
  review.ts        the on-demand reviewer (a third, deliberate child process)
  land.ts          merge preview, landing, branch deletion, branch inventory
  chat.ts          the orchestrator chat (a fourth, deliberate child process),
                   and the shared spawn a workflow's deciding block reuses
  workflows.ts     saved graphs of run blocks — form input, never a run; and
                   the blocks that decide what to run, which are not
  workflowGraph.ts what a graph is on the wire, and every refusal decidable
                   without the disk; re-exported by workflows.ts in full
  schedules.ts     when a saved workflow presses its own Run — the one place
                   an agent starts with nobody present
  workspace.ts     the folder walk, shared by the picker and the chat's tools
  knowledge.ts     an Obsidian vault in one of the mounts, read as a link
                   graph — parse, resolve, cache; read-only, and no write path
  vaultSkill.ts    the vault-lookup skill a run is handed: generated per spawn
                   as a plugin directory, never installed into ~/.claude
  dreaming.ts      failures that recurred, counted from the transcripts'
                   is_error results — its own incremental cache, never the
                   usage scan's; writes nothing
  dreamingLedger.ts  what a night wrote into the vault and what each night
                   decided — the deduplication key and the retraction list,
                   since the vault has no history of its own
  dreamingRun.ts   the half that spends: selects what has recurred and is
                   unwritten, starts one run in the vault, and the nightly
                   clock over it — the second clock in this app after
                   schedules.ts, and it never catches up after a boot
  knowledgeGraph.ts  what the graph view shows before anything draws it —
                   the search query, the colour groups, the filters, the
                   local-graph walk, and the settings the browser stores
  forceLayout.ts   the force-directed layout under it: Barnes-Hut repulsion,
                   link springs, centring, and an alpha that cools to a stop
  canvasView.ts    what every <canvas> needs and none of them owns: the
                   world/screen transform, the cull rectangle, framing, the
                   nearest-within-reach hit test, device-pixel sizing under a
                   ResizeObserver, the wheel's deltaMode, the colour probe.
                   Knows what a pixel is and never what is drawn on it
  db.ts            SQLite (runs, events, reviews, chats, proposals, workflows,
                   schedules, settings)
src/app/api/       usage · account · runs · branches · calibrate · settings ·
                   folders · chat · mcp · workflows · knowledge
```

Transcripts are re-read incrementally: only bytes appended since the last scan
are parsed, and a partial trailing line is left unconsumed for the next pass.
