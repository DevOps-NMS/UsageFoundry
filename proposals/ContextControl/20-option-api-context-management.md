# Option M — the API's own `context_management` block

**Rejected, on reachability, by probe rather than by judgement.** The lever
exists, it is the best-shaped lever in this survey, and **this app cannot emit
it**. Nothing on any argv this app builds reaches it, and the `--settings`
channel accepts a `context_management` key, applies the rest of the same file,
and silently ignores it. What follows fills the ten headings anyway, because
establishing that a lever does not exist is the same kind of finding as
establishing that one does, and because the day the CLI exposes it this file is
the analysis that was already done.

This option was not on the survey's list. It is here because the survey scored
twelve mechanisms at the *app* layer and the *CLI* layer and never looked at the
**API** layer, where Anthropic ships a first-party mechanism for exactly the
problem `00-problem.md` opens on. `19-validation.md` names that gap in its own
words — "No search was made for a thirteenth shape."

## The strongest case

**It is the only mechanism in this survey that does the work server-side, on
the vendor's side of the wire, with no state for this app to keep.** The vault's
description of the mechanism, from
`/workspace2/3 Resources/AI Context and Memory/Compaction and Context Editing.md:57`:

> Editing happens server-side, before the prompt reaches the model. The client
> keeps its full unmodified history — no state syncing required.

Every other option in this survey that removes anything has to decide what to
remove, hold the decision somewhere, and answer `01-constraints.md`'s question
about what the removal does to `--resume`. This one does not. The transcript on
disk stays whole; retention sweeps the same files; `--resume` replays the same
conversation; the edit happens between the request leaving and the model seeing
it.

**And its parameterisation is the survey's own arithmetic, shipped as an API
field.** `01-constraints.md:32` derives the break-even from this install's
transcripts:

    T* = 19·(S / D) − 20

— an edit only pays if what it removes (*D*) is large enough against what it
leaves standing after the cut (*S*). The vault records that Anthropic shipped a
parameter whose entire job is that inequality
(`/workspace2/3 Resources/AI Context and Memory/Compaction and Context Editing.md:65`):

> The mitigation is the `clear_at_least` parameter: only clear if doing so frees
> at least N tokens, making the cache invalidation worth paying for.

and again in
`/workspace2/3 Resources/AI Context and Memory/Prompt Caching.md:59`:

> The `clear_at_least` parameter in [[Compaction and Context Editing]] exists
> precisely to arbitrate this — only pay the invalidation if you're clearing
> enough to make it worthwhile.

That is a convergence worth recording plainly, because it cuts both ways. It is
external corroboration that `01-constraints.md` found the right trade-off rather
than an artefact of one install's corpus: the vendor independently priced the
same collision between curation and the prefix cache and exposed a floor
parameter to arbitrate it. And it is the strongest available argument that the
survey's twelve app-layer options are re-implementing, badly and without a
server-side view of the token count, something that already exists one layer
down. `clear_at_least` is `T*` with the algebra solved for *D* and the answer
enforced by the party that can actually count the tokens.

**Its other half is aimed at the one line in the bill nothing else in this
survey touches.** `00-problem.md` measures a fixed, invisible prefix — 31,373
bytes at the intercept, 13,734 of it unattributed — and separately records
`thinking blocks: empty 13454 non-empty 0`: thinking is billed and is not in the
transcript. `clear_thinking_20251015` is the only lever anywhere in this
proposal aimed at that mass. It is also, as the probes below show, the only
strategy the pinned CLI actually constructs — which is the one thing this option
has going for it, and it has it in a form this app cannot configure.

## Shape

**A JSON object on the `/v1/messages` request body, alongside `tools`, `system`
and `messages`** — not a flag, not a file, not a prompt. Shape as the vault
records it
(`/workspace2/3 Resources/AI Context and Memory/Compaction and Context Editing.md:46`–`:57`,
graded `evidence: vendor`, `confidence: low` at
`/workspace2/3 Resources/Sources/Claude Context Management (Anthropic 2025).md`):

| strategy | what it clears | default trigger |
|---|---|---|
| `clear_tool_uses_20250919` | oldest tool *results*, chronologically, replaced with placeholder text; `clear_tool_inputs: true` also clears the `tool_use` params | 100,000 input tokens; keeps the last 3 tool uses |
| `clear_thinking_20251015` | thinking blocks from earlier assistant turns | model-dependent; Opus 4.5+ and Sonnet 4.6+ keep all by default |
| `compact_20260112` | server-side compaction of the whole conversation | separate beta `compact-2026-01-12`; **not** a context-editing strategy |

