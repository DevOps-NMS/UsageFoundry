# Validation

Every factual claim in this proposal, with the command or `file:line` that
checks it. Written last, run against the tree at the commit this proposal was
written on.

Three sections: **verified** (checked, reproduces), **corrected** (the brief or
an earlier draft said something the tree contradicts), and **not verified** (a
claim that stands on reasoning rather than measurement, and is flagged in the
option file that makes it).

Environment: this container, `2026-08-28`. Corpus at
`/home/node/.claude/projects`. Repository at
`/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1`, branch
`uf/usagefoundry-721638d11c0b-1-a51ad53a`.

---

## A. Verified

### A1. Thinking blocks are empty for the model this app runs

**Claim** (`00-problem.md` §1): 28,857 empty `thinking` blocks on
`claude-opus-5`, zero non-empty; every record carrying an `effort` field carries
empty thinking.

```
node scripts/thinking-by-model.mjs
→ files=875 records=266362 isSidechain=true → 0
→ claude-opus-5              empty= 28857  non-empty=   0  bytes=0
→ claude-haiku-4-5-20251001  empty=    25  non-empty=  11  bytes=3905
→ claude-sonnet-5            empty=     2  non-empty=   0  bytes=0
→ claude-opus-5 | sdk-cli | xhigh   empty=21244  non-empty=0
→ claude-opus-5 | cli     | xhigh   empty= 7613  non-empty=0
→ claude-sonnet-5 | sdk-cli | xhigh empty=    2  non-empty=0
→ claude-haiku-4-5 | sdk-cli | -    empty=   25  non-empty=11
```

**Status: verified, and the earlier finding is strengthened rather than
repeated.** `proposals/ContextControl/00-problem.md:476-493` measured 13,454
empty / 0 non-empty; `19-validation.md:62` re-confirmed 13,734 over 113,468
records. This pass covers 266,362 records — roughly double — and the
non-empty count on `claude-opus-5` is still zero.

**Caveat recorded in the text.** The corpus grows while it is measured; the
empty count moved 28,805 → 28,857 across two runs of the script twenty minutes
apart, because this session writes to the corpus. The non-empty column did not
move.

