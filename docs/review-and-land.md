# Reviewing and landing what a run did

[← Documentation index](README.md)

A finished run tells you it spent $3.40 over four work cycles and put six commits
on `uf/foo-1`. It does not tell you whether any of that is worth keeping. Four
things on the run page answer that.

**The agent's own report.** The last thing each work cycle said, rendered as the
markdown it was written as — headings, numbered steps, code fences. That text is
in the live log too, but as one monospace line per content block among the tool
calls, which makes the one paragraph explaining what a cycle did the hardest
thing on the page to find. The most recent cycle is open and earlier ones fold
away, but each is still there: the cycle where an agent said it was stuck is
rarely the last one. It is derived from the events already on disk, so it works
on runs that finished before it existed, and it costs nothing — no fetch, no
second source, no spend.

There is no markdown dependency behind it, and that is deliberate rather than
frugal. The renderer emits React nodes, so there is no `dangerouslySetInnerHTML`
and no sanitiser to keep current — which matters precisely because this text is
model-written and unreviewed. It understands fenced code, headings, list items
and inline code/bold/italic, and anything else falls through as plain text
rather than as markup it guessed at. Underscore emphasis is excluded on purpose:
`snake_case_name` would otherwise render as a corrupted identifier.

**The diff.** `<base>...<branch>` as a file list you can expand, which for an
isolated run is exactly that run's work and nothing else. A run that worked
directly in your folder gets a file list of the folder's current state with the
caveat attached — your own edits are in there too and nothing records which is
which, so no patch is shown rather than a confident diff of the wrong thing.

Large changes are budgeted: every changed file is always listed, and patch bodies
stop at a size limit. When that happens the page says how many files are listed
without contents, because a diff that quietly shows twelve of forty reads as a run
that touched twelve.

**The review.** A button that runs Claude once against the diff, the task the run
was given, and how it ended, and asks what changed, what to look at first, and
what looks risky. It is on demand only and never automatic — it is billed, and a
review nobody asked for is spend nobody authorised. It cannot edit anything
(`--permission-mode plan`), and **its cost is shown separately and never added to
the run's own spend**, which counts work cycles. If the diff was too large to send
whole, the reviewer is told which files it did not see, and the card repeats that
above the review.

A review is refused outright if either window is already at a ceiling you set —
it spends against the same 5-hour allowance your runs do.

**Landing.** UsageFoundry used to refuse to merge on principle. It now merges,
and everything that principle protected is a check rather than a caveat:

- The merge is previewed with `git merge-tree`, entirely in memory. You find out
  whether it fast-forwards, merges cleanly, or conflicts — and for a conflict,
  which files, what kind of conflict each one is, and the `<<<<<<<` blocks
  themselves — with nothing written to any working tree. That last part is free:
  the tree `merge-tree` writes holds each file exactly as a real merge would
  leave it, so the conflict can be read before deciding anything. (Needs git
  2.38+; an older one says so rather than guessing.)
- Landing needs your checkout **clean** and **on the branch the run started
  from**, which is recorded when the run is created. Anything else is refused with
  the reason, not greyed out. "Could not read your checkout" counts as dirty.
- A branch belonging to a run that is still `running`, `queued` or `paused` is
  never landable — it can gain commits at any moment.
- A merge that conflicts is aborted immediately and the conflicting files
  reported. Your checkout is left as it was found.
- Merge or squash, defaulted in Settings. Merging keeps the run's commits, so the
  diff above still means something afterwards; squashing gives your history one
  commit per run.

**Several branches can be queued, and a queue is not a batch.** Tick them on the
Branches page in the order you want them landed and the branches in one
repository go through one at a time, each re-previewed against git at its own
turn rather than against whatever the page showed when you queued them — because
every landing changes the base for the one behind it. Every check above still
applies to every one of them, taken fresh. Queue a second set of the *same*
repository's branches while the first is still going and it waits its turn:
batches drain whole, oldest first, so nothing you queue later lands between two
branches you had already put in order.

