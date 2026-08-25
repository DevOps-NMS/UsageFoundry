# Option I — an allow-listed installer, which is not a shell at all

No command line anywhere. A page with a small set of **verbs** the app
understands — install a `uv` tool, install a `gh` extension, fetch a release
tarball to a named directory, remove one of the above — each a typed form whose
fields are validated, whose argv the *app* composes from a template, and where
nothing the operator types ever becomes a token in a command line.

The operator asked for a terminal. This gives them the four things a terminal was
going to be used for and refuses the fifth.

## 1. The strongest case

This is the only option in the directory that does not have to reconcile with
`CLAUDE.md:134` — because there is nothing to reconcile. `"Never a shell. Argv
arrays only, at every spawn site"` is a rule this option *obeys* rather than one
it argues its way around: the argv is a constant template, the operator's input
lands in a validated field, and `08-` §4's test is passed without a paragraph of
justification. It is also the only option that already exists twice in this
codebase and works. `docker-entrypoint.sh:169-190` and `:241-310` are exactly
this — a declared list, a fixed install command per kind, `setpriv` to the uid
that will run it — and `.env.example` documents them across 110 lines. What is
missing is not the mechanism, it is that the declaration lives in `.env` and the
read-back is a boot log nobody scrolls (`00-problem.md` §"Missing 4"). Moving both
into a page is a smaller change than any terminal and delivers the operator's
stated example — Terraform is a release tarball — without handing a browser tab a
root shell. **And it is the only option here whose failure mode is "the operator
asks for a fifth verb", which is a feature request, rather than "fourteen runs
failed 690ms later" (`orchestrator.ts:5147-5150`), which is an incident.**

## 2. Shape

The verbs, and the closed list is the design:

| Verb | Composed argv | Precedent |
|---|---|---|
| `uv-tool` | `uv tool install <name>` under `setpriv` | `docker-entrypoint.sh:216-224`, `:241-310` |
| `gh-extension` | `gh extension install <owner/repo>` under `setpriv` | `:145-153`, `:169-190` |
| `release-tarball` | `curl -fsSL <url>` → verify sha256 → extract one named member → `chmod +x` into a fixed directory | **new**, and it is the gap `02-` names |
| `remove` | the inverse of whichever kind | `docs/install.md:150-151`, `:254-255` |

- **`src/lib/installer.ts`** — pure: a typed request → a validated argv, plus the
  field validators. Every one of those is a pure function whose failure is silent,
  which is `CLAUDE.md`'s "Always" bar and `docs/agent/testing.md`'s standard.
  **This is where the option's whole safety argument lives, so it is where the
  tests go.**
