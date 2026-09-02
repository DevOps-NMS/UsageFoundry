# The write path

Every option except `09-option-g-the-recurrence-readout.md` writes a file into a
document store a person edits by hand, in another application, on a machine this
container has bind-mounted. This file costs that write. It is the part of
Dreaming with no precedent anywhere in this repository: **nothing in `src/` has
ever written into a mount the operator reads with something other than git.**

---

## 1. Which module owns it, and why not the obvious one

Not `src/lib/knowledge.ts`. Its docblock is not silent on this:

> "It is also read-only, end to end. Nothing in this module or in the routes
> over it opens a file for writing, creates a directory or removes one. That is
> a deliberate bound rather than a stage not reached yet: the vault is a live
> document store that a person edits in another application, and a background
> index that can write into it is one that can lose somebody's paragraph while
> they are typing it."
>
> — `:39`–`:44`

Two things to notice. The bound covers "this module **or the routes over it**",
so `src/app/api/knowledge/*` is closed too — a `POST /api/knowledge/note` is the
same violation with a different file. And the reason given is a *concurrency*
argument about a live document, not a squeamishness about writing: the vault is
open in Obsidian while this runs.

So a Dreaming write is a new module. It needs, at minimum:

- the mount resolution `knowledge.ts` already does — `knowledgeBaseMountId`
  names a configured mount and `knowledgeBaseSubpath` narrows it
  (`src/lib/settings.ts:645`, `:659`; `knowledge.ts:30`–`:37`), and nothing may
  widen `WORKSPACE_ROOTS`, which is fixed at boot;
- the containment pair, twice: lexical, `realpathSync`, lexical again, one mount
  at a time (`docs/agent/security.md:11`);
- an atomic write, which `src/lib/vaultSkill.ts:314` already has a helper for —
  "Write a file so that a child reading it concurrently sees one whole version";
- and one thing none of the above provides.

## 2. The check the two containment checks do not make

`resolveInMount()` answers *is this path inside the mount*. It does not answer
*may this app write **this** file*. For a run's checkout the question does not
arise, because the checkout is this app's to write. For the vault it is the
whole question, and it has three parts:

**Does the file already exist, and did a person write it?** There is no author
field. `01-constraints.md` C7 quotes the vault's own note on this: "no memory
system found so far authenticates what wrote a memory". Neither does a
filesystem. A Dreaming that overwrites is a Dreaming that can overwrite a
paragraph the operator typed this afternoon; a Dreaming that refuses to overwrite
is a Dreaming that can only append, which is the duplicate problem in
`11-deduplication-and-retirement.md`.

**Is the file open in an editor right now?** Obsidian holds files open and
writes them on its own schedule. The failure is not a lock error; it is a silent
last-writer-wins, and both writers think they succeeded. This is precisely the
hazard `knowledge.ts:39`–`:44` names, and no check in this repository detects
it.

**Is the write inside the licence?** `AGENTS.md:115` permits one shape — a
single question capture into `3 Resources/Questions/Inbox/` using that folder's
`_TEMPLATE.md` — and forbids the rest. Enforcing that is a path allowlist
narrower than the mount, plus a template check, and it is the only enforcement
in this survey that would make an automatic write defensible.

## 3. What it does to `vaultSkill.ts` and the read guard

Both are generated per spawn and handed to the child with `--plugin-dir`
(`src/lib/vaultSkill.ts:13`–`:14`), never installed, for a reason stated at
`:16`–`:32`: compose bind-mounts `~/.claude` into the container, the CLI's
registry records absolute paths, and whichever side installs last breaks the
other silently.

- **The skill's text is a template string in that module** (`:34`–`:46`), in
  git, reviewable and unit-testable. If Dreaming's writer is an agent rather
  than app code, the *permission to write* would be described there — and that
  is the wrong place for a permission, because a skill is persuasion. Nothing in
  `SKILL.md` enforces anything; `01-constraints.md` C3's licence is a sentence
  in `AGENTS.md` that no mechanism reads.
- **`readGuard.ts` is a `PreToolUse` hook on `Read`** that ships off and whose
  effect is explicitly unmeasured (`:31`–`:47`). The CLI validates
  `PreToolUse` output against a union keyed on
  `hookSpecificOutput.hookEventName` with `permissionDecision` of
  allow/deny/ask/defer (`:52`–`:56`). **A `PreToolUse` hook on `Write` is the
  one place a write licence could actually be enforced against an agent**, and
  it would be the first hook in this app that denies rather than persuades on a
  path rather than on a repeat. That is a real design and it is not in scope for
  this survey; it is named here because it is the only mechanism found that
  could make Option A safe, and building it is more work than Option A.
