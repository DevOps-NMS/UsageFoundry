# Validation

Every citation in `00-` through `21-` was resolved mechanically: the cited file
opened at the cited line, and what it says compared with what the citing file
claims. This is the step `proposals/ContextControl/19-validation.md` did and
`proposals/ModelRouter/15-validation.md` explicitly did not, and it is worth
doing because it keeps finding things — the two earlier passes in that directory
found fifty broken references and eight substantive errors doing exactly this.

**Result: roughly 390 checkable citations across `00-` to `13-`. 39 were wrong
and are fixed in place. Six of the 39 changed an argument rather than a
reference; five of those six made the recommendation easier and one made it
harder. A further fifteen errors in this run's own files (`14-` to `21-`) are in
§3 — three of which made the recommendation harder, all by finding it had
overstated a margin in its own favour.**

No citation was unresolvable. Every cited file, symbol, line range and test name
exists.

---

## 1. The six that changed an argument

These are the ones worth reading. Each is stated with what it was, what it is,
and which way it moved `20-recommendation.md`.

### 1.1 `02-` — the closed table has no precedent · **easier**

**Was:** *"every existing pinned download in the Dockerfile carries a checksum
the repository chose (`Dockerfile:172`, `:203`, `:259`)"*, used to argue that a
closed table of tool URLs *"matches this repository's temperament."*

**Is:** every one of the three verifies against the **publisher's** own published
digest, fetched at build time. The Dockerfile says so in three places — gh's
*"checksum is verified against the release's own manifest"* (`:160-161`), Go's
*"a checksum verified against Google's own published digest… fetched per version
rather than pinned here"* (`:189-191`), uv's *"verified against Astral's own
published digest"* (`:247-248`). And `:203` was the tarball download line, not a
checksum at all; the digest is `:204-205`.

**Direction: easier.** The closed-table sub-shape of Option A would be the
*first* place this repository chose a digest itself, which is a cost rather than
a precedent. `20-` defers `02-` behind `05-`'s minimal form, and this correction
is part of why.

### 1.2 `05-` — the minimal form needs no manual tagging · **easier**

**Was:** the image is built from source rather than pulled, so
`FROM usagefoundry:latest` requires the operator to have tagged a build.

**Is:** `docker-compose.yml:37` is `image: usagefoundry:${UF_IMAGE_TAG:-latest}`
alongside `build:` at `:3-18`, and compose tags the built image with the `image:`
value. `usagefoundry:latest` exists after any stock `docker compose up --build`.
The real caveat is narrower: an operator running a second instance under a
distinct `UF_IMAGE_TAG` has to `FROM` that one instead.

**Direction: easier, and this one moved a score.** Option D's minimal form is
documentation only, half a day, and now has no setup step in front of it.
`19-` §5 records it as the table's surprise at 90 points; `20-` phase 1 ships it.

### 1.3 `06-` — one of its three "wrong claims in the tree" is a misreading · **easier**

**Was:** `orchestrator.ts:5983-5984`'s docblock *"says the two `BUILD_CACHE_DIRS`
are pointed at a named volume… That is true of `$GOPATH` and **false of
`$HOME/.npm`**."*

**Is:** the full sentence is *"npm's cache is `$HOME/.npm` and Go's is under
`GOPATH`, **which** the image points at a named volume so it survives a container
it is meant to outlive"* — the relative clause attaches to `GOPATH`, immediately
preceding it. **The comment is correct as written.** What is true is that it
reads on a fast pass as covering both, and three files in this directory read it
that way. `$HOME/.npm` is genuinely on no volume (`docker-compose.yml:330-423`)
and is discarded by every rebuild.

**Direction: easier.** Phase 1 of `20-` inherits `06-` §2's corrections, and one
of the three is now a clarification rather than a fix. Less work, and the tree
was not as wrong as this directory said it was. Fixed in all three places that
carried it — `00-`, `01-` §8 and `06-` §2.

### 1.4 `09-`, `10-`, `11-` — `terminalEnv()`'s strip list is six, not five · **easier**

