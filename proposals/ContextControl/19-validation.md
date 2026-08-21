# Validation

A pass over the nineteen files before this one, on 2026-08-21, from inside a live
work cycle on the install they were written on and against the same tree. Every
`path/file.ts:42` in `00-` through `18-` was resolved **mechanically** and the
line it lands on was read; every measurement in `00-problem.md` was re-run
through the same compiled `src/lib/` rather than re-derived; and — unlike
`proposals/ModelRouter/15-validation.md`, which explicitly did not — **this pass
opened the pinned CLI and re-ran the load-bearing probes in
`02-levers-on-the-pin.md`** against a recorder of its own.

**The recommendation stands as written, and the one finding that moved a number
in an option's favour moved it in the runner-up's.** Option H's break-even was
out by a factor of four in the wrong direction — a delegation pays for its own
prefix at two-thirds of one mean-sized read rather than at three — which is why
`17-recommendation.md` names H as the runner-up rather than as a curiosity, and
why the thing that would promote it is a billed experiment rather than an
argument.

Counts across the nineteen files: **thirty-nine claims opened and confirmed**,
**eight refuted**, **ten unverifiable from here**. All eight refutations were
corrected in place before this file was written; this file records what they
were rather than leaving them for a reader to rediscover.

The compile and the reference resolver are two commands:

    $ node_modules/.bin/tsc -p tsconfig.test.json --outDir "$TMPDIR/ctxctl-close-721638d11c0b-1/build"
    (exit 0)

    $ node refs.js .          # every `path:NNN` and every bare `:NNN`, chained
                              # off the last full path cited before it
    total refs 961, unresolvable 4

Three of the four are `01:22`–`28` and `01:32`, cited from sibling files in this
directory, which the resolver looks for at the repository root; both were checked
by hand and are correct — `01:22`–`28` is the `P`/`S`/`D` derivation and `01:32`
is `T* = 19·(S / D) − 20`. The fourth is the house rule's own exemplar, quoted in
the first paragraph of this file.

---

## Verdict table

Refuted first.

