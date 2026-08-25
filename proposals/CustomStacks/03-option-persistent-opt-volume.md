# Option B — one general-purpose writable volume on `PATH`

Mount a fourth named volume at `/opt/stacks`, put `/opt/stacks/bin` on the
image's `PATH`, make it writable by `UF_AGENT_UID`, and let anything that can
write there install anything it likes. No install loop, no manifest, no list.

This is the option the operator's own description implies: a terminal, and a
place for what it installs to land.

## 1. The strongest case

Every other option in this directory decides in advance what an operator may
install. This one does not, and that is the whole point: a substrate is a place
where things go, not a curated list of things. It is also the *least code* of any
option that adds a capability — two lines in the Dockerfile, one volume in
compose, one `mkdir`+`chown`, and no `src/` change whatsoever. It composes with
everything: a terminal pane writes there, a boot-time loop could write there, an
agent's own `Bash` call can write there, and all three reach every child through
the same `PATH` the `pytools` volume already proves works
(`Dockerfile:271-274`). It answers the question the operator actually asked, in
the shape they actually asked it, and it does not pretend to know which tools
matter.

## 2. Shape

- **`usagefoundry-stacks`** at `docker-compose.yml:572-576`, mounted
  `- usagefoundry-stacks:/opt/stacks` beside `:409`.
- **`ENV PATH="/opt/stacks/bin:${PATH}"`** beside `Dockerfile:281`.
- **`mkdir -p /opt/stacks/bin /opt/stacks/state`** in `Dockerfile:514-516`'s
  `RUN`, chowned `node:node` there so a fresh volume inherits it
  (`Dockerfile:508-513`).
- **A chown in `docker-entrypoint.sh`**, beside the four at `:44`, `:70`, `:91`,
  `:114`, for the case `UF_AGENT_UID` is not 1000 — *"the ownership a volume is
  created with is never revisited"* (`Dockerfile:496-499`).
- **Nothing else.** No env var, no loop, no route, no `src/` change.

`/opt` rather than `/home/node/stacks` is deliberate and matches
`/opt/playwright/browsers` (`Dockerfile:440`) and `/opt/winnow`
(`Dockerfile:303-314`): `/home/node` is recursively chowned in the Dockerfile,
and a recursive chown over a large tree writes a second copy of it into the image
(`docs/agent/environment.md:33`).

## 3. What persists it, and what discards it

| Event | Outcome |
|---|---|
| `docker restart` | survives |
| `up --build` | **survives** |
| `down -v` | **destroyed, and nothing rebuilds it** |
| fresh host | **empty**; every tool must be reinstalled by hand |

**This is the option's central weakness and it should not be softened.** The two
existing loops survive `down -v` because the declaration outlives the volume
(`.env.example:212-213`, `:296-297`). Here the volume *is* the declaration.
`scripts/backup-db.mjs` covers one SQLite file and nothing else
(`docs/backup-and-restore.md:14-31`), and
`docs/backup-and-restore.md:129-142` excludes things on the express grounds that
they *have other copies*. A stacks volume would be the first thing this app holds
that has no other copy anywhere — not in the image, not in git, not on the host,
not in the database.

So the honest framing is: this option makes an operator's tools survive the
rebuild they asked about, and lose them to a command the documentation already
warns is destructive. That is a real improvement and an incomplete one.

**Not verified.** No volume was created or destroyed here; Docker is
unavailable. `01-constraints.md` §11 item 1 is the command.

## 4. Reach

Identical to Option A: `PATH` reaches all five kinds of child unmodified, through
five copies of a strip loop none of which touches `PATH`
(`orchestrator.ts:6306`, `chat.ts:2251`, `review.ts:760`, `claudeAuth.ts:258`,
`git.ts:51`).

And identically to Option A, `PATH` is the link that was never broken.
**A work cycle at `acceptEdits` may still be unable to invoke what is there**
(`00-problem.md` §"Missing 3"). This option does nothing about it.

One extra reach property worth naming: because the directory is agent-writable
and on `PATH`, **an agent can install its own tools here and they persist across
runs and across rebuilds**. That is either the feature or the vulnerability,
depending on the reader — see §6.

## 5. Tool state, not the binary

`/opt/stacks/state` exists in the shape above, and **nothing points any tool at
it.** That is the difference from Option A: there is no install step at which a
`TF_PLUGIN_CACHE_DIR` could be set, because there is no install step. The
operator would have to set it themselves, in a
`docker-compose.override.yml` — which is exactly the route `.env.example:263-273`
already prescribes for third-party tool configuration, and which the same passage
confirms reaches the agents *"because childEnv strips only UF_*, OTEL_* and four
named keys"*.

