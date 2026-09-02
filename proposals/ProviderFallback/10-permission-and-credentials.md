# Permission, sandbox, and credentials

What a Codex process would and would not be under, item by item, and where an
OpenAI key would live. This file does not paper over a gap; where there is no
equivalent it says so and says what is given up.

It also contains the one piece of work this survey recommends **regardless of
which option wins**.

---

## Part 1 — What confines a work cycle today

Four mechanisms, in decreasing order of how much they actually bound.

### 1. The container, and the uid below it

`childCredentials()` (`src/lib/privsep.ts:252`) drops the child to
`UF_AGENT_UID`. The spawn site's comment says what that is for:

> The uid `childEnv`'s strip only means something against: same process, one step
> down, so `/proc/<server>/environ` and `/data` stop being readable by the thing
> whose prompt came out of a repository.
> — `src/lib/orchestrator.ts:5624`–`:5626`

**A Codex process would be under this unchanged**, because it is a property of
the spawn rather than of the binary. Any option that spawns through the same
discipline (C9) inherits it for free. This is the strongest containment the app
has and it is provider-independent.

### 2. `--permission-mode`

`buildArgs` emits it per cycle (`cycleInvocation.ts:1025`). Runs default to
`acceptEdits` (`CLAUDE.md`).

**Codex has no equivalent, and the substitute is not a substitute.** Codex has
two orthogonal controls:

- `--sandbox {read-only | workspace-write | danger-full-access}`
  (`codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs`)
- an approval policy with exactly two members, `on-request` and `never`
  (`approval_mode_cli_arg.rs`), plus `--approve-for-me`, which routes approvals
  through automatic review under `workspace-write`, and
  `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`), whose own help
  reads "EXTREMELY DANGEROUS. Intended solely for running in environments that
  are externally sandboxed."

For an unattended run there is nobody to approve, so the approval axis collapses
to `never` — and the sandbox axis is then the whole of the boundary. What
`workspace-write` actually permits on Linux, and whether it composes with this
container's seccomp profile, is **U5** and was not verified.

Note what the `--yolo` help implies: OpenAI's own position is that bypassing the
sandbox is acceptable *when something else is doing the sandboxing*. This
container is that something else — the uid drop, the process group, the mounts —
which is a coherent argument for using it. It is also exactly the argument that
`docs/agent/security.md` exists to make carefully rather than quickly.

### 3. `--allowedTools` and `--disallowedTools`

```
--allowedTools    <ISOLATED_GIT_TOOLS if isolated> <SEARCH_TOOLS>
--disallowedTools Bash(pkill:*) Bash(killall:*)
```
— `cycleInvocation.ts:1042`–`:1050`, with `PROCESS_KILLERS` at `:650`

**No per-invocation equivalent was found.** Codex has execpolicy `.rules` files
and `--ignore-rules` to skip them — a file-based mechanism with a different
lifetime and a different owner (user, project, or managed layers).

The `--disallowedTools` half is the one that matters and it is not about
convenience. **The app runs inside the process the agent could kill.** `pkill`
and `killall` are denied on argv, and `SELF_HOSTING_NOTICE` (`:652`–`:663`) is
what stops the agent routing around the denial:

> `PROCESS_KILLERS` stops two commands; this is what stops the agent routing
> around them, which otherwise takes it one turn — `kill $(pgrep -f next-server)`
> is not `pkill` and is exactly as fatal.

**Both halves are absent for Codex** — the deny list has no argv, and the notice
needs `--append-system-prompt`, which is U6.

### 4. The managed sandbox, and the fact that this app only reads it

`sandboxArrangement` (`src/lib/sandbox.ts:232`) reads
`/etc/claude-code/managed-settings.json` (`sandbox.ts:166`) and reports one of four states.
It does **not** write it. `Dockerfile:400`–`:402` installs
`@anthropic-ai/sandbox-runtime` pinned at `0.0.71` because without it "the domain
allowlist is enforced by a proxy on a unix socket, and the seccomp filter is the
whole of what stops a sandboxed command dialling that socket directly. Absent,
the allowlist is advice."

So the network boundary an agent runs under is a Claude Code feature, configured
in a Claude Code file, enforced by a Claude Code package.

**A Codex process is under none of it**, and — this is the part that must not be
papered over — **the app's own reporting would not say so.** The Sandbox card
reads the Claude managed-settings file and would keep reporting whatever that
file says, for a run that was not under it. That is exactly the failure
`policyNamesSomething` (`:201`) was written against: a sandbox that reads as on
and confines nothing.

Any option that spawns Codex owes a change to `sandboxArrangement`'s output, or
the card lies.

### 5. MCP — not part of the run contract

Worth stating because the brief asks: **`buildArgs` carries no `--mcp-config`.**
MCP wiring in this repository is on the *chat* path (`src/app/api/mcp/route.ts`
and `docs/agent/chat.md`), not the run path. So the MCP tool surface is not
something a fallback has to satisfy, and U7 is about future scope rather than
about this feature.

## Part 2 — Summary of what is given up

