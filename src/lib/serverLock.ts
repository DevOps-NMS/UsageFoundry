import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { DATA_DIR } from "./config";
import { GIT_SYNC_TIMEOUT_MS } from "./git";

/**
 * Which process owns this data directory.
 *
 * `db.ts` opens with the reason this matters: the folder claim that keeps two
 * agents out of one directory is a synchronous check-then-insert, and it is
 * only atomic because one process runs it. Everything here exists because that
 * assumption turned out to be reachable from inside the product — an agent
 * working on UsageFoundry itself starts a dev server to check its work, and
 * `next dev` runs `instrumentation.ts`, which runs the four boot reconcilers.
 * Pointed at the live database by an inherited `DATA_DIR`, one of those closed
 * out three runs whose agents were mid-cycle and carried on working. The row
 * said the server had restarted; nothing had.
 *
 * `childEnv` withholding `DATA_DIR` is what stops that particular route. This
 * is the check that does not depend on remembering to: whatever a second
 * process is and however it found the file, it does not get to close out rows
 * belonging to a server that is still running.
 *
 * The lock is a file rather than a row because it has to answer a question
 * about the database from outside it, and because a heartbeat every second is
 * WAL churn nobody needs.
 */

/** One process's claim on `DATA_DIR`. */
export interface ServerLock {
  /**
   * The writer's pid *as it saw itself*, which is only meaningful to a reader
   * in the same PID namespace. That is exactly the case this guards: the
   * second server was a grandchild of the first.
   */
  pid: number;
  /** Random per process. What makes a lock changing hands observable. */
  ownerId: string;
  startedAt: number;
  heartbeatAt: number;
}

/** How often the owner restamps the file. */
export const HEARTBEAT_MS = 1_000;

/**
 * Silence after which the owner is presumed gone.
 *
 * Derived from the worst-case synchronous block rather than chosen against an
 * assumption, because the previous figure — 15 s — was **shorter than a single
 * git call**. `gitSync` is a `spawnSync` with `GIT_SYNC_TIMEOUT_MS` on it, and
 * one `git status --porcelain` on a large checkout with `core.fsmonitor`
 * cleared can reach that ceiling, so one admission-path call was sufficient to
 * miss the window with no other load at all. One admission makes several of
 * them in one uninterrupted stretch — `probeIsolation`'s `rev-parse`s, then a
 * `status` per candidate checkout slot — which is why the window has to be a
 * multiple of git's own ceiling rather than a fraction of it.
 *
 * A longer window costs very little, and that is a fact about `lockVerdict`
 * rather than optimism. Staleness is the *last* question it asks, and the only
 * case it decides is "the lock's pid is alive and has stopped beating": no lock
 * is claimed outright, a dead pid goes to the four-second observation, and our
 * own pid — the container restart, where the server reliably lands where its
 * predecessor was — is claimed outright. And a live pid that has stopped
 * beating is a *stalled owner*, which is precisely the one that must not be
 * claimed: taking it runs the six boot reconcilers over runs whose agents are
 * still working and still billing. What the longer window does cost is an owner
 * that died and whose pid a live process has since taken, which then holds the
 * directory for up to this long. Bounded, rare, and the cheaper mistake.
 *
 * It is no longer the only defence either, which is the other half of why the
 * exact figure matters less than it did: `heartbeatVerdict` means an owner that
 * loses the directory anyway finds out within a beat and stands down, rather
 * than restamping the file over the new owner's and leaving two processes both
 * believing they hold it for ever.
 */
export const STALE_MS = GIT_SYNC_TIMEOUT_MS * 6;

/** How long a fresh lock with no live pid behind it is watched before claiming. */
export const OBSERVE_MS = 4_000;

/**
 * `claim` — take it. `held` — someone else is alive, do nothing.
 * `observe` — undecided; watch the file for a beat and ask again.
 */
export type LockVerdict = "claim" | "held" | "observe";

/**
 * Tolerant of anything: a truncated write, a file from a future version, an
 * empty file left by a full disk. An unreadable lock is not evidence of an
 * owner, and treating it as one would strand runs for ever.
 */
export function parseLock(raw: string): ServerLock | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = value as Partial<ServerLock> | null;
  if (
    !v ||
    typeof v.pid !== "number" ||
    typeof v.ownerId !== "string" ||
    !v.ownerId ||
    typeof v.startedAt !== "number" ||
    typeof v.heartbeatAt !== "number"
  ) {
    return null;
  }
  return {
    pid: v.pid,
    ownerId: v.ownerId,
    startedAt: v.startedAt,
    heartbeatAt: v.heartbeatAt,
  };
}