| # | Claim | Where | Verdict | Evidence |
|---|---|---|---|---|
| 1 | Fifty bare `` `:NNNN` `` references resolve against the file cited before them | throughout `00`–`15` | **refuted** (unresolvable as written) | Mechanical resolution of all 775 citations put fifty outside their anchor file's line count. In `00-problem.md` the `--plugin-dir` bullet's two bare numbers chained off `src/lib/plugins.ts`, which has 372 lines; the session-lifecycle paragraph's five chained off `src/lib/settings.ts`, which has 822; the resume-failure paragraph's four chained off `docs/agent/retention.md`, which has 19. Five option files chained `orchestrator.ts` line numbers off a sibling proposal file. Every one of the fifty is a four-digit `orchestrator.ts` line, and every anchor is something else. **This is `proposals/ModelRouter/15-validation.md`'s finding #5 recurring in a new survey**, and commit `6b794f4` on this branch claims to have fixed the class. Fifteen chain starts now name their file and the rest chain correctly off those. |
| 2 | An `--agents` member "named on `--agent` … fails the spawn outright" (`docs/agent/agents-and-templates.md:12`, `docs/agent/architecture.md:131`) | `01:261` | **refuted** (attribution) | The claim is true and the first citation carries the whole of it. `docs/agent/architecture.md:131` is the four-kinds-of-agent-child paragraph and says nothing about registration. **This is that pass's finding #3 recurring at a different line, in a different proposal.** Corrected, with the mis-citation named rather than deleted. |
| 3 | "a delegation has to displace about three mean-sized reads before it breaks even" | `11:126` | **refuted** (arithmetic) | It divides the sub-agent's fixed prefix by the *delegated cost* of a read rather than by the *saving*. Measured directly rather than derived: the sub-agent's tool block is **42,813 bytes for 10 definitions** beside the parent's 109,992 for 28, plus a 3,769-byte system prompt — 46,582 B ≈ 11,646 tokens, $0.073 at 1.25×, against $0.112 saved per mean-sized read moved. **0.65 reads, not three.** Corrected, and it runs in Option H's favour. |
| 4 | `--autocompact`'s range error, quoted | `02:240` | **refuted** (quotation) | Re-run on the pin, the message ends `… between 100k and 1M (e.g. 500k, 200000, or 200 as shorthand)`. The quote stopped at "1M" without an ellipsis, and the elided tail says the flag takes `200` as shorthand for 200k. Corrected, both invocations, verbatim. |
| 5 | The file-read cap's paging instruction, quoted as `[… truncated. Use offset=516 and limit=516 …]` | `02:344` and `15:98` | **refuted** (quotation) | The CLI emits `[Truncated: PARTIAL view — <path>: showing lines 1-387 of 1217 total (21329 tokens, cap 8000). Call Read with offset=388 limit=387 for the next page, or Grep …]`, wrapped in a `<system-reminder>`. The tail from "for the next page" is verbatim; the head is not, and the real head names the token count and the cap. Corrected in both files. |
| 6 | "tools 111,472B … 28 tool definitions" | `02:458`, and `12:107`'s $8.26/week derived from it | **refuted** (not reproducible) | The same 28 tools re-measure at **109,800 bytes** on the same pin in a different scratch directory — 1.5% smaller. The per-tool standing cost is therefore good to about 2% and not better: $8.14 to $8.26 a week. Corrected in both, with a sentence saying the block is not a constant. |
| 7 | `claude -p "hi" --exclude-dynamic-system-prompt-sections` → `Terminated`, `exit=143` | `14:227` | **refuted** (not reproducible) | Re-runs as `Execution error` and `exit=124`, which is `timeout`'s own code for a child it killed. The material claim — the flag parses rather than being refused, where `--not-a-real-flag` exits 1 at the parser — reproduces exactly and is unaffected. Corrected. |
| 8 | "`grep -c system-reminder` over a container transcript returns 0" | `00:883` and `00:1320` | **refuted as written** | 33 of this container's 604 transcripts contain the string, every one because an agent grepped for it and the tool call went into the file — **this proposal's own measurement runs among them**. The transcript the claim cites, `6a2ccabb-…`, still returns 0 for both `system-reminder` and `claudeMd`. Corrected by naming the file and saying why it has to be named. |
| 9 | 62.1% cache reads and 20.9% one-hour writes; 82.3% of the week is carried context | `00:54` and `00:84` | confirmed | Re-run: `turns 26254 actual $3597.71`, `cacheRead 62.1% cacheWrite1h 20.0%` — 82.1%. The window slid by hours; the shape is identical. |
| 10 | Every main-thread turn writes a 1h cache and never a 5m; every delegated turn the reverse; zero exceptions | `00:627`–`629` | confirmed | `main-thread turns with any 5m write: 0 | delegated turns with any 1h write: 0 | of 26254 turns`. Still zero, in a window 60 turns larger. |
| 11 | Carried context explains session cost at r² = 0.935; 14.0× spread; 3.4× at fixed length; 9.3× per turn | `00:1011`–`1019` | confirmed | Every figure identical to three decimals, on 184 sessions rather than 181. |
| 12 | Tool results are 64.2% of a conversation; `Read` is 72.1% of tool-result bytes; the largest 10% hold 72.2% | `00:320`–`345` and `00:383`–`399` | confirmed | 64.3% / 71.8% / 72.2% over a 40-file set that has itself moved. `p50 288 p99 42120 max 602196` against `278 / 41227 / 602196`. |
| 13 | 39.5% of `Read` bytes belong to files never named again; 31.2% later edited | `00:463`–`466` | confirmed | 39.3% and 30.3%, over 1,257 `Read` results against 1,259. |
| 14 | Verbatim re-reads are 0.3% of tool-result bytes | `00:402` | confirmed | `64188 = 0.3%`, byte-identical. |
| 15 | 13,454 thinking blocks, not one carrying its text | `00:491` | confirmed | `empty 13734 non-empty 0 non-empty bytes 0` over 113,468 records. |
| 16 | `records 111845 compaction markers {}` | `00:1346` | confirmed | `records 113468 compaction markers {}`. The set is still empty. |
| 17 | 0.374 tokens per visible byte; median intercept 31,575 tokens of invisible prefix | `00:563`–`566` | confirmed | `0.3743 => bytes/token 2.67`, intercept median 31,373, all three quartiles within a rounding. |
| 18 | The five-repository `CLAUDE.md` table, r² = 0.165, and VisualMerge's 27 KB producing a smaller prefix than UsageFoundry's 15 KB | `00:1268`–`1274` | confirmed | Every row within a rounding; r² = 0.166. The inversion holds. |
| 19 | A UsageFoundry opening writes a median 42,380 tokens of prefix, p90 92,085, max 132,919, over 261 openings | `00:1300` | confirmed | 42,189 / 91,074 / 132,919 over 264. |
| 20 | `nextPrompt` at the shipped defaults: eight strings and four outputs | `00:1142`–`1157` | confirmed **to the byte** | All twelve figures reproduce exactly, including 1,096 / 443 / 639 / 136 / 536 / 199 / 679 / 364 and the 19,927-byte ten-cycle total. |
| 21 | 79 of 108 handovers re-wrote, $183.69, median 231,644 tok / $2.32, max $4.38 | `00:756`–`760` | confirmed | 72 of 99, $173.95, median 238,624 / $2.39, **max $4.38 identical**. Session openings 122 / $87.84 against 133 / $95.74. |
| 22 | A fresh opening costs $0.294; a resumed continuation $1.923; a re-writing one $2.335; a hit $0.165 | `00:944`–`947` | confirmed | $0.286 / $1.962 / $2.398 / $0.171. The ratio the file leads on — a resumed handover against a fresh opening — moves from 6.5× to 6.9×. |
| 23 | 174 sidecar files, 81.7 MB of tool output kept out of context | `00:1328` | confirmed | 179 files, 82,097,390 bytes. |
| 24 | Delegated turns are 6.5% of the container's bill; $0.163 a turn against $0.060 | `02:398`–`400` and `11:42` | confirmed | 6.5%; $0.164 against $0.060; **the sidechain total $188.03 is identical to the cent**. 517 main-thread and 510 sub-agent transcript files against 513 and 495. |
| 25 | The pin is `2.1.226 (Claude Code)` at `/usr/local/lib/…/bin/claude.exe`, unauthenticated, with the credential a device node | `02:11`–`35` | confirmed | All four outputs reproduce; `claude auth status` is pretty-printed rather than one line, which is a formatting difference and not a content one. |
| 26 | The `gitStatus` mutation probe: `system identical: False`, `sys[2]` grows, `tools identical: True`, `first user message` block2 changes | `02:426`–`448` | confirmed **by independent re-run** | A fresh recorder, a fresh scratch repository, the same two-cycle shape: `sys[2] 27750B -> 27787B` with the same four diff lines (`-?? uncommitted-before.txt`, `+M CLAUDE.md`, `+?? uncommitted-after.txt`, `+<sha> a cycle committed`), `tools identical: True`, `block2: 680B -> 715B identical=False`, `block3` identical. |
| 27 | The request carries exactly three `cache_control` marks and no `ttl` | `02:457`–`469` | confirmed, **and sharper than claimed** | Three on both cycles. On the *resumed* request the third moves from `msg0.3` to the newest user message, so the first user message carries **no breakpoint at all** — which makes `14-option-move-the-volatile-prefix.md`'s "still ahead of the entire conversation" stronger, not weaker. |
| 28 | `--exclude-dynamic-system-prompt-sections` makes the system block identical across a handover | `02:487`–`503` | confirmed | `system identical c1->c2: True`, `'gitStatus' in system: False`, `sys[2]` 27,750 → 26,802 (−948 against the claimed −897), and `msg0.0`/`msg0.1` — 6,780 bytes against the claimed 6,754 — now stay matched. |
| 29 | `--autocompact` is clamped to `min(asked, window) − 20,000` | `02:253`–`258` | confirmed **verbatim** | `autocompact: tokens=[REDACTED] level=ok effectiveWindow=80000` and `…=180000`, reproduced character for character — with the method sharpened: under `--output-format stream-json` the line is only reachable through `--debug-file`, not a bare `--debug`. |
| 30 | A `PostToolUse` hook can *replace* a tool's output before the model sees it | `02:134`–`143` | confirmed **verbatim** | Against a file whose contents are `canary-line-from-disk`, the model received `"1\tHOOK-REPLACED-THE-FILE-CONTENTS"` — the same string `02-` quotes, from a hook script written from scratch. |
| 31 | Hooks on `--settings` survive `--resume`; hooks on `--plugin-dir` do not, silently | `02:183`–`219` | confirmed | Three cycles of one session: the `--settings` hook fired 3 times, the plugin hook 2, and cycle 3 without the flag exited 0 with nothing on stderr. **`--plugin-dir`'s docblock (`src/lib/orchestrator.ts:4828`–`:4831`) is now confirmed on the pin twice by two runs.** |
| 32 | `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` shortens a large `Read` and appends a paging instruction | `02:336` | confirmed, **with a mechanism nobody had named** | 88,988 → 28,394 chars on an 84,010-byte file. And the cap is enforced against a `/v1/messages/count_tokens` **answer**: with a recorder returning a fixed 1,000 for every such call it did not fire at 1,000, 2,000 or 8,000. See "Also found". |
| 33 | A `Read` above some size is refused outright with a ~199-character result | `02:358`–`364` | confirmed, **and it names its own ceiling** | 197 characters: "File content (392.6KB) exceeds maximum allowed size (256KB)…". **256 KB is the hard ceiling on what one `Read` can put in a conversation**, which the original quote elided. |
| 34 | A delegated turn's context is entirely separate: fewer tools, a fraction of the system prompt, no parent history, parent prefix unchanged | `02:371`–`382` | confirmed | `req-001 main tools 28 system 27,573B msgs 1`; `req-002 agent tools 10 system 3,769B msgs 1`; `req-003 main … sysSha unchanged`. The tool and byte counts differ from `02-`'s because a different agent type was delegated to — `02-` does not say which, and this pass used `Explore`, whose system prompt opens "You are a file search specialist…". Every structural claim holds. |
| 35 | The CLI makes an unbilled `count_tokens` call over a large tool result | `02:533`–`536` | confirmed | One per large `Read`, on `/v1/messages/count_tokens?beta=true`. |
| 36 | `context_management` is on every request as `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` | `02:543`–`546` | confirmed | Present on all four requests of both mutation probes. |
| 37 | Seven context-shaping environment variables are "present in the binary" | `02:332`–`339` and `15:56`–`63` | confirmed | `grep -c -a` over `bin/claude.exe` returns 6 to 16 hits for each of `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `DISABLE_AUTO_COMPACT`, plus `DISABLE_COMPACT`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and the four sub-agent keys. |
| 38 | `Bash` cannot run inside this agent's sandbox, so `BASH_MAX_OUTPUT_LENGTH` is *could not establish* | `02:338` | confirmed | Attempted rather than assumed: a scripted `Bash` call in a probe child returned `Sandbox is required but failed to initialize: EPERM: operation not permitted, listen '/tmp/claude-1000/srt-mux-17-1.sock'`. The verdict stands and now stands on a re-run. |
| 39 | `CLAUDE.md` is 15,172 bytes; there is no tokenizer in this container | `00:1207` and `00:505` | confirmed | `wc -c` and `ls node_modules | grep -i token` (no output). |
| 40 | `childEnv` strips exactly six classes | `09:59`–`63` and `15:24`–`27` | confirmed **verbatim** | `src/lib/orchestrator.ts:5216`–`:5231` lists `UF_*`, `OTEL_*`, `ANTHROPIC_ADMIN_KEY`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `DATA_DIR`, `NODE_OPTIONS` and nothing else. |
| 41 | `--max-budget-usd` is `max(0, maxRunCostUSD − spentGuardUSD)`, derived per cycle | `01:112`–`116` and eight options | confirmed | `src/lib/orchestrator.ts:4881` is the expression verbatim, inside the `!== null` guard at `:4880`. |
| 42 | The check order is terminus, cycles, duration, run spend, run tokens, weekly, session — at seven named lines | `01:117`–`119` and every option file | confirmed | `block("no_terminus")` at `:495`–`:496`, `iterations` `:506`–`:507`, `duration` `:518`, `run_cost` `:525`, `run_tokens` `:532`, `weekly_fraction` `:551`, `session_fraction` `:582`. All seven land on the code they claim. |
| 43 | The `COMPLETION_NOTICE` docblock records 92 runs costing $162 | `01:149`, `05:141`–`144` and `09:169` | confirmed **verbatim** | `src/lib/orchestrator.ts:4445`, inside the block at `:4433`–`:4446`, and it carries three further figures the survey does not use. |
| 44 | `SELF_HOSTING_NOTICE`'s docblock records two runs killed by a literal, with dates and run ids | `05:158`–`166` | confirmed **verbatim** | `src/lib/orchestrator.ts:4719`–`:4737`, including `b81e7c70`, `9b98ddec`, 2026-08-15 23:39:42, "exited with code 143", the 2026-08-16 repeat and "the mechanism is stated rather than the conclusion". |
| 45 | `BudgetMeter` already carries a `tokens` unit | `10:33`–`34` | confirmed | `src/lib/budget.ts:131`–`:136`, `unit: "fraction" | "usd" | "tokens" | "count" | "minutes"`. |
| 46 | Every arithmetic chain in `01-`, `05-`, `06-`, `08-`, `12-`, `13-` and `14-` | throughout | confirmed by recomputation | `T*` at 18 / 170 turns and the $0.96 / $1.81 pair; $4.28 a week for `SELF_HOSTING_NOTICE` and $0.06 a cycle; the $84 chain (0.393 × 0.718 × 0.643 × 0.668 × 0.419 = 5.1%); the $213 and $93 ceilings; $8.26 per tool definition and the 60-substitution break-even; the four-block netting at $1.70 against $7.02; and `14-`'s $1.44 / $5.02 pair. All reproduce. |
| 47 | `03-experiment-resumed-vs-fresh.md`'s internal arithmetic | `03:211`–`235` | confirmed by recomputation, **not by re-observation** | 877,712 / 852,232 / 2,271,316 all follow from the quoted byte counts; 2.9% and 2.59× follow from those; the 3.06 weighted bytes per byte of file and the 3,900-byte break-even both follow. **The bytes themselves could not be re-observed** — see "Unverifiable". |

---

## The measurements, re-run

Same procedure as `00-problem.md`: compile `src/lib/` and call the app's own
functions rather than write arithmetic for this document. **Nothing below
reproduces to the last digit and the reason is `00-problem.md`'s own opening
paragraph** — the window slides and the corpus grows while it is being read.
Every figure moved by hours' worth of traffic and none moved in a way that
changes a conclusion.

The two that moved most, and why neither matters:

**The handover count fell from 108 to 99 and the total from $183.69 to
$173.95**, because the rolling week's leading edge dropped nine handovers and
picked up fewer. The *split* — 27% hitting, 73% re-writing — is unchanged to a
tenth of a point, and the maximum single handover, $4.38, is the same turn.

**The median long session's carried context rose from 17,079,927 to 17,806,795
cache-read tokens.** `00-problem.md` uses it once, for scale, against the app's
own 4,982-token authored contribution. The ratio moves from 3,400:1 to 3,600:1.

Three that reproduce exactly and are load-bearing:

- **`nextPrompt` at the shipped defaults, all twelve figures**, because it reads
  compiled constants rather than a corpus.
- **The 5m/1h split by thread: zero exceptions, again**, in a window 60 turns
  larger. This is the cleanest finding in the survey and it has now survived two
  independent readings a day apart.
- **`r² = 0.935` for carried context against session cost**, with turn count at
  0.410 and output tokens at 0.506 against 0.512. The one sentence
  `00-problem.md` rests its whole diagnosis on did not move.

## The pin, re-run

`02-levers-on-the-pin.md`'s method was rebuilt from its own description — the
real binary, a local HTTP recorder speaking enough of the Messages API to drive
it, `ANTHROPIC_BASE_URL` and a dummy key, a fresh `CLAUDE_CONFIG_DIR` per probe.
**No probe reached Anthropic and nothing here was billed**: every request went to
`127.0.0.1`, and the one invocation that pointed at a real hostname was the
`--not-a-real-flag` parse test, which exits before any API call.

Five probes, all reproducing:

| Probe | Result |
|---|---|
| Two cycles, one session, a commit and a `CLAUDE.md` edit in between | `sys[2]` diverges by the four expected lines; tools identical; the first user message's `claudeMd` block changes and the prompt block does not |
| The same, with `--exclude-dynamic-system-prompt-sections` | `system identical: True`, `gitStatus` gone from the system block, the volatile content now in a 1.4 KB user block |
| Three cycles with hooks on `--settings` and on `--plugin-dir` | 3 firings against 2; cycle 3 without the flag exits 0 with nothing on stderr |
| `PostToolUse` returning `updatedToolOutput` | the model receives the hook's string in place of the file's contents |
| `--autocompact 100000` and `1000000` with `--debug-file` | `effectiveWindow=80000` and `180000` |

**What the re-run adds that `02-` did not have** is in the next section. What it
did *not* reach is the same list `02-` could not reach: a completed compaction,
`BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
and anything bounding a delegated turn's size.

