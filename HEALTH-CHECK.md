# Code health check — 2026-08-11

Full-repo health check of UsageFoundry at `267b901`.

## Mechanical checks

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | pass — 94 tests, 18 suites, 0 failures |
| `npm run build` | pass — `.next/standalone` produced |
| `npm audit` | **3 high severity**, all transitive under `next` |

Note for anyone reproducing this: `NODE_ENV=production` is set in the container,
so `npm ci` installs no devDependencies and `tsc` is absent. Use
`npm ci --include=dev` before running `typecheck`/`test`.

## Findings

Filed as issues 1–7 below. Nothing here is a data-loss or security defect; the
containment, folder-claim, and land-refusal paths all hold up against the
invariants in `CLAUDE.md`.

---

### 1. A `blocked` run cannot be reopened, which is the one status reopening exists for

**Labels:** bug
**Files:** `src/lib/orchestrator.ts:2669`, `src/app/runs/[id]/page.tsx:483`

`REOPENABLE` is `["failed", "stopped", "completed"]`. `blocked` is excluded, but
`blocked` is set at `orchestrator.ts:1968` for exactly one situation:

```ts
finalStatus = iterations === 0 ? "blocked" : "stopped";
```

— a budget guard refused the run before it did any work. That is precisely the
case `reopenRun`'s own doc comment describes as the reason it takes a budget at
all:

> It takes a budget because the usual reason a run needs picking up is that its
> own limits ended it, and re-queueing it under the limits that stopped it just
> reproduces the stop.

So the run whose refusal is *most* recoverable by raising a limit is the one run
that cannot be picked up. The run detail page compounds it: it renders
`"Refused to start:"` next to the stop reason (`page.tsx:330`) and then offers no
button, because `resumable` (`page.tsx:481`) mirrors `REOPENABLE`.

**Failure scenario.** An operator sets `maxWeeklyFraction: 0.8` with no weekly
ceiling configured. `evaluateBudget` returns `no_ceiling` — "Set one in Settings
(or run Calibrate) before using this guard" — the run goes `blocked` with 0
cycles and $0 spent. They set the ceiling. There is no way to start that run;
they must retype the prompt and budget into the new-run form.

**Extra cost.** `ensureWorktree` runs *before* the guard loop
(`orchestrator.ts:1915`), so a blocked isolated run has already created its
checkout and branch. Being unreopenable orphans that branch (0 commits, base ==
HEAD) with no path back to it.

**Suggested fix.** Add `"blocked"` to `REOPENABLE` and to `resumable` in the run
detail page. `blocked` is terminal and holds no folder, so it satisfies the
comment above `REOPENABLE` ("Terminal, and holding nothing") as well as the three
already listed. The pre-flight guards in `reopenRun` (`iterations`, run spend,
run tokens) are all trivially satisfied by a run at 0/0/0, and `nextPrompt`
already handles `sessionId === null` by sending the original task.

---

### 2. `matchesCopyGlobs` treats `?` as a regex quantifier, so a glob containing it matches the wrong files

**Labels:** bug
**File:** `src/lib/orchestrator.ts:1003-1014`