/**
 * Should this process take the data directory?
 *
 * Pure, and separated from the filesystem because both ways of being wrong are
 * expensive and neither announces itself. Claiming when someone is alive is the
 * incident this was written for — live runs marked failed while their agents
 * keep working and keep billing. Refusing when nobody is means the reconcilers
 * never run, so a crashed run holds its folder for ever and every later run
 * queues behind a directory nothing is in.
 *
 * `lock.pid === self.pid` reads as ours rather than a stranger's, and that is a
 * fact about PID namespaces rather than a guess: pids are unique among live
 * processes in one namespace, so a *live* stranger cannot be holding ours. What
 * it does match is our own predecessor across a container restart, where the
 * server reliably lands on the same pid — which is the common case this must
 * not refuse.
 *
 * A fresh lock whose pid is gone is the ambiguous one, and it is left to the
 * caller to watch rather than decided here.
 */
export function lockVerdict(
  lock: ServerLock | null,
  self: { pid: number; now: number },
  ownerAlive: boolean,
): LockVerdict {
  if (!lock) return "claim";
  if (self.now - lock.heartbeatAt > STALE_MS) return "claim";
  if (lock.pid === self.pid) return "claim";
  return ownerAlive ? "held" : "observe";
}

/**
 * Did the lock move while we watched it?
 *
 * A vanished or unparseable file counts as *not* beating: the owner releases by
 * unlinking, so absence is the clean-shutdown signal. Writes are atomic
 * (temp + rename), so a reader never catches half a record and mistakes it for
 * a corpse.
 */
export function stillBeating(before: ServerLock, after: ServerLock | null): boolean {
  if (!after) return false;
  return after.ownerId !== before.ownerId || after.heartbeatAt > before.heartbeatAt;
}

/**
 * Is the lock we are about to restamp still ours?
 *
 * The owner never asked. `beat()` wrote the file unconditionally and compared
 * nothing, so after a stall past `STALE_MS` the sequence was: a second process
 * reads a stale lock, claims it, runs all six boot reconcilers over runs whose
 * agents are alive; then this process's loop resumes and overwrites that lock
 * with its own `ownerId`, never noticing it had changed hands. **Both then hold
 * the directory, permanently**, and the folder claim's guarantee — one event
 * loop deciding a folder is free — is void from that moment on.
 *
 * Pure, and separated for `lockVerdict`'s reason: it is a decision about
 * whether to go on writing to somebody else's database, and getting it wrong in
 * the permissive direction announces itself nowhere.
 *
 * A **missing** lock is `beat`, not `lost`, and the asymmetry is deliberate:
 * the owner releases by unlinking, so absence is nobody holding the directory,
 * and re-stamping it there takes back something no other process has claimed. A
 * different `ownerId` is the only evidence that it changed hands, which is the
 * same test `releaseDataDir` already makes before it deletes the file.
 */
export function heartbeatVerdict(
  lock: ServerLock | null,
  ownerId: string,
): "beat" | "lost" {
  if (!lock) return "beat";
  return lock.ownerId === ownerId ? "beat" : "lost";
}

/**
 * What this process has been told about the data directory.
 *
 * A boolean could not say the thing that matters, which is the difference
 * between "we asked and were refused" and "nobody has asked yet". Only the
 * first is a second writer; the second is every unit test, every script and
 * every caller that reaches this module without a boot behind it, and refusing
 * those would be refusing a question nobody put.
 *
 * `held` is the answer `claimDataDir` got at boot. `lost` is the same fact
 * discovered later, by the heartbeat — see `heartbeatVerdict`. They refuse
 * identically and are separate words because the operator's diagnosis differs:
 * one is a second server that should not have been started, the other is this
 * server having stalled long enough for someone else to take the directory.
 */
export type DataDirOwnership = "unclaimed" | "owned" | "held" | "lost";

interface LockState {
  ownerId: string;
  startedAt: number;
  ownership: DataDirOwnership;
  /** The lock we were refused by, so a refusal can name a pid. */
  holder: ServerLock | null;
  timer?: NodeJS.Timeout;
}

/**
 * `globalThis` for the reason every other long-lived singleton here uses it.
 *
 * A new key rather than the old `__ufServerLock`: `??=` only initialises when
 * absent, so on a dev hot reload a pre-upgrade record carrying `owned: boolean`
 * would survive and every read of `ownership` would come back undefined — which
 * is neither "owned" nor "held" and would refuse everything.
 */
