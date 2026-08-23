# Option I: a narrow-viewport pass

The brief asked for this option, and the answer is that it already exists, has an
owner, has a written procedure, and is blocked on the same thing this survey is
blocked on. Re-deciding it would be the survey's worst failure mode: producing a
second copy of a live document.

## The state of it

`docs/verification.md:1113-1250` carries two narrow-viewport entries. They record:

- `Table`'s `stack` prop covers **seventeen of twenty** tables; three are
  deliberately flat, named there.
- All three commands in the entries have since **passed**, at `c9d0b3c` and
  `a294ed2`.
- "**What is still open is the browser.**"
- The prescribed reading: **390x844**, the branches selection bar's left edge,
  the `max-md:h-80` spacer, and the workflow instance page as the cross-component
  proof of `stack`.
- The two greps that work, with their escaping, and the measured note that the
  unescaped form returns **0 on a build where the class is present**:

  ```sh
  grep -cF 'md\:contents' .next/static/css/*.css                # expect >= 1
  grep -cF 'max-md\:last\:border-b-0' .next/static/css/*.css     # expect >= 1
  ```

- Two device-only iOS checks that remain: the zoom on `/runs/new`, and
  `--keyboard-inset` returning to `0px`.

And `C6` is why it is still open: the one browser ever driven at this app
"refused to resize below the host window and reported `innerWidth: 2560` at a
1519px window" (`docs/agent/ui-density-audit.md:2624-2628`). The `md` breakpoint
has never been crossed by anyone.

## What this survey adds to it

Two facts and no work item.

**The invariant with the most silent failure mode in the whole convention set has
a test and has never been seen.** `docs/agent/conventions.md`: a table stacks
below `md` only with `Table stack` **and** a `label` on every `Td`, and one
without the other is a column of unnamed figures. `ui/Table.test.tsx` asserts the
markup. Nothing has ever looked at the result. That is stated in
`proposals/GapRegister/01-frontend.md`'s F5 and it is worth repeating here
because it is the single strongest argument for the browser reading that
`docs/verification.md` already prescribes.

**The narrow-viewport path is where the app's colour work is most exposed, and
this survey did not extend to it.** Every ratio in `00-problem.md` is for the
four surface tokens. Below `md` the app changes more than layout: `Field.tsx:29`
swaps to `max-md:text-[16px]`, `WorkflowCanvas.tsx:826-836` grows a
`max-md:after` hit-target overlay on the Link control (which is one of finding
1b's two sites), and `max-md:min-h-11` raises control heights. None of that
changes a colour, so no ratio moves, but **the claim that no ratio moves is
inference from reading the `max-md:` variants, not a measurement**, and a narrow
reading should carry a glance at it.

## Why it is not an option here

Because an option is a decision, and this decision is made. The procedure is
written, the commands are quoted, the target viewport is chosen, the three flat
tables are enumerated, and the two device-only checks are separated from the
browser-only ones. What is missing is a browser at 390px, which is not in this
container and was not in the last one.

Folding it into this proposal would either duplicate `docs/verification.md` or
quietly re-scope it, and `CLAUDE.md` says that file's "Not yet verified by hand"
list "must stay honest". The honest thing is to point at it.

`13-validation.md` therefore lists the narrow reading as a **prerequisite it does
not own**: if somebody gets a browser to 390px to check Option B's ring, the
seventeen stacked tables are on the same screen and should be looked at in the
same sitting. That is a scheduling observation, not a proposal.
