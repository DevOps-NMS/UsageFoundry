# Limits and accuracy

[← Documentation index](README.md)

## The one thing to understand first

There are **two unrelated things** called "your Anthropic limits", and this tool
treats them separately on purpose:

| | Claude Code subscription (Pro/Max) | Console API account |
|---|---|---|
| What a "limit" is | 5-hour session window, weekly quota | rate limits (RPM / ITPM / OTPM), spend |
| Official API | `/api/oauth/usage` — **percentages only**, no numeric quota value | `/v1/organizations/rate_limits`, `/usage_report/messages`, `/cost_report` |
| How this tool reads it | percentages from that endpoint; volumes and costs by parsing `~/.claude/projects/**/*.jsonl` locally | Admin API, with an `sk-ant-admin01-…` key |
| Accuracy | **volumes and costs are exact; percentages are the provider's own, or estimates when it cannot be reached** | authoritative |

The **Dashboard** is the subscription view. The **API account** page is the
Console view, and stays empty unless you set an Admin key. They are never summed
together.

### ⚠️ What the subscription view can and cannot see

Your 5-hour and weekly limits are **shared across every Claude surface**. Only
Claude Code writes local transcripts, so only Claude Code is measurable here:

| Surface | Local data | Counted |
|---|---|---|
| Claude Code (terminal) | `~/.claude/projects/**/*.jsonl` | ✅ |
| Claude Code SDK | same, `entrypoint: sdk-cli` | ✅ |
| **Cowork** | Electron profile — no transcript, no usage ledger | ❌ |
| **Cowork scheduled tasks** | run in the cloud, device offline | ❌ |
| Claude Desktop / web / mobile | server-side | ❌ |

This is structural, not an oversight — there is no local file to parse, and the
authoritative figure lives behind the same undocumented endpoint the in-session
`/usage` command calls. The CLI exposes no scriptable equivalent.

**It fails unsafe.** If Cowork has consumed half your weekly window, the
dashboard still reads ~20% and an 80% guard will happily start a run that
overruns the real limit.

**Mitigation: reserved headroom.** Settings → *Reserved headroom* holds back a
percentage of every window for usage this tool cannot see. It shrinks the
effective ceiling everywhere — meters, guards, and projection — so guards trip
early instead of late. Set it roughly to the share of your Claude usage that
happens outside the terminal. Capped at 95%.

Numbers below are always a **floor** on real consumption.

**The reset time is derived, and can disagree with `/usage` by minutes.**
Anthropic sends the exact reset instant back on every API response, and Claude
Code reads it from there — but it lands on no transcript record, in no config
file, and in none of the telemetry the CLI exports, so there is nothing local to
copy it from. What this app does instead is apply the published rule: the window
opens with your first turn and runs five hours. Two things move that away from
the figure `/usage` shows, in opposite directions. It reads **late** by the
length of the turn that opened the window, because the transcript records the
response rather than the request — seconds, usually. And it reads **early**
whenever the window was really opened by a surface from the table above, which
this app cannot see at all. If the two are far apart, Settings → *5-hour window
reset (override)* pins the boundary to what `/usage` says.

> This used to round a window's start down to the top of the hour, which put the
> reset time up to 59 minutes early *and* rolled the window over that much too
> soon — showing an empty session, and re-arming the budget guard, while
> Anthropic was still counting the old one. If you recognise that, it is fixed;
> nothing needs re-configuring.

**It also cannot see a window that was reset for you.** The 5-hour block is
derived from your own turns: it opens at the first one after a gap and runs five
hours. Changing subscription tier restarts that window on Anthropic's side, and
nothing about it is written to a transcript — the entries still describe one
continuous block while the limit is being enforced against a window that started
later. Settings → *5-hour window reset (override)* takes the reset time
`/usage` prints and splits the block there: earlier work stays in history but
leaves the current window and the budget guard. It is inert once that reset has
passed, and the weekly quota is not touched.

### Ceilings are denominated in cost, not tokens