- **Validation, per field.** A tool name matched against `^[A-Za-z0-9._-]+$`; a
  `gh` extension against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`; a URL required to be
  `https:` with a host from an operator-configured list; a tarball member path
  refused if it is absolute or contains `..`. Refusals are by name and loud —
  `docs/agent/agents-and-templates.md`'s *"refused **by name** at every door,
  never dropped to none"* is the shape.
- **A sha256 the operator supplies**, and the download refused if it does not
  match. Nothing else in this survey has integrity checking at all, and a release
  tarball over `https` from a host nobody pinned is the one place it is cheap.
- **The spawn**: `setpriv --reuid --regid --clear-groups`, `terminalEnv()`
  stripping `UF_*` and the rest (`01-constraints.md` §3), `stdio: ["ignore",
  "pipe", "pipe"]`.
- **A table** — and here this option and `04-` converge. If the rows are just a
  log, this is `10-` without the command line; if they are a *manifest reapplied
  at boot*, this **is** `04-option-declared-manifest.md` with a typed form on the
  front. §10 is where that choice gets made; `04-` §2's reconcile-host question is
  inherited whole and is not re-argued here.
- **UI**: a sub-route with a card per verb and a `ui/Log` transcript per run.
  Entirely inside the seven affordances (`conventions.md:50`) — a card, a
  `ListGroup` of installed things, a `Disclosure` for the transcript. **The only
  option in this file set that adds no new UI shape at all.**

## 3. What persists it, and what discards it

If the rows are a log: exactly `09-` §3 and `10-` §3 — the substrate decides, four
events, four identical answers, no Docker socket so it cannot rebuild the image.

If the rows are a manifest: **this is the only option in the directory that
survives all four events**, including `down -v` and a fresh host, because the
declaration is reapplied and the volume is a cache. That is `04-` §3's argument
and it belongs to `04-`; what this file adds is the surface that makes the
declaration something an operator types into a form rather than into `.env`.
`scripts/backup-db.mjs` covers the manifest, as it covers every other setting
(`docs/backup-and-restore.md:14-31`).

**That difference is the largest single spread in this whole survey**, and it is
decided by one design choice inside one option.

## 4. Reach

`PATH` reaches all five kinds of child untouched (`orchestrator.ts:6244-6246`,
pinned at `git.test.ts:93`), and this option has an advantage none of the shell
options have: **the app chooses the install directory**, so it can choose one that
is (a) on `PATH`, (b) on a named volume, and (c) owned by `UF_AGENT_UID`. All
three properties hold for `/home/node/pytools/bin` today (`Dockerfile:281-284`,
`docker-entrypoint.sh:90-98`), and none of them is guaranteed when a human types a
path.

The uid question in `08-` §3 mostly **dissolves**: there is no root mode to offer,
because every verb the app understands is one the agent uid can perform. An
operator cannot ask for `apt-get`, so they cannot be quietly given a root-owned
binary. That is the strongest thing in this option's favour and it is a
consequence of the closed list rather than a separate mechanism.

`acceptEdits` is untouched, as everywhere: a tool that is installed and on `PATH`
may still not be *invokable* by a work cycle (`00-problem.md` §"Missing 3"), and
this needs `07-`'s `stackTools` as much as anything else here does.

## 5. Tool state, not the binary

The same gap as everywhere — `$HOME` is not on a volume except the three carved
subdirectories — but **this is the one option that can do something about it**,
because the app composes the environment. `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR` and
`UV_PYTHON_INSTALL_DIR` are already pointed into the volume by
`Dockerfile:281-284`, and the same move is available per verb for a tool that
respects an env variable: `TF_PLUGIN_CACHE_DIR`, `GOMODCACHE`, `npm_config_cache`.

It does not generalise — a tool that hardcodes `~/.config` cannot be redirected —
and a credential (`terraform login`, `aws configure`) is out of scope entirely,
because there is no interactive prompt to answer. **That is a real refusal, not an
oversight: this option cannot authenticate a tool, and an operator whose stack
needs a login has to `docker compose exec` anyway**, which is `13-`.

## 6. What it does to the boundaries

**It crosses none of them, and that is the entire point.**

- `/data` 0700 root — untouched; no verb reads a path.
- The root/`UF_AGENT_UID` split — preserved; every verb runs under `setpriv` at
  the agent uid, and there is no root mode to offer.
- `UF_CHAT_GID` — untouched; the installer child is not in that group and has no
  reason to be.
- The CLI sandbox's write allowlist and the read guard — unaffected; these are
  properties of a `claude` child and this is not one.
- Worktree isolation and the folder claim — **untouched, uniquely.** No verb takes
  a `cwd` in a mount, so `08-` §8's undetected-writer problem does not arise. Both
  shell options have it and neither can fix it.
- What it hands an agent that the agent did not have: **a binary, and nothing
  else.** No file access it lacked, no environment variable, no credential.

The one new boundary it *does* need is `resolveInMount`-shaped and narrower: the
tarball extractor must refuse an absolute or `..`-bearing member path before it
writes, which is the same double-check discipline as
`docs/agent/security.md:11` applied to an archive instead of a symlink. A
tar-slip is this option's only novel attack surface and it is a solved problem
with a unit test.

## 7. The operator's surface

Four forms and a list. The list is the read-back nothing in this app has today:
what is declared, what is installed, what failed and the error text. Remove is a
button.

A restart does nothing to it if the rows are a log; a restart **reapplies** it if
they are a manifest. Changing a version is editing a row.

What it refuses, plainly, and this belongs in the UI rather than only in this
file: anything that is not one of the four verbs. An operator who needs
`apt-get install libpq-dev`, or a two-step install, or a tool that wants a login,
gets nothing here and must use `docker compose exec` (`13-`) or a
`docker-compose.override.yml` (`05-`).

## 8. How it fails, and whether loudly

**The loudest of the five, by construction.** Every verb has an exit code, a
stored error and a row on a page. `.env.example:222-226`'s 213 sessions could not
happen: a failed install is a `failed` row with the stderr attached, not a stderr
line in a boot log.

What still fails quietly:

- **The reach gap**, in every option: installed, on `PATH`, on the page as
  `installed`, and a work cycle at `acceptEdits` still refuses to invoke it
  (`00-problem.md` §"Missing 3"). The page saying `installed` makes this *worse*
  here than elsewhere, because the app is now asserting something it has not
  checked.
- **A tool state directory that is not redirected** (§5) — installed, working,
  re-downloading its providers every cycle.
- **The manifest/volume drift** if the rows are a manifest — `04-` §8 names it and
  it is inherited.
- **A verb that "succeeds" and installs nothing.** `uv tool install` on a name that
  resolves to an empty distribution exits 0. The mitigation is a post-install
  probe — does the named executable exist on `PATH` and is it `+x` — which is four
  lines and is the difference between this option clearing the `.env.example` bar
  and merely claiming to.

## 9. What it costs to build

**Three to five days** as a log; **`04-`'s week to two weeks** as a manifest,
because it then inherits that option's reconcile-host question whole.

Files: `src/lib/installer.ts` with real tests, one route, one migration, one
sub-route page, one settings field for the allowed download hosts. No new
dependency, no transport work, no native module, no ANSI handling, no keystroke
capture.

**Invariants that move: almost none**, and this is the quietest option in the set
against `docs/agent/`. No new spawn *shape* — it is `setpriv` + argv, which the
entrypoint already does three times. No new child *kind* in the architecture
sense worth arguing about, though `docs/agent/architecture.md`'s count still needs
a line. `docs/agent/conventions.md` is untouched: cards, a `ListGroup` and a
`Disclosure` are three of the seven.

## 10. What would have to be true

**Promotes it:** that the four verbs cover what the operator actually needs. The
same unasked question as `09-` §10 and `10-` §10, from the third direction, and
the same ten-minute fix — **ask them for the five commands they expect to type.**
If four of the five are `uv tool install`, `gh extension install` and a release
tarball, this option is the whole answer and both shells are a security budget
spent on the fifth.

**Kills it:** the fifth command being `apt-get`, or a login, or a two-step
install. The closed list is the safety argument, so a verb added under pressure is
not a feature — it is the argument dissolving one entry at a time until somebody
adds `run-arbitrary-command` and this becomes `10-` with worse ergonomics. **The
list has to be closable, and if it is not, this option should be rejected rather
than widened.**