**Was:** all three described `terminalEnv()` as stripping *"`UF_*`,
`ANTHROPIC_*`, `OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `DATA_DIR`"*, citing
`01-constraints.md` §3.

**Is:** §3 and the code it quotes (`childEnv`, `orchestrator.ts:6306-6321`) give
**six**: `UF_*`, `OTEL_*`, **`ANTHROPIC_ADMIN_KEY`** — not the wildcard
`ANTHROPIC_*`, which is `gitEnv`'s form (`git.ts:55`) —
`CLAUDE_CODE_ENABLE_TELEMETRY`, `DATA_DIR`, and **`NODE_OPTIONS`**, which all
three dropped.

**Direction: easier, and it matters most for `09-`.** That file's §2 argues the
strip is what keeps `UF_AUTH_TOKEN` out of the terminal's environment. A
`terminalEnv()` built from the list as written would have inherited
`NODE_OPTIONS`, **which is code execution into every Node child that terminal
starts**. The terminal's security cost is higher than it was written to be, and
`20-` rejects it.

### 1.5 `08-` and `13-` — a fabricated quote under a real argument · **harder**

**Was:** *"`.env.example` calls `UF_ALLOW_NO_AUTH` 'only ever right for a
loopback-bound install on a machine you alone use'."* **No such sentence exists
anywhere in `.env.example`.**

**Is:** `.env.example:7-9` says to set it *"ONLY if the port is bound to loopback
and you are the only user of the machine"*, and the *"only ever right for
loopback"* phrasing lives at `docker-compose.yml:71-72`.

**Direction: harder, and it is the only one.** `13-` §10's argument — that on a
sanctioned `UF_ALLOW_NO_AUTH=1` install a terminal pane is an unauthenticated
root shell for any local process that can reach port 3000 — is load-bearing in
`20-`'s rejection of `09-`. It survives on the real sources, which say the same
thing in weaker words. **A rejection resting partly on a quotation that was never
written is exactly what this pass exists to catch**, and the argument is now
sourced rather than asserted.

### 1.6 `13-` — the `docker compose exec` counts · **easier on net**

**Was:** *"twenty-one times across its four operator-facing pages —
`install.md` 10, `security.md` 4, `README.md` 4, `backup-and-restore.md` 3, and
55 times across the whole tree."*

**Is:** install.md 10 ✓, security.md 4 ✓, **README.md 3**, backup-and-restore.md
3 ✓ — so **twenty**, not twenty-one. And the whole tree is **109** occurrences
(82 excluding `proposals/`), not 55.

**Direction: easier on net.** The headline figure drops by one and the tree
figure doubles. `20-`'s claim that the shell is *"shipped, documented twenty
times"* is now exact.

---

## 2. The other 33, by class

**Wrong line numbers (16).** `00-`: `docker-entrypoint.sh:169-190` → `:169-211`
(the block closes at 211, not 190; the sibling `:241-310` was already exact), and
`privsep.ts:238-240` → `:237`. `01-`: nothing. `02-`: `privsep.test.ts:69` →
`:68` (69 is a comment inside the test). `03-`: `Dockerfile:496-499` → `:498-499`
at the quoted sentence. `04-`: `Dockerfile:129` → `:130` for `sqlite3`. `07-`:
`docs/backup-and-restore.md:14-31` → `:33-72` for a *restore* claim — `:14-31` is
the Back up section. `08-`: `chat/page.tsx:977-1066` → `:789-793` (the cited
range is the Proposals side card, not the composer), `ui-density-audit.md:166` →
`:166-167`, `:161` → `:160-161`, `QuickOpen.tsx:72-77` → `:73-77`. `11-`:
`docker-entrypoint.sh:169-190` → `:169-211`, twice. `12-`:
`docs/backup-and-restore.md:14-31` → `:33-72`, same error as `07-`'s.

**Wrong file for a real quote (3).** `08-`: *"whose hooks the container runs"*
attributed to `docs/agent/architecture.md` — it is `CLAUDE.md:95`; and *"a shared
secret over plain HTTP"* attributed to the compose comment — it is
`.env.example:136-137`. `04-`: `auditMutation`'s invariant attributed to
`docs/agent/chat.md` — it is `docs/agent/run-lifecycle.md:11`. (`chat.md:22`
mentions `auditMutation` only to say the `/api/mcp` capability check stands
*outside* it, which is nearly the opposite claim.)

**Wrong counts (5).** `00-`: `tar`, `sha256sum` and `install` claimed to come
from *busybox* — they are GNU coreutils/tar from the Debian base, and the word
"busybox" appears nowhere else in the repository. `01-` §10: *"the three existing
loops"* — there are **two**; three is the volume count. `01-` §3: *"all five are
consumed entirely by the entrypoint"* — the `UF_SANDBOX*` wildcard expands to
three, so it is **six** names. `01-` §10: *"carries two suites"* followed by four
items — `:892` is in the winnow suite and `:961` in the compose-forwarding one.
`05-`: *"the six `ARG`s that already exist"* — the runner stage carries **eight**.

**Wrong citation for a true claim (2).** `00-`: `middleware.ts`'s bearer token
cited to `docs/agent/environment.md:14`, which never mentions middleware or a
bearer token — the evidence is `src/middleware.ts:41`, `:128-129`. And the
`isolate` default cited to `settings.ts:697`, which is `DEFAULT_CHAT_GUARDS` —
the run default is `src/app/runs/new/page.tsx:171`, with an omitted field also
reading as on at `settings.ts:934`.

**Citation over-reach (1).** `08-`: five env functions claimed to strip `UF_*`
"per `01-constraints.md` §3", where §3 names only two of them. The claim is true;
the source covers 40% of it.

**A command that returns nothing (1).** `03-` §10: `grep -rn "spawn(\"" src/lib/`
returns **zero** matches, because every spawn site passes an identifier rather
than a string literal. The conclusion the file draws from it is right — argv[0]
is `CLAUDE_BIN`, `GIT_BIN` or one absolute interpreter — but a reader running the
stated command would have concluded there were no spawn sites at all. Corrected
to `grep -rn "spawn(" src/lib/`.

**An incomplete table (1).** `01-` §7's seccomp table omits `pivot_root`, which
is in the appended ungated group and — unlike the five listed beside it —
appears **once**, in no gated Docker rule. `docker-compose.yml:462-463` names all
six.

**A self-inconsistent example (1).** `05-` §2's Dockerfile example set
`TF_PLUGIN_CACHE_DIR=/home/node/go/../tf-cache`, which normalises to
`/home/node/tf-cache` — the **writable layer**, by that file's own §5 and
`01-constraints.md` §8, and therefore discarded on every rebuild. The example
demonstrated the exact failure it existed to avoid. Corrected to
`/home/node/go/tf-cache`, inside `usagefoundry-gocache`.

**A correction that was itself wrong (1).** `06-` §2 item 3 said `chat.ts`'s one
`spawn(` serves two kinds. It has one `spawn(` (`:1709`), but
`docs/agent/architecture.md:203` says a workflow's orchestrator block is *"not a
fifth kind: it is the fourth one invoked without a thread"* — so `chat.ts` serves
**one** kind through two callers, and it is `review.ts`'s single spawn that
serves two. Also, `06-` §2 called `contextPruning.ts:626-627` a contradiction
*"300 lines away"* from `privsep.ts:236` — they are in different modules, so no
distance applies. `00-` carried the same `chat.ts` error and is fixed with it.

**Stale provenance (1).** `08-` line 8 said the tree was at `86debce`. That is
now several commits back; the file records both the original check and the
re-resolution.

---

## 3. `14-` through `21-`

Written this run, and held to the same standard rather than exempted from it —
including a second, independent pass over all eight of them, which is the only
reason half the table below exists. **Fifteen errors were found and fixed**,
listed here for the same reason the other 39 are: a validation file that audits
everything except its own author's work is a validation file with a hole in it.

| | What was wrong | Direction |
|---|---|---|
| `16-`, `17-`, `21-` | *"this repository does not test I/O"* — **false.** Sixteen of its 92 tests are over routes and components, and `src/app/api/health/route.test.ts` gives the grounds: the healthcheck *"answers falsely when this server cannot do its job"*, and *"a route that always answers 200 is indistinguishable from a working one until the day the database goes read-only."* The true bar is narrower and the sketch's routes still fail it, so the conclusion stands on a better reason | neutral |
| `20-`, `README` | the recommendation's own arithmetic: three phases at 1-2, 2-3 and 1-2 days is **four to seven**, not six to nine. It was overstating its own cost | easier |
| `19-` §6 | the Asked×5 / Cheap×2 row's figures were wrong — the right ones are `L` 93, `N` 89, `C/M` 70. **The conclusion it supports is unchanged, which is why it survived a read** | neutral |
| `19-` §6 | *"`F` drops from 84 to ~40"* — zeroing a 5 at weight 5 gives **59** | neutral |
| `19-` §6 | *"the ranking does not change"* under Asked×5 — the **lead** does not; `C/M` rises three places below it | neutral |
| `19-` §5 | *"`B` … worse on five of seven criteria, better only on cost"* — it is worse on **four**, tied on a fifth, and better on **two** (Cheap and Asked). The domination claim is weaker than written and still holds | **harder** |
| `20-` | *"phase 2 is that feedback at a twentieth of the cost"* — `16-`+`12-` is 7-12 days against phase 2's 2-3. **A third, not a twentieth** | **harder** |
| `20-` | *"three `docs/agent/` files moved"* for `16-` — its own §9 lists three and says `conventions.md` gains **nothing**, so it is **two** | **harder** |
| `14-` §5, §7 | three `docs/agent/` quotes were **`CLAUDE.md`'s paraphrases wearing the doc's name**. `agents-and-templates.md:18` says *"never falls back to none"*, `:10` says *"refused at save"*, and `workflows-and-schedules.md:47` says *"no permission mode, no isolation choice, no model and no budget blob"* | neutral |
| `14-` §6 | `.env.example:288-290` called a *repeat* of `:204-207` — it is near-identical, ending *"an executable a hook runs"* | neutral |
| `21-` phase 1 | `.env.example:263-273` cited for the `Dockerfile.stack` route — that range covers the override half only, and **`Dockerfile.stack` appears nowhere in the tree** | neutral |
| `21-` | *"the 92 existing ones"* — `docs/agent/testing.md` covers both counts; 76 under `src/lib/`, 92 across `src/` | neutral |
| `14-`, `21-` | the hatched-meter rule quoted in `CLAUDE.md`'s paraphrase rather than `docs/agent/metering.md:8`'s own words | neutral |
| `16-` §2 | *"the five that are already there"* did not say which five. Now named with line numbers | neutral |
| `21-` | two off-by-ones: `settings.ts:300-303` → `:300-302`, `docs/install.md:52-56` → `:53-57` | neutral |

**Three of the fifteen made the recommendation harder**, all in the same
direction: `19-` and `20-` were each overstating a margin in their own favour —
a domination that is four criteria rather than five, a cost ratio of three
rather than twenty, and one fewer invariant moved by the option being rejected.
None of the three reverses anything; all three make the case narrower than it
was written to be.

**And the second pass found a bug in the tree rather than in this directory.**
`docs/agent/conventions.md:50` says the pane list *"is closed at eight, because
⌘1…⌘8 has eight digits"* and bans *"a ninth pane"* — where
`src/components/shell/panes.ts:14-16` says *"Nine is the ceiling and Knowledge is
the ninth — a tenth destination has no digit"* and `ui-density-audit.md:159`
counts nine rows bound to ⌘1–⌘9. **The proposals cite `panes.ts` and the audit
and are right; `conventions.md` is stale by one** — and it is stale on the same
line four files here quote *"seven affordances"* from. `21-` phase 1 item 6
collects it.

Counts in these files that were checked rather than asserted: **eighteen** route
answers through `jsonMaybeGzipped` (`docs/agent/conventions.md:18`), **seven**
boot reconcilers in `instrumentation.ts:101-164`, **92** test files under `src/`,
and **twenty** `docker compose exec` occurrences across the four operator-facing
pages (10 + 4 + 3 + 3).

Four facts these files rest on were measured directly in this container rather
than reasoned, and each is stated at the point it is used:

1. **`docker-entrypoint.sh` is 972 lines and `exec "$@"` is the last one.** Both
   install loops sit hundreds of lines above it, so a slow install is a container
   that is not yet serving. (`14-` §4.)
2. **Neither loop has a timeout.**
   `grep -n "timeout\|--max-time\|--connect-timeout" docker-entrypoint.sh`
   returns exactly one line, `:951`, and it is a one-second socket probe for
   winnow's port — on neither install path. (`14-` §4.)
3. **Nothing in `src/` reads the boot log.** `ops_events` is server-written only;
   the two `deployment.test.ts` references to `docker-entrypoint.sh` read it as a
   *text fixture* at build time, not at runtime. An operator's only channel for
   an install failure is container stderr. (`14-` §4, §5.)
4. **The server holds `UF_PY_TOOLS` and `UF_GH_EXTENSIONS`**, which is the one
   fact `20-`'s phase 2 is cheap because of. Compose forwards both
   (`docker-compose.yml:123`, `:130`), and `grep -n "unset" docker-entrypoint.sh`
   shows the only two variables removed before `exec` are `DISCORD_WEBHOOK_URL`
   and `DISCORD_MENTION_USER_ID` (`:853`). `childEnv`'s strip is a **child-side**
   rule and does not reach the server. (`15-` §2, `21-` phase 2.)

The one claim in these files that is **reasoned and not observed** is
`14-` §3's persistence table, for the same reason every other persistence claim
in this directory is: Docker is unavailable here.

---

## 4. What cannot be verified from this container

Unchanged from `00-` and `08-`, and restated because a recommendation that
depends on unobserved facts should say so where the recommendation is, not only
where the survey started.

- **Any rebuild, any volume, any image build.** Docker is not installed. Every
  row of `01-constraints.md` §1's four-event table is documented semantics plus
  this repository's own statements, and `19-` §7 marks the whole "Durable" column
  as reasoned rather than measured.
- **Whether a work cycle at `acceptEdits` can invoke an arbitrary binary.** The
  single most decisive unknown in the survey; eleven of `19-`'s twelve rows score
  0-3 on it. Reasoned from two adjacent measurements
  (`orchestrator.ts:5082-5089`, `settings.ts:290-296`), both of which are of
  `git`, which the CLI may classify specially.
- **Terraform, or any real stack tool.** None was downloaded, installed or run.
- **The seccomp profile in action.** Parsed (`01-` §7), never applied —
  `docker-compose.yml:490-491` ships it commented out.
- **`/data`, and therefore all run history.** `ls -la /data` → `Permission
  denied`. There is no figure anywhere in this survey for how many runs would
  have used a stack tool, how often an operator installs one, or how long a boot
  currently takes.
- **Whether the operator has one toolchain or four**, and **whether they have
  host access to the container.** Neither is a fact about the tree. Both are
  named in `20-` "What would overturn this" and both are one sentence away from
  being known.
- **`09-`'s four probes**, unchanged from `08-` §9: the standalone server's
  `upgrade` handler, `node-pty`'s build and trace, an agent-uid shell's real
  write set, and backpressure on an unread stream.

---

## 5. The exact commands a human should run

In the order they buy the most.

**1. The probe — one work cycle, and it decides more than the other four
together.**

```bash
docker compose up -d --build
# set UF_PY_TOOLS=ruff==0.6.9 in .env, then:
docker compose restart
docker compose logs usagefoundry | grep "installed Python tool"
#   expect: [usagefoundry] installed Python tool ruff==0.6.9   (docker-entrypoint.sh:297)
```
Then start a run at `acceptEdits` (the default) on any mounted repository with
the task: *"Run `ruff --version` and report exactly what it printed. Then run
`ruff check .` and report the first line."* Read the log for a
`This command requires approval` refusal, and read the run's own report text.
Four outcomes, each decides something different — `07-` §10 lists them.

**2. The four persistence events, which nothing in this directory has observed.**

```bash
docker compose exec usagefoundry sh -c 'command -v ruff; ls /home/node/pytools/bin'
docker compose up -d --build                                    # the rebuild row
docker compose exec usagefoundry sh -c 'command -v ruff'        # expect: still there
docker compose down -v && docker compose up -d                  # the down -v row
docker compose logs usagefoundry | grep "installed Python tool" # expect: reinstalled
```
Whatever these print belongs in `docs/verification.md`, which today has **one**
line matching `UF_PY_TOOLS|UF_GH_EXTENSIONS|gocache` (`:1371`) and it is about a
guard. The mechanism the whole survey builds on is pinned by a unit test over
file contents (`deployment.test.ts:664`, `:733`) and has never been run against a
real rebuild.

**3. Whether an agent-uid shell can write anything worth writing** — `08-` §9
item 3, and it decides whether any terminal option is livable.

```bash
uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
gid=$(docker compose exec -T usagefoundry printenv UF_AGENT_GID)
docker compose exec -T usagefoundry setpriv --reuid="$uid" --regid="$gid" \
  --clear-groups bash -lc 'id; echo $PATH; touch /usr/local/bin/probe; \
    touch /home/node/pytools/bin/probe; apt-get install -y --dry-run jq'
#   expected: /usr/local/bin refused, /home/node/pytools/bin written, apt-get refused.
```

**4. `05-`'s minimal form, end to end** — because `20-` phase 1 documents it and
nobody here has run it.

```bash
# Dockerfile.stack + docker-compose.override.yml per 05- §2, then:
env -u __NEXT_PRIVATE_STANDALONE_CONFIG docker compose up -d --build
docker compose exec usagefoundry terraform version
```
The `env -u` is not optional if the build is started from inside an agent
session: a shell inheriting `__NEXT_PRIVATE_STANDALONE_CONFIG` makes `next build`
die with `TypeError: generate is not a function` (`CLAUDE.md`, Commands), and the
error names nothing relevant.

**5. The two questions for the operator**, which cost a sentence each and settle
more than any command above.

- *Do you have host access to the machine this container runs on?* — decides
  whether `13-` is an answer or a refusal, and it is `13-` §10's own killer.
- *What are the five commands you expect to type?* — decides between `11-`,
  `10-` and nothing at all. `09-` §10, `10-` §10 and `11-` §10 each name this
  question from their own direction and **none of the three runs that wrote this
  directory asked it.**
