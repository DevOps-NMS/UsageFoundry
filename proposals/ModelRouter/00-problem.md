# Who picks the model, and what that costs

Everything below was read out of the tree at `2362283` — this branch's head when
the reading was taken — or measured from this install's own transcripts on
2026-08-20. Commands and their output are quoted rather than described; a figure
with no command beside it is not in this file.

## One setting decides, and nothing else does

`settings.defaultModel` is the only control an operator has. It is a free-form
string, `null` by default (`src/lib/settings.ts:86`, `:611`), typed into one
text box on the Settings page under the heading "Runs"
(`src/app/settings/page.tsx:2229`–`2248`), whose placeholder is "Claude Code's
own default".

`createRun` copies it onto the row at INSERT:

    input.model ?? settings.defaultModel        src/lib/orchestrator.ts:3205

`runs.model` is `TEXT` and nullable (`src/lib/db.ts:146`). `input.model` is on
the wire — `CreateRunInput.model` at `src/lib/orchestrator.ts:2559`, read from
the body at `src/app/api/runs/route.ts:233` — but **nothing this app ships ever
sets it**. The new-run form has no model control. `grep -n model
src/app/runs/new/page.tsx` returns four hits and not one of them is an input:
two are comments, one is a line of copy about the *agent's* model
(`:1527`–`1537`), and the last is the template picker's own description —
"Keeps the task, the limits and how it behaves. Not the model — that stays a
single global setting" (`:2209`). Neither do the two server-side creation paths:
`grep -n "model" src/lib/workflows.ts src/lib/chat.ts` finds no `model:` key at
any of the five `createRun` call sites (`src/lib/workflows.ts:3243`, `:4295`,
`:4720`, `:5441`, `src/lib/chat.ts:933`). So every run this install has ever
started took `settings.defaultModel`, whatever it was at that moment.

It is then never changed. `grep -rn "SET model" src/` returns nothing: no route,
no sweeper and no guard writes `runs.model` after the INSERT. `reopenRun`
(`src/lib/orchestrator.ts:8080`) carries it forward by not touching it, the same
way it carries the permission mode and the agent.

And it is displayed nowhere. `RunDTO.model` exists (`src/lib/apiTypes.ts:559`),
but `grep -rn "\.model" src/app src/components --include=*.tsx` finds it on no
page — the run detail page renders the *agent's* model
(`src/app/runs/[id]/page.tsx:1329`–`1331`) and the review card renders the
*review's* (`src/components/RunReview.tsx:44`), and neither is the run's own.

## What carries the choice onto a process

Three of the four kinds of agent child (`docs/agent/architecture.md:131`) get
the run's model; the fourth gets the setting directly.

**The work cycle.** `buildArgs` pushes it first:

    if (opts.model) args.push("--model", opts.model);     src/lib/orchestrator.ts:4843