## Also found, not a claim anyone made

- **The file-read cap is decided by a round trip to the provider.**
  `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` is enforced against a
  `/v1/messages/count_tokens` answer, not a count the CLI takes locally — with a
  recorder returning a fixed 1,000 tokens the cap did not fire at any value, and
  with a realistic answer the same file went 88,988 → 28,394 chars. `02-` records
  the `count_tokens` calls and the cap as two separate findings and attributes the
  calls only to the compaction decision. Two consequences for
  `15-option-cap-tool-output-at-the-source.md`, both added to it: the cap costs an
  extra request per large read, and on a network where that endpoint is slow or
  refused the cap silently stops applying.
- **The 256 KB read ceiling.** The CLI refuses any `Read` whose content exceeds
  256 KB, naming the number. That is a bound on every option in this survey that
  reasons about large tool results — the corpus's 602,196-byte maximum
  `tool_result` cannot have been a single unbounded `Read`, and `00-problem.md`'s
  p99 of 42,120 bytes is what survives *after* both this refusal and the CLI's own
  spilling of 82 MB to `<session>/tool-results/`.
- **On a resumed request the first user message carries no cache breakpoint at
  all.** The third `cache_control` mark moves to the newest message. So on cycle 2
  and after, everything in the first user message — the agent listing, the skills
  listing, `claudeMd`, the original prompt — sits inside the prefix that `sys[2]`
  breaks. This strengthens `14-option-move-the-volatile-prefix.md`'s central
  sentence and weakens nothing.