```ts
const re = new RegExp(
  `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
);
```

The escape class omits `?`. `*` is translated to `.*`; `?` is translated to
nothing and survives into the regex as "previous token is optional".

**Failure scenario.** `isolationCopyGlobs` is set to `[".env?"]`, intending
"`.env` plus one character" (`.env1`, `.enva`). Verified actual behaviour:

```
glob ".env?" vs ".env"  => true    (expected false)
glob ".env?" vs ".envx" => false   (expected true)
glob ".env?" vs ".en"   => true    (expected false)
```

The result is that `seedWorktree` copies the wrong set of gitignored files into a
fresh checkout — either missing the env file the agent needs for its first
command, or copying one that was meant to be excluded. It fails silently: the
copied list is logged, but nothing says a pattern was misread.

Same class of bug affects a negation like `!.env?.local`.

**Suggested fix.** Add `?` to the escaped class and translate it to `.`
explicitly, matching how `*` is handled:

```ts
const re = new RegExp(
  `^${pattern
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\\?/g, ".")}$`,
);
```

The shipped default (`[".env", ".env.*", "!.env.example"]`) contains no `?`, so
this only bites operators who edit the setting — which is the only reason it is
a setting.

---

### 3. `invalidateTranscriptCache` does not provide the guarantee its comment claims, and is unreachable

**Labels:** bug, dead-code
**File:** `src/lib/transcripts.ts:371-377`

```ts
export function invalidateTranscriptCache(): void {
  cache.clear();
  // In-flight refreshes still hold the offsets they read before the clear, so
  // drop them too rather than letting one write a pre-invalidation offset back.
  inflight.clear();
  globalInflight.__ufScanInflight = null;
}
```

Clearing `inflight` drops the *promise registry*; it does not cancel the running
`readAppended`. That function captured `base` (and therefore the pre-invalidation
`offset`) at `transcripts.ts:236-243` and unconditionally writes it back on
completion:

```ts
base.offset = start + lastNewline + 1;
base.size = stat.size;
cache.set(file, base);          // <- repopulates the freshly-cleared cache
```

So for any file with a refresh in flight at the moment of invalidation, the stale
offset is restored and the intended "re-read every file from byte 0" never
happens for that file. The comment states the opposite.

**Why this is low severity today:** nothing calls it. `grep -rn
invalidateTranscriptCache src/` returns only the definition. So this is a latent
trap rather than a live defect — but it is a documented invariant that is false,
and the function exists to be called.

**Suggested fix.** Either delete it (see issue 4), or make it correct with an
epoch counter that `readAppended` checks before its final `cache.set`:

```ts
let epoch = 0;
// in readAppended, capture `const myEpoch = epoch` at entry and guard every
// `cache.set(file, base)` with `if (myEpoch === epoch)`.
export function invalidateTranscriptCache(): void {
  epoch += 1;
  cache.clear();
  inflight.clear();
  globalInflight.__ufScanInflight = null;
}
```

---

### 4. Five unreachable exports

**Labels:** dead-code
**Files:** `src/lib/pricing.ts`, `src/lib/transcripts.ts`, `src/lib/account.ts`

Each of these is exported and referenced nowhere else in `src/` (verified by
`grep -rn` across `*.ts` and `*.tsx`, tests included):

| Symbol | File:line |
|---|---|
| `billableWeightedTokens` | `pricing.ts:176` |
| `isKnownModel` | `pricing.ts:135` |
| `knownModelIds` | `pricing.ts:214` |
| `invalidateTranscriptCache` | `transcripts.ts:371` |
| `invalidateAccountProfile` | `account.ts:184` |

Two of them carry comments asserting a role they do not have.
`invalidateAccountProfile` says "used by tests and after a settings change" — no
test imports it and no settings path calls it. `invalidateTranscriptCache` is
covered by issue 3.

This matters more than usual in this codebase: `CLAUDE.md` states that comments
here explain *why* a decision was made, so a comment describing a caller that
does not exist is actively misleading to the next reader.

**Suggested fix.** Delete all five, or add the call sites the comments promise.
`isKnownModel` and `knownModelIds` look like they were meant for a settings-page
model picker that was never wired up — worth deciding which.

---

### 5. Two doc comments in `review.ts` are attached to the wrong constants

**Labels:** documentation
**File:** `src/lib/review.ts:48-51`

```ts
/** Diff bytes sent to the reviewer. Bounded by argv, not by context. */
const REVIEW_DIFF_BYTES = 60_000;
/** A single argv entry is capped at 128 KB on Linux; stay well clear of it. */
const REVIEW_TIMEOUT_MS = 10 * 60_000;
```

The 128 KB argv cap is the reason `REVIEW_DIFF_BYTES` is 60,000 — it has nothing
to do with a ten-minute timeout. The rationale has slid one declaration down, so
the constant that carries a real, non-obvious constraint now looks arbitrary and
`REVIEW_TIMEOUT_MS` looks like it is bounded by argv.

`REVIEW_TIMEOUT_MS` has no stated rationale at all as a result.

**Suggested fix.**

```ts
/**
 * Diff bytes sent to the reviewer. Bounded by argv, not by context: a single
 * argv entry is capped at 128 KB on Linux, so stay well clear of it.
 */