and is called from *inside* the cycle loop — `for (;;)` opens at
`src/lib/orchestrator.ts:6412`, `buildArgs({ … model: run.model … })` is at
`:6701`–`:6703` — so the flag is rebuilt and re-sent on **every** cycle,
including a resumed one. That is asserted rather than assumed
(`src/lib/orchestrator.test.ts:2353`, "still passes the mode, the model and the
session to resume"). It matters for a reason `--plugin-dir` recorded first: that
flag is *not* restored by `--resume`, so a version that only sent it on the
opening cycle would silently drop it thereafter
(`src/lib/orchestrator.ts:4824`–`4838`). Whether `--model` would have survived
`--resume` on its own is **not measured here** and does not need to be, because
`buildArgs` re-sends it either way — but an option that proposes to *stop*
sending it on later cycles is proposing to depend on an unmeasured property.

**The reviewer and the conflict resolver**, which are one spawn site with two
kinds (`AssistKind = "review" | "resolve"`, `src/lib/review.ts:51`):

    if (run.model) args.push("--model", run.model);       src/lib/review.ts:624

So `runs.model` decides what an on-demand review of a diff costs and what a
merge-queue conflict resolution costs, and the review's copy is recorded
separately on `run_reviews.model` (`src/lib/db.ts:218`) precisely so its cost is
never folded into `runs.spent_usd` (`src/lib/db.ts:206`–`211`).

**The orchestrator chat and its blocks** skip the run entirely:

    if (settings.defaultModel) args.push("--model", settings.defaultModel);   src/lib/chat.ts:1699

## Four records deliberately hold none, and the reasons are written down

A router that decides per run, per node or per proposal is proposing to overturn
four separate decisions. Each has an argument beside it in the tree.

**A template.** `run_templates` has no model column, and
`src/lib/templates.ts:35`–`38` says why:

> **The model.** `settings.defaultModel` already sets it globally and the run
> form does not offer it at all. Two places to set one thing is how they drift,
> and the second place would be the one nobody remembers to check.

**A workflow node.** `src/lib/db.ts:367`–`370`:

> No guards, no permission mode, no model: a node names a template for those, or
> names none and takes `settings.chatDefaultGuards`. […] the graph picks what
> work to do, something a person wrote picks what an agent may do.

**A chat proposal.** `src/lib/db.ts:616`–`619`:

> What it deliberately does *not* hold: guards, a permission mode, a model.
> Those come from the template it names, or from `settings.chatDefaultGuards`
> when it names none, and either way from something a person wrote.

**An orchestrator block's run spec.** `src/lib/workflows.ts:1345`–`1351`:

> Five fields, and the list is the boundary rather than a starting point […]
> There is no template id, no budget, no permission mode, no isolation choice
> and no model, because the block's own template already answered all of those.

Three of the four are about a *model* writing the record. The template's is not:
it is about drift between two human-editable places. A router is a fifth writer
and would have to answer both objections separately.

## The one record that does hold a model, and the measurement that keeps it safe

A saved agent may carry one (`src/lib/agents.ts:121`, column at
`src/lib/db.ts:289`). Under `--agents` alone that was a *delegated sub-turn's*
model, which nothing else here can express; selected with `--agent` it is the
**session's**. What stops it being a second place to set the run's model is
measured off the `system`/`init` event on the pinned CLI, quoted at
`src/lib/agents.ts:99`–`110`:

    --agents '{"uf-m":{…,"model":"sonnet"}}'                 → claude-opus-5[1m]
    --agents '{"uf-m":{…,"model":"sonnet"}}' --agent uf-m    → claude-sonnet-5
    --model opus  … --agent uf-m                             → claude-opus-5
    --model haiku … --agent uf-m                             → claude-haiku-4-5-20251001

An explicit `--model` outranks the agent's pin, so the agent's fills a gap the
run left. `buildArgs` passes one whenever the run has one, and
`orchestrator.test.ts:2207` pins this app's half: a run with a model of its own
still emits it, unchanged, when an agent naming another is selected.

Note what that precedence means for a router. `settings.defaultModel` being
non-null makes *every* run carry an explicit `--model`, which means the agent's
own pin is unreachable on this install for as long as that box has text in it.

## What this install actually spends

The live database is **not readable from here**, and that is deliberate rather
than an accident of this shell: `DATA_DIR` is `/data` (`docker-compose.yml:188`),
a named volume (`:272`), and `docker-compose.yml:35`–`36` says why an agent
cannot open it — "/data is root-owned 0700, so an agent cannot rewrite a budget,
a status or a permission mode straight in the database". From inside a work
cycle:

    $ ls -ld /data          →  drwxr-xr-x 2 node node 40
    $ ls -la /data          →  (empty)
    $ find / -maxdepth 4 -name usagefoundry.db
      /workspace/UsageFoundry/.data/usagefoundry.db     (and the same file via /workspace3, /workspace4)
    $ sqlite3 -readonly /workspace/UsageFoundry/.data/usagefoundry.db "SELECT count(*) FROM runs;"
      0

That last file is a `npm run dev` artifact — `DATA_DIR` defaults to
`process.cwd()/.data` (`src/lib/config.ts:281`) — and only four of its 21 tables
hold a row (`chat_sessions`, `ops_events`, `request_log`, `settings`), none of
them `runs`. So **no figure below comes from `runs.spent_usd`, `run_reviews` or
`otlp_requests`.** They come from the transcripts, which is the source
`buildSnapshot()` itself reads (`src/lib/transcripts.ts:406` →
`src/lib/windows.ts:669`), through this app's own `scanUsage()` and `pricing.ts`
rather than through arithmetic written for this document.

Everything below was produced by compiling `src/lib/` and calling those
functions:

    $ node_modules/.bin/tsc -p tsconfig.test.json --outDir /tmp/ufb-721638d11c0b

The window is the rolling seven days, which is what `weekStart(now, null)`
returns when no anchor is set (`src/lib/windows.ts:276`–`277`), and
`settings.weeklyAnchor` defaults to `null` (`src/lib/settings.ts:606`). That
this install has not overridden it is **assumed** — the settings row is in the
database above.

**One model does 99.3% of the spending, because one setting picked it.**

    $ node -e '
      const {scanUsage}=require("/tmp/ufb-721638d11c0b/lib/transcripts");
      scanUsage().then(s=>{
        const w=Date.now()-7*24*3600*1000, e=s.entries.filter(x=>x.ts>=w), m={};
        for(const x of e) m[x.model]=(m[x.model]||0)+x.costUSD;
        const t=e.reduce((a,x)=>a+x.costUSD,0);
        console.log("turns",e.length,"total $"+t.toFixed(2),"unpriced",JSON.stringify(s.unpricedModels));
        for(const [k,v] of Object.entries(m).sort((a,b)=>b[1]-a[1]))
          console.log(k.padEnd(26), "$"+v.toFixed(2), (100*v/t).toFixed(1)+"%");
      });'

    turns 28868 total $4080.13 unpriced []
    claude-opus-5              $4050.90 99.3%
    claude-sonnet-5            $28.99 0.7%
    claude-haiku-4-5-20251001  $0.25 0.0%
    <synthetic>                $0.00 0.0%

Four model strings in a week, and the price table placed every one that spent a
token — `unpricedModels` is empty, and `<synthetic>` is absent from it by design
because it carries an all-zero usage block (`src/lib/transcripts.ts:268`–`274`).

## Something is already routing, and it is not this app

The obvious reading of that table — one model, one setting, nothing to see — is
wrong, and the way it is wrong is the most useful fact in this file. Splitting
the same window by sub-agent bucket *and* model:

    $ node -e '
      const {scanUsage}=require("/tmp/ufb-721638d11c0b/lib/transcripts");
      scanUsage().then(s=>{
        const w=Date.now()-7*24*3600*1000, e=s.entries.filter(x=>x.ts>=w), by=new Map();
        for(const x of e){ const k=(x.agent??"(main thread)")+" | "+x.model;
          const v=by.get(k)||{c:0,n:0}; v.c+=x.costUSD; v.n++; by.set(k,v); }
        for(const [k,v] of [...by].sort((a,b)=>b[1].c-a[1].c))
          console.log("$"+v.c.toFixed(2).padStart(9), String(v.n).padStart(6), k);
      });'

    $  3592.72  21550 (main thread) | claude-opus-5
    $   290.13   4035 workflow-subagent | claude-opus-5
    $   115.63   1033 Explore | claude-opus-5
    $    53.69    948 general-purpose | claude-opus-5
    $    28.58   1231 general-purpose | claude-sonnet-5
    $     0.23     11 (main thread) | claude-haiku-4-5-20251001
    $     0.22      5 (main thread) | claude-sonnet-5
    $     0.16     13 Explore | claude-sonnet-5
    $     0.03      1 uf-probe-sub | claude-sonnet-5
    $     0.02      2 general-purpose | claude-haiku-4-5-20251001
    $     0.00     48 (main thread) | <synthetic>

**Every main-thread dollar in the window is `claude-opus-5`** — the $0.45 that
is not spans 16 turns across six directories, five of them scratch paths under
`/tmp` or `/private/var/folders` and the sixth a one-turn probe inside a
worktree ("Without using any tool: am I in a linked worktree…"). None of them is
a work cycle. So yes: every work cycle in the window ran on the one setting.

But `general-purpose` ran 948 turns on Opus and 1,231 on Sonnet in the same
week, and `Explore` ran 13 turns on Sonnet. Nothing in this app asked for that.
`general-purpose` and `Explore` are the CLI's own built-in agents — they appear
in the "Available agents" list this repository measured off the pin and quoted
at `docs/agent/agents-and-templates.md:10` (`claude, Explore, general-purpose,
Plan, statusline-setup, typescript`) — and this app defines neither and stores
no model for either. It could not, even by accident: `normalizeAgentInput`
refuses a saved agent whose name is in `BUILT_IN_AGENTS`
(`src/lib/agents.ts:179`–`185`, `:284`–`:292`), and both are on that list, so
neither name can reach an `--agents` payload this app builds. `runs.model`
reaches the session; what a delegated turn runs on is decided somewhere below
it.

Only three sessions in the window contain a delegated Sonnet turn, and two of
them have an Opus main thread:

    sessions with delegated sonnet turns: 3
      feb3ca7b main-thread models: claude-sonnet-5 | main $0.19  | sonnet-sub $0.03
      92c4e4ea main-thread models: claude-opus-5   | main $17.23 | sonnet-sub $24.34
      c3566197 main-thread models: claude-opus-5   | main $30.76 | sonnet-sub $4.40

(same scan, grouping the window's entries by `sessionId` and splitting on
`agent`.) In `92c4e4ea` the delegated turns cost more than the session that
delegated them.

That is a routing decision, in production, on this install, today, taken below
the level this app operates at. Its policy is not visible here and this app
cannot read it. Whether `settings.defaultModel` was non-null for those two runs
— and therefore whether an explicit `--model` was on their argv while their
delegates ran on Sonnet — is **not verified**: the settings row lives in the
database that is unreadable from a work cycle, and the transcripts do not record
the argv. What *is* verified is that a saved agent's model does not reach a
delegated turn any more (`src/lib/agents.ts:88`–`96` — that is precisely the
meaning `--agent` took away), so this app has no expressible way to set one.

Any option that proposes to choose a model for delegated work is therefore
proposing to *displace* an existing mechanism rather than fill a gap, and has to
say what happens when the two disagree.

## What a run costs, and where the money is inside it

**A run costs $4.75 to $66.66, and the spread is not the model.**

    $ node -e '
      const {scanUsage}=require("/tmp/ufb-721638d11c0b/lib/transcripts");
      scanUsage().then(s=>{
        const by=new Map();
        for(const x of s.entries){ if(!x.project.includes("/.uf-worktrees/")) continue;
          const v=by.get(x.sessionId)||{c:0,n:0,syn:true}; v.c+=x.costUSD; v.n++;
          if(x.model!=="<synthetic>") v.syn=false; by.set(x.sessionId,v); }
        const all=[...by.values()].filter(v=>!v.syn).map(v=>v.c).sort((a,b)=>a-b);
        const q=p=>all[Math.floor(p*(all.length-1))];
        console.log("sessions",all.length,"min $"+q(0).toFixed(2),"p25 $"+q(.25).toFixed(2),
          "median $"+q(.5).toFixed(2),"p75 $"+q(.75).toFixed(2),"p90 $"+q(.9).toFixed(2),
          "max $"+q(1).toFixed(2),"sum $"+all.reduce((a,b)=>a+b,0).toFixed(2));
        const long=[...by.values()].filter(v=>!v.syn&&v.n>=50).map(v=>v.c).sort((a,b)=>a-b);
        console.log(">=50 turns: n",long.length,"min $"+long[0].toFixed(2),
          "median $"+long[Math.floor(long.length/2)].toFixed(2),"max $"+long[long.length-1].toFixed(2));
      });'

    sessions 304 min $0.03 p25 $4.23 median $8.72 p75 $17.05 p90 $28.03 max $66.66 sum $3695.05
    >=50 turns: n 179 min $4.75 median $13.97 max $66.66

One `.jsonl` under a `.uf-worktrees/` project directory is one resumed
conversation, and because `buildArgs` passes `--resume` on every cycle after the
first, that is one run's whole segment. It is a *proxy* for a run and not the
row: a run picked back up after a pause opens a second session, and the
`runs`-row figure would differ. Taking only the 179 sessions of fifty turns or
more — long enough to be work rather than a probe — **the dearest is 14 times
the cheapest, and every one of them ran on the same model.** Whatever produces
that spread, it is the task, not the pin.

**Cache reads are the largest line, and a model swap is a flat multiplier.**

    $ node -e '
      const {scanUsage}=require("/tmp/ufb-721638d11c0b/lib/transcripts");
      const {resolvePrice,addTokens,ZERO_TOKENS,costOf}=require("/tmp/ufb-721638d11c0b/lib/pricing");
      scanUsage().then(s=>{
        const w=Date.now()-7*24*3600*1000, e=s.entries.filter(x=>x.ts>=w);
        const t=e.reduce((a,x)=>addTokens(a,x.tokens),ZERO_TOKENS);
        const p=resolvePrice("claude-opus-5");
        const parts={input:t.input*p.input, output:t.output*p.output,
          cacheRead:t.cacheRead*p.input*0.1, cacheWrite5m:t.cacheWrite5m*p.input*1.25,
          cacheWrite1h:t.cacheWrite1h*p.input*2.0};
        const tot=Object.values(parts).reduce((a,b)=>a+b,0)/1e6;
        for(const [k,v] of Object.entries(parts))
          console.log(k.padEnd(13),"$"+(v/1e6).toFixed(2),(100*v/1e6/tot).toFixed(1)+"%");
        console.log("all at opus-5 rates $"+tot.toFixed(2));
        for(const m of ["claude-sonnet-5","claude-haiku-4-5"])
          console.log("same tokens at",m,"$"+costOf(t,resolvePrice(m)).toFixed(2));
        const sub=e.filter(x=>x.agent);
        const st=sub.reduce((a,x)=>addTokens(a,x.tokens),ZERO_TOKENS);
        console.log("sub-agent turns",sub.length,"actual $"+sub.reduce((a,x)=>a+x.costUSD,0).toFixed(2),
          "| at sonnet-5 $"+costOf(st,resolvePrice("claude-sonnet-5")).toFixed(2),
          "| at haiku-4-5 $"+costOf(st,resolvePrice("claude-haiku-4-5")).toFixed(2));
      });'

    input         $1.72 0.0%
    output        $495.62 12.0%
    cacheRead     $2560.48 62.1%
    cacheWrite5m  $205.24 5.0%
    cacheWrite1h  $861.87 20.9%
    all at opus-5 rates $4124.93
    same tokens at claude-sonnet-5 $1649.97
    same tokens at claude-haiku-4-5 $824.99
    sub-agent turns 7263 actual $488.24 | at sonnet-5 $212.59 | at haiku-4-5 $106.30

Two things fall out of that split, and both bear on what a router could be worth.

First, **62% of the bill is cache reads and 21% is 1-hour cache writes** — 83%
of the money is context being carried between turns, not answers being
generated. Those classes are multiples of the model's own *input* rate
(`src/lib/pricing.ts:16`–`18`), so they scale with the pin exactly as everything
else does; the counterfactual lines above are therefore uniform ratios rather
than a mix. Today `claude-sonnet-5` is 0.400× `claude-opus-5` and
`claude-haiku-4-5` is 0.200×. The Sonnet figure is temporary: it is running on
introductory pricing that ends 2026-09-01 (`src/lib/pricing.ts:68`–`69`), after
which 3/15 against 5/25 makes it 0.600×.

Second, those numbers are **counterfactuals on a fixed token count, and that is
the assumption the whole case rests on.** They say what this week's traffic
would have cost at another model's rates. They do not say a cheaper model would
have emitted the same tokens, and the honest prior is that it would emit more —
more tool calls, more re-reads, more cycles. Nothing in this install measures
that, and nothing in this file claims it.

**Sub-agent turns are where the counterfactual is least unsafe, and they are
also where somebody is already acting on it.** 7,263 of the week's turns carry
an `attributionAgent` (`src/lib/transcripts.ts:263`–`264`, surfaced as `byAgent` in
`src/lib/windows.ts:877`), costing $488.24 — 12% of the window. Their bucket
split, from the same scan:

    workflow-subagent   $290.13   4035 turns
    Explore             $115.79   1046 turns
    general-purpose      $82.29   2181 turns

$28.60 of that is already on Sonnet or Haiku, per the split above, so the part
still on Opus is $459.62. That the CLI moved 1,231 `general-purpose` turns onto
Sonnet and left 948 on Opus, inside the same week, is the strongest available
evidence that per-turn routing is *tractable* — and the strongest available
warning that a second router would be arguing with the first. A delegated turn's
model is also the one thing this app *could* express before `--agent` and no
longer can: `SavedAgent.model` was exactly that field
(`src/lib/agents.ts:88`–`96`).

**And the case that started this proposal.** On 2026-08-19 this repository ran a
documentation wave: four read-only audits at 19:00 ("**Do not fix anything.**
[…] file one GitHub issue per confirmed drift"), then four runs from 19:38 that
implemented the resulting `documentation` issues. The whole branch diff behind
them is `git diff --stat 7a07962..HEAD` → 36 files, 731 insertions, of which
`src/` is two files and +65 lines. Their cost:

    $ node -e '
      const {scanUsage}=require("/tmp/ufb-721638d11c0b/lib/transcripts");
      const {costOf,resolvePrice,addTokens,ZERO_TOKENS}=require("/tmp/ufb-721638d11c0b/lib/pricing");
      scanUsage().then(s=>{
        const a=Date.parse("2026-08-19T18:55:00Z"), b=Date.parse("2026-08-19T21:00:00Z");
        const ids=new Set(), first=new Map();
        for(const x of s.entries){ if(!x.project.includes("721638d11c0b")) continue;
          first.set(x.sessionId, Math.min(first.get(x.sessionId)??Infinity, x.ts)); }
        for(const [id,t] of first) if(t>=a&&t<=b) ids.add(id);
        const e=s.entries.filter(x=>ids.has(x.sessionId));
        const tok=e.reduce((t,x)=>addTokens(t,x.tokens),ZERO_TOKENS);
        const cost=e.reduce((t,x)=>t+x.costUSD,0);
        const w=Date.now()-7*24*3600*1000;
        const week=s.entries.filter(x=>x.ts>=w).reduce((t,x)=>t+x.costUSD,0);
        console.log("sessions",ids.size,"turns",e.length,"actual $"+cost.toFixed(2),
          (100*cost/week).toFixed(2)+"% of the weekly window");
        for(const m of ["claude-sonnet-5","claude-haiku-4-5"])
          console.log("  same tokens at",m,"$"+costOf(tok,resolvePrice(m)).toFixed(2));
      });'

    sessions 8 turns 647 actual $74.80 1.83% of the weekly window
      same tokens at claude-sonnet-5 $29.92
      same tokens at claude-haiku-4-5 $14.96

Individually: the four audits were $12.15, $9.21, $7.52 and $6.29; the four
implementation runs $6.88, $9.82, $11.64 and $11.29. Eight runs, one of which
was forbidden from writing a file at all, that between them edited markdown and
opened issues — for $74.80, at the same rate the run that added the orchestrator
block was charged.

## What a router would prevent, stated as the measurement allows

Not "cost savings". The specific failure is this: **this install has exactly one
model control, it is global, no surface reads it back, and it is the same
decision for every kind of work the app runs.** The eight documentation runs of
2026-08-19 and the $66.66 run at the top of the distribution came out of one
text box last touched some time before either; the cheapest of the eight spent
$6.29 auditing `CLAUDE.md` and `README.md` under an instruction forbidding it to
edit anything.

The prize is small and worth naming exactly. On that wave: $74.80 actual against
$29.92 at Sonnet's rates today, a difference of $44.88, or **1.1% of the weekly
window**; from 2026-09-01 the same comparison is $44.88 and the difference is
$29.92, or 0.7%. On sub-agent turns, the larger target: $488.24 against $212.59,
a difference of $275.65, or **6.8% of the window** — and $28.60 of that has
already been taken by whatever is routing `general-purpose` today.

Two things follow, and they point in opposite directions. The measurement
**does not** support a router justified by aggregate savings: 83% of the bill is
carried context rather than generated answers, the spread between runs is
fourteen times *at a constant model* so none of it is the pin's doing, and every
cheaper-model figure here is a fixed-token-count counterfactual that a real run
would not hold. A router sold on "spend less" is being sold on an unmeasured
assumption. The measurement **does** support the narrower complaint that a
single global text box is the wrong shape for the decision — a read-only audit,
a delegated `Explore` turn and a multi-cycle implementation run are three
different asks answered by one string; the wire already carries
`CreateRunInput.model` per run and `SavedAgent.model` per agent, and no surface
this app ships sets the first or can reach the second while the text box has
anything in it.

Which of those two the option survey is answering has to be settled before the
options are read, because they do not have the same answer. If it is the first,
the honest recommendation may be to build nothing until somebody measures a
cheaper model doing one of these tasks end to end.
