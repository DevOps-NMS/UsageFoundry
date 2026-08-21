# What the pinned CLI actually offers

`00-problem.md` measured what a run carries. `01-constraints.md` said what an
option must survive. This file establishes which levers *exist*, by running the
binary and quoting what it printed. Every claim below carries the command that
produced it and one of three verdicts — **exists**, **does not exist on this
pin**, **could not establish**. Nothing here recommends anything.

The pin:

    $ claude --version
    2.1.226 (Claude Code)

    $ readlink -f $(which claude)
    /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe

That is the same build `docs/agent/agents-and-templates.md:12` records the app's
argv was captured against, so every verdict here is against the version this
install is running.

## How these were measured, and the one thing the method cannot do

**No probe below reached Anthropic, by construction.** Every probe pointed the
real binary at a local HTTP server that speaks enough of the Messages API to
drive it, with `ANTHROPIC_BASE_URL` and a dummy `ANTHROPIC_API_KEY`, and recorded
every request body verbatim. That is the right instrument for this file: what is
being established is what the CLI *does* — which flags parse, which hooks fire,
what goes on the wire — and a recorder answers that exactly, repeatably and for
nothing, where a live model answers it once and charges for the privilege.

    $ ls -la /home/node/.claude/.credentials.json
    crw-rw-rw- 1 nobody nogroup 1, 3 Aug 19 21:22 /home/node/.claude/.credentials.json

    $ claude auth status
    {"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}

(The credential is masked in this agent's sandbox in any case, so nothing here
could have been billed even by accident.)

The invocation, unchanged across every probe below bar its own flags:

    $ env NO_PROXY=localhost,127.0.0.1 \
          ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT \
          ANTHROPIC_API_KEY=sk-ant-mock-not-a-real-key \
          CLAUDE_CONFIG_DIR="$OUT/cfg" \
          claude -p "$PROMPT" --output-format stream-json --verbose \
            --model claude-haiku-4-5-20251001 --include-hook-events "$@"

Every probe therefore ran the **real CLI**: real hook dispatch, real tool
execution against real files on disk, real session and transcript writing, real
argv parsing. What was fake is only the model's replies and the `usage` numbers
attached to them, which the recorder scripts.

So the method establishes, with certainty: which flags parse, which hooks fire
and in what order, what a hook may return and what the model receives after it,
what the CLI puts on the wire, where it places cache breakpoints, what changes
between two cycles, and what it writes to the transcript. It establishes
**nothing** about token counts, real cost, or what a model would do — every
`total_cost_usd` any probe printed is the CLI's arithmetic over numbers the
recorder invented, and none of it is money. Where a question needs a live model,
the verdict below is *could not establish* and says so.

`CLAUDE_CONFIG_DIR` was pointed at a fresh directory per probe, so no probe read
the operator's `~/.claude` settings or wrote into the shared bind mount. Two
consequences show up below: `Bash` cannot run inside this agent's sandbox at all
(`Sandbox is required but failed to initialize: EPERM … srt-mux-20-1.sock`), and
`Glob` is not in this container's tool set.

## Hooks

This is the section the survey leans on hardest, and it has the strongest
answers.

### Which fire under a work cycle's flags — **exists**

All five asked about fire under `-p --output-format stream-json --verbose`, plus
`Stop`, `SessionEnd` and `PostToolUse`. A settings payload naming every event,
handed to the CLI as JSON on the argv, with a hook script that appends its event
name and stdin to a file:

    $ claude -p 'Read the file /tmp/…/fixtures/target.txt then reply OK.' \
        --output-format stream-json --verbose --model claude-haiku-4-5-20251001 \
        --permission-mode bypassPermissions --include-hook-events \
        --settings "$(cat settings-hooks-read.json)"

    --- hooks fired ---
    ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']

    --- stream hook events ---
    hook_started  SessionStart:startup
    hook_response SessionStart:startup      success
    hook_started  UserPromptSubmit
    hook_response UserPromptSubmit          success
    hook_started  PreToolUse:Read
    hook_response PreToolUse:Read           success
    hook_started  PostToolUse:Read
    hook_response PostToolUse:Read          success
    hook_started  Stop
    hook_response Stop                      success

Two properties worth carrying forward. `--include-hook-events` puts every hook
dispatch on the same `stream-json` channel `handleStreamLine` already reads, as
`{"type":"system","subtype":"hook_started"|"hook_response", …}` carrying
`hook_name`, `outcome`, `exit_code`, `stdout` and `stderr` — so a hook's failure
is observable by this app without a second channel. And the hook payload on
stdin carries `session_id`, `transcript_path`, `cwd`, `prompt_id`,
`permission_mode` and the event's own fields:

    UserPromptSubmit  {"session_id":"8ac2fcd2-…","transcript_path":"/home/node/.claude/projects/…/8ac2fcd2-….jsonl",
                       "cwd":"/tmp/…","prompt_id":"43255a06-…","permission_mode":"bypassPermissions",
                       "hook_event_name":"UserPromptSubmit","prompt":"Run the Bash tool exactly once …"}

`PreCompact` fires too, and its own section is below. The tool-gated events were
exercised through `Read` rather than `Bash`, for the sandbox reason above; no
event listed in the settings payload failed to fire when its trigger occurred.

### Whether a hook can modify or replace what a tool returns — **exists**

It can do both, and they are different mechanisms.

**Append.** `hookSpecificOutput.additionalContext` on a `PostToolUse` hook
reaches the model as a *separate* text block, not as part of the tool result:

    TOOL_RESULT:    "1\tcanary-line-from-disk\n2\t"
    TEXT-WITH-HOOK: "<system-reminder>\nPostToolUse:Read hook additional context: HOOK-ADDED-CONTEXT\n</system-reminder>"

**Replace.** `hookSpecificOutput.updatedToolOutput` substitutes the tool's output
before the model sees it. The binary's own schema string describes it —
`updatedToolOutput: "Replaces the tool output before it is sent to the model"`,
beside `updatedMCPToolOutput: "Replaces the output for MCP tools only. Prefer
updatedToolOutput, which works for all tools"` — and it was observed working. A
`PostToolUse` hook that emits

    {"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":
      {"type":"text","file":{"filePath":"/tmp/…/fixtures/target.txt",
       "content":"HOOK-REPLACED-THE-FILE-CONTENTS","numLines":1,"startLine":1,"totalLines":1}}}}