- **The tool block is not a constant.** 111,472 bytes in `02-`'s probe, 109,800
  in this one, same pin, same 28 tools. Any option that prices a *marginal* tool
  definition — Option I does, at about $8 a week — is working to about 2%.
- **`--settings` hooks and `--plugin-dir` hooks were re-confirmed in one run
  rather than two.** `02-` established them separately; this pass ran both
  channels in the same three-cycle session, which is a stronger form of the same
  claim: the difference is the channel and not the session.
- **The `-p` session's own agent list.** The probe's `init` event names five
  agents — `claude`, `Explore`, `general-purpose`, `Plan`, `statusline-setup` —
  which matches `BUILT_IN_AGENTS` (`src/lib/agents.ts:179`–`:185`) exactly and
  matches `docs/verification.md:479`'s recorded answer minus `uf-set-probe`.
  `proposals/ModelRouter/15-validation.md` found `typescript` on a six-name list in
  `docs/agent/agents-and-templates.md:10` and not in the CLI's own answer; that is
  still true here and is still not this proposal's to correct.

## Unverifiable from here

Ten, and each is named in the file that depends on it.

1. **Anything in the live `runs`, `run_events` or `run_reviews` tables.**
   `/data` is a named volume, root-owned 0700, and `docker-compose.yml:35`–`36`
   says why an agent cannot open it. So: how many cycles a typical run uses,
   whether anyone uses `continueBranch` today (`13-`), whether this install has
   ever pressed Save on the settings page (`05-`), and whether `weeklyAnchor` is
   overridden (`00-`, marked "assumed", still the right word).