A Claude Code workload is **~98% cache reads**, which bill at 0.1×. A raw-token
ceiling therefore measures conversation length far more than it measures work,
and its ratio to any real limit drifts with context size. Cost already applies
the 0.1× / 1.25× / 2× multipliers, so it is the stabler proxy.

This is not a theoretical concern. On the same real usage, with two
plausible-looking ceilings:

| Ceiling | Reading |
|---|---|
| $50 equivalent API cost | **45%** |
| 20M raw tokens | **143%** |

Same work, 3.2× disagreement. Cost is the primary metric everywhere; raw-token
ceilings remain available as a fallback and render as a secondary line when both
are set.

### Where percentages come from

Token counts and dollar costs come straight from your transcripts and are exact.
A *percentage* needs a denominator, and Anthropic still publishes no numeric
value for a Max quota in any unit — but it will tell you the percentage itself.

`GET /api/oauth/usage`, authenticated with the OAuth token Claude Code already
keeps in `.credentials.json`, returns what `claude /usage` and claude.ai show:
utilisation and a reset instant for the 5-hour window, the week, and any weekly
wall scoped to one model family. That is a **first-party figure for the whole
account**, so unlike anything derived here it also counts the surfaces that
share your allowance and write nothing to this disk — the web app, Desktop,
Cowork. It leads every meter, and its reset instants anchor both windows.

This was not a refinement. Measured on one machine: the provider reported 5.0%
of the 5-hour window while the dashboard, dividing local spend by a hand-typed
$650 ceiling, showed 1.3%. The arithmetic behind that $8.49 was fine —
cross-checking 4,995 turns against Claude Code's own per-request OTLP cost put
`pricing.ts` within **0.8%** in aggregate — and the derived window boundary was
53 seconds off the provider's. The denominator was simply a guess, and no
adjustment to a token weight can repair a guessed denominator.

Three things to know about that source:

- **It is percentages, not numbers.** There is still no ceiling to read, and
  nothing here ever populates one by itself. **Settings → Estimate a ceiling
  from your own history** can now
  *divide* by it — a window that cost $71 and took 15% of the allowance implies
  a ~$474 ceiling — which is a measurement rather than the observed-peak lower
  bound below it. It errs the same way and for a new reason: the cost is Claude
  Code's and the percentage is every surface's, so a window that also held web
  or Desktop work divides part of the spend by all of the usage.
- **It can be unreachable** — an expired login, an offline container, or its own
  rate limiter (a handful of requests inside a minute earns a `429`). It is
  therefore cached on Claude Code's own cadence, a failure re-serves the last
  good reading rather than blanking a meter, and past an hour it falls back to
  the derived reading instead of passing off a stale percentage as current.
- **It is undocumented**, so every failure is a miss and never an error.

The weekly meter takes the **worst** of the all-model week and every
model-scoped wall it reports, because being cut off by the Opus week is being
cut off. An account whose payload names a scoped wall and *no* all-model figure
at all is the case worth stating on its own: that wall now stands as the weekly
reading rather than being dropped, which left the weekly guard on such an
account falling back to the derived reading — a reading that did not fire at 90%
of a week that was nearly spent. The meter still reports no all-model percentage
there, because the provider named none.

Turn it off with **Settings → "Read plan usage from Anthropic"**, and everything
below is what you get back — which is also what you get for a window the
provider did not answer for:

- With no ceiling configured, meters render **hatched** ("no ceiling set"), not
  at 0%. An empty bar would read as "plenty left", which is the opposite of
  "we don't know".
- **Settings → Estimate a ceiling from your own history** derives a ceiling from
  your own peak usage — press **Scan history** — reporting the
  costliest fully-elapsed 5-hour block, and the peak trailing-7-day total. Those
  are **lower bounds** on the real limit (you reached them without being cut
  off), so percentages computed against them read *high* rather than low — a
  guard trips early rather than late.
- Any budget rule expressed as a fraction (`stop at 80% of weekly`) is **refused
  outright** when no ceiling exists, rather than silently passing. A guard you
  believe is active but isn't is worse than no guard.