against a file whose actual contents are `canary-line-from-disk` produced:

    --- what the model received as tool_result ---
    TOOL_RESULT: "1\tHOOK-REPLACED-THE-FILE-CONTENTS"
    --- debug ---
    [DEBUG] Hook PostToolUse (…/posttool-read-replace.sh) replaced tool output

**The replacement is validated against the tool's own output schema, and a
mismatch is refused rather than coerced.** A string handed to `Write` gave:

    [DEBUG] Hook PostToolUse (…/posttool-str.sh) replaced tool output
    [ERROR] "PostToolUse hook returned updatedToolOutput that does not match Write's
             output shape: [ { "expected": "object", "code": "invalid_type", "path": [],
             "message": "Invalid input: expected object, received string" } ]"

and the model received the real output. `Read`'s shape is a union discriminated
on `type`; `{}` gave `"code": "invalid_union" … "No matching discriminator" …
"path": ["type"]`. **That refusal is loud in the debug log and silent
everywhere else** — the run continues with the unreplaced output, which is the
`--plugin-dir` failure mode from `01-constraints.md` in a new place: an option
built on this must state what happens when a future build changes a tool's
output shape.

The binary's validation-error string enumerates the rest of the surface, and it
is the authoritative list on this pin:

    for PreToolUse:        hookEventName, permissionDecision "allow"|"deny"|"ask"|"defer",
                           permissionDecisionReason, updatedInput ("Modified tool input to use")
    for UserPromptSubmit:  hookEventName, additionalContext (required)
    for PostToolUse:       hookEventName, additionalContext (optional)   [+ updatedToolOutput, above]
    for Stop / SubagentStop: hookEventName, additionalContext
                           ("Feedback for the model; the conversation continues so the model can act on it")
    top level:             continue, suppressOutput, stopReason,
                           decision "approve"|"block", reason, systemMessage

So a hook can shorten a tool result (`PostToolUse.updatedToolOutput`), rewrite a
tool's arguments before it runs (`PreToolUse.updatedInput`), add text to the
conversation at three points (`UserPromptSubmit`, `PostToolUse`, `Stop`), and
stop the loop (`continue: false`). It cannot reach anything already in the
conversation.

