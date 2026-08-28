# What a run actually leaves behind, and the tree it makes

`00-problem.md` measured what is missing. This file measures what is *there*,
run by run and field by field, and then draws the tree one real run produces —
because the option files below are all arguments about how to annotate this
shape, and the shape should be on the table before the arguments start.

---

## 0. Which run, and why not the two the brief named

The brief named `83bed426-a595-492d-a21e-43b74b335f01` (winnow) and
`fc491479-5fc3-4b9b-8952-c8431ee04b5b` (UsageFoundry). **Neither is resolvable
in this container**, and the reason is worth recording rather than working
around:

```
$ node -e 'new DatabaseSync(".data/usagefoundry.db").prepare("SELECT count(*) c FROM runs").get()'
{ c: 0 }
$ node -e '… .next/standalone/.data/usagefoundry.db …'
{ c: 0 }
$ grep -rl "83bed426-…|fc491479-…" ~/.claude/projects
./-workspace--uf-worktrees-usagefoundry-721638d11c0b-1/b66837ed-….jsonl   # this session's own prompt
./-workspace/5f119efd-….jsonl                                            # a sibling agent's prompt
./-Users-hendrikkuehnel-Documents-GIT-winnow/69cf1fb9-….jsonl            # the operator discussing them
```

Both databases in the image are schema-only: `runs` has 46 columns and zero
rows. The two ids appear on disk **only inside prompts** — mine, a sibling
agent's, and two host sessions where the operator was talking about them. The
run rows live on the operator's host, and `runs.session_id` is what maps a run
id to a transcript (`src/lib/db.ts:744`), so without the row there is no
mapping. A run id is not a session id and cannot be guessed into one.

So the grounding run below is the closest real equivalent that *is* here: a
UsageFoundry-spawned agent run against this repository's worktree lineage. Every
number in this proposal comes from it and from a second run for contrast.

**Run A — the grounding run**

```
~/.claude/projects/-workspace--uf-worktrees-usagefoundry-721638d11c0b-1/
  4c7c4e5c-9581-4e38-8e4a-f73cbe1eec1d.jsonl
```

| | |
|---|---|
| cwd | `/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1` |
| entrypoint / model / effort | `sdk-cli` / `claude-opus-5` / `xhigh` |
| CLI version | `2.1.226` |
| started | `2026-08-22T02:05:14.528Z` |
| wall clock | ~58 minutes |
| what it did | revised `proposals/ContextControl/` — 13 commits, 11 files, +1634 −74 |

**Run B — the contrast run**, `~/.claude/projects/-workspace2/b51351ba-….jsonl`:
same harness, different repository, 484 tool calls, web-research shaped rather
than edit-shaped.

---

## 1. The census

```
node scripts/census.mjs ~/.claude/projects/-workspace--uf-worktrees-…/4c7c4e5c-….jsonl
node scripts/types.mjs  <same>
```

| | run A | run B |
|---|---:|---:|
| bytes | 3,838,145 | — |
| records | 1,292 | 1,464 |
| — `assistant` | 520 | 631 |
| — `user` | 302 | 486 |
| — `attachment` | 369 | — |
| — `last-prompt` | 95 | — |
| — `system` | 4 | 0 |
| — `queue-operation` | 2 | — |
| distinct uuids | 1,195 | 1,169 |
| `parentUuid` null | 102 | 296 |
| dangling `parentUuid` | **0** | **0** |
| `tool_use` / `tool_result` | 297 / 297 | 484 / 484 |
| `thinking` (all empty) | 210 | 140 |
| assistant text blocks | **13** | **7** |
| assistant text bytes | **5,578** | **6,670** |
| `TodoWrite` | 0 | 0 |
| compaction boundaries | 4 | 0 |
| sidechain records | 0 | 0 |

Two numbers deserve emphasis before anything is designed on top of them.

**`dangling parentUuid = 0`.** Every non-null parent pointer resolves inside its
own file. The graph is not corrupt; it is *severed at known points*, which is a
much better problem (C5).

**520 assistant records, 13 text blocks.** 507 of the run's model turns produced
a thinking block and a tool call and no words at all.

### Tool composition