**Different repositories land at the same time**, up to four at once. A landing
in one changes nothing about the base in another, so waiting would only mean a
clean branch sitting behind somebody else's conflict — which can take twelve
minutes to resolve. Within any one repository it is still strictly one merge at
a time, and that is the part that has to hold.

A second press of Land does not start a second queue — it adds to the back of the
same one. The panel shows every batch that still has something to do, oldest
first, with the three most recent finished ones under them, and each batch keeps
its own *Cancel*: it drops that batch's branches that have not started and leaves
the merge in flight to end, which is the same rule everywhere here. Nothing is
cancelled by pressing Land again for another repository.

Two failures are told apart deliberately. A branch that cannot be landed is
reported and the queue carries on to the next. A problem with your *checkout* —
uncommitted changes, or standing on the wrong branch — would refuse every
remaining branch in that repository for the same reason, so the queue stops
there and says so once instead of ten times. Nothing is left half-merged either
way, and the queue never resumes itself after a restart: queued merges are
cancelled, because a server coming back up and merging four branches into the
tree you are working in is the one thing it must not do on its own.

Optionally — and it is a toggle on the form, not a setting — a conflict can be
sent to Claude as it comes up, resolved on the run's branch exactly as below, and
then landed. That spends money unattended, so the toggle carries the warning, the
cost lands on each queue row, and nothing switches it on for you.

**Conflicts can be resolved by Claude, and never in your checkout.** When the
preview reports a conflict, *Resolve with Claude* merges the target branch
**into the run's branch**, the opposite direction from landing, inside an
isolated checkout — the run's own if it still has it, otherwise a throwaway one
that is deleted afterwards. Claude edits the conflicted files and nothing else;
it is not allowed to run git. UsageFoundry then checks that no conflict marker
survived and makes the commit itself. If anything is still unresolved the merge
is rolled back and the branch is exactly as it was — an agent that says "done"
without doing it cannot get past that check. When it works, the branch now
contains the target, so landing it is a plain fast-forward under all the checks
above.

Your own checkout is not involved at any point, and a resolution that goes badly
costs a branch nobody has landed. Like a review, it is billed and shown with its
own cost — never added to the run's spend.

Afterwards the card shows both halves of it: what Claude says it kept and why,
and the diff of the merge commit it made, against the branch as it stood before
the merge. The first is an account of the work; the second is the work, and it
is what landing will bring across.

**Work an agent never committed can be committed for it.** An isolated run is
now granted `git add` and `git commit`, but a run from before that — or one whose
agent simply never got round to it — finishes with a full checkout and an empty
branch, which reads as a run that did nothing. Both the run page and the
Branches page show what is sitting there, uncommitted, and commit it onto the
run's own branch under the run's task as the subject (the run page lets you write
your own). Nothing is written to your checkout. It is also how you get the
checkout slot back: one with work left in it cannot be reused by the next run.

The commit is refused if the slot has since been taken over by another run —
what is uncommitted in it is then that run's, and committing it here would put
one run's work on another's branch.

**The Branches page** lists every `uf/*` branch across runs: which run made it,
what it lands into, how far ahead it is, whether it is merged, and how much is
uncommitted in its checkout. It is also where the merge queue lives.

Two ways out of a branch, and they are not the same button. **Delete** appears
once git can see the work is in the target — it removes the branch and frees its
checkout slot, and it is refused the moment the branch gains a commit that has
not landed. **Purge** is the other door, for the attempt that went nowhere: it
deletes the branch, its commits and its checkout whatever state they are in. It
takes two presses, the second one saying how many commits go with it, and it is
not offered for a run that is still going. Nothing here can put any of it back.

A squashed branch is a special case worth knowing: git cannot see a squash as a
merge, so the tool records the branch tip it took instead. That is what lets a
squashed branch show as landed and be deleted — and it stops being true the
moment the branch gains a commit, which is exactly when deleting would lose
something.