2. **`03-experiment-resumed-vs-fresh.md`'s wire measurement.** Its harness lived
   under `/tmp` and is gone with the run that built it — deliberately, and the file
   says so and gives a four-step recipe for rebuilding it. Its arithmetic was
   recomputed line by line and holds; its byte counts were not re-observed. **This
   is the largest single thing this pass could not check, and it is the file the
   overturning experiment would replace.**
3. **Whether a compaction survives `--resume`.** `02-`'s explicit *could not
   establish*, unchanged: no completed compaction is reachable without a live
   model, and no marker is written either way. Gates Option F entirely.
4. **Whether a cycle's `--max-budget-usd` bounds its delegated turns.** `11-`
   calls it the single question that would most change its risk. Needs a billed
   run.
5. **Whether the API's prefix match ends at a `cache_control` breakpoint or at
   the first divergent byte.** This decides between the two readings of Option K's
   saving — $1.44 a week or $5.02 — and no probe can answer it, because every
   `usage` block a recorder produces is invented.
6. **Whether a cheaper arrangement answers as well.** `03-`'s stated limit: "no
   model answered any of the five questions; the recorder returned fixed strings."
   The assumption the whole discard family rests on.
7. **`BASH_MAX_OUTPUT_LENGTH`.** Re-attempted and re-refused: `Bash` cannot
   initialise its sandbox in this agent's container. 22.0% of tool-result bytes
   are behind it.