**The eleven non-empty blocks are real and do not reopen the design.** All are
`claude-haiku-4-5-20251001`, all in probe sessions of 10–18 records
(`-tmp-committest/73aa8686-…`, `-tmp-uf-probe-work/b8e263aa-…`, seven `"reply
ok"` sessions in this worktree's project dir), all at CLI `2.1.226`, none
carrying an `effort` field. Combined: 3,905 bytes. Located with the per-block
listing in `scripts/thinking-by-model.mjs`'s sibling walk.

### A2. Zero sidechain records corpus-wide

**Claim** (`00-problem.md` §4): 0 records with `isSidechain: true` in 266,362.

```
node scripts/thinking-by-model.mjs   # first line
→ files=875 records=266362 isSidechain=true → 0
```

**Status: verified.** 91 transcripts contain `Task`/`Agent` tool calls (counted
by a walk over `tool_use` names); none contains a sidechain record.

### A3. Sub-agent reports can be `<persisted-output>` stubs

**Claim** (`00-problem.md` §4): a large sub-agent report is replaced in the
parent transcript by a pointer to a file.

Checked against `-Users-hendrikkuehnel-Documents-GIT-UsageFoundry/3b99665e-6a95-53b3-ab99-739b330aa956.jsonl`,
which makes five `Agent` calls:

```
Agent "Explore run UI and API routes"         promptLen=1565  resultLen=45768
Agent "Explore orchestrator run loop"         promptLen=1922  resultLen=40268
Agent "Explore usage windows and reset times" promptLen=1848  resultLen=32564
Agent "Design live-kill and pause/resume"     promptLen=9145  resultLen=2288
   → "<persisted-output>\nOutput too large (52.4KB). Full output saved to: …"
Agent "Design policy model and UI"            promptLen=8566  resultLen=2288
   → "<persisted-output>\nOutput too large (67.8KB). Full output saved to: …"
```

**Status: verified.** Two of five reports are stubs.

### A4. The grounding run's census

**Claim** (`02-…` §1): run A is 1,292 records, 297 tool calls, 210 empty
thinking blocks, 13 assistant text blocks / 5,578 bytes, 0 `TodoWrite`, 4
compaction boundaries, 3,838,145 bytes.

```
node scripts/census.mjs ~/.claude/projects/-workspace--uf-worktrees-usagefoundry-721638d11c0b-1/4c7c4e5c-9581-4e38-8e4a-f73cbe1eec1d.jsonl
node scripts/types.mjs  <same file>
```

**Status: verified.** One number was corrected during writing: an early pass
reported "18 text blocks, 121,932 bytes" because the counter included `user`
records whose `content` is a string — the five SDK prompts, ~20 KB each. The
assistant-only figures are 13 blocks / 5,578 bytes, and 12 blocks / 5,553 bytes
at the ≥40-character threshold. `scripts/census.mjs` still reports the combined
figure under `textBlocks`; the assistant-only figures come from a separate
type-filtered pass and are the ones quoted throughout.

Record types (`scripts/types.mjs`): `assistant` 520, `user` 302, `attachment`
369, `last-prompt` 95, `system` 4, `queue-operation` 2 = 1,292.

Of the 302 `user` records, 297 carry a `tool_result` and 5 are SDK prompts with
string content and `promptSource: "sdk"` → **five work cycles**.

### A5. Dangling parent pointers: zero

**Claim** (`02-…` §1): 102 null `parentUuid` in run A, 296 in run B, and **zero**
non-null parents that fail to resolve in-file.

`scripts/census.mjs` second pass. **Status: verified** for both runs. The graph
is severed at known points, not corrupt.

### A6. Compaction boundaries carry a resolvable `logicalParentUuid`

**Claim** (`00-problem.md` §6, `02-…` §1): four boundaries in run A, all
`trigger: "auto"`, `logicalParentUuid` resolves 4/4, `preTokens` 167,284 /
167,264 / 170,492 / 169,820, `cumulativeDroppedTokens` 156,149 / 309,026 /
467,899 / 626,408, each carrying `preservedMessages.uuids`.

```
node scripts/seams.mjs <transcript>
```

**Status: verified.** Also verified: `parentUuid` is `null` at all four
boundaries, which is why the naive chain fragments.

### A7. Tool composition and the five errors

**Claim** (`02-…` §1): run A is Bash 192 / Read 52 / Edit 48 / Write 5; 292
successes, 5 errors, all Bash, all mechanical. Run B is Edit 239 / Bash 98 /
WebSearch 77 / Read 55 / WebFetch 13 / ToolSearch 1 / Write 1.

```
node scripts/decisions.mjs <transcript>
```

**Status: verified.** The five errors, with their commands and result heads, are
listed in that script's output; each is a shell typo (`ls` flag, `node -e`
syntax, `grep` exit 2, a `git add` on a non-existent path, a missing node
module). The claim that reading them as "rejected alternatives" would be wrong
five times out of five is an interpretation of verified data, not a measurement.

### A8. Fourteen commits, with messages in `tool_use.input.command`

**Claim** (`02-…` §1, `10-recommendation.md`): 14 `git commit` invocations,
eleven using `git commit -F - <<'EOF'`.

`scripts/decisions.mjs` extracts them. **Status: verified** — the count is 14 and
the listed subjects (`Audit`, `Give the invisible t…`, `Hold the recommendation,
a…`, `Record the second pass, its se…`, `Retire the PreCompact hook from Phase
0b, and count the fields`) are the run's own bytes. The heredoc count of eleven
is by inspection of the extracted commands.

### A9. The twelve prose blocks

**Claim** (`02-…` §1): the twelve assistant text blocks over 40 characters,
their timestamps and byte lengths, eleven of which total 680 bytes and one of
which is the 4,873-byte final report.

`scripts/decisions.mjs` prints them verbatim. **Status: verified, after a
correction.** The script's `len` column is `text.length` — UTF-16 code units —
while the census sums `Buffer.byteLength`. For the eleven narration blocks the
two agree (pure ASCII): 77+71+49+50+53+87+50+55+54+62+72 = **680**. The report
is 4,821 characters and **4,873 bytes**; the 52-byte gap is its em-dashes and
box-drawing characters. 680 + 4,873 = 5,553 = the ≥40 byte total. An earlier
draft subtracted characters from bytes and reported 732; corrected throughout.