### Which channels deliver hooks, and which survive `--resume`

Three channels, and they do not behave alike.

**`--settings <json>` on the argv — exists, survives `--resume`.** This is the
channel `sandboxArgs` (`src/lib/orchestrator.ts:5158`) already uses. Three
cycles of one session, the flag re-sent on each:

    cycle 1 exit=0  session_id=02d2f700-2345-40a3-bf8e-82a5d664eba3
    cycle 2 exit=0  session_id=02d2f700-2345-40a3-bf8e-82a5d664eba3
    cycle 3 exit=0  session_id=02d2f700-2345-40a3-bf8e-82a5d664eba3

    --- hooks fired per cycle ---
    ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SessionEnd',
     'SessionStart','UserPromptSubmit','Stop','SessionEnd',
     'SessionStart','UserPromptSubmit','Stop','SessionEnd']

(`PreToolUse`/`PostToolUse` appear once because only cycle 1's scripted reply
called a tool.) A single-event payload works too — `PostToolUse`, `PreToolUse`
and `UserPromptSubmit` each fired alone.

**`--settings <path>` to a file on disk — exists, survives `--resume`.** Same
result with the payload in a file rather than inline: the hook fired on cycle 1
and on the `--resume` cycle.

**`--plugin-dir <path>` — exists, and does *not* survive `--resume`.** A plugin
directory with `hooks/hooks.json` naming a `UserPromptSubmit` hook, over three
cycles: flag present, flag present, flag absent.

    "plugins":[{"name":"ctxprobe","path":"/tmp/…/plug/ctxprobe","source":"ctxprobe@inline","version":"0.0.1"}]

    === plugin hook fired (cycle1 with flag, cycle2 with flag, cycle3 WITHOUT flag) ===
    ['PLUGIN-UserPromptSubmit', 'PLUGIN-UserPromptSubmit']

Two firings, not three. **That is the docblock at `src/lib/orchestrator.ts:4828`
–`4831` confirmed on the pin, and confirmed as silent**: cycle 3 exited 0 with
nothing on stderr and no hook. The app's answer — rebuild the whole argv per
cycle — is the correct shape, and any option that delivers a hook through a
plugin directory inherits that requirement rather than the settings channel's.

## Compaction

### A `-p` session compacts on its own — **exists**

`PreCompact` fired, unprompted, in a `-p --output-format stream-json --verbose`
run, with `trigger: "auto"`:

    PreCompact  {"session_id":"b92d94c0-…","transcript_path":"/tmp/…/b92d94c0-….jsonl",
                 "cwd":"/tmp/…","prompt_id":"cc082502-…","hook_event_name":"PreCompact",
                 "trigger":"auto","custom_instructions":null}

`custom_instructions` being a field rather than absent is worth noting: the
compaction the CLI performs is parameterisable from somewhere, though not from
anything this app puts on an argv.

### The threshold, and the flag that moves it — **exists**

`--autocompact <auto|tokens>` is on the parser, and its own error names the
range:

    $ claude --autocompact 50000 --help
    error: option '--autocompact <auto|tokens>' argument '50000' is invalid. It must be 'auto', or between 100k and 1M (e.g. 500k, 200000, or 200 as shorthand)

    $ claude --autocompact 100000 --help     # accepted
    $ claude --autocompact 1000000 --help    # accepted
    $ claude --autocompact 2000000 --help
    error: option '--autocompact <auto|tokens>' argument '2000000' is invalid. It must be 'auto', or between 100k and 1M (e.g. 500k, 200000, or 200 as shorthand)

What it sets is visible in the debug log, and it is **clamped by the model's own
window and reduced by a fixed reserve**. On `claude-haiku-4-5-20251001` —
`--debug-file <path>` rather than a bare `--debug`, because under
`--output-format stream-json` a bare `--debug` writes nothing to either stream
and the line is only reachable through the file:

    --autocompact 100000    →  autocompact: tokens=[REDACTED] level=ok       effectiveWindow=80000
    --autocompact 1000000   →  autocompact: tokens=[REDACTED] level=ok       effectiveWindow=180000

