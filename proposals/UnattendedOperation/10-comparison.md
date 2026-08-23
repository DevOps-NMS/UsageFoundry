# Comparison

Nine criteria, weighted, then the four places the table misleads. The weights are
justified before the scores, because a weighted table is an argument about weights.

## The criteria and why they weigh what they do

| # | Criterion | Weight | Why |
|---|---|---|---|
| 1 | **Latency removed on the two interrupt rows** | **8** | The brief's instruction is explicit: "Score each on how much operator latency it actually removes, not on how modern it is." C1 identifies the two rows where waiting costs money or capacity rather than attention — row 3's 429 ladder holding three resources for ~17-26 minutes, and row 8's dead login compounding across every admitted run. This criterion *is* the question, so it outweighs the next two combined |
| 2 | Coverage of all nine rows, with identity rather than a count | 3 | Breadth matters, but a channel covering seven digest rows is worth less than one covering two interrupt rows, and criterion 1 already pays for the latter |
| 3 | **What leaves the machine** | 5 | The brief's hard constraint. `docs/agent/security.md` and `src/lib/status.ts:25-27` both refuse to export what this install works on |
| 4 | **Credential surface added** | 4 | `docs/agent/security.md:22`: "A monitor must not be handed the credential that starts agents." Every new secret is a new thing to hold, rotate and leak |
| 5 | Code cost, discounted by whether its failure is silent | 3 | `CLAUDE.md`: "nearly every one of them fails **silently**". A silent failure in a notifier is worse than no notifier, so cost and failure-mode are one criterion rather than two |
| 6 | Standing decisions touched | 3 | Four runtime dependencies, nine panes, no clock on the landing path, one credential shape per subject. An option touching one of these is proposing to change it |
| 7 | Recurring money | 1 | Every option is at or near zero for one operator. Low weight because it does not discriminate |
| 8 | Verifiability from inside this container | 2 | C9 and C10: no browser at any viewport, no run history, no provider contacted. Low weight because it is a property of this survey rather than of the option |
| 9 | Does a delivery failure announce itself? | 4 | The survey's most repeated finding. A channel the operator trusts and that has silently stopped is strictly worse than the current state |

## The table

Scored 0-5, higher is better, as the mechanism stands today with no prerequisite
work assumed.

| Option | 1 (×8) | 2 (×3) | 3 (×5) | 4 (×4) | 5 (×3) | 6 (×3) | 7 (×1) | 8 (×2) | 9 (×4) | **Total** |
|---|---|---|---|---|---|---|---|---|---|---|
| **A** change nothing | 1 | 2 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **124** |
| **B** in-app digest | 2 | 4 | 5 | 5 | 3 | 4 | 5 | 3 | 4 | **121** |
| **C** outbound webhook | 3 | 4 | 4 | 3 | 4 | 4 | 5 | 4 | 4 | **121** |
| **G** narrow-viewport page | 2 | 4 | 5 | 5 | 2 | 3 | 5 | 1 | 4 | **111** |
| **H2** orchestrator chat | 0 | 3 | 5 | 5 | 4 | 4 | 2 | 4 | 5 | **108** |
| **F** chat-channel bot | 4 | 4 | 2 | 2 | 4 | 4 | 5 | 2 | 3 | **107** |
| **H1** MCP tool | 1 | 4 | 5 | 1 | 2 | 1 | 5 | 4 | 5 | **91** |
| **D** web push | 4 | 4 | 2 | 2 | 1 | 2 | 5 | 1 | 1 | **82** |
| **E** email | 1 | 5 | 1 | 2 | 2 | 1 | 3 | 2 | 1 | **56** |

Maximum 165. **Nothing scores 5 on criterion 1**, and that is the survey's central
result rather than a rounding artefact: no option reaches both interrupt rows,
because they need opposite mechanisms (`01-constraints.md` C1). A subscriber gets
row 3 and misses row 8; a reader gets row 8 and misses row 3.