with `keep`, `trigger`, `clear_at_least` and `exclude_tools` as the dials, under
beta header `context-management-2025-06-27`.

**And the shape this app would need is not that object. It is a way to put that
object on a request it does not build.** This app never speaks to
`/v1/messages`. It spawns `claude` (`src/lib/orchestrator.ts`, `buildArgs` at
`:4809`, rebuilt per cycle at `:6821`) and the CLI assembles the request. So the
only two shapes available are an argv entry the CLI translates, or a
`--settings` key the CLI reads. Both were probed. Both are absent.

## What leaves the context, and when the decision is taken

**Nothing leaves, because the decision is not this app's to take on the pinned
CLI. The CLI takes it, unconditionally, and takes exactly one of the three.**

Probed on the wire, against the pin, with the CLI pointed at a local recorder so
nothing reached Anthropic and nothing could be billed —
`02-levers-on-the-pin.md`'s arrangement:

    $ node /tmp/ctxctl-rev-721638d11c0b-1/recorder.js &
    $ ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=sk-ant-not-real \
      NO_PROXY=localhost,127.0.0.1 CLAUDE_CONFIG_DIR=$SCRATCH/cfg \
      claude -p "hi"

    bodyA.json  POST /v1/messages?beta=true
      context_management = {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}
      thinking           = {"type":"adaptive"}

So on every request this app causes, the block **is** present and it carries one
edit: clear nothing. `keep: "all"` is the whole configuration, and it is a
literal. The producer in the pinned binary takes one boolean and has no other
branch:

    function Gzp(e){let{hasThinking:t=!1}=e??{};
      if(t)return{edits:[{type:"clear_thinking_20251015",keep:"all"}]};return}

called once, `let vs=Gzp({hasThinking:di})`, and spread into the body as
`...vs&&ie&&so.includes(n$t)&&{context_management:vs}`, where
`n$t=hC("context_management","context-management-2025-06-27")` is the beta gate.
There is no path through that function that emits `clear_tool_uses_20250919`, no
path that emits a `trigger`, and no path that emits `clear_at_least` or
`exclude_tools` — which is what the string counts already say (below).

**The one decision this app can take is subtraction, and it is the wrong
one.** `MAX_THINKING_TOKENS` is an environment variable the CLI honours, and
setting it to zero removes the block entirely:

    MAX_THINKING_TOKENS=0     → thinking = {"type":"disabled"}, context_management absent
    MAX_THINKING_TOKENS=1024  → thinking = {"type":"adaptive"},  block present, keep "all"

That is the only reach this app has over the field: it can delete it. It cannot
change it. And `childEnv` (`src/lib/orchestrator.ts`) strips the classes of
variable it strips precisely so a spawned agent does not inherit the parent's
model configuration, so adding one back to disable thinking would be a change
with a much larger blast radius than a context-management setting.

## What it does to the prefix cache

**Nothing, on this install, because `keep: "all"` clears nothing** — which is
also the reason the CLI ships it that way. The vault records the underlying
trade-off at
`/workspace2/3 Resources/AI Context and Memory/Compaction and Context Editing.md:63`:

> Cache hits require an identical prefix. Clearing content *in the middle* of
> the history changes that prefix and invalidates everything after the edit
> point. So every clearing event incurs a fresh cache write.

and the per-model default at `:53` — Opus 4.5+ keeps all thinking by default.
The pinned CLI's literal is that default written out. Keeping thinking preserves
the cache; clearing it breaks the prefix at the clear point.

**Were the block reachable, this is the option in the survey whose cache
arithmetic is best understood in advance, and the news is not good.**
`01-constraints.md`'s table prices a mid-life edit at `S ≈ 213,156` tokens:
removing a tenth of the suffix costs $1.81 once and saves $0.011 a turn, so it
breaks even after **170 further turns**, and only 807 of 11,422 measured turns
live past index 160 at all. A `clear_tool_uses` firing at its documented 100,000
input-token default fires *mid-conversation*, which is precisely the shape that
never pays. `clear_at_least` is the parameter that exists to stop it firing
there — the vendor's floor and the survey's `T*` are the same inequality — but
`clear_at_least` is the string that appears **zero** times in the pinned binary.

The one free moment `01-constraints.md` identifies is the work-cycle handover,
where the suffix is written again anyway. A server-side strategy triggered on
input-token count has no idea where a work-cycle boundary is. Only this app
knows that, and this app is the layer that cannot reach the field.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**Untouched, all four — because the option does nothing on this install.** The
honest version of this heading is that the question is unreachable rather than
answered, and it is worth stating what it would ask, because it is a harder
question than any other option's.

