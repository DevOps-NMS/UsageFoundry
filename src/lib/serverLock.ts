import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { DATA_DIR } from "./config";

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
 * `childEnv` withholding `DATA_DIR` is what stops that particular route, and
 * the uid split is what makes the withholding enforceable — a child cannot read
 * the variable out of `/proc/<server>/environ` any more, and cannot open the
 * directory even knowing the path, because it belongs to the server at 0700.
 * This is still the check that does not depend on either: whatever a second
 * process is and however it found the file, it does not get to close out rows
 * belonging to a server that is still running. It is also the one that survives
 * an unseparated install — `npm run dev` on a laptop, where the lock and the
 * variable are all there is.
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
 * Generous relative to the heartbeat because the alternative error is the
 * expensive one: `buildSnapshot` re-aggregates the whole transcript history
 * synchronously, so a busy server can miss several beats while very much
 * alive, and treating that as death is how a stranger gets permission to close
 * out live runs.
 */
export const STALE_MS = 15_000;

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

interface LockState {
  ownerId: string;
  startedAt: number;
  owned: boolean;
  timer?: NodeJS.Timeout;
}

/** `globalThis` for the reason every other long-lived singleton here uses it. */
const state = ((globalThis as unknown as { __ufServerLock?: LockState })
  .__ufServerLock ??= {
  ownerId: randomUUID(),
  startedAt: Date.now(),
  owned: false,
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
 * A caller that gets `false` must not close out rows it did not create. It is
 * otherwise left alone deliberately: a second server is usually an agent's dev
 * server, it does nothing but read, and refusing to boot it would break the
 * one workflow — running this app against its own worktree — that found this
 * bug in the first place.
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

  if (verdict === "held") return false;

  writeLock(Date.now());
  state.owned = true;
  state.timer ??= setInterval(beat, HEARTBEAT_MS);
  state.timer.unref?.();
  return true;
}

/**
 * A heartbeat that cannot be written stops, loudly, rather than retrying every
 * second into a log nobody can read. The lock then goes stale on its own and
 * the next process to boot takes the directory — which is the right outcome for
 * a server that can no longer write to its own data directory, and it is said
 * out loud rather than inferred later from runs that were closed out.
 */
function beat(): void {
  try {
    writeLock(Date.now());
  } catch (err) {
    if (state.timer) clearInterval(state.timer);
    state.timer = undefined;
    state.owned = false;
    console.warn(
      `[usagefoundry] Could not update ${lockPath()}: ${(err as Error).message}. ` +
        "Another server starting from now on will treat this data directory as free.",
    );
  }
}

/**
 * Give the directory up on a clean exit, so the next boot claims it without
 * waiting out `STALE_MS` or watching a dead pid.
 *
 * The ownerId check is what stops a late release from deleting a lock that has
 * already changed hands.
 */
export function releaseDataDir(): void {
  if (!state.owned) return;
  state.owned = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  try {
    if (readLock()?.ownerId === state.ownerId) fs.unlinkSync(lockPath());
  } catch {
    /* already gone, or never written — nothing to release */
  }
}