100,000 − 20,000 and min(1,000,000, 200,000) − 20,000. So on a 200k-window model
the flag can only ever *lower* the threshold, never raise it, and asking for 1M
buys nothing.

`level` moves `ok` → `compact` → `blocked` as the conversation grows, and the
CLI acts on it:

    autocompact: tokens=[REDACTED] level=compact effectiveWindow=80000
    autocompact: routing through reactive (thresholdSource=settings)

### It refuses when the fixed prefix is the problem — **exists**

    autocompact: fixed prefix ~83280 > threshold 67000 — compaction cannot help

**This is the most consequential line in the section for the survey.** The CLI
computes a fixed prefix and, when that alone exceeds the threshold, declines to
compact rather than compacting uselessly — because compaction removes
conversation and cannot remove the prefix. An option that proposes to lean on
the CLI's own compaction has to answer what happens on a run whose prefix is
already over the line, and the answer this pin gives is *nothing happens*.

### Switching it off — **exists**

`DISABLE_AUTO_COMPACT=1`, on two otherwise identical runs:

    without:  ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PreCompact','SessionEnd']
    with:     ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','SessionEnd']

`PreCompact` stops firing. `DISABLE_COMPACT` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
are also in the binary; their behaviour was not exercised.

### Whether a compaction survives `--resume`, and what the transcript shows — **could not establish**

Two things stopped this. The recording upstream cannot produce a summary a real
compaction would accept, so no probe reached a *completed* compaction — only the
decision to attempt one. And the transcript carries no marker either way:

    $ python3 …  # every record of every probe transcript, keys isCompactSummary/compactMetadata/isCompact/summary
       queue-operation | keys: []
       user            | keys: []
       assistant       | keys: []
       …

which is `00-problem.md`'s corpus result — `records 111845 compaction markers {}`
— reproduced on a session that demonstrably reached `PreCompact`. **So the
absence of markers in the corpus is not evidence that compaction did not
happen.** `00-problem.md` left that as an open disjunction; one half of it is now
closed, and the file has been corrected.

## Session flags

All established by observation, one session driven through five invocations in
one directory.

| flag | verdict | observed |
|---|---|---|
| `--session-id <uuid>` | exists | honoured verbatim: the id passed came back as `session_id` in `init` and named the transcript file |
| `--resume <id>` | exists | same `session_id` on cycles 2 and 3; message count grew 1 → 3 → 5 → 7 |
| `--fork-session` (with `--resume`) | exists | new id `f524488b-…`, **new transcript file**, and the forked request carried the prior conversation (5 messages) |
| `--continue` | exists | resumed the most recent conversation in the cwd — which was the *fork*, not the original |
| `--no-session-persistence` | exists | fresh id, 1 message, and **no transcript file written** |

    b1a730b9-34e7-4d87-8ed9-3369a27919fa.jsonl     ← original, resumed twice
    f524488b-6567-4e72-8004-c424377f2c44.jsonl     ← the fork
    (nothing for the --no-session-persistence run)

Two of these bear directly on this app. `--continue` picking the *latest*
conversation in a directory rather than a named one makes it unusable where two
runs can share a checkout, which `docs/agent/concurrency-and-ownership.md` says
is the case this app is built around. And `--no-session-persistence` removes the
file that `scanUsage()` reads, so a run under it would cost money and appear
nowhere in `buildSnapshot()` — every figure in `00-problem.md` and every window
meter comes from those files.

## Output caps

| lever | verdict | observed |
|---|---|---|
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | exists | request `max_tokens` 32000 → **4096**; drags `thinking.budget_tokens` 31999 → 4095 with it |
| `MAX_THINKING_TOKENS` | exists | `thinking.budget_tokens` 31999 → **2000**, `max_tokens` unchanged at 32000 |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | exists | a `Read` of an 84,000-byte file: tool result **93,401 → 32,226 chars**, plus a paging instruction appended. **The cap is enforced against a `/v1/messages/count_tokens` answer**, not against a local count: re-run by the closing pass with a recorder returning a fixed 1,000 for every `count_tokens` call, the cap never fired at any value; with a realistic answer the same file went 88,988 → 28,394 chars |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | could not establish | present in the binary; no observable change to the request body on a short conversation, and the long conversation that would show it needs a live model |
| `BASH_MAX_OUTPUT_LENGTH` | could not establish | present in the binary; `Bash` cannot run inside this agent's sandbox — every call returns `Sandbox is required but failed to initialize: EPERM … srt-mux-20-1.sock` |
| `MAX_MCP_OUTPUT_TOKENS` | could not establish | present in the binary; no MCP server is on a work cycle's argv (`00-problem.md`), and none was stood up |