`clear_tool_uses` replaces tool results with placeholder text and keeps the last
three. The DONE contract does not live in a tool result: `COMPLETION_NOTICE`
(`src/lib/orchestrator.ts:4467`) and `NEEDS_REVIEW_NOTICE` (`:4507`) are appended
to the **user** message by `nextPrompt` (`:4331`–`:4362`), and `cycleEnding`
(`:4544`) matches over the model's final text. Neither is a tool result, so
neither is a candidate for `clear_tool_uses`. That is a genuine advantage over
Option F.

`--resume` is the interesting one and the answer is favourable in principle:
context editing is server-side and stateless, so the transcript on disk is
unmodified, and a resumed session replays the same file to the same edit policy.
`docs/agent/retention.md`'s three horizons sweep the same evidence they swept
before. Nothing in this option writes a store, a marker or a schema.

**None of that is verified, because none of it can be reached.** It is written
here as what the option *would* owe, not as what it has been shown to do.

## Guards and the three cost sources

**Adds to none, and reads from none.** `evaluateBudget`
(`src/lib/budget.ts:400`) gains no caller and its order is unchanged.
`--max-budget-usd` is still derived per cycle from `maxRunCostUSD −
spentGuardUSD`. Nothing new is produced for `buildSnapshot()`, `runs.spent_usd`
or OTLP, and `docs/agent/architecture.md`'s rule that the three sources are
never summed is not engaged.

**One thing it would owe if it worked, and it is the reason a guard question
exists at all.** A server-side edit changes what the provider bills for a turn
without changing anything this app writes or reads. The saving would appear in
the transcripts' `usage` blocks — the one source that could see it — and nowhere
else, and this app has no per-cycle readout of that. Which is Option A again,
and is the third option in this survey whose effect is invisible without it.

## What the operator sees, and how they override it by hand

**Sees nothing, and — the finding that decides this option — can change nothing,
including by hand.** Two override channels exist and both were probed.

**Argv.** `claude --help` at the pin carries no context-management flag; the
strings that would have to appear in a flag translation do not appear in the
binary in any assembling position. Counted as matches, not lines:

    $ B=/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
    $ for s in clear_at_least exclude_tools clear_tool_uses_20250919 \
               clear_thinking_20251015 compact_20260112 clear_tool_inputs \
               context_management contextManagement; do
        printf '%-26s %s\n' "$s" "$(grep -ao -- "$s" "$B" | wc -l)"; done

    clear_at_least               0
    exclude_tools                0
    clear_tool_uses_20250919     3
    clear_thinking_20251015      4
    compact_20260112             6
    clear_tool_inputs            2
    context_management          59
    contextManagement            1

Every one of the three `clear_tool_uses_20250919` occurrences, all six
`compact_20260112` and both `clear_tool_inputs` sit inside **embedded
documentation text** — escaped-newline markdown for the platform docs the CLI
ships, plus the vendored SDK's `toolRunner()` deprecation notice — never in
request assembly. Of the four `clear_thinking_20251015`, one is the `Gzp`
literal above, one is a decompressed data table entry for it, and two are
documentation. `contextManagement`'s single occurrence is a line in a
docs table describing the *Java* SDK's builder. `clear_at_least` and
`exclude_tools` are absent from the binary entirely: the two parameters that
would make the mechanism safe under `01-constraints.md`'s arithmetic are the two
that are not there at all.

**`--settings`.** The channel that does survive `--resume`, and the only other
place a per-install policy could be injected. A settings file was written
carrying the key under all three plausible spellings, plus a `SessionStart` hook
as a control that proves the file was read:

    $ cat settings-ctx2.json
    {
      "contextManagement":  { "edits": [ { "type": "clear_tool_uses_20250919", "keep": 3 } ] },
      "context_management": { "edits": [ { "type": "clear_tool_uses_20250919", "keep": 3 } ] },
      "hooks": { "SessionStart": [ { "hooks": [ { "type": "command",
                  "command": "touch /tmp/ctxctl-rev-721638d11c0b-1/marker.txt" } ] } ] }
    }

Three runs back to back, same recorder, same `CLAUDE_CONFIG_DIR`, same cwd, so
nothing but the `--settings` argument varied: a baseline, the file above, and a
third file carrying `contextEditing` and a `trigger` object as well.

    $ rm -f marker.txt
    $ claude -p "hi"                                 → bodyA.json   exit 0
    $ claude -p "hi" --settings settings-ctx2.json   → bodyB.json   exit 0
    $ claude -p "hi" --settings settings-ctx.json    → bodyC.json   exit 0

    $ ls -l marker.txt
    -rw-r--r-- 1 node node 0 Aug 22 02:26 marker.txt      ← the hook fired

    $ cmp bodyA.json bodyB.json && echo identical
    identical
    $ cmp bodyA.json bodyC.json && echo identical
    identical

