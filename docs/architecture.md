# Architecture

[← Documentation index](README.md)

```
src/lib/
  transcripts.ts   JSONL parser — incremental byte-offset reads, dedupe
  windows.ts       5-hour block + weekly rollups, burn rate, projection,
                   calendar day/week/month history (display only)
  pricing.ts       per-model rates, cache-TTL multipliers, fast mode
  adminApi.ts      Admin API client (rate limits, usage, cost) w/ pagination
  budget.ts        policy evaluation
  orchestrator.ts  run loop, process spawn, stream-json parsing, SSE bus
  git.ts           the one way this app runs git — argv only, environment scrubbed
  diff.ts          a run's <base>...<branch> as a budgeted file list + patches
  review.ts        the on-demand reviewer (a third, deliberate child process)
  land.ts          merge preview, landing, branch deletion, branch inventory
  chat.ts          the orchestrator chat (a fourth, deliberate child process),
                   and the shared spawn a workflow's deciding block reuses
  workflows.ts     saved graphs of run blocks — form input, never a run; and
                   the blocks that decide what to run, which are not
  schedules.ts     when a saved workflow presses its own Run — the one place
                   an agent starts with nobody present
  workspace.ts     the folder walk, shared by the picker and the chat's tools
  knowledge.ts     an Obsidian vault in one of the mounts, read as a link
                   graph — parse, resolve, cache; read-only, and no write path
  vaultSkill.ts    the vault-lookup skill a run is handed: generated per spawn
                   as a plugin directory, never installed into ~/.claude
  db.ts            SQLite (runs, events, reviews, chats, proposals, workflows,
                   schedules, settings)
src/app/api/       usage · account · runs · branches · calibrate · settings ·
                   folders · chat · mcp · workflows · knowledge
```

Transcripts are re-read incrementally: only bytes appended since the last scan
are parsed, and a partial trailing line is left unconsumed for the next pass.