The file-read cap is the one an option could use today, and what it does is
worth quoting because it is not truncation. Verbatim, from the closing pass's
re-run at `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=8000` over an 84,010-byte
file — the whole thing arrives wrapped in a `<system-reminder>`:

    [Truncated: PARTIAL view — /tmp/…/big.txt: showing lines 1-387 of 1217 total
     (21329 tokens, cap 8000). Call Read with offset=388 limit=387 for the next page,
     or Grep to find a specific section. Do NOT answer from this page alone if the
     answer may be further in the file.]

It *pages*. The saving is real on the turn it happens and is repaid in full, plus
a fresh tool-call round trip, the moment the model asks for page two — which is
precisely what that instruction tells it to do. An option built on this is
betting that the model does not need the rest, and `00-problem.md` already
refuses the equivalent claim about file reads generally: its own proxy "cannot
distinguish *wasted* from *read and understood*".

One further cap the CLI applies without being asked, and it names its own
number: a `Read` of a 402,020-byte file was refused outright with a
197-character tool result — "File content (392.6KB) exceeds maximum allowed size
(256KB). Use offset and limit parameters to read specific portions of the file,
or search for specific content instead of reading the whole file." — and the env
var above did not change that. **256 KB is the ceiling on anything a single
`Read` can put in a conversation, whatever this app does.**

## Delegated turns

**A sub-agent's context is entirely separate — exists.** The parent's turn and
the delegated turn, from one probe, as they went on the wire:

    req-001  main   tools 28  system 27,452 B  msgs 1   first user 7,111 B
    req-002  agent  tools 14  system  3,204 B  msgs 1   first user 5,309 B
    req-003  main   tools 28  system 27,452 B  msgs 3   first user 7,111 B   (sha unchanged)

The delegated turn gets half the tools, an eighth of the system prompt, its own
first user message, and **no parent history at all**. Its system prompt opens
`"You are an agent for Claude Code, Anthropic's official CLI for Claude. Given
the user's message, you should use the tool…"` where the parent's opens `"You
are an interactive agent that helps users with software engineering tasks."`

**Its cost does land where `scanUsage()` attributes it — and `00-problem.md` was
wrong about this.** The delegated conversation is a separate file:

    …/<session>/subagents/agent-a7cf763a96c3e3bd5.jsonl
    …/<session>/subagents/agent-a7cf763a96c3e3bd5.meta.json

with `isSidechain: true` on every record and the usage block on the assistant
one. `listTranscriptFiles` (`src/lib/transcripts.ts:162`–`184`) walks the
projects directory **recursively**, so those files are in the scan:

    $ node -e '… walk("/home/node/.claude/projects") …'
    main-thread .jsonl files 513 | subagent .jsonl files 495

    $ node -e '… scanUsage() …'
    rolling week, container projects:
      main-thread turns 16529 $2693.79
      sidechain turns    3116 $188.03
      sidechain share of cost 6.5%
      entries carrying an attributionAgent 3102

**6.5% of this container's weekly bill is delegated turns, and it is already in
`buildSnapshot()`.** `00-problem.md` said the app "neither builds it nor reads
it"; half of that is right and the file has been corrected.

**What the parent can control — partial.** `--agents`/`--agent` decide the
definition and which one the session *is* (`src/lib/agents.ts:376`–`389`), and
the `Agent` tool's own schema on the wire exposes a per-call `model` override
with an enum of aliases. `CLAUDE_CODE_SUBAGENT_MODEL`,
`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` are all in the binary. **Nothing
observed bounds the *size* of a delegated turn's context** — no flag, no env var
and no `--agents` field reached it in any probe, and the sub-agent's 3,204-byte
system prompt and 14-tool set were the same under every argv tried. Verdict:
*could not establish* that the parent can bound a delegated turn's size, and
*exists* for everything else above.