So: **possible, documented, and entirely manual.** A tool installed without that
step keeps its state in `$HOME`, which is the writable layer for everything
outside the four carved-out subdirectories (`01-constraints.md` §8), and loses it
on the rebuild the operator installed it to survive. The symptom is a slow work
cycle, not an error.

## 6. What it does to the boundaries

This is the option that moves the most, and one movement is serious.

- **A new agent-writable directory on the *server's* `PATH`.** The server runs as
  root (`docker-compose.yml:64`). `contextPruning.ts:76-83` already names this
  exact hazard for `/home/node/pytools/bin` — *"an operator-managed directory a
  sibling agent can write"* — and works around it by resolving
  `/opt/winnow/venv/bin/python` absolutely. `contextPruning.ts:610` is also the
  one spawn in the app that does not drop to the agent uid (`:626-627`). This
  option adds a second such directory, and it is one an agent may write
  *deliberately* rather than one an operator populates. **Nothing currently
  resolves a bare command name on the server's path**, so nothing is broken
  today — but the invariant becomes load-bearing and is written down nowhere.
  Promoting this option means adding it to `docs/agent/security.md`.
- **Persistent agent-authored code.** Today an agent's writes land in a worktree
  under a mount (`orchestrator.ts:2171`), in `$HOME`'s writable layer, or in the
  three tool volumes. All are either visible to the operator in git, or discarded
  by the rebuild. A general-purpose executable directory that survives rebuilds
  is the first place an agent can leave a running program that the operator will
  not see in a diff and will not lose in an upgrade. `docs/security.md:104-119`
  already says there is no boundary between two concurrent runs; this extends
  that from "within a session" to "indefinitely".
- **`/data` 0700** — untouched.
- **CLI sandbox** — same as Option A: runs, cannot write its state, would need a
  `BUILD_CACHE_DIRS` entry (`orchestrator.ts:5996-5999`).
- **Read guard, worktree isolation, `UF_CHAT_GID`** — no interaction.

## 7. The operator's surface

There isn't one, and that is the point: the volume is inert until something
writes to it. Paired with run 2's terminal pane it is a shell and a `PATH`.
Paired with nothing it is a directory an agent can be told about in a prompt.

Changing or removing a tool is `rm`. There is no version, no pin, no record of
what is installed and no way to ask — the same read-back gap as everywhere else
(`00-problem.md` §"Missing 4"), except that here there is not even a boot log
line, because nothing was declared.

## 8. How it fails, and whether loudly

**Silently, in every mode.** This is the option with the worst failure profile in
the directory, and the list is not padding:

- A tool is there, then a `down -v` happens, and it is gone with no
  reinstallation and no message. An agent meets `unknown command` inside a tool
  call the run loop does not read — the exact failure `docker-compose.yml:386-391`
  describes, restored in a new place.
- An operator moves to a new host and their stack does not come with them,
  because there is nothing to bring.
- Two operators on one install disagree about what is installed and there is no
  file that settles it.
- A tool half-installs (binary written, state directory not) and works until the
  first operation that needs the cache.
- The ownership case: a volume created before a `UF_UID` change is owned by the
  old uid and stays that way (`Dockerfile:496-499`). The entrypoint chown in §2
  is what prevents it, and forgetting it is silent.

The only loud failure is a full disk, and nothing in this app watches this
volume's size — the Storage card's two walks are over specific paths
(`docs/agent/retention.md`).

## 9. What it costs to build

**The cheapest option in the directory.** Three files (`Dockerfile`,
`docker-compose.yml`, `docker-entrypoint.sh`), one `describe` in
`deployment.test.ts` in the shape of `:892`'s volume-vs-image assertion, no
`src/` change, no DTO, no route. **Half a day.**

One `docs/agent/` invariant would have to be *added* — §6's "nothing in `src/`
resolves a bare command name from an agent-writable path" — which is a paragraph
in `docs/agent/security.md`, not a code change.

## 10. What would have to be true

**Promotes it:** that the operator genuinely wants arbitrary tools and accepts
`down -v` as destructive. If their mental model of the volume is already "this is
mine to keep and mine to lose", the weakness in §3 is a documentation line rather
than a defect, and this becomes the cheapest honest answer in the directory.

**Kills it:** that anything in `src/`, now or later, resolves an executable by
bare name on the server's `PATH`. Check with
`grep -rn "spawn(\"" src/lib/` and read each argv[0]: today they are
`CLAUDE_BIN`, `GIT_BIN` and one absolute interpreter, so the answer is no — but
this option makes that a rule someone must keep rather than an accident.