### A10. The attachment histogram

**Claim** (`02-…` §1): 369 attachments — `budget_usd` 290, `task_reminder` 29,
`compact_file_reference` 15, `deferred_tools_delta` 10, `hook_success` 5,
`agent_listing_delta` 5, `mcp_instructions_delta` 5, `file` 5, `nested_memory` 2,
`edited_text_file` 2, `skill_listing` 1.

```
node scripts/seams.mjs <transcript>   # "attachment kinds:"
```

**Status: verified.** Sums to 369.

### A11. The run's cost, and the reconstruction's

**Claim** (`02-…` §1 and §4, `05-option-c…`): run A cost **$43.51** at Opus 5
list rates; a reconstruction pass costs $0.0837 (Haiku 4.5) to $0.4185 (Opus 5),
0.19%–0.96% of the run.

```
node scripts/cost.mjs <transcript>
→ assistant requests 520 · input_tokens 1040 · cache_creation 1278150
→ cache_read 53184875 · output_tokens 356961 · peak request context 166798
→ run cost @ opus-5  $43.51
→ skeleton lines 616 · bytes 139089 (3.6% of transcript) · tokens 53702 @ 2.59 B/tok
→ haiku-4.5 $0.0837 (0.19%) · sonnet-5 intro $0.1674 (0.38%)
→ sonnet-5 list $0.2511 (0.58%) · opus-5 $0.4185 (0.96%)
```

**Status: verified**, with three inputs to the arithmetic that are assumptions
rather than measurements and are labelled as such in the text:

- **Rates.** Opus 5 $5/$25, Sonnet 5 $3/$15 (intro $2/$10 through 2026-08-31),
  Haiku 4.5 $1/$5 per MTok; cache writes 1.25×, reads 0.1×. Confirmed against
  the `claude-api` skill's current model table. Today is 2026-08-28, so the
  Sonnet 5 intro rate is still live for three more days — both figures are given.
- **Output size.** 6,000 tokens for an annotated 15-node tree. An estimate.
  Halving or doubling it moves the Opus 5 figure to $0.34 / $0.57 — the
  conclusion ("under 1% of the run") survives either way.
- **Bytes per token.** 2.59, calibrated below.

### A12. The bytes-per-token calibration

**Claim** (`02-…` §2): 2.59 bytes of serialized `message` JSON per context
token, over 285 consecutive-assistant pairs, and it over-counts prose.

```
node scripts/calib.mjs <transcript>
→ calibration pairs=285 tokens=506847 messageBytes=1311491 bytesPerToken=2.59
```

**Status: verified as a measurement; the "over-counts prose" claim is
reasoning.** The method: for each consecutive pair of assistant records with no
compaction between them, the growth in `input + cache_read + cache_creation` is
the token cost of the intervening records, whose serialized bytes are known.
Pairs with non-positive or >100k deltas are dropped. The ratio includes JSON keys
and punctuation; English prose runs nearer 4 bytes/token, so token counts derived
from 2.59 for a prose-heavy slice are upper bounds — which is the conservative
direction for every cost figure in this proposal.

### A13. The decision skeleton is 3.6% of the transcript

**Claim** (`02-…` §3): 616 lines, 139,089 bytes.

```
node scripts/skeleton.mjs <transcript>
→ skeleton lines=616 bytes=139089 (3.6% of transcript) tokens@2.59B/tok=53702
→ prose-only lines=22 bytes=7922 tokens@2.59=3059
```

**Status: verified.** The definition of "decision-bearing" is a design choice
(digest lengths of 300 / 240 / 400 characters) and is stated in the text; the
byte counts follow from it deterministically.

### A14. Code anchors

Every `file:line` cited in this proposal, checked against the tree:

| claim | anchor | status |
|---|---|---|
| `runs.session_id` exists | `addColumn(db, "runs", "session_id", "TEXT")` — `src/lib/db.ts:744` | ✔ |
| `run_events` schema | `src/lib/db.ts:167-173` — `(id, run_id, ts, kind, payload)`, `ON DELETE CASCADE` on `runs(id)` | ✔ |
| `resolveSessionTranscript` | `src/lib/transcripts.ts:1062`; returns `null` unless exactly one basename matches | ✔ |
| `RunEventDTO["kind"]` union | `src/lib/apiTypes.ts:1711` — `status \| log \| assistant \| subagent \| tool \| tool_error \| sandbox \| iteration \| budget \| result \| handoff \| land \| review \| error \| replay-complete` | ✔ |
| kinds emitted by the stdout parser | `src/lib/orchestrator.ts` — `tool` :7483/:7659/:7671, `assistant` :7565/:7640, `subagent` :7620, `tool_error` :7720, `sandbox` :7737, `result` :7750/:7812, `iteration` :8501, `handoff` :2943 | ✔ |
| `emit` | `src/lib/orchestrator.ts:608`, exported as `emitRunEvent` `:783` | ✔ |
| `runTasks` | `src/lib/runTasks.ts:189` — `runTasks(events: readonly RunEventDTO[]): RunTask[]`; `RunTaskState` :39, `RunTask` :46 | ✔ |
| tab strip | `src/app/runs/[id]/page.tsx:415` — `type RunTab = "log" \| "report" \| "changes" \| "review" \| "land"`; used :474, :703, :958 | ✔ |
| `parseToolRecord` / `buildToolComposition` | `src/lib/toolComposition.ts:124` / `:256`; `ToolCall` :53, `ToolResultSize` :65, `ToolRecord` :71, `ToolCompositionRow` :170, `ToolComposition` :195 | ✔ |
| `autoLayout` signature | `src/lib/canvasGraph.ts:149` — `(blocks: readonly {id}[], links: readonly {from, to}[]) => Map<string, Point>`; `resolveLayout` :228, `layoutBounds` :243, `edgeGeometry` :283 | ✔ |
| `forceLayout` is a force simulation | `src/lib/forceLayout.ts` — `createSimulation` :151, `buildQuadtree` :224, `step` :436, `ALPHA_DECAY` :96 | ✔ |
| `expiredTranscripts` is pure | `src/lib/retention.ts:554`; `retentionCutoff` :107 returns `null` for "keep all"; `DAY_MS` :58; `MAX_TRANSCRIPT_FILES` :574 | ✔ |
| `forgetTranscriptFiles` is imported by retention | `src/lib/retention.ts:17` | ✔ |

### A15. `autoLayout` is reusable unchanged

**Claim** (`01-constraints.md` C11, `10-recommendation.md`): a decision tree is
`{id}[]` plus `{from, to}[]`, which is exactly `autoLayout`'s signature.

```
src/lib/canvasGraph.ts:149-152
  export function autoLayout(
    blocks: readonly { id: string }[],
    links: readonly { from: string; to: string }[],
  ): Map<string, Point>
```

**Status: verified as a type claim.** Whether the *layered* placement it produces
reads well for a five-cycle tree is a rendering judgement, not a fact, and is not
claimed as verified.

### A16. The weighted comparison arithmetic

**Claim** (`09-comparison.md` §4): base totals A=118, B=132, C=118, D=146,
E=153, and four sensitivity runs.

```
node scripts/score.mjs
→ base                                A=118  B=132  C=118  D=146  E=153   → E
→ "retroactive coverage" → weight 2   A=108  B=124  C=110  D=144  E=143   → D
→ "density" → 5, "risk" → 3           A=110  B=124  C=119  D=142  E=145   → E
→ fleet delegates heavily             A=115  B=129  C=115  D=146  E=153   → E
→ retention horizon off (weight 0)    A=114  B=112  C= 98  D=126  E=133   → E
```

**Status: arithmetic verified; the scores themselves are judgements.** An earlier
draft asserted totals (125/135/119/139/150) that were simply wrong — computed by
hand and not checked. `scripts/score.mjs` exists so this cannot recur, and so the
operator can re-weight and re-run rather than argue with a table.