- **Neither may name a literal an agent could `pgrep -f`**
  (`docs/agent/security.md`), which constrains how a write path is described to
  the child.

And one thing worth stating because it is easy to assume the opposite: the
managed sandbox policy the entrypoint writes has a `filesystem` clause
containing exactly one key — `"denyRead": ["${DATA_DIR:-/data}", "/backups"]`
(`docker-entrypoint.sh:431`–`:433`) — plus a credentials deny for
`~/.claude/.credentials.json` (`:436`). **There is no path-based write
restriction in it.** Whatever confines a child's writes comes from the
permission mode on its argv and the CLI's own sandbox defaults, not from
anything this app configures — so "the vault is a different mount" is not, by
itself, a boundary.

## 4. What the operator's other tools do with a file a model wrote

Read from the vault itself rather than assumed; `/workspace2` is mounted and
reachable from this run.

- **`_Meta/qc.py` fails the vault, not the note.** It "checks every note in the
  vault against the binding rules in `CLAUDE.md` and exits non-zero on any
  violation" (`_Meta/Vault Quality Control.md:17`). `FM/*`, `TAG/*`,
  `LINK/broken`, `LINK/sparse` (≥3 outgoing links), `LINK/orphan` (≥1 inbound
  link), `SEED/*`, `PATH/*` are all **ERROR** (`:38`–`:49`). A nightly note that
  gets any of those wrong does not fail at write time — it fails the next time
  the operator runs `qc.py`, on their whole vault, with an exit code that "drops
  into a pre-commit hook or a session-end check unchanged" (`:34`).
- **`LINK/orphan` is the one that cannot be satisfied by writing one file.** A
  note needs an *inbound* link, so a compliant write is two writes: the note, and
  an edit to a MOC or parent note that links to it. That doubles the surface on
  which a paragraph can be lost.
- **`_Meta/build_index.py` has to run afterwards** (`AGENTS.md:113`): it
  "rewrites `INDEX.md` *and* every file under `_Meta/index/`", and `--check`
  exits 1 if anything is stale. `INDEX.md` is 2,633,599 bytes. So a 2 KB note
  either obliges a 2.6 MB regeneration — executing the operator's Python inside
  their vault — or leaves their own tooling reporting stale.
- **Obsidian will render it immediately**, in the same graph, with the same link
  colours, indistinguishable from a hand-written note.
- **`_to_delete/` exists** at the vault root, which is what retirement currently
  looks like there: a person moves a file into a folder. There is no `.git`
  (`01-constraints.md` C4), so that is the whole mechanism.

## 5. The two things a write path must have and does not

**Provenance.** Nothing marks a file as machine-written. The
`Questions/Inbox/` template supplies `captured_by: "external session"`,
`captured_from:` and a closing `> [!warning] Unreviewed capture` block —
which is exactly the missing mechanism, and it exists only inside the licence
Option D takes. Outside it, a Dreaming note is anonymous by default.

**Reversal.** No `.git`, no history, no undo, no list of what was written last
night. `retention.ts` governs what ages out of this app's own storage
(`docs/agent/retention.md`); it has no opinion about a mount, and it must not
gain one — a sweep that deletes files from the operator's document store is a
worse feature than Dreaming.

## 6. What this costs to build, honestly

| piece | size |
|---|---|
| new module: resolve, contain, atomically write one file | small — the pieces exist in `knowledge.ts` and `vaultSkill.ts:314` |
| path allowlist enforcing `AGENTS.md:115`'s single shape | small, and it is the load-bearing one |
| frontmatter/template compliance so `qc.py` stays green | medium; `LINK/orphan` needs a second file edited |
| provenance fields and a warning callout | small — copy the Inbox template |
| a record of what was written, so it can be listed and undone | **medium, and nothing in this repository is a precedent for it** |
| a `PreToolUse` deny-on-`Write` hook, if the writer is an agent rather than app code | large |

The row that should decide it is the second-to-last. Every other row is work;
that one is a new responsibility — this app becoming answerable for the contents
of a store it does not own, with no version control underneath it.