const REVIEW_DIFF_BYTES = 60_000;
/** How long a one-shot review may run before it is signalled. */
const REVIEW_TIMEOUT_MS = 10 * 60_000;
```

---

### 6. Three high-severity advisories in transitive dependencies of `next`

**Labels:** security, dependencies

`npm audit` reports:

- **postcss `<=8.5.22`** (via `next`) — high. Four advisories:
  GHSA-qx2v-qp2m-jg93 (XSS via unescaped `</style>` in stringify output),
  GHSA-6g55-p6wh-862q and GHSA-fxqj-rqcc-2cmp (arbitrary file read via
  attacker-controlled `sourceMappingURL`), GHSA-r28c-9q8g-f849 (path traversal in
  previous-source-map auto-loading).
- **sharp `<0.35.0`** — high. Inherited libvips CVEs: CVE-2026-33327,
  CVE-2026-33328, CVE-2026-35590, CVE-2026-35591.

Exposure here is limited but not zero. postcss runs at build time over this
repo's own CSS, and the direct `postcss`/`@tailwindcss/postcss` devDependencies
are already on fixed versions — the vulnerable copy is `next`'s own nested one.
`sharp` backs `next/image` optimisation; this app serves no user-supplied images,
so the libvips surface is not reachable from any route it exposes.

`npm audit fix --force` wants `next@16.3.0`, a major bump from the pinned
`^15.5.4`. That is not a change to make as part of a health check — App Router,
`serverExternalPackages`, and the `output: "standalone"` build all need a real
smoke test (`docker compose up --build`) behind it.

**Suggested action.** Decide deliberately: either take the `next` 16 upgrade as
its own piece of work with the README's "Verified" section updated, or record an
explicit accept-risk note with the reachability argument above.

---

### 7. `RunLand` overwrites the operator's strategy choice on every reload

**Labels:** bug, ui
**File:** `src/components/RunLand.tsx:37-49, 66-88`

`load()` ends with `setStrategy(json.defaultStrategy)`, and `act()` calls
`await load()` after every POST.

**Failure scenario.** The operator selects "Squash into one commit" and presses
Land. The land is refused — say their checkout is dirty, which is the most common
refusal. The error notice renders, and the select silently snaps back to "Merge,
keeping its commits". They stash, press Land again, and get a merge commit they
did not ask for.

The displayed value and the sent value do stay in sync, so this is a papercut
rather than a silent wrong write — but the reversion happens under an error
message the operator is reading, which is exactly when it is least likely to be
noticed.

**Suggested fix.** Seed the strategy from the server default only when the
operator has not chosen one:

```ts
const [strategy, setStrategy] = useState<"merge" | "squash" | null>(null);
// in load(): setStrategy((s) => s ?? json.defaultStrategy);
```

---

## What was checked and found sound

Recorded so a later pass knows what has already had eyes on it:

- **Containment.** `resolveInMount`'s two-phase check (lexical, then post-
  `realpathSync`) is intact, is applied per mount, and is re-run before every
  spawn (`orchestrator.ts:2025`). `prepareWorktreeStore` `lstat`s for a symlink
  before git writes, not after.
- **The folder claim.** `createRun` is genuinely `await`-free from entry to
  INSERT. `gitSync` exists to keep it that way. `selectPromotable`'s
  `reserved.some(r => r !== key && ...)` identity check is correct, and the
  concurrency cap counts `running` only.
- **Guard/display split.** `costUSD`/`costGuardUSD`, `spent_usd`/`spent_usd_est`
  and `fraction`/`guardFraction` are consistently separated; `evaluateBudget`
  compares `guardFraction` and the `no_ceiling` refusal reads `fraction`, which
  is correct because both come from the same `fractionOf` against the same
  ceiling.
- **Guard ordering.** terminus → cycles → duration → run spend → weekly →
  session, with `pause` reachable only from `session_fraction` under
  `live-resume`. `LIVE_ENFORCEABLE_CODES` correctly excludes `iterations`,
  `no_ceiling`, `no_terminus`.
- **Cycle refund.** Applied at the post-cycle interrupt site only; the two
  pre-increment `applyInterrupt` call sites correctly do not refund.
- **Land refusals.** `landRefusal` tests run status ahead of the preview, dirty
  and unreadable both block, wrong-branch is refused by name, and
  `landing.has → landing.add` has no `await` between them.
- **Diff parsing.** `parseNumstat`/`parseNameStatus` index NUL fields correctly
  for the rename/copy shape; `splitPatches` matches by position with a count
  guard; `DIFF_FLAGS` carries `--no-ext-diff --no-textconv`; pathspecs are pinned
  with `:(top,literal)`.
- **Child processes.** Exactly three spawn sites (`git.ts`, `orchestrator.ts`,
  `review.ts`), all argv arrays, none via a shell. `childEnv`/`reviewEnv`/
  `gitEnv` strip `UF_*`, `ANTHROPIC_*` and `OTEL_*` as documented.
- **Auth.** `middleware.ts` imports nothing from `lib/config`, compares
  constant-time, and gates `/api/otlp` (the exporter authenticates via
  `OTEL_EXPORTER_OTLP_HEADERS`).
- **Persist-then-publish.** `emit()` writes `run_events` before `bus.emit`, and
  the SSE route replays from storage honouring `Last-Event-ID` before tailing.

### Measured, not a problem

`/api/calibrate`'s sliding weekly window is `O(days × entries)` and looked like a
scalability risk. Benchmarked: 2 years of history with 400k entries costs ~350 ms
of blocked event loop, 1 year with 150k costs ~71 ms. Not worth restructuring.