Percentages for a *calendar* day, week or month are a separate question with a
separate answer — see [Usage by period](#accuracy-notes) below.

---

## Accuracy notes

Two details that materially change the numbers, both handled:

**Deduplication.** Claude Code writes the same assistant message to disk more
than once (resumed sessions, sidechain replay, snapshot rewrites). Every copy
carries an identical `message.id` + `requestId`, which is used as the dedupe key.
On the transcripts this was developed against, **99 raw records deduplicated to
31** — summing naively would have over-reported by roughly 3×.

**Cache TTL pricing.** `cache_creation` splits into `ephemeral_5m` and
`ephemeral_1h`, which bill at **1.25×** and **2×** input respectively. Claude
Code leans on 1h writes, so collapsing both into one number understates spend on
exactly this workload. Cache reads are billed at 0.1×. Older records with no TTL
split are attributed to the cheaper 5m bucket, so an unsplit record understates
rather than overstates.

Models with no known price contribute **$0 to every reported figure and are
listed in a banner** — dollar totals are a floor, never a silent guess.

**The budget guard is the one exception, deliberately.** A displayed $0 means a
window consisting entirely of an unpriced model reads as 0% used, and no
threshold can ever be crossed — so the guard would quietly cease to exist the
week a new model ships. For guard purposes only, an unrecognised model is
charged a conservative **$10/$50 per Mtok**: the most expensive
current-generation rate in the table, so an unknown can never look cheaper than
something known. The meters draw that as a hatched band past the solid fill, so
a run stopped before the visible bar looks full is explained rather than
mysterious. Nothing shown as a dollar amount is ever the fallback rate.

**Cost attribution.** Beyond model and project, each turn is broken down by
**reasoning effort**, **agent**, and **skill** — all three recorded by Claude
Code on the transcript record itself, so the tables cover full history rather
than starting from the day they were added. Turns carrying no agent name or no
skill get explicit `(main thread)` / `(no skill)` buckets, so every column
reconciles to the window total instead of quietly omitting a remainder. Effort is
typically the largest single lever.

That column was *Sub-agent* while the only way a name could reach it was a turn
the main thread handed off. A run can now be **started as** an agent, so a name
here need not be a sub-agent at all, and `(main thread)` is a turn Claude Code
recorded no agent name on rather than a turn no agent produced. Nothing infers a
bucket either way — the rollup groups on what the transcript says, which is why
the word had to stop asserting more than the arithmetic does. Two things stay
separate from it: *Count sub-agent turns in usage totals* in Settings keys on the
record's own sidechain flag, which is a genuinely delegated turn, and the origin
chip beside a row says only where **this install** found a definition for that
name.

**What filled the context is a sixth reading and is deliberately not a sixth
breakdown.** The five above answer *who* spent the money; that card answers what
the money was spent carrying — tool results, which an agent puts into a session
once and then pays to re-read on every later turn. It cannot be a breakdown,
because a tool result is not a billable turn: it carries no usage block, no
model and no price, and what it costs is billed on the *next* assistant turn
mixed in with everything else placed beside it. So its rows are denominated in
**characters of tool output** and carry no dollar figure at all, nothing on it
reconciles to the window total, and no figure on it may be added to one above
it. What it does carry is a price for *placing* a token — the window's whole
bill over the tokens that entered a context in it, beside how many times the
average one was read back — and that price is a floor rather than an estimate,
because a re-written cache prefix counts twice in its denominator.

**The counterfactual column beside the agent breakdown is arithmetic, not a
forecast.** On the agent view each row carries a second dollar figure — these
exact turns, the same input, output and cache tokens, repriced at one tier-down
model's rate on the day each one ran. It says nothing about whether the same
task on that model would have taken the same number of turns; it cannot, since
those turns do not exist. The page says so under the table rather than leaving
it to be inferred, because a second dollar figure with nothing beside it is a
figure somebody will quote as a saving.

**Usage by period (day / week / month).** The two meters answer *may I start a
run right now*; the **Usage by period** card answers *what has this been
costing me*. It cuts the same deduplicated, same-priced entries into calendar
buckets — a fortnight of days, a quarter of weeks, a year of months — and shows
each one's cost, tokens, turns, and share of the ceiling. The toggle switches
between the three without a request: all three series ship on the same poll.

Two details are load-bearing.

*The buckets are cut in your timezone, not the container's.* The container runs
in UTC, so a 22:30 UTC turn is already tomorrow in Berlin, and bucketing it in
UTC would file an evening's work under the wrong day. The browser sends its own
zone (`/api/usage?tz=`), the server rejects anything that is not one and falls
back to its own, and the label is rendered from the same zone the boundary was
cut in. DST is handled by taking each bucket's end from the next bucket's
start, so the series is contiguous by construction — the 25-hour day when the
clocks go back is 25 hours long and nothing falls between two buckets.

*A day and a month have no published allowance, so their percentage is a pace.*
Anthropic enforces a 5-hour window and a weekly one and nothing in between. The
weekly ceiling is therefore the only configured number a calendar bucket can be
measured against: a **week** uses it as it stands, and a **day** and a **month**
get it spread evenly over their own length. The card says so in words on every
non-weekly view — *"your weekly ceiling spread over 31 days. Anthropic sets no
monthly limit, so this is a pace rather than an allowance"* — and the wording is
driven by the same value that produced the fraction, so the two cannot drift.
Nothing here reaches `evaluateBudget`: no guard has ever had a daily threshold
and this does not add one. With no weekly ceiling set, every bucket reads as the
hatched indeterminate meter, never 0%.

Weekly buckets follow the **weekly reset day** when one is configured, rather
than a calendar Monday, so the newest bucket is the same seven hours-to-the-
minute as the weekly meter above it. Buckets that closed before your first
recorded turn are dropped rather than shown as `$0.00`, so a fresh install sees
the days it has instead of thirteen empty ones above them.

**Agent self-reporting (optional, off by default).** Claude Code computes a cost
for every API request and will push it to any OTLP endpoint. Turning on *Agent
self-reporting* in Settings points agents this app spawns back at this server,
which records one row per request — a first-party number that needs no price
table, no dedupe key, and no file polling. It is shown as its own card on the
run page and its own card on the dashboard, and is **never** merged into
`spent_usd`, the dashboard's meters, or the budget guard, all of which stay
transcript-derived.

Its one real advantage: per-iteration spend normally comes from the CLI's
terminal `result` event, so a work cycle killed before that event reports $0.
Telemetry arrives per request as the run proceeds, so it captures that work. A
telemetry figure *higher* than the run's own total is the expected outcome of an
interrupted run, not a discrepancy.

The same property is why it is on the dashboard. Because per-cycle spend is only
reported when a cycle *ends*, a run that has been working for twenty minutes
reads $0 everywhere until it finishes — so nothing on the page attributed the
week's most expensive activity to the thing currently doing it. The **Live from
runs** card covers the same five hours as the session meter, lists the heaviest
runs by name with their status, and says how long ago the last request landed.
It is a third reading rather than a correction: the meters count every Claude
Code session on this machine through our price table, the card counts one class
of session through Anthropic's own, and the work overlaps — so the two are shown
side by side and never added. While a run is working the dashboard polls every
**60 seconds** instead of 120 — minutes rather than seconds either way, because
every poll re-aggregates the whole transcript history and the agent the page is
watching wants the same CPU. A run's own page is the exception, at 3 seconds,
because what it asks for is one row rather than a rollup and the log beside it
arrives over a stream rather than on the poll at all; it stands down completely
once the run reaches an ending it cannot move from, and re-arms if an event says
somebody picked it up again.

It cannot replace the transcript scan: there is no historical backfill, no `cwd`
so no per-project attribution, and `cache_creation_tokens` is a single number
with the 5m/1h split collapsed. The payload also carries `user.email` and
account UUIDs — none of which are stored.

Provider-decorated model IDs are canonicalised before lookup — Bedrock's
`us.anthropic.claude-…-v1:0` and Agent Platform's `claude-…@20250929` resolve to
the same rates as the first-party IDs. No short catch-all keys are used: a
hypothetical `claude-opus-4` key would price an unreleased `claude-opus-4-9` at
a confident wrong number instead of surfacing it as unknown.
