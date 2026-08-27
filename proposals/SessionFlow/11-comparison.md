# Comparison

**Two axes, two tables, and scoring them in one would be the survey's own
mistake.** The request bundles a *placement* ("a new tab on the left") with a
*content* ("a visual flow representation"), and they are independent: any content
could go at any legal placement. A single ranked list would let a strong content
carry a banned placement, which is exactly how the two things the brief named as
the fork both turn out to be banned without either being anybody's first choice.

---

## Axis 1 — placement

Not weighted, because two of the four are refused by a written invariant and a
score would imply they were on the scale.

| | Placement | Legal? | Costs | Verdict |
|---|---|---|---|---|
| **B** | [Tenth pane](03-option-b-tenth-pane.md) | **No** — `ui-density-audit.md:159-161` names it | one array entry, one glyph, three doc corrections | **Refused.** No tenth digit; fails the `/knowledge` test in the sentence that granted the last exception |
| **C** | [Sixth tab](04-option-c-sixth-tab.md) | **No** — `conventions.md:50` caps a strip at five; `ui-density-audit.md:1122` freezes this one | one array entry | **Refused.** At the cap already, on exactly the runs this feature is for |
| **D** | [Sub-route](05-option-d-sub-route.md) | Yes — and named as the replacement in the ban itself | ~2 lines of routing, a link from the run page, its own poll discipline | **Right at the second step.** A destination holding one table is a thing to learn in order to read something that fitted where you already were |
| **P4** | Inside the existing Changes tab | Yes | one tab rename | **Right at the first step.** Keeps both halves of a reconciliation on one screen |

**Both placements the brief named are banned, and neither is a close call.** That
is the fork resolved, and it is resolved against the operator's phrasing by the
app's own documents rather than by preference. The cost of overruling them is
stated in full at
[03-option-b](03-option-b-tenth-pane.md#the-cost-of-overruling-the-operator-stated-plainly)
— it is a ⌘-digit and, more honestly, visibility to an operator who was not
looking.

---

## Axis 2 — content

Six criteria, weighted. Every weight is argued rather than asserted, because a
weighting nobody defends is a way of writing down a conclusion you already had.

| # | Criterion | Weight | Why that weight |
|---|---|---|---|
| 1 | Answers a question that has no surface today | **5** | The whole burden of a new reader. The Log and Changes tabs already answer a great deal ([02-option-a](02-option-a-change-nothing.md)) |
| 2 | Can state honestly what it cannot show | **4** | `conventions.md:17` makes this a correctness property, not polish: a view that is empty for two different reasons and says so for neither is a false answer |
| 3 | Scales to a real run without an unmeasured guess | **4** | `/data` is empty; anything whose layout depends on a count nobody has taken is committing before it knows |
| 4 | Cost — new mechanisms, not lines | **3** | Real but recoverable. A reader can be deleted |
| 5 | Is what the operator asked for | **3** | Genuinely weighted, not zeroed. It is their install and their sentence |
| 6 | Produces the measurement that decides the next step | **2** | Cheap to have and worth something; never worth much on its own |

Scores are 0–5. Total is the weighted sum out of 105.

| | Option | 1 · 5 | 2 · 4 | 3 · 4 | 4 · 3 | 5 · 3 | 6 · 2 | **Total** |
|---|---|---|---|---|---|---|---|---|
| **H** | [Reconciliation table](09-option-h-reconciliation-table.md) | 5 | 5 | 5 | 4 | 1 | 5 | **90** |
| **G** | [Cycle grid](08-option-g-cycle-heatmap.md) | 4 | 3 | 2 | 3 | 4 | 2 | **65** |
| **F** | [Delegation tree](07-option-f-delegation-tree.md) | 2 | 3 | 5 | 3 | 1 | 1 | **56** |
| **A** | [Change nothing](02-option-a-change-nothing.md) | 0 | 5 | 5 | 5 | 0 | 0 | **55** |
| **I** | [Fleet-wide](10-option-i-fleet-wide.md) | 3 | 2 | 1 | 2 | 1 | 1 | **38** |
| **E** | [Force graph](06-option-e-file-tool-graph.md) | 1 | 1 | 1 | 1 | **5** | 1 | **33** |

### The scores that carry the result

**H scores 5 on criterion 3 and E scores 1**, and that is the largest single
swing in the table. It is not a claim that tables are prettier. A table with 400
rows is a table: it sorts, it caps, and a cap says what it dropped. A force graph
with 400 nodes is a different object from one with 40, and `capGraph` prunes **by
degree, largest first** (`knowledgeGraph.ts:719-722`), which in a bipartite
tool→file graph keeps the dozen tool hubs and drops the files
([06-option-e §1](06-option-e-file-tool-graph.md#1-every-candidate-edge-is-either-a-hub-spoke-or-a-clique)).
**The one nearly-generic piece of graph plumbing in the tree generalises in the
wrong direction for this data.**

**E scores 1 on criterion 2** because an edge has nowhere to put a hedge. Success
is never recorded (`orchestrator.ts:7343-7344`) and a failure joins to its call
only by a flattened 160-character string ([F3](00-problem.md#f3)), so every edge
means *attempted*. A table says that once in a header. A line is drawn or it is
not.

**E scores 5 on criterion 5 and still comes last.** That is the honest shape of
this survey: the thing that was asked for is the thing that was asked for, and it
loses on the other five criteria by enough that criterion 5 would have to be
weighted above 8 — more than criteria 1 and 2 combined — to change the order. It
is worth stating that explicitly rather than burying it, because "we scored it
and it lost" is a much weaker claim than "it would have to matter more than
correctness and honesty put together."

**A scores 55 and beats three of the five things that could be built.** The null
is not a formality here. It beats E, I and (narrowly) F.

## Where this table misleads

**G's score is depressed by a number H produces.** Criterion 3 costs G eight
points, and the whole of that is "the row and column counts are unmeasured". They
are unmeasured *because nothing prints them yet* — and H's output is exactly
those two counts. So the gap between 90 and 65 is partly an artefact of ordering
rather than of merit, which is why
[12-recommendation.md](12-recommendation.md) recommends **H then G** rather than
H instead of G, and why G is the only option in the survey that is neither
recommended nor refused.

**F's 56 understates it, because it was scored as a view and it is a column.**
Attributing each touched path to `main` or a named sub-agent is one
`json_extract` in a query that is already running
([07-option-f](07-option-f-delegation-tree.md#what-is-worth-keeping-from-it)). As
a column its cost is near zero and it rides into H. The 56 is the score of the
thing nobody should build.

**Criterion 4 is scored in mechanisms, not lines, and that flatters H.** H is one
route handler and one component — but it also asks to rename a tab that
`ui-density-audit.md:1122` froze, and a rename of a frozen label is a
conversation rather than a diff. It is called out by name in
[09-option-h](09-option-h-reconciliation-table.md#where-it-renders) rather than
priced at zero.

**Nothing here is scored on how it looks.** No browser was opened and no
container started, so criterion 3's "hairball" language is an argument from node
counts and pruning rules, never from having seen one.