## Two things nobody asked about that the survey needs

### The prefix that moves between cycles is `gitStatus`, and it is in the system prompt

`01-constraints.md` closes by saying the pin probe owes an answer to what changes
in the prefix across a handover, and that "if it is the CLI's own environment
block … then no lever here reaches it and the survey is about something else."

It is the CLI's own environment block. Two cycles of one session, with a commit
and a `CLAUDE.md` edit in between — everything else identical:

    === req-001 (cycle 1) vs req-002 (cycle 2) ===
    system identical: False
      sys[2] 27623B -> 27660B
        --- c1
        +++ c2
         Status:
        -?? uncommitted-before.txt
        +M CLAUDE.md
        +?? uncommitted-after.txt

         Recent commits:
        +5351e60 a cycle committed
         a7d1d6b init
    tools identical: True
    first user message blocks: 4 -> 4
      block0: 1786B -> 1786B identical=True
      block1: 4968B -> 4968B identical=True
      block2:  662B ->  697B identical=False
        -first version of the project memory
        +SECOND version of the project memory, materially longer than the first
      block3:   50B ->   50B identical=True

Where those breakpoints sit decides what that costs. The request carries exactly
three `cache_control` marks, and no `ttl` field on any of them — sizes below are
from a probe in a directory that is not a git repository, which is why its
`sys[2]` is 27,325 bytes rather than the 27,623 of the mutation probe above:

    sys[0]      74B  cc=null                     x-anthropic-billing-header: cc_version=2.1.226.e6b; cc_entrypoint=sdk-cli;
    sys[1]      62B  cc={"type":"ephemeral"}     You are a Claude agent, built on Anthropic's Claude Agent SDK.
    sys[2]  27,325B  cc={"type":"ephemeral"}     You are an interactive agent that helps users with software engineering tasks…
    tools  111,472B  cc=null                     28 tool definitions
    msg0.0   1,786B  cc=null                     <system-reminder> available agent types
    msg0.1   4,968B  cc=null                     <system-reminder> available skills
    msg0.2     306B  cc=null                     <system-reminder> claudeMd + currentDate
    msg0.3      50B  cc={"type":"ephemeral"}     the prompt this app sent

**The tool block's size is not stable and no option should treat it as a
constant.** The closing pass re-ran the same probe and got **109,800 bytes for
the same 28 tools** — 1.5% smaller, on the same pin, in a different scratch
directory. Exactly three `cache_control` marks reproduced both times, on `sys[1]`,
`sys[2]` and the newest user block; on a *resumed* request the third mark moves
to the newest message, so the first user message carries no breakpoint at all
and everything in it sits inside the prefix `sys[2]` breaks.

`sys[2]` is the **first** thing after the tool definitions and it carries a
breakpoint, so a change in it invalidates everything after it — which is the
whole conversation. That is a re-write of the entire suffix, on every cycle
whose predecessor touched the repository. **This app's isolated runs are told to
commit**, so on this install that is most of them.

With nothing changed, the prefix is byte-identical and the conversation stays
matched. Three resumed cycles in a clean tree:

    system identical across cycle1->cycle2: True
    tools identical: True
    first user message identical: True

and within one cycle it is stable too (`within one cycle, system identical: True`).

`--exclude-dynamic-system-prompt-sections` — "Move per-machine sections (cwd,
env info, memory paths, git status) from the system prompt into the first user
message. Improves cross-user prompt-cache reuse" — **exists and does exactly
that**, on the same mutation:

    system blocks: [(74,'null'), (62,'ephemeral'), (26726,'ephemeral')]
    system identical c1->c2: True
    'gitStatus' in system: False

    first user message blocks c1: [(1786,'null'), (4968,'null'), (1360,'null'), (50,'ephemeral')]
      block2: 1360B -> 1432B identical=False    ← the volatile content, now here
      block3:   50B ->   50B identical=True

**It moves the break, it does not remove it.** Before the flag, the first
divergence is at byte 0 of a 27 KB system block; after it, at a 1.4 KB user block
that still sits ahead of the only breakpoint in that message and therefore still
ahead of the entire conversation. What is saved is 27,623 − 26,726 ≈ 900 bytes of
system text plus the 6,754 bytes of `msg0.0`/`msg0.1` that now stay matched —
about 7.6 KB, against a suffix `00-problem.md` measures at a median 231,644
written tokens. The survey should price it as a small, certain saving and not as
a fix.