---

## B. Corrected

### B1. The two named runs are not in this container

**The brief named** `83bed426-a595-492d-a21e-43b74b335f01` (winnow) and
`fc491479-5fc3-4b9b-8952-c8431ee04b5b` (UsageFoundry) as the runs to ground on.

```
$ node -e '… new DatabaseSync(".data/usagefoundry.db") … SELECT count(*) FROM runs'
{ c: 0 }
$ … .next/standalone/.data/usagefoundry.db …
{ c: 0 }
$ grep -rl "83bed426-…" ~/.claude/projects   # → 2 files, both prompts naming the id
$ grep -rl "fc491479-…" ~/.claude/projects   # → 4 files, all prompts naming the id
$ find ~/.claude/projects -name '83bed426*' -o -name 'fc491479*'   # → nothing
```

Both SQLite databases in the image are schema-only (`runs` has 46 columns, zero
rows), including after copying the `-wal`/`-shm` sidecars. The two ids appear on
disk only inside prompt text — this session's, a sibling agent's, and two host
sessions where the operator discussed them. A run id is not a session id, and
`runs.session_id` (`src/lib/db.ts:744`) is the only mapping between them, so
without the row there is no path to a transcript.

**Correction applied:** the proposal grounds on
`4c7c4e5c-9581-4e38-8e4a-f73cbe1eec1d`, a real UsageFoundry-spawned
(`entrypoint: sdk-cli`, `claude-opus-5`, `effort: xhigh`) agent run against this
repository's own worktree lineage, with `b51351ba-571a-4ed0-a752-b466d4b63e39`
as a contrasting second run. Recorded in `02-…` §0.

### B2. `src/lib/retentionSweep.ts` does not exist

**The brief named** `src/lib/retention.ts` and `src/lib/retentionSweep.ts`.

```
$ ls src/lib/retentionSweep.ts
ls: cannot access 'src/lib/retentionSweep.ts': No such file or directory
```

Both halves live in `retention.ts`: the pure decision (`expiredTranscripts`
:554) and the sweep below it. `docs/agent/retention.md` is the routing doc.
**Correction applied** in `00-problem.md` §7.

### B3. `proposals/IntakeFilter/` does not exist

**The brief named** `proposals/ContextControl/` and `proposals/IntakeFilter/` as
the structural models to match.

```
$ ls proposals/
ContextControl  ContinuousImprovement  CustomStacks  ExternalValidator
GapRegister  GrowthLimits  ModelRouter  OperatorInterface  OperatorQuestions
README.md  SessionFlow  implemented - Sandboxing  implemented - UnattendedOperation
```

No `IntakeFilter`. **Correction applied:** this proposal follows
`proposals/ContextControl/`'s convention (README index, `00-problem`,
`01-constraints`, numbered options, comparison, recommendation, validation) with
`proposals/OperatorInterface/`'s precedent for shipping a measurement script
beside the prose (`contrast.py` there, `scripts/` here).

### B4. `src/lib/pricing.ts` does not exist

An early draft cited it for the model rates. It is not a file in this tree; the
rates used are the Anthropic list prices confirmed against the `claude-api`
skill's current model table, and they are stated inline in `scripts/cost.mjs`
rather than imported. **Correction applied** — `02-…` §1 no longer cites a repo
path for the rates.

### B5. The "18 text blocks / 121,932 bytes" figure was wrong

An early census counted `user` records with string content — the five ~20 KB SDK
prompts — as text blocks. The assistant-only figures are **13 blocks / 5,578
bytes**. Every prose claim in the proposal uses the corrected figure.
**Correction applied**; noted in A4.

### B6. The weighted totals in the first draft of `09-comparison.md` were wrong

125/135/119/139/150 asserted; 118/132/118/146/153 correct. The ranking's top two
were unaffected but the C-vs-A relationship changed (C ties A rather than
beating it) and the sensitivity numbers all moved. **Correction applied**, and
`scripts/score.mjs` added so the table is executable. Noted in A16.

---

## C. Not verified

Claims that stand on reasoning, on a single observation, or on something this
container cannot test. Each is flagged in the option file that relies on it.