const state = ((globalThis as unknown as { __ufDataDirLock?: LockState })
  .__ufDataDirLock ??= {
  ownerId: randomUUID(),
  startedAt: Date.now(),
  ownership: "unclaimed",
  holder: null,
});

function lockPath(): string {
  return path.join(DATA_DIR, "server.lock");
}

function readLock(): ServerLock | null {
  try {
    return parseLock(fs.readFileSync(lockPath(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Written to a temporary name and renamed over the target, so a reader in its
 * observation window never sees a partial record — which `stillBeating` would
 * read as an owner that had stopped.
 */
function writeLock(now: number): void {
  const lock: ServerLock = {
    pid: process.pid,
    ownerId: state.ownerId,
    startedAt: state.startedAt,
    heartbeatAt: now,
  };
  const tmp = `${lockPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock));
  fs.renameSync(tmp, lockPath());
}

/**
 * `EPERM` means the pid exists and belongs to someone we may not signal, which
 * is still an owner. Only `ESRCH` — no such process — is death.
 */
function ownerAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take ownership of `DATA_DIR`, or report that someone else has it.
 *
 * A caller that gets `false` must not close out rows it did not create — and,
 * since this answer now gates every writer in the app, must not create any
 * either. What is left is a process that reads: a second server is usually an
 * agent's dev server checking its work against the live database, and refusing
 * to boot it would break the one workflow — running this app against its own
 * worktree — that found this bug in the first place. So it boots, it serves
 * every page, and `ownershipRefusal` answers everything that would write.
 *
 * Asked once, at boot, and never retried. A retry would widen the one window
 * this whole module exists to keep narrow: a second process that keeps asking
 * is a second process waiting to claim the directory the moment the owner
 * stalls past `STALE_MS`, and what it does with it is close out live runs. A
 * process that finds the directory taken stays read-only until somebody starts
 * it again, and says so on `/api/health` and in the interface rather than in a
 * line of container stdout.
 */
export async function claimDataDir(): Promise<boolean> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const lock = readLock();
  let verdict = lockVerdict(
    lock,
    { pid: process.pid, now: Date.now() },
    lock !== null && ownerAlive(lock.pid),
  );

  if (verdict === "observe" && lock) {
    await sleep(OBSERVE_MS);
    verdict = stillBeating(lock, readLock()) ? "held" : "claim";
  }

  if (verdict === "held") {
    state.ownership = "held";
    // Re-read rather than reusing `lock`: the observation window above may have
    // watched it change hands, and the refusal names whoever holds it now.
    state.holder = readLock() ?? lock;
    return false;
  }

  writeLock(Date.now());
  state.ownership = "owned";
  state.holder = null;
  state.timer ??= setInterval(heartbeat, HEARTBEAT_MS);
  state.timer.unref?.();
  return true;
}

/**
 * Whether this process may write to the database behind `DATA_DIR`.
 *
 * Read at the moment of the write rather than captured at boot, because the
 * answer moves: `heartbeat` clears it the moment the directory changes hands.
 */
export function ownsDataDir(): boolean {
  return state.ownership === "owned";
}

/** What this process has been told, for a surface that reports it. */
export function dataDirOwnership(): DataDirOwnership {
  return state.ownership;
}

/** Whoever holds the directory, when it is not us. */
export function dataDirOwner(): ServerLock | null {
  return state.ownership === "owned" ? null : state.holder;
}

/**
 * Why a write is being refused, or `null` if it is not.
 *
 * Pure, and separated from the state it is asked about for the reason
 * `lockVerdict` is: this is the sentence every writer in the app answers with,
 * and getting it wrong in the permissive direction is silent — two processes
 * running `createRun` against one SQLite file, each deciding a folder is free
 * inside its own event-loop turn, which is exactly the collision `db.ts` opens
 * by saying the single process is what prevents.
 *
 * `unclaimed` is deliberately not a refusal. The claim is made once, at boot,
 * before the first request; a process that has never asked has never been told
 * no, and refusing there would refuse every caller that reaches this module
 * without `instrumentation.ts` in front of it.
 */
export function ownershipRefusal(
  ownership: DataDirOwnership,
  owner: { pid: number } | null,
): string | null {
  if (ownership === "owned" || ownership === "unclaimed") return null;
  const who = owner ? `process ${owner.pid}` : "another server process";
  return ownership === "lost"
    ? `This server has lost its claim on the data directory to ${who} and can ` +
        "no longer start or change anything. Only one process may write to a " +
        "UsageFoundry data directory; restart this one once the other has stopped."
    : `This server does not own its data directory — ${who} does — so it can ` +
        "read but not start or change anything. Only one process may write to " +
        "a UsageFoundry data directory; it cannot be scaled to a second replica.";
}

/** `ownershipRefusal` against this process's own state. */
export function dataDirRefusal(): string | null {
  return ownershipRefusal(state.ownership, state.holder);
}

/**
 * The same question for a caller with nothing to say a refusal to.
 *
 * Deliberately not `ownsDataDir()`, and the difference is the `unclaimed` case
 * `ownershipRefusal` is written around: a process that has never asked has
 * never been refused. Every background loop here — the promoter, the parked
 * sweeper, the merge worker — is reachable from a caller with no boot behind
 * it, and gating those on ownership rather than on refusal would stop them in
 * every test and every script that ever reaches this module.
 */
export function mayWriteDataDir(): boolean {
  return dataDirRefusal() === null;
}

/**
 * Throw unless this process may write.
 *
 * For the writers that already have an error channel — `createRun` throws for
 * an empty prompt, and `POST /api/runs` turns that into a 400 — so a second
 * replica's run submission is refused where the operator is looking rather than
 * admitted into a database it does not own.
 */
export function requireDataDir(): void {
  const refusal = dataDirRefusal();
  if (refusal) throw new Error(refusal);
}

/**
 * Restamp the lock — or find out it is not ours any more and stand down.
 *
 * The interval's own callback, and exported because the fault it now covers has
 * no other way of being observed: a lock silently changing hands under a
 * working server leaves nothing to inspect afterwards, so the only evidence is
 * this function's answer.
 *
 * Two ways ownership ends here, and both refuse every write from that moment
 * on, because `mayWriteDataDir` is read at the write rather than at boot.
 *
 * **The directory changed hands.** See `heartbeatVerdict`. Writing over it
 * unconditionally, which is what this did, left two processes both believing
 * they held it, permanently.
 *
 * **The lock cannot be written at all.** It stops rather than retrying every
 * second into a log nobody can read; the file then goes stale on its own and
 * the next process to boot takes the directory, which is the right outcome for
 * a server that can no longer write to its own data directory. Giving ownership
 * up at that moment is the point of saying it here rather than leaving it
 * implied: from now on another process may claim the directory, so this one
 * carrying on writing is the two-writer case reached by a route that has
 * nothing to do with how many servers were started.
 */
export function heartbeat(): void {
  // Asked every beat, before the write. One `readFileSync` a second, against a
  // fault whose whole shape is that nothing else would ever notice it.
  const held = readLock();
  if (heartbeatVerdict(held, state.ownerId) === "lost") {
    standDown("lost", held);
    // `error`, not `warn`. From here this server serves pages and refuses
    // everything else — and the runs it had in flight belong to whoever took
    // the directory, which has already closed them out.
    console.error(
      `[usagefoundry] Lost this data directory to ${
        held ? `process ${held.pid}` : "another process"
      } — this server was unresponsive for longer than the ${
        STALE_MS / 1000
      }s stale window and another server claimed it. Refusing every write from ` +
        "now on. Stop one of the two servers and restart the other.",
    );
    return;
  }

  try {
    writeLock(Date.now());
  } catch (err) {
    standDown("lost", null);
    console.warn(
      `[usagefoundry] Could not update ${lockPath()}: ${(err as Error).message}. ` +
        "Another server starting from now on will treat this data directory as " +
        "free, so this one has stopped writing too.",
    );
  }
}

/** Give up the claim and the timer together — never one without the other. */
function standDown(to: DataDirOwnership, holder: ServerLock | null): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  state.ownership = to;
  state.holder = holder;
}

/**
 * Give the directory up on a clean exit, so the next boot claims it without
 * waiting out `STALE_MS` or watching a dead pid.
 *
 * The ownerId check is what stops a late release from deleting a lock that has
 * already changed hands.
 */
export function releaseDataDir(): void {
  if (state.ownership !== "owned") return;
  state.ownership = "unclaimed";
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  try {
    if (readLock()?.ownerId === state.ownerId) fs.unlinkSync(lockPath());
  } catch {
    /* already gone, or never written — nothing to release */
  }
}