| run A | | run B | |
|---|---:|---|---:|
| Bash | 192 | Edit | 239 |
| Read | 52 | Bash | 98 |
| Edit | 48 | WebSearch | 77 |
| Write | 5 | Read | 55 |
| | | WebFetch | 13 |
| | | ToolSearch | 1 |
| | | Write | 1 |

`buildToolComposition` (`src/lib/toolComposition.ts:256`) already computes this
rollup from `parseToolRecord` (`:124`), and `docs/agent/metering.md` records why
`byTool` is deliberately not a sixth cost rollup. A decisions view wants the
*sequence*, not the histogram — but it wants the same parser.

### Failures are mechanical, not deliberative

Five tool errors in 297 calls, all Bash, all typos:

```
node -e '…'          → SyntaxError: Expected '}', got '<eof>'
grep -n "…"          → Exit code 2
ls -d */ | head      → ls: invalid option -- 'e'
git add -A proposals/ContextControl && …  → could not open directory
cat > /tmp/…/render-skill.js …            → Cannot find module
```

This matters more than it looks. A tempting design reads *"call failed, then a
different call succeeded"* as a rejected alternative. In run A **that inference
is wrong five times out of five** — every failure is a shell mistake immediately
re-typed, not a strategy abandoned. Structural rationale mined from error/retry
pairs would have produced five confident fabrications in this run.

### The prose, in full

Twelve blocks over 40 characters, 5,553 bytes. Eleven of them total 680 bytes:

```
02:05:16   77B  I'll start by reading the ground rules and the current state of the proposal.
02:29:28   71B  Now the remaining two paragraphs of that section, then the audit table.
02:33:58   49B  Now fixing the figure error in the option M file:
02:36:24   50B  Now the score table and the sensitivity paragraph:
02:41:35   53B  Now committing the comparison work and this addendum.
02:45:29   87B  Two of Option F's stated unknowns are now answerable from the corpus. Writing the file.
02:46:25   50B  Now the framing paragraph at the head of Option F.
02:47:24   55B  Now the two repairs, where repair #2's premise changed.
02:47:53   54B  Now the runner-up section, which the re-score changes.
02:48:12   62B  Now Option F's rejection paragraph and the new Option M entry.
02:59:27   72B  Now the citation-resolution check across everything this revision wrote.
03:01:35 4821B  Thirteen commits, 11 files, +1634 −74, all under `proposals/`. …
```