Four cells worth restating: A's 1 on criterion 1 (an operator's existing log
shipper filtering `level:error` does catch the 429 ladder today, mixed
indistinguishably with real failures); C's 3 (row 3 directly, row 8 never); D's 1
on criterion 5 (300-500 lines of hand-written RFC 8291 crypto whose bugs return
201 and deliver nothing); and E's 1 on criterion 9 (a spam-foldered message is a
202 Accepted).

## Where the table misleads

Four places, and the first is the one that decides how to read the result.

### 1. The null wins by 3 points, and the 3 points are made entirely of costs avoided

A at 124, B and C tied at 121. That is a real result and it should not be
massaged: the top three are within one scoring step of each other, so **the
table does not choose between them.**

But look at where A's margin comes from. On criteria 1 and 2 — the two that
measure whether an operator learns anything — A scores 1 and 2, against B's 2 and
4 and C's 3 and 4. A wins on the other seven criteria, six of which measure cost
avoided. So the honest reading is: *the null is cheapest by a margin that is
smaller than the measurement error in these scores, and it is worst at the thing
being surveyed.*

That is why `11-recommendation.md` does not simply take the table's top row. It
takes the part of A that is free, adds the two projection repairs that cost almost
nothing, and then makes the B-versus-C choice on a fact the table cannot contain —
whether the operator has a receiver.

### 2. F is not an alternative to C. It is C's receiver, and the 14-point gap is the price of the leak

Option F is one `fetch` with a vendor-shaped body — Option C plus a formatter, per
`07-option-f-chat-bot.md`. So the two rows are not competing designs. Read
together they say something more useful than either score: **the same mechanism is
worth 121 when the destination is unspecified and 107 when the destination is a
chat channel**, even though F scores a full point *higher* on criterion 1 because
it actually arrives on the operator's phone. The 14-point swing is criteria 3 and 4
— the permanent searchable multi-reader store, and a bearer credential in a URL
that cannot be signed — outweighing the delivery gain.

That difference is a decision the operator makes in their own `.env`, not one the
app makes for them. Which is the strongest argument in the survey for shipping the
generic mechanism and documenting the vendors rather than building per-vendor
integrations.

### 3. Criteria 3, 4, 5, 6, 7 and 9 all reward inaction, and they sum to 20 of 33

Six of nine criteria — 20 weight of 33 — measure *cost avoided* rather than *value
delivered*. An option that does nothing scores full marks on all six, which is why
A reaches 124 while removing almost no latency, and why H2 reaches 108 while
proposing to pay a model to run a `SELECT`.

This is not a fixable defect in the table; it is what happens when the constraints
are real. It does mean the table should be read as **"what does this cost against
the null"** rather than as a ranking, and it means an option that beats A does so
on criteria 1 and 2 alone. Only C and B do.

### 4. Two options are not really in the running and their scores flatter them

**G** at 111 is Option B with a different stylesheet, and its own file hands the
question back to `docs/verification.md:1113-1250` rather than scoring it. Its
score is B's minus verifiability, and it should not be read as a fourth-place
candidate.

**H1** at 91 is dominated by criterion 4, where it scores 1 — not because a
read-only MCP tool is dangerous, but because reaching it requires a fifth
credential shape on a route whose `middleware.ts` exemption comment says the
exemption and the in-route check must be kept together. The tool is forty lines.
The security design is the option, and it is not a notification decision.

## What the table does not contain

**Frequency.** C10: `/data` is `Permission denied`, the stale in-checkout database
has zero `runs` rows and one `ops_events` row. No option is weighted by how often
its target state occurs, because that number does not exist on this machine. Every
criterion-1 score is a claim about a mechanism's latency, not a measurement of
delivered value.

**Rendering.** C9: no browser has been driven at this app at any viewport. D's
score on criterion 8 is a 1 for that reason and E's is a 2, and neither has been
seen working.

**Any provider's actual behaviour.** No email provider was contacted, no Slack
workspace was used, no push endpoint was called. E's free-tier assumption and D's
iOS install-path assumption are both marked "assumed" in their files.