8. **`MAX_MCP_OUTPUT_TOKENS` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.** No MCP
   server is on a work cycle's argv and none was stood up; the long live
   conversation that would show the second was not run.
9. **Whether the model pages** when `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`
   fires. `02-` shows the CLI actively instructing it to. Option L turns on the
   rate and nothing measures it.
10. **Whether a second delegation in the same session matches the first's
    prefix from cache.** Plausible on a 5-minute TTL, and it would roughly halve
    Option H's already-small break-even. No probe measured two delegations in one
    session, this one included.

## The experiments, gathered

Every experiment the survey named, plus three this pass added, in the order they
should be run — cheapest and most decisive first. **What each would change is
stated, because an experiment that changes nothing is a measurement rather than
an experiment.**

| # | Question it settles | Cost | Where named | What result would change the recommendation |
|---|---|---|---|---|
| 1 | Does a fresh conversation per cycle finish the same task in the same number of work cycles, with the same answers, on a tree that commits? Re-run `03-`'s two arrangements with a live model. | single-digit dollars, billed | `03-`, and `17-recommendation.md` calls it the overturning fact | **Yes → the recommendation is wrong and the answer is Option G.** No, or more cycles → the recommendation is confirmed and Options C, D and G close for good. |
| 2 | Does a cycle's `--max-budget-usd` bound its delegated turns? | small, billed | `11-` | Yes → Option H's largest risk is gone and it should ship beside A. No → H stays a runner-up with an unbounded exposure. |
| 3 | Does a delegation displace enough reading to be worth its own prefix, on this install's real tasks? | small, billed | `11-`, corrected here | Enough → H moves ahead of A on the prize row, which is the one axis A scores 0 on. |
| 4 | Does `--exclude-dynamic-system-prompt-sections` save $1.44 a week or $5.02? One billed pair of cycles with and without, priced through `scanUsage()`. | small, billed | `14-`, and it also settles which reading of the flag is right | $5.02 → Option K ships beside A rather than behind it. $1.44 → it stays a rounding correction. |
| 5 | Does a compaction survive `--resume`? Run a cycle to `PreCompact`, resume, compare what the next request carries. | small, billed | `09-`, gates Option F entirely | Survives → F's arithmetic becomes the best in the survey and its other three objections still stand. Does not → F is dead rather than rejected. |
| 6 | What share of `Read` calls under a file-read cap are followed by an `offset` on the same path? | one live run with the cap and without | `15-` | A low rate → Option L is the cheapest real saving in the survey. A high rate → it is a round trip tax. |
| 7 | Does a second delegation in one session match the sub-agent prefix from cache? | small, billed | added by this pass | Yes → H's break-even roughly halves again. |
| 8 | `SELECT max_iterations, COUNT(*) FROM runs GROUP BY 1;` and the share of runs using `continueBranch`. | free, needs database access | `13-`, and `00-`'s standing limit | A fleet of one-cycle runs → the whole handover prize is smaller than $173.95 and every discard option shrinks with it. |
| 9 | Has this install ever pressed Save on the settings page? | free, needs database access | `05-` | Never → Option B's four editable strings can still be changed from this repository. Ever → they cannot, and B collapses to the four it may not touch. |
| 10 | `BASH_MAX_OUTPUT_LENGTH`, on a machine where `Bash` can initialise its sandbox. | free, needs a different container | `02-`, `15-` | Works → Option L reaches 22% more of the addressable bytes. |

