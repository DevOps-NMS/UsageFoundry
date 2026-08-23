# Option E — Raise the four-mount ceiling

**Refused. It is already raisable, the code refuses the wrong way of raising it
by name, and `docs/install.md` documents the right way.**

This option is in the survey because the brief named "the four-mount limit"
among the ceilings to measure, and because #77 and #78 both describe it as a
problem. Measuring it found the problem gone.

## What the ceiling actually is

`MOUNTED_WORKSPACE_SLOTS = 4` (`src/lib/config.ts:213`), and it is **not a cap in
the code**. `parseMounts` (`:161-200`) has no limit of any kind; the ceiling is
the number of hand-written `volume:` lines in `docker-compose.yml`, because
compose cannot add a volume conditionally. The docblock at `:205-211` states
this and forbids the obvious change:

> The ceiling on mounts is the number of volume lines in that file, not a cap in
> `parseMounts` — **which has none, and must not gain one, because a compose
> override file is a legitimate way to mount more.**

So there is nothing in `src/` to raise. Raising it means adding volume lines,
which is a deployment change an operator makes, and the supported route is a
`docker-compose.override.yml`.

## What was broken and is not any more

#77's finding — a fifth slot in `.env` is a silent no-op — was correct and is
fixed:

- `unmountedWorkspaceRefusal(forwarded)` (`config.ts:234-247`) builds a sentence
  naming the *variable* the operator set, and `:248-251` throws it at module
  load, so the boot fails rather than the directory quietly not appearing.
- Compose forwards the names it could not honour, for slots 5 through 8, without
  their values: `docker-compose.yml:178`.
- `docs/install.md:493-505` is a section titled "More than four workspaces" that
  quotes the refusal and documents the override.
- `src/lib/config.test.ts:22-60` pins the message, including that it names
  `MOUNTED_WORKSPACE_SLOTS`, the one-versus-many grammar, and the empty case.

The docblock at `:214-232` makes #77's own argument back, including the sentence
that is the whole reason it mattered: an unmounted fifth slot "reads exactly like
a directory that *is* mounted and happens to be empty."

## Why raising the shipped four is still wrong

**Four is a cost, not a limit.** Each `volume:` line is a bind mount present on
every container on every install, whether or not the operator uses it. Shipping
eight would put four unused mounts into every deployment, and `resolveInMount`'s
containment checks, the picker, `conflictKey`'s cross-mount inode resolution and
`branchInventory`'s repository dimension all widen with them.

**The thing that scales with repositories is not the mount count.** #78 said this
first and it holds: "**nothing about correctness. Everything about reclamation
and reach.**" What grows with repositories is `<mount>/.uf-worktrees` toward
`64 × repositories` checkouts, and the reach caps at
`MAX_REMOTES_READ = 25`, `MAX_INVENTORY = 60` and `MAX_FOLDERS_PER_MOUNT = 400`.
Adding a fifth mount raises none of those and reclamation is what
`checkoutRetentionDays: 7` (`settings.ts:727`) exists for.

**And the asymmetry that makes the refusal safe is the same one that makes it
raisable.** `config.ts:205-209` and `:214-232` both rest on compose being unable
to add a volume conditionally. That is what makes an unmounted fifth slot
detectable, and it is what makes an override the only way to add one. The two
properties are the same fact, so a change that made mounts configurable from
`.env` would have to give up the refusal.

## The one thing worth doing here, and it is not this option

**Nothing.** But if the operator axis is the concern rather than the code axis,
the reading that would matter is repositories-per-mount against
`MAX_FOLDERS_PER_MOUNT = 400` (`workspace.ts:25`, applied `:73` and `:81`), which
is a per-mount folder-discovery bound and is the one repository-axis number no
surface reports. Measured here: n = 2 mounts, both a single repository, so this
proposal has no data on it at all. It is named in
[12-validation.md](12-validation.md) §5 rather than turned into an option,
because a survey with n = 2 on an axis should not recommend anything about it.

## Score summary

| | |
|---|---|
| Files in `src/` to change | **0** — there is no cap to raise |
| Already possible today | **yes**, via `docker-compose.override.yml` + `UF_UNMOUNTED_WORKSPACES=""` |
| Documented | `docs/install.md:493-505` |
| Tested | `src/lib/config.test.ts:22-60` |
| Verdict | **refused** |
