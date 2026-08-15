# Validation

An adversarial pass over the eleven files before this one, on 2026-08-15, from
inside a live work cycle on the install they were written on.

**The recommendation stands.** Option B is still the best fit after the refuted
claims are removed, and the reason is that every one of the new findings applies
to Option D as well — D reaches the same confinement through the same CLI
mechanism (`04-option-runner-with-per-run-sandboxes.md`, "the managed-settings
route of `02x` is available here too"), so the evidence moves both candidates
down together and leaves the ordering alone. What did move is the **cost** and
one **precondition**: the sandbox needs three dependencies rather than one, and
per-run confinement is decorative until `~/.claude/settings.json` stops being
agent-writable. That last one is not in the proposal anywhere and is the single
most important thing in this file.

The codebase claims are accurate. Twenty-eight of them were opened and read;
two are wrong, one of those because the proposal faithfully reproduced a stale
comment in `privsep.ts`. The claims that failed are almost all claims about the
**vendor binary**, which is exactly where `08-recommendation.md` said its risk
was — the proposal was right about where it was weakest, and still understated
how weak.

Counts: **21 confirmed**, **7 refuted**, **6 unverifiable**.

---

## Verdict table

Refuted first.

| # | Claim | Citation | Verdict | Evidence |
|---|---|---|---|---|
| 1 | The per-run policy cannot be weakened by anything the run can write; the repository's `.claude/settings.json` "would otherwise be the hole" | `02x:34`, `09:56` | **refuted** (incomplete) | The repo's file is indeed ignored. But `~/.claude/settings.json` is an *honored* sandbox source — `FUt()` returns `[...Mne(), tn("flagSettings"), vg("userSettings") ? tn("userSettings") : null]`, and `filesystem.allowWrite` is documented "Additional paths to allow writing" (additive). Measured here: `/home/node/.claude` is `drwx------ node node`, `settings.json` is `-rw------- node node`, both writable by uid 1000, and `CLAUDE_CONFIG_DIR=/home/node/.claude` is in the agent's own environment. A run appends `{"sandbox":{"filesystem":{"allowWrite":["/"]}}}` and every later session — its own and every sibling's — is confined to nothing. |
| 2 | "one image plus `bubblewrap`", "one apt line", "`bubblewrap` is a small package" | `README:8`, `02x:29,83,124`, `08:44`, `09:51` | **refuted** | The binary's own dependency check reports **three**: `bubblewrap (bwrap) not installed` and `socat not installed` are *errors*; a missing seccomp applier is a *warning* — `"seccomp not available - unix socket access not restricted"` and `"[Sandbox Linux] apply-seccomp binary not available - unix socket blocking disabled. Install @anthropic-ai/sandbox-runtime globally for full protection."` The third is an npm global (`@anthropic-ai/sandbox-runtime`, or vendored `vendor/seccomp/*` with `sandbox.seccomp.bpfPath` and `applyPath`), so `Dockerfile:194`'s version pin does not cover it and it is a second vendor contract to keep in step. |
| 3 | A network allowlist "enforced inside a namespace rather than by an environment variable, which is the difference between a policy and a suggestion" | `08:38`, `02x:43`, `07:51` | **refuted** (mechanism) | It is a **proxy**. The CLI runs an HTTP and a SOCKS proxy on unix sockets and bridges them in with `socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:<sock>`; `sandbox.network.tlsTerminate` and `caCertPath: Qj?.trustBundlePath` terminate TLS with its own CA. Placement is right — the namespace has no other route — but what closes the bypass is the seccomp filter of #2, and that is the piece whose absence is only a warning. |
| 4 | "*project settings … are ignored. If managed settings configure `sandbox.filesystem` at all, or list any `sandbox.credentials.files` deny entry, only managed settings can set this*", quoted as a general pin on `sandbox.filesystem` | `02x:19`–`21` | **refuted** (attribution) | In the binary this is the `describe()` of **`sandbox.filesystem.disabled`** — the sentence continues "*an admin who deployed filesystem restrictions must not have them switched off by a user-writable file*" and ends "*When unset, filesystem isolation stays on.*" It pins the escape hatch, not the policy. The conclusion survives on different evidence: `allowWrite`/`allowRead` carry their own "*Only honored from user, managed/policy, or CLI (`--settings`) settings — project settings … are ignored*". |
| 5 | "all six spawn sites — the work cycle, the reviewer, both of the chat's and both of git's"; "both spawns in `src/lib/chat.ts:1653`" | `00:11`–`14`, `09:78` | **refuted** | There are **five**: `orchestrator.ts:4793`, `review.ts:608`, `chat.ts:1653`, `git.ts:124`, `git.ts:176`. `chat.ts` has one, which serves both the chat and an orchestrator block (`runOrchestratorChild` — `docs/agent/architecture.md:102` says so by name). The proposal is faithful to `src/lib/privsep.ts:148`–`149`, which says "both of `chat.ts`'s" and is itself stale. |
| 6 | "Four bind mounts, one named volume for the database, one for Go's caches" | `00:18` | **refuted** | **Six** host bind mounts. `/proc/self/mountinfo` shows four workspaces, `~/.claude`, **and `/backups`** (`docker-compose.yml:231`, `${UF_BACKUP_DIR:-./backups}`). `/backups` is missing from the reachability table and is writable by the agent — see #7. |
| 7 | The reachability table in `README.md` and `00-problem.md` is the complete list of what a run reaches | `README:28`–`38` | **refuted** (incomplete) | `/backups` is a host directory (`…/Documents/GIT/UsageFoundry/backups`), `test -w` passes as uid 1000, and it is where `scripts/backup-db.mjs` writes — defaulting to `/backups` whenever that is a directory (`scripts/backup-db.mjs:96`–`104`). `/data` is 0700 root; a snapshot of the database inside it is not. Nothing writes there unless the operator runs the script, which bounds it, but it is a documented path (`docs/backup-and-restore.md`) and it belongs in the table. |
| 8 | `/data` unreachable: `0:0 700`, `test -r` fails | `00:31`–`32` | confirmed | Re-run below. |
| 9 | Server environment unreachable: `/proc/7/environ` denied | `00:33` | confirmed | Re-run below. |
| 10 | `~/.claude/.credentials.json` readable by the agent uid | `00:44` | confirmed | `-rw------- 1 node node 509`, readable as uid 1000. |
| 11 | A concurrent run's checkout is writable | `00:49`–`51` | confirmed | 20 slots now (19 when written); three sampled, all `WRITABLE`. |
| 12 | `/proc/7/cmdline` world-readable, reads `next-server (v…)` | `00:62` | confirmed | Re-run below. |
| 13 | `CapBnd 00000000a80425fb`, no `CAP_SYS_ADMIN`, `unshare` EPERM, `cgroup2fs`, `6.12.76-linuxkit aarch64` | `00:74`–`77`, `02x:93`–`94`, `08:50` | confirmed, **and sharpened** | All four reproduce. `CapEff` is `0000000000000000` — the bounding set is not the effective set. And the block is **seccomp, not capabilities**: `/proc/sys/user/max_user_namespaces` is 31734, `Seccomp: 2` with `Seccomp_filters: 1`, and *every* namespace type fails, including plain `unshare -U` which needs no privilege on a stock kernel. The proposal reasoned its way to the right diagnosis without this measurement; it now has it. |
| 14 | Three of four workspace slots resolve to the same host directory, all mounts carry `fakeowner` — Docker Desktop for macOS | `00:19`–`24` | confirmed | `/workspace`, `/workspace3`, `/workspace4` → `/hendrikkuehnel/Documents/GIT`; every bind is `fakeowner /run/host_mark/Users`. |
| 15 | The nine `sandbox.*` keys and `/etc/claude-code` + `managed-settings.json` are in the pinned binary | `02x:9`–`14` | confirmed | Both commands reproduce **exactly**, including the nine key names. Sub-keys the proposal did not list also exist: `credentials.{files,envVars,awsPairs,sigv,allowPlaintextInject}`, `filesystem.{allowRead,allowWrite,denyRead,denyWrite,disabled}`, `network.{allowedDomains,deniedDomains,allowManagedDomainsOnly,tlsTerminate}`, `seccomp.bpfPath`, and `enabledPlatforms`. |
| 16 | `sandbox.failIfUnavailable` exits at startup rather than running unsandboxed | `02x:16`–`17,108`, `08:32` | confirmed, **stronger than claimed** | Two distinct paths in the binary: `Sandbox required but unavailable: ${v}. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.` on the result envelope, and `sandbox.failIfUnavailable is set — refusing to start without a working sandbox.` on stderr. Also `t.enabled===!0 && t.failIfUnavailable===void 0 ? {...t, failIfUnavailable:!0}` — enabling without saying defaults it to *on*. |
| 17 | "*bubblewrap is required for subprocess env scrubbing and isolation*" | `02x:18` | confirmed | Verbatim, twice. |
| 18 | No `--sandbox` flag on this pin; `--settings <file-or-json>` is real | `02x:22`–`25` | confirmed | `claude --sandbox mcp list` → `error: unknown option '--sandbox'`. `--settings <file-or-json>` is in `--help`. |
| 19 | "*By default, your command will be run in a sandbox*", and the sandbox is around **commands** — assumed, not executed | `02x:50`–`56`, `08:72` | confirmed as *assumed*, evidence now runs both ways | The quote is verbatim and sits under a `## Command sandbox` heading in the Bash tool's own prompt text. The wrapper entry points are `wrapWithSandbox` / `wrapWithSandboxArgv` and take a command. But `getFsReadConfig` exists as a separate export returning `{denyOnly, allowWithinDeny}`, which is the shape a **file tool** would consult, not a shell wrapper. Still unexecuted; see the unverifiable list. |
| 20 | Masking the Anthropic OAuth token is unavailable; the re-signing machinery is sigv4-shaped | `02x:60`–`63`, `09:119` | **unverifiable**, and the reasoning is half right | The sigv4 half is confirmed: `credentials.awsPairs`, `credentials.sigv`, `accessKeyIdVar`/`secretAccessKeyVar`. But `credentials.files` **mask** entries are generic "sentinel binds" that "protect the bytes" independent of AWS. So masking a file is available; whether a masked OAuth token still authenticates and bills is the open question, and nothing static answers it. A `files` **deny** entry is available either way, which is all the proposal builds on. |
| 21 | `configCheck.ts` warns rather than refuses on a `CLAUDE_HOME` with no `projects/` | `08:18`, `03:45` | confirmed | `docs/agent/environment.md:17`; `DATA_DIR` is the only variable that refuses the boot. |
| 22 | `scanUsage()` is the only input to the windows and to every guard but one | `01:17`–`24`, `08:14` | confirmed | `src/lib/otlp.ts:12`–`17` says it in those words; `telemetrySpendSince` is the exception. `PROJECTS_DIR = path.join(CLAUDE_HOME, "projects")` at `config.ts:62`, walked for `*.jsonl` at `transcripts.ts:184`. |
| 23 | `OTLP_SELF_URL` defaults to loopback `/api/otlp`; `middleware.ts:81` exempts `/api/otlp/v1/logs`; `MCP_SELF_URL` at `:127` exempted at `:66`; both exemptions rest on a self-authenticating capability | `01:26`–`35`, `08:21`–`28` | confirmed | All four lines land on exactly what is claimed, comments included. |
| 24 | The MCP tools run in-process because `createRun` is atomic on one event loop | `01:63`–`68`, `08:26`–`28` | confirmed | `config.ts:120`'s comment argues precisely this. |
| 25 | A worktree is not self-contained; its `.git` is a pointer into the main repository | `01:42`–`48` | confirmed | `cat .git` → `gitdir: /workspace/UsageFoundry/.git/worktrees/…`, re-run from this checkout. |
| 26 | `chownForChild` throws rather than warns, and `seedWorktree` deletes the file if it does | `01:39`–`40`, `02:72` | confirmed | `privsep.ts:173`–`177`; `orchestrator.ts:2374`–`2380` catches, `rmSync`, rethrows. |
| 27 | `Dockerfile:194` pins CLI 2.1.226; the binary is 294,566,840 bytes; the apt block is `Dockerfile:88`–`92` | `01:52`–`54`, `02x:12`, `09:51` | confirmed | `ARG CLAUDE_CLI_VERSION=2.1.226`; `claude --version` → `2.1.226`; `stat -c %s` → 294566840. |
| 28 | `maxConcurrentRuns: 4`; README's 25-run example is `UF_MEM_LIMIT=44g`, `UF_PIDS_LIMIT=8192`; limits at `docker-compose.yml:271/286/297/308` | `01:55`–`59` | confirmed | `settings.ts:577`; `README.md:744`; `mem_limit` 271, `pids_limit` 286, `cpus` 297, `stop_grace_period` 308. |
| 29 | `resolveInMount` checks containment lexically and again after `realpathSync` | `03:58`–`61` | confirmed | `orchestrator.ts:654`–`696`, both checks present with the comment explaining each. |
| 30 | `buildArgs` at `:4396`; `PROCESS_KILLERS` denied at `:4482` and is `Bash(pkill:*)`/`Bash(killall:*)` | `00:63`, `02x:35` | confirmed | Declared at `:4358`, pushed at `:4482`. |
| 31 | The reviewer runs `--permission-mode plan`; the chat passes `--add-dir` for every mount | `09:75`–`78` | confirmed | `review.ts:236`,`:598`; `chat.ts:1631`–`1633`. The chat also runs `--permission-mode bypassPermissions` (`chat.ts:1616`), which the proposal's "deliberately wider" understates by a lot. |
| 32 | The shipped install has no CPU ceiling | `09:13`–`17` | confirmed **by measurement** | `cat /sys/fs/cgroup/cpu.max` → `max 100000`. `pids.max` → 2048, matching compose's default. The sketch proposed this as a check; it passes, in the direction the sketch feared. |
| 33 | No container runtime is present: `command -v runsc kata-runtime crun runc podman docker` finds none, and no `/var/run/docker.sock` | `06:12`–`13` | confirmed | Reproduced below, plus `bwrap`, `bubblewrap`, `capsh`, `firejail`, `nsjail` and `nerdctl` all absent; `unshare`, `nsenter`, `setpriv`, `chroot` present. |
| 34 | The pinned CLI exposes `--cloud` and `--environment ccpool_…` | `07:66` | confirmed | Both in `--help`. |

### Also found, not a claim anyone made

- **`sandbox.filesystem` glob patterns are silently dropped on Linux.** `"Skipping glob pattern on Linux/WSL: ${n}"`, filtered out of both `allowWrite` and `denyWrite`. `09`'s migration paragraph worries about `settings.isolationCopyGlobs`, which is `[".env", ".env.*", "!.env.example"]` (`settings.ts:579`) — glob strings. Anyone who maps them straight into the write set loses them with a debug log and no error.
- **An empty policy returns the command unwrapped.** `if(!n&&!M&&!N&&!D&&!U) return t;` — no network deny, no read/write restriction, no credential entry, no wrapping at all. `sandbox.enabled: true` with a policy that resolved to nothing is a sandbox that silently does nothing, and `failIfUnavailable` does not catch it for the same reason `08:58` already gives about a renamed key: nothing was unavailable.
- **`filesystem.allowWrite` is "Merged with paths from `Edit(...)` allow permission rules."** Nothing widens the set today — `buildArgs` emits only `Bash(git add:*)`, `Bash(git commit:*)` and the two deny entries — but the app's tool policy and the sandbox's write set are now one surface, and a future `Edit(...)` allow rule widens the boundary from a file nobody reviews as a security control.
- **`areSandboxSettingsLockedByPolicy` locks the `/sandbox` command, not the settings files.** `G5u()` checks `flagSettings` and `policySettings` for `enabled`/`autoAllowBashIfSandboxed`/`allowUnsandboxedCommands` only, and gates an interactive UI. It is not a defence against #1.

---

## Environment findings

Read-only. Nothing started, stopped, reconfigured or killed.

```
$ uname -a
Linux 0ad752750adc 6.12.76-linuxkit #1 SMP Mon Jul 27 16:56:11 UTC 2026 aarch64 GNU/Linux
$ id
uid=1000(node) gid=1000(node) groups=1000(node)
```

**Docker socket and CLI — neither exists.**

```
$ ls -la /var/run/docker.sock /run/docker.sock
ls: cannot access '/var/run/docker.sock': No such file or directory
ls: cannot access '/run/docker.sock': No such file or directory
$ command -v docker docker-compose podman nerdctl
(no output, rc=1)
```

**Sandbox tooling.**

```
$ for c in bwrap bubblewrap unshare nsenter setpriv runsc kata-runtime crun runc \
           chroot capsh firejail nsjail; do printf '%-14s ' $c; command -v $c || echo '(absent)'; done
bwrap          (absent)
bubblewrap     (absent)
unshare        /usr/bin/unshare
nsenter        /usr/bin/nsenter
setpriv        /usr/bin/setpriv
runsc          (absent)
kata-runtime   (absent)
crun           (absent)
runc           (absent)
chroot         /usr/sbin/chroot
capsh          (absent)
firejail       (absent)
nsjail         (absent)
```

**User namespaces — blocked by seccomp, not by the kernel and not by capabilities.**

```
$ unshare -Ur true                     → unshare: unshare failed: Operation not permitted  (rc=1)
$ unshare -U true                      → unshare: unshare failed: Operation not permitted  (rc=1)
$ unshare -m true / -p true / -n true  → Operation not permitted  (rc=1, all three)
$ cat /proc/self/uid_map               →          0          0 4294967295
$ cat /proc/sys/user/max_user_namespaces → 31734
$ cat /proc/sys/kernel/unprivileged_userns_clone → No such file or directory
$ grep -E 'Cap|NoNewPrivs|Seccomp' /proc/self/status
CapInh: 0000000000000000    CapPrm: 0000000000000000    CapEff: 0000000000000000
CapBnd: 00000000a80425fb    CapAmb: 0000000000000000
NoNewPrivs: 0    Seccomp: 2    Seccomp_filters: 1
$ ls /sys/kernel/security/apparmor     → No such file or directory
$ ls /sys/fs/selinux                   → No such file or directory
```

Plain `unshare -U` needs no capability on a stock kernel, the kernel's own
`max_user_namespaces` is 31734, and one seccomp filter is loaded. So
`02x-option-cli-sandbox.md`'s diagnosis — Docker's default seccomp profile, fixed
by a custom profile via `security_opt` — is right, and no capability grant is
needed. `CapEff` being zero is worth noting separately from `CapBnd`: the bounding
set the proposal quotes is what the process *may* acquire, not what it holds.

**Cgroup and host size.**

```
$ stat -fc %T /sys/fs/cgroup     → cgroup2fs
$ cat /sys/fs/cgroup/memory.max  → 10737418240      (10 GiB — compose's UF_MEM_LIMIT default)
$ cat /sys/fs/cgroup/pids.max    → 2048             (compose's UF_PIDS_LIMIT default)
$ cat /sys/fs/cgroup/cpu.max     → max 100000       (no quota — 09's Phase 0 confirmed)
$ nproc                          → 12
$ grep MemTotal /proc/meminfo    → MemTotal: 8126204 kB   (7.75 GiB)
```

The container's limit is **larger than the VM's RAM**. `docker-compose.yml:270`
says "a limit above what the host can supply is not a limit"; on this install the
shipped default already is one, and `README.md:744`'s `UF_MEM_LIMIT=44g` is not
reachable here at all. Not a defect in the proposal — it is a fact about the
machine every arithmetic claim in the survey was written against.

**Mounts.**

```
$ grep -E ' /workspace| /home/node/.claude| /backups| /data' /proc/self/mountinfo
… /hendrikkuehnel/Documents/GIT                  /workspace   … fakeowner /run/host_mark/Users
… /hendrikkuehnel/Library/…/Knowledge Vault      /workspace2  … fakeowner /run/host_mark/Users
… /hendrikkuehnel/Documents/GIT                  /workspace3  … fakeowner /run/host_mark/Users
… /hendrikkuehnel/Documents/GIT                  /workspace4  … fakeowner /run/host_mark/Users
… /hendrikkuehnel/.claude                        /home/node/.claude … fakeowner
… /hendrikkuehnel/Documents/GIT/UsageFoundry/backups  /backups … fakeowner
… /docker/volumes/usagefoundry_usagefoundry-data/_data /data    … ext4 /dev/vda1
```

**`00-problem.md`'s own measurements, re-run.**

```
$ stat -c '%u:%g %a' /data                          → 0:0 700      ; test -r → not readable
$ tr '\0' '\n' < /proc/7/environ                    → Permission denied
$ ls -l /home/node/.claude/.credentials.json        → -rw------- 1 node node 509  ; test -r → READABLE
$ ls /workspace/.uf-worktrees/ | wc -l              → 20
$ test -w /workspace/.uf-worktrees/<sibling>/       → WRITABLE  (3 sampled, all three)
$ tr '\0' ' ' < /proc/7/cmdline                     → next-server (v
$ test -w /backups                                  → WRITABLE
```

**The new one.**

```
$ ls -ld /home/node/.claude                → drwx------ 26 node node
$ ls -l  /home/node/.claude/settings.json  → -rw------- 1 node node 3035
$ test -w /home/node/.claude/settings.json → WRITABLE
$ touch /home/node/.claude/.uf-validate-probe && rm -f … → CREATE OK / removed
$ env | grep CLAUDE_CONFIG_DIR             → CLAUDE_CONFIG_DIR=/home/node/.claude
```

Twenty-five entries under `~/.claude`, every one owned by `node:node`.

**The pinned binary.** `strings` only — nothing below was executed.

```
$ B=/usr/local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-arm64/claude
$ stat -c %s "$B"                                     → 294566840
$ claude --version                                    → 2.1.226 (Claude Code)
$ strings -n 6 "$B" | grep -oE '\bsandbox\.[a-zA-Z]+' | sort -u
sandbox.allowUnsandboxedCommands  sandbox.enabled     sandbox.network
sandbox.autoAllowBashIfSandboxed  sandbox.filesystem  sandbox.seccomp
sandbox.bwrapPath                 sandbox.credentials sandbox.failIfUnavailable
$ strings -n 8 "$B" | grep -oE '/etc/claude-code[a-z/.-]*|managed-settings\.json' | sort -u
/etc/claude-code   /etc/claude-code.   managed-settings.json
$ claude --sandbox mcp list                           → error: unknown option '--sandbox'
```

`grep -oE '.{0,300}TERM.{0,300}'` over 300 MB of `strings` output is
catastrophic-backtracking slow and gets OOM-killed inside this cgroup; the
context extracts above were taken with a linear `awk` `index()`/`substr` window
instead.

---

## The load-bearing five, for Option B

**The credential.** Holds, with the limit the proposal already states. A
`sandbox.credentials.files` **deny** entry over `~/.claude/.credentials.json`
exists and is generic; the CLI process keeps reading it; a sandboxed `cat` does
not. *Unstated:* the deny is dropped for sandboxed commands if
`filesystem.disabled` is ever set — the binary says so in as many words — so the
credential gain and the filesystem policy are one switch, not two. And #1 above
governs here too: a run that widens `filesystem` from `~/.claude/settings.json`
does not get the credential back (deny is a separate list), but it gets
everything else.

**Metering.** Holds, and it is still Option B's strongest axis — same process,
same `CLAUDE_CONFIG_DIR`, same `PROJECTS_DIR`, same root server reading it.
*Unstated, and it is the sharp one:* the metering requirement and the
policy-integrity requirement point at **the same directory in opposite
directions**. `09`'s Phase 3 test asserts `CLAUDE_CONFIG_DIR` is writable
"which is the metering path" — and that writability is exactly what makes #1
work. Closing #1 means root-owning `~/.claude` itself and handing back only the
subtrees the CLI writes (`projects/`, `sessions/`, `todos/`, `shell-snapshots/`,
`history.jsonl`, `.credentials.json`, `statsig`-style caches — 25 entries here,
all agent-owned today), because a run that owns the *directory* can `rm` a
root-owned `settings.json` and write its own. That is a Phase 2 item the proposal
does not have, and it is not small.

**Telemetry.** Holds, unqualified. Same container, same network namespace for
the CLI process, same loopback `OTLP_SELF_URL`, no change to `middleware.ts`.
*Unstated:* the CLI's egress proxy sits between sandboxed commands and the
network, and `OTLP_SELF_URL` is `http://127.0.0.1:${PORT}` — if the exporter ever
moves inside the sandbox, `127.0.0.1` inside a bwrap namespace with
`--new-session` is not the server's loopback, and `sandbox.network.allowedDomains`
takes domains. Under the "commands only" assumption this never arises; if
question 3 of Phase 1 answers the other way, it does, and `needsLiveSpendTelemetry`
(`orchestrator.ts:4573`) makes it a guard reading zero.

**Committing into the operator's `.git`.** Holds exactly as written, including
the limit the proposal states plainly: the worktree's `.git` is a pointer
(re-verified from this checkout), so `<repo>/.git` is in the write set and two
runs on one repository can still rewrite each other's refs. *Unstated:* the write
set is spelled with paths, and glob entries are silently dropped on Linux — so
`settings.isolationCopyGlobs`' `.env.*` cannot be expressed in it. Whatever
generates the per-run overlay has to expand globs itself, and its failure is a
tool call nobody reads.

**Concurrency and memory at 25 runs.** *Does not hold as written.* "`mem_limit`/
`pids_limit`/`cpus` unchanged … so at 25 concurrent runs `README.md:744` stands"
assumes the sandbox adds no processes. It adds several per sandboxed command:
one `bwrap`, two `socat` bridge listeners, and — `TCP-LISTEN:…,fork` — one
`socat` child per outbound connection, on top of the command itself. `pids_limit`
counts tasks, README's formula is `256 × (runs + others + 1)`, and this term is
not in it. Today's ceiling is 2048 with no CPU quota at all. Unmeasured in either
direction; the honest statement is that the arithmetic needs re-deriving, not
that it is unchanged.

---

## Verdict on the recommendation

**Stands.** Option B remains the best fit. Findings #1, #2 and #3 are properties
of the CLI's sandbox, and Option D reaches confinement through that same sandbox
by its own account (`04:11`–`12`), so all three land on the runner-up equally.
Nothing found here narrows the gap: D still pays for a supervisor, a second
metering path and a telemetry hop across a network, and #2 makes the *build* side
of both options more expensive, which costs D more because it was already
negative there. The fact `08:87` names as the one that would flip the
recommendation — whether the sandbox wraps the session or only Bash — is still
unanswered, so it is still the thing to measure first.

What changes is the price and the order. Option B is a three-dependency change
with a precondition on `~/.claude` ownership, not a one-apt-line change; the
verification in Phase 1 has to grow two questions; and Phase 4's reporting has to
move ahead of the phases whose failures it is the only way to see.

---

## What this validation did not check

Not a clean bill of health. Nothing here was executed against a running sandbox.

- **No sandbox was ever started.** `bubblewrap` is not in this image, the seccomp
  profile blocks the syscall, and starting one would have meant reconfiguring a
  container with other runs in flight. Every claim about the CLI's sandbox
  *behaviour* — #1's merge semantics included — is read out of `strings` on the
  pinned binary. `strings` shows what the code says about itself, not what it
  does. #1 in particular deserves the executed test before anyone acts on it, and
  the test is two lines: write `{"sandbox":{"filesystem":{"allowWrite":["/tmp/x"]}}}`
  into `~/.claude/settings.json` under a managed policy that does not list it,
  and see whether `/tmp/x` becomes writable.
- **The session-versus-Bash question is still open**, which is the same thing
  `09`'s Phase 1 says. `getFsReadConfig`'s existence is new evidence and points
  the other way from the Bash-tool prose; neither settles it.
- **Whether `bubblewrap` and `socat` are installable in this image at all** —
  `Dockerfile:92` removes the apt lists and no network fetch was attempted.
  `apt-get update && apt-cache policy bubblewrap socat` settles it in one command.
- **No billed cycle was run.** Questions 2, 3 and 4 of Phase 1 all need one.
- **No measurement of `bwrap` overhead, of behaviour at 25 concurrent runs, or of
  what `sandbox.seccomp` filters** — the three items `09:100`–`104` already lists
  for `docs/verification.md`, and they are still unmeasured.
- **The `fakeowner` per-uid question is untouched**, so `02-option-harden-in-place.md`
  is exactly as verified as it was.
- **Options C, D, E and F were read for internal consistency and for citations,
  not adversarially.** Their claims about second containers, sockets and
  alternate runtimes were not tested, because none of that exists on this machine
  to test against.
- **Only the pinned version was examined.** Everything in #2, #3 and #4 is a
  property of 2.1.226 and can move on any bump, which is `02x:116`–`120`'s point
  and now has a second vendor contract attached to it.