Experiments 8 and 9 are one session at a database an operator can open, and
between them they bound two options. That they are blocked on the same thing is
worth naming twice: **this app's own ledger is the evidence the survey most often
wanted and least often had**, and every figure in `00-problem.md` comes from the
transcripts instead. `proposals/ModelRouter/15-validation.md` wrote the same
sentence about a different survey.

## What this validation did not check

- **It executed no billed child.** Every `claude` invocation pointed at
  `127.0.0.1` or at a closed port. The one that named a real hostname was the
  unknown-flag parse test, which exits 1 before any API call. Every
  `total_cost_usd` any probe printed is arithmetic over numbers a recorder
  invented and is not money.
- **It did not rebuild `03-`'s harness.** Two arrangements, four cycles each,
  three variants, with the byte-exact prefix accounting — that is the experiment
  itself rather than a check on it, and it is item 1 in the table above.
- **It did not open the live database**, for the reason item 1 of "Unverifiable"
  gives. Five of the survey's claims about what operators do are therefore taken
  on the files' own "not established" markers.
- **It did not check the rendering.** Whether a per-cycle table sits inside the
  right band, stacks correctly below `md`, and renders unknown as a hatched meter
  are claims about `docs/agent/conventions.md:46` and `docs/agent/metering.md`,
  read and cited but not built.
- **It read the option files for accuracy rather than for completeness.** No
  search was made for a thirteenth shape. `16-comparison.md` names the two that
  were considered and left out — `--fork-session` and `--no-session-persistence` —
  and gives the reason for each.
- **It did not re-derive the price table.** `resolvePrice`'s answers were taken
  from the function. Whether `claude-opus-5` really is $5/$25 is the table's claim
  and nothing tests it — `proposals/ModelRouter/14-implementation-sketch.md`
  already records that there is no `pricing.test.ts` in the tree, and that is
  still true.