One corroboration from the corpus, offered as suggestive rather than settled.
Classifying each work-cycle handover in the rolling week by whether the previous
cycle committed, merely wrote files, or did neither:

    handover that RE-WROTE     commit-in-prev-cycle   53 | write-only   21 | neither    0 | n   74
    handover that HIT cache    commit-in-prev-cycle   13 | write-only   10 | neither    6 | n   29

**No handover whose previous cycle changed nothing in the repository ever
re-wrote (0 of 74), and every handover with no repository change hit the cache
(6 of 6).** The converse does not hold — 23 of the 29 hits followed a cycle that
did change something — so a repository change is necessary but not sufficient in
this data, and the classifier's cycle boundaries are approximate. It is enough to
say the mechanism measured above is live in the corpus, and not enough to say it
is the only one.

### The CLI makes unbilled `count_tokens` calls over large tool results

Every probe that read a file above roughly 24 KB produced an extra request, which
looked at first like a summarisation call — a bare `{model, messages, tools}`
body, no system prompt, no `max_tokens`, whose single user message is the raw
file. It is not:

    req-000.json POST /v1/messages?beta=true
    req-001.json POST /v1/messages?beta=true
    req-002.json POST /v1/messages/count_tokens?beta=true      ← 32,822 B, the file just read
    req-003.json POST /v1/messages?beta=true

`/v1/messages/count_tokens` is not billed as inference. It is recorded here
because any accounting done from request bodies rather than from `usage` blocks
will over-count if it treats these as turns — the arrangements in
`03-experiment-resumed-vs-fresh.md` sent 123,401 bytes of them per run — and
because it is the CLI measuring context size for the compaction decision above.

Also on the wire, unasked for and worth one line each: `context_management`, the
API's context-editing beta, is **already present on every request** as
`{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` — an edit that
keeps everything — and nothing tried here changed it; and the CLI spends one
extra billed turn per fresh conversation generating a session title, with its
own 1,190-byte system prompt.

## The verdicts, in one place

| lever | verdict |
|---|---|
| `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `PreCompact` fire under `-p --output-format stream-json --verbose` | **exists** |
| A hook can append to what the model sees (`additionalContext`) | **exists** |
| A hook can *replace* a tool's output (`updatedToolOutput`), schema-validated, refusal logged only in debug | **exists** |
| A hook can rewrite a tool's input (`PreToolUse.updatedInput`) | **exists** |
| Hooks via `--settings` JSON on the argv, surviving `--resume` | **exists** |
| Hooks via `--settings <file>`, surviving `--resume` | **exists** |
| Hooks via `--plugin-dir`, **not** surviving `--resume`, silently | **exists** |
| A `-p` session compacts on its own | **exists** |
| `--autocompact`, clamped to the model window minus 20,000 | **exists** |
| `DISABLE_AUTO_COMPACT=1` suppresses it | **exists** |
| Compaction is refused when the fixed prefix exceeds the threshold | **exists** |
| Whether a compaction survives `--resume`, and its transcript shape | **could not establish** — no completed compaction reachable without a live model; no marker written either way |
| `--session-id`, `--resume`, `--fork-session`, `--continue`, `--no-session-persistence` | **exists** |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | **exists** |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | **could not establish** — needs a long live conversation |
| `BASH_MAX_OUTPUT_LENGTH` | **could not establish** — `Bash` cannot run in this agent's sandbox |
| `MAX_MCP_OUTPUT_TOKENS` | **could not establish** — no MCP server on a work cycle's argv, none stood up |
| A delegated turn's context is separate from the main thread's | **exists** |
| A delegated turn's cost reaches `scanUsage()` | **exists** — 6.5% of the container's week |
| Anything on the parent's argv bounding a delegated turn's *size* | **could not establish** — nothing tried reached it |
| `--exclude-dynamic-system-prompt-sections` moves `gitStatus` out of the cached system prompt | **exists** |
| What changes in the prefix across a handover | **exists** — `gitStatus` in `sys[2]`, regenerated per cycle |