### C1. That the appended prompt reaches sub-agents (Option D)

`06-option-d…` claims a delegated agent's `⟦decision⟧` markers would reach
`run_events` via the `subagent` kind. **Not verified.** It depends on how
`src/lib/agents.ts` composes the appended system prompt and what the Claude Agent
SDK propagates to a `Task`/`Agent` child — neither of which was traced, and
neither of which can be tested here without spawning a billed run. It is one of
Option D's two best properties and it is a hypothesis. `10-recommendation.md`
phase 3 exists partly to test it.

### C2. That commit messages are recoverable from `run_events` alone (Option E)

`07-option-e…` flags this as the option's sharpest open question. `run_events`
rows carry a `payload` extracted by the stdout parser, not `tool_use.input`.
Whether a `tool` row for a `git commit -F - <<'EOF'` invocation retains the
message body was **not verified** — the database in this container has zero
`run_events` rows, so there is no sample to inspect, and reading the parser's
payload construction at `orchestrator.ts:7483–7671` was not done in enough depth
to claim an answer. If the answer is no, Option E either reads the transcript for
that one field or loses the densest `why` in the run.

### C3. That a resumed run's transcript is detectable from its own contents

`03-option-a…` claims a resumed transcript is recognisable because its early
records replay a history whose `sessionId` differs from the filename. **Inferred
from the duplicate-pair evidence, not directly checked.** The pairs
(`00ffb053…`/`db276def-3f4a-50ed…` at 1,544 records / 252 tool calls;
`62086ee2-e9e3-5f1d…`/`717c455d…` at 1,161/248;
`b2baed45-8727-50ee…`/`d01c0434…` at 1,138/258) are verified — identical counts,
one member of each pair carrying a version-5 UUID marker. The mechanism producing
them, and whether the per-record `sessionId` differs from the filename inside
one, was not inspected record by record.

### C4. The build estimates

1–2 days (E), 2–3 (A), 3–5 (B), 4–6 (D), 8–12 (C). **Judgement**, informed by
line counts of the analogous modules (`runTasks.ts` is 200-odd lines for the same
shape of fold; `canvasGraph.ts` and the existing canvas components set the
rendering scale). Not measured, and the C estimate is the least reliable because
most of its risk is in a prompt.

### C5. That Option D changes what runs decide

`06-option-d…` raises this as the main objection to the approach and explicitly
declines to quantify it. Nothing here measures it, and nothing could without
running paired runs with and without the instruction.

### C6. The per-request CPU cost of Option A's walk

`03-option-a…` says "on the order of 40–80 ms" for a 3.84 MB, 1,292-record
JSON-lines parse. **Not benchmarked.** It is a plausible figure for Node parsing
that volume, and the argument it supports (C3: do not put an unbounded parse in
front of the Land button) does not depend on the exact number.

### C7. Whether the provenance rendering actually works

`08-marking-inference.md` proposes an acceptance test — show an operator a tree
with one fabricated rationale; can they find it? — and it has **not been run**.
The recommendation to defer Option C rests partly on the assumption that it would
be hard to pass. That assumption is untested and the test is cheap.

---

## D. How to re-run everything

```
cd proposals/RunDecisionTree
T=~/.claude/projects/-workspace--uf-worktrees-usagefoundry-721638d11c0b-1/4c7c4e5c-9581-4e38-8e4a-f73cbe1eec1d.jsonl

node scripts/thinking-by-model.mjs     # A1, A2
node scripts/census.mjs "$T"           # A4, A5
node scripts/types.mjs "$T"            # A4
node scripts/seams.mjs "$T"            # A6, A10
node scripts/decisions.mjs "$T"        # A7, A8, A9
node scripts/calib.mjs "$T"            # A12
node scripts/skeleton.mjs "$T"         # A13
node scripts/cost.mjs "$T"             # A11
node scripts/score.mjs                 # A16
```

All scripts are dependency-free Node ≥ 20 and read-only. The one exception is
opt-in: `SKELETON_OUT=/tmp/skel.txt node scripts/skeleton.mjs "$T"` writes the
skeleton to that path, and writes nothing without it.