| mechanism | Codex under it? |
|---|---|
| the container | **yes** |
| uid drop (`childCredentials`) | **yes**, by construction |
| own process group / `signalTree` | **yes**, by construction |
| `--permission-mode` | **no** — `--sandbox` × approval policy, not equivalent, U5 unverified |
| `--disallowedTools` (`pkill`, `killall`) | **no** — no argv equivalent found |
| `SELF_HOSTING_NOTICE` | **no** — needs `--append-system-prompt`, U6 |
| `COMMIT_IDENTITY_NOTICE` | **no** — same |
| `@anthropic-ai/sandbox-runtime` seccomp + domain allowlist | **no**, and the app's Sandbox card would not say so |
| winnow's intake proxy | **no** (C11) |
| the vault skill and read guard (generated plugins) | **no** — Claude-Code-shaped artifacts |

**Two of those are safety rather than fidelity**, and they are the pair worth
refusing over: the process-kill denial and the self-hosting notice. Together
they are what stands between an unattended agent and the supervisor process it
runs inside. An option that ships without both has to say, in writing, that it
accepts an agent in this container with no instruction about the process it is
running in and no denial on the two commands that end it.

## Part 3 — Credentials

### Where a key would live

Codex reads three environment variables by name —
`OPENAI_API_KEY_ENV_VAR`, `CODEX_API_KEY_ENV_VAR`, `CODEX_ACCESS_TOKEN_ENV_VAR`
(`codex-rs/login/src/lib.rs:38-47`, used in
`codex-rs/login/src/auth_env_telemetry.rs`) — and additionally supports a
ChatGPT-plan login persisted under `CODEX_HOME` with a `chatgpt_plan_type` on the
token (`codex-rs/login/src/token_data.rs`).

That gives two shapes, and they are not equally good here:

**A file under `CODEX_HOME`, mounted.** This is what `~/.claude` already is for
Claude: a mount carrying a login and nothing else. `claudeAuth.ts:275`–`:284`
records the hazard that comes with it — the CLI writes `.credentials.json` at
mode 0600 owned by whoever wrote it, and every work cycle runs as
`UF_AGENT_UID`, so a login performed with the server's authority produces a
credential the panel reports as present and no agent can open. A Codex
equivalent inherits that whole trap, and inherits the fix (`childCredentials()`
in `spawnOptions`, `claudeAuth.ts:286`–`:292`).

**An environment variable.** Simpler, and the one that is dangerous here.

### The defect that exists today

`childEnv` (`src/lib/orchestrator.ts:5369`–`:5384`) is a **denylist**:

```ts
key.startsWith("UF_") || key.startsWith("OTEL_") ||
key === "ANTHROPIC_ADMIN_KEY" || key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
key === "DATA_DIR" || key === "NODE_OPTIONS"
```

`OPENAI_API_KEY` is not on it. Neither is `CODEX_API_KEY`. So **an operator who
sets either on the server today hands it to every child this app spawns** —
`orchestrator.ts:5621` (runs), `chat.ts:2104` (chat), `review.ts:660` (review),
`claudeAuth.ts:302` and `:414` (auth) — inside sessions that have `Bash`, which
can print `env`.

`authEnv` (`claudeAuth.ts:258`) is a copy of the same list, and its docblock
proves the repository already reasons about this class:

> `ANTHROPIC_API_KEY` is **not** stripped, and that is the point rather than an
> oversight: `childEnv` passes it to every work cycle, so a status read that hid
> it would report the subscription login while runs billed a key.
> — `claudeAuth.ts:249`–`:252`

That is a considered decision for a credential the CLI in question is *supposed*
to use. There is no such decision on record for a credential that belongs to a
different vendor's binary.

### The repair that is owed either way

**Add `OPENAI_API_KEY` and `CODEX_API_KEY` to `childEnv`'s strip — or, better,
adopt the namespace rule the repository already uses.**

`githubEnv`'s docblock makes the argument for a namespace over a list:

> That withholding is by namespace rather than by remembering, so a *second*
> credential shape is covered by it with no change: `UF_GITHUB_TOKENS` leaves
> those children the same way `UF_GITHUB_TOKEN` does.
> — `src/lib/orchestrator.ts:5515`–`:5517`

The same argument applies: a credential this app holds for a *provider* should
arrive under `UF_` and be re-emitted deliberately at the one spawn site that
needs it, rather than being inherited by every child because nobody remembered
to add it to a list. A denylist fails open, and this one currently fails open on
a key that does not exist yet — which is the cheapest possible moment to fix it.

**This is one line plus a unit test, it is worth doing whether or not any
fallback is ever built, and it is the only concrete change this survey
recommends.** `14-validation.md` §"Owed repairs" carries it.

### And the commit hazard

`CLAUDE.md` and `COMMIT_IDENTITY_NOTICE` forbid an agent signing commits with
the operator's email; commit `1943bdd` is that rule being added. The notice
rides `--append-system-prompt`, which Codex has no equivalent for (U6).

So a Codex run's commits are attributed by whatever `git` config the container
provides, with no instruction to the agent about it — and `githubEnv`
(`orchestrator.ts:5526`–`:5554`) already installs a credential helper for `github.com` and
rewrites SSH remotes to HTTPS, so a Codex process inheriting that environment can
push. **A run that cannot be told not to sign as the operator, and can push, is
the one combination this repository has already legislated against.**