The hook ran, so the file was read and applied. The request bodies are
**byte-identical**, metadata included: `context_management` still
`{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` in all three, no
warning on stderr, no error, no mention in the transcript. **The key is accepted
and silently ignored** — the worst failure shape `01-constraints.md` names,
arriving before the option is even built.

**Per run, mid-run, in Settings: no channel, so no design.** There is nothing to
put a boolean beside.

## How it fails, and whether loudly

**It has already failed, silently, and that is the finding.** An operator who
wrote the block into `--settings` today would get no warning, no error and no
symptom — the file's other keys would apply, the hook would fire, and the
context-management key would go nowhere. Anyone reading `docs/` afterwards would
believe the install had a context-editing policy.

**The second failure is the one that decides the recommendation rather than the
option.** Because the block is present on every request with `keep: "all"`, a
future CLI release that changes `Gzp`'s literal — from `keep: "all"` to a
number, or adding a `clear_tool_uses` edit — changes what every agent on this
install can see, at the API layer, with no argv change, no settings change, no
release note this app reads and no marker in the transcript. This app has no
assertion that would notice. That is a monitoring obligation this survey did not
previously know it had, and it belongs in `17-recommendation.md` rather than
here.

**Version pin.** Everything above is measured against `2.1.226 (Claude Code)`,
which is what `Dockerfile:215` pins (`ARG CLAUDE_CLI_VERSION=2.1.226`) and what
`claude --version` reports in the container. The vault's mechanism note is
`evidence: vendor`, `confidence: low`, and is documentation about the **API**,
not about the CLI — so nothing in the vault was refuted by these probes. What
they establish is narrower and entirely local: *the CLI at 2.1.226 does not
expose the API's mechanism to its caller.* On a later CLI that answer can change
without notice, and this file is a claim about one pin.

## What it costs to build

**Unbuildable at this pin, at any price.** There is no `args.push` that reaches
it and no settings key that reaches it. The three routes that would, in
ascending order of how much this app would have to become:

1. **Wait for the CLI to expose it.** Zero build cost, unknown date, and a
   version-bump surface: the flag would have `14-option-move-the-volatile-prefix.md`'s
   fleet-wide-argv failure shape, loud at the parser.
2. **A proxy.** Point `ANTHROPIC_BASE_URL` at a local process that injects the
   block into every request body. Technically sufficient — the recorder used for
   these probes is 66 lines and already intercepts exactly the right requests —
   and it means this app terminates its own agents' TLS, holds their credentials
   in a second place, and owns a component that silently breaks every run when
   the CLI's wire format moves. `docs/agent/security.md` is the wrong document
   to have to reopen for a cost optimisation. **Rejected as a shape, not merely
   as an effort.**
3. **Stop spawning the CLI.** Build the loop against the SDK, where
   `context_management` is a parameter. That is not an option in this survey; it
   is a different product.

**It earns no test.** There is no pure function.

## What would have to be true

**That the lever is reachable — and it is not.** That is the whole rejection,
and it is settled by five converging probes against the pinned binary rather
than by argument: the wire body, the producer function, the beta gate, the
string counts, and a `--settings` file whose own hook proves it was read while
its context-management key changed nothing.

**Option M is rejected by name, on the ground that at CLI 2.1.226 this app
cannot emit the mechanism.** Not because it is a bad mechanism — on the ten
headings above it is a better-shaped mechanism than most of the twelve the
survey scored, it is the only one that is server-side and stateless, and its
`clear_at_least` parameter is the survey's own break-even arithmetic shipped as
a vendor field.

**What would have to change for this file to be reopened**, in the order it is
worth watching for:

- `claude --help` grows a context-management flag, or the `--settings` schema
  grows the key. Either is a string search against a new pin and costs minutes.
- `Gzp`'s literal changes. That would mean the CLI has started clearing content
  on this install's behalf, and this survey's correctness criterion
  (`16-comparison.md`) applies to it whether or not anybody chose it.
- The measurements behind the correctness criterion get replicated, at which
  point the question stops being "can we clear context more cheaply" and becomes
  "should anything clear context at all" — which is a question this option
  answers worse than doing nothing, and better than Option F, because
  `clear_tool_uses` is documented as reversible-by-placeholder where a summary
  is not.

**And one thing this file does not claim.** It does not claim the mechanism
would help. Nothing here measures a saving; the block is inert on this install,
so there was nothing to measure. The case above is a case about *shape*, made
against a lever that cannot be pulled.