One of these — `02:45:29` — actually states a reason ("two of Option F's stated
unknowns are now answerable from the corpus"). The rest announce the next
action. **The run's usable first-hand rationale, excluding the final report, is
one sentence.**

### Commit messages are the richest first-hand source in the run

Fourteen `git commit` invocations. The subjects, as written by the run:

```
Audit
Give the invisible t…
Hold the recommendation, a…
Record the second pass, its se…
Retire the PreCompact hook from Phase 0b, and count the fields
```

These are imperative, specific, and *reason-bearing* in a way the inter-tool
narration is not — "Retire the PreCompact hook from Phase 0b, and count the
fields" states both a decision and its scope. Eleven of the fourteen use a
heredoc (`git commit -F -`), so the bodies are multi-paragraph and sit in the
`tool_use.input.command` string, verbatim, in the transcript.

This is the single most under-used `why` source in the run, and no existing
panel surfaces it: `RunDiff` shows the range diff, `RunTouches` shows files, and
neither shows what the run said when it committed.

### The attachments the harness injected

369 `attachment` records:

```
budget_usd 290 · task_reminder 29 · compact_file_reference 15 · deferred_tools_delta 10
hook_success 5 · agent_listing_delta 5 · mcp_instructions_delta 5 · file 5
nested_memory 2 · edited_text_file 2 · skill_listing 1
```

`budget_usd` × 290 is the app's own budget line arriving before nearly every
turn. These are *context the run had when it decided*, not decisions. They
belong in a node's evidence panel, never as nodes.

### The seams

Four `system/compact_boundary` records, all `trigger: "auto"`:

| # | rec | preTokens | postTokens | dropped (cum.) | `logicalParentUuid` resolves |
|---|---:|---:|---:|---:|---|
| 1 | 170 | 167,284 | 11,135 | 156,149 | yes |
| 2 | 444 | 167,264 | 14,387 | 309,026 | yes |
| 3 | 764 | 170,492 | 11,619 | 467,899 | yes |
| 4 | 1139 | 169,820 | 11,311 | 626,408 | yes |

Each boundary also carries `preservedSegment.{headUuid, anchorUuid, tailUuid}`
and the explicit `preservedMessages.uuids` list — four or five records that
crossed. So the view can say exactly *which* four records the run still had in
hand when it made decision #171.

### Work cycles

`user` records split cleanly: **297 are tool results, 5 are real prompts**
(`promptSource: "sdk"`, string content). Five prompts = five work cycles, which
matches `runs.iterations` semantics. The 95 `last-prompt` records all carry the
same `lastPrompt` and a `leafUuid` that resolves in-file — they are the CLI's
resume bookmark, re-written as the leaf moves, not five distinct prompts.

### What the run cost

```
node scripts/cost.mjs <transcript>
```

| | |
|---|---:|
| assistant requests | 520 |
| `input_tokens` | 1,040 |
| `cache_creation_input_tokens` | 1,278,150 |
| `cache_read_input_tokens` | 53,184,875 |
| `output_tokens` | 356,961 |
| peak single-request context | 166,798 |
| **cost at Opus 5 list rates** | **$43.51** |

(Opus 5 is $5/$25 per MTok, cache writes at 1.25× and reads at 0.1× — Anthropic
list rates, stated inline in `scripts/cost.mjs`. There is no `pricing.ts` in this
tree to cite; see `11-validation.md` B4.) Note `input_tokens = 1,040`
against 53.2M cache reads: essentially the entire spend is re-reading a cached
prefix 520 times. This is the denominator every option's cost is measured
against.

---

## 2. The bytes-per-token calibration

Options 2 and 3 need token counts for slices of a transcript, and guessing is
not acceptable in a file that asks other options for measurements. The
transcript calibrates itself:

For each pair of consecutive assistant records with no compaction between them,
the growth in total context (`input + cache_read + cache_creation`) is the token
cost of the records in between, whose serialized `message` bytes are known.

```
node scripts/calib.mjs <transcript>
→ calibration pairs=285 tokens=506847 messageBytes=1311491 bytesPerToken=2.59
```

**2.59 bytes of serialized `message` JSON per context token**, over 285 pairs.
This is deliberately conservative for the slices below: it includes JSON keys
and punctuation, which tokenize densely, whereas the decision skeleton is mostly
English prose and shell commands at roughly 4 bytes/token. Token figures derived
from 2.59 therefore **over**-estimate, and the costs in `05-option-c…` are
upper bounds.

---

## 3. The decision skeleton

Every option that feeds a run to something — a renderer, a model, a diff — needs
to know how much of the transcript is decision-bearing. Reduce each record to
its act:

- `tool_use` → `DO(name): <digest>` (Bash: first 300 chars of the command; Edit:
  path plus 120 chars each of old/new; Read: path and range; Write: path and size)
- `tool_result` → `GOT:`/`ERR:` plus the first 240 chars
- assistant `text` → `SAY:` in full
- prompt → `[PROMPT nB]` plus the first 400 chars
- compaction → `[COMPACT trigger=… pre=… post=…]`

```
node scripts/skeleton.mjs <transcript>
→ skeleton lines=616 bytes=139089 (3.6% of transcript) tokens@2.59B/tok=53702
→ prose-only lines=22 bytes=7922 tokens@2.59=3059
```

**The decision-bearing content of a 3.84 MB run is 139 KB — 3.6%.** That single
number is why option C is affordable and why option A's per-request walk is
tractable if it is done once rather than per-node.

The prose-only variant — 22 lines, 7.9 KB — is the whole of what run A said
about itself, prompts included. It fits on two screens.

---

## 4. The tree run A actually produces

Grouping by work cycle, then by the file or subject each contiguous run of tool
calls touched, and treating a commit as a terminus. Node counts are exact;
labels are the run's own bytes.

```
run 4c7c4e5c  ·  proposals/ContextControl revision  ·  58 min  ·  $43.51  ·  297 acts

▸ WORK CYCLE 1  (prompt 20.4 KB, 02:05:14)
  │ "I'll start by reading the ground rules and the current state of the proposal."   ← quoted
  ├─ ORIENT            22 Read/Bash  →  CLAUDE.md, proposals/ContextControl/*, docs/agent/
  ├─ ⑂ 20-option-api-context-management.md            [new file]
  │    └─ ✔ commit  "Give the invisible t…"                              ← quoted
  ├─ ⑂ 01-constraints.md                              [3 edits]
  │    └─ ✔ commit  "Audit"                                              ← quoted
  └─ ✖ Bash  node -e '…'  → SyntaxError                    [mechanical, 1 of 5]

▸▸ COMPACTION  #170 · auto · 167,284 → 11,135 tok · 156,149 dropped · 5 records carried
   ⚠ the run below this line could not see the 22 files it read above it

▸ WORK CYCLE 2  (02:29 – 02:41)
  ├─ ⑂ 16-comparison.md + 01-constraints.md           [co-edited, 8 edits]
  │    │ "Now the score table and the sensitivity paragraph:"            ← quoted
  │    └─ ✔ commit
  ├─ ⑂ 09-option-app-driven-compaction.md             [2 edits]
  └─ ✔ commit  "Hold the recommendation, a…"                            ← quoted

▸▸ COMPACTION  #444 · 167,264 → 14,387 · 309,026 cumulative

▸ WORK CYCLE 3  (02:45 – 02:48)
  │ "Two of Option F's stated unknowns are now answerable from the corpus."  ← quoted, and
  │                                                        the only stated reason in the run
  ├─ ⑂ 17-recommendation.md                           [runner-up section rewritten]
  ├─ ⑂ 19-validation.md                               [4 edits + 3 python rewrites]
  └─ ✔ commit  "Record the second pass, its se…"                        ← quoted

▸▸ COMPACTION  #764 · 170,492 → 11,619 · 467,899 cumulative

▸ WORK CYCLE 4
  ├─ ⑂ README.md ×2 (proposal + index)                [python heredoc rewrites]
  └─ ✔ commit  "Retire the PreCompact hook from Phase 0b, and count the fields"  ← quoted

▸▸ COMPACTION  #1139 · 169,820 → 11,311 · 626,408 cumulative

▸ WORK CYCLE 5  (02:59 – 03:01)
  ├─ VERIFY  "Now the citation-resolution check across everything this revision wrote."
  └─ ▣ REPORT  4,873 B  "Thirteen commits, 11 files, +1634 −74…"        ← quoted

   collapsed: 297 acts → 5 cycles · 12 file-branches · 14 commits · 4 seams · 5 errors
```

### What that sketch demonstrates

**The structure is rich.** Five cycles, four seams, twelve file-branches, ten of
which were revisited (a file edited, left, and returned to is the clearest
structural signal of a reconsidered decision in the whole run), fourteen
termini. That is a readable page and it is strictly more than the log tail or
the diff gives.

**The annotations are thin, and honestly so.** Every `← quoted` mark above is a
real byte from the run. There are **thirteen** of them for 297 acts. Every other
node in that tree carries *what* and not *why* — and under C1/C2 it must say so
rather than be filled in.

**The seams carry their own weight.** `⚠ the run below this line could not see
the 22 files it read above it` is not decoration. It is the single most useful
sentence on the page for an operator wondering why cycle 3 re-read a file cycle
1 had already read — and it is derived, exactly, from `preservedMessages.uuids`.

**Nothing here needs a sub-agent expansion**, because run A spawned none. Run B
spawned none either. The corpus's 91 delegating transcripts are host sessions;
under this app's system prompt (`Do not call the AgentTool unless the user
requested it`) agent runs mostly do not delegate — which makes C7 a correctness
constraint rather than a common case.

### What it would cost to annotate every node

139 KB of skeleton = ~53,702 tokens in; a tree this size out is ~6,000 tokens.

| model | in $/MTok | out $/MTok | cost | as % of the run's $43.51 |
|---|---:|---:|---:|---:|
| Haiku 4.5 | 1 | 5 | **$0.084** | 0.19% |
| Sonnet 5 (intro) | 2 | 10 | **$0.167** | 0.38% |
| Sonnet 5 (list) | 3 | 15 | **$0.251** | 0.58% |
| Opus 5 | 5 | 25 | **$0.419** | 0.96% |

```
node scripts/cost.mjs <transcript>
```

Under one percent of the run, at the top of the model range, for a rationale on
every node. That is the number `05-option-c…` has to justify — and, per C1, the
number is not the hard part.
