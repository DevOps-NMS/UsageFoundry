import { spawn, spawnSync } from "node:child_process";
import { GIT_BIN } from "./config";
import { childCredentials } from "./privsep";

/**
 * The one way this app runs git.
 *
 * Extracted from `orchestrator.ts` when reviewing and landing a run's branch
 * became things the app does too: three modules now shell out to git, and the
 * scrubbing below is the whole reason it is safe to. Arguments go as an array
 * and never through a shell; the config the calls carry turns off the two ways
 * a repository gets git to run a command of its choosing (`core.fsmonitor` and
 * hooks — `worktree add` fires `post-checkout`, `merge` fires
 * `pre-merge-commit`/`commit-msg`); and the environment is stripped of this
 * app's configuration anyway, because the drivers reached through
 * `.gitattributes` are repository-controlled too and `diff.ts` disables those
 * per call rather than here. Terminal prompting is disabled because these
 * children have no stdin; a credential prompt would otherwise hang until a
 * timeout.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Raw exit status. `merge-tree` uses 1 for "conflicts", not for "failed". */
  code: number | null;
}

/**
 * Environment for the git this app runs on its own behalf.
 *
 * The exclusion list is `childEnv`'s in `orchestrator.ts`, deliberately the
 * same one rather than a shorter one: a git child is the *only* child here that
 * executes code written by something other than this app — a hook, a
 * `core.fsmonitor`, a `textconv` — and it does so with no permission mode, no
 * tool lists and no line in `run_events`. It had the shortest exclusion list of
 * the three, which was the wrong way round. `DATA_DIR` is the one that bites:
 * `serverLock.ts` names it as the variable withholding exists to protect, and
 * nothing git does needs to know where this app's database is.
 *
 * `CLAUDE_CONFIG_DIR` and `HOME` still pass through, as they do for the agent —
 * git reads `HOME` for its own configuration, and an allowlist here would fail
 * in ways that are tedious to diagnose from inside a container.
 *
 * `NODE_OPTIONS` is on the list for the reason `childEnv` gives, and it is not
 * dead weight here even though git ignores it: the hooks, `textconv` drivers
 * and `core.fsmonitor` this child can be made to run are repository-controlled
 * and one of them may well be a Node program.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of Object.keys(env)) {
    if (
      k.startsWith("ANTHROPIC_") ||
      k.startsWith("UF_") ||
      k.startsWith("OTEL_") ||
      k === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      k === "DATA_DIR" ||
      k === "NODE_OPTIONS"
    ) {
      delete env[k];
    }
  }
  return env;
}

/**
 * `core.fsmonitor` is a command git runs, so it is cleared on every call.
 *
 * `core.hooksPath` is cleared for exactly that reason and is the larger half of
 * it: a hook is a repository-controlled command that git runs, `worktree add`
 * and `checkout` fire `post-checkout`, and `merge`/`commit` fire four more —
 * inside the operator's own checkout, at a moment the operator triggered. An
 * agent can write `.git/hooks/post-checkout` in any repository it works in, and
 * a run started afterwards would execute it as this server's git child, outside
 * the CLI's permission model entirely. `/dev/null` is not a directory, so git
 * finds no hook there and carries on; verified against 2.39, including that it
 * outranks a `core.hooksPath` the repository sets in its own `.git/config`.
 *
 * This is the git *this app* runs, and nothing here reaches the agent's own:
 * `buildArgs` passes no config at all, so a repository's `pre-commit` still runs
 * for the run that was asked to commit. That is part of the work.
 *
 * `safe.directory` is waived for the same reason the image waives it: a
 * bind-mounted repository carries the host's uid, which need not be this
 * process's, and git's refusal is indistinguishable from "not a repository" by
 * the time `probeIsolation` sees it. The check it disables guards against
 * repositories reached by surprise on a shared host; every path that gets here
 * has already been proved to sit inside a configured mount by `resolveInMount`.
 */
export const gitArgs = (args: string[]) => [
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "safe.directory=*",
  ...args,
];

/**
 * The longest one synchronous git call may hold the event loop.
 *
 * Named rather than inlined because it is read from outside this module:
 * `serverLock.ts` derives `STALE_MS` from it, since a `spawnSync` is a hold on
 * the one event loop that also beats the lock's heartbeat, and a heartbeat
 * window shorter than a single git call is a window a working server can miss
 * with no other load at all.
 */
export const GIT_SYNC_TIMEOUT_MS = 20_000;

/**
 * Synchronous git, for the admission decision only.
 *
 * `createRun` runs from entry to INSERT with no `await`, and that is what makes
 * its folder claim atomic — so the calls it makes have to be synchronous. These
 * are single-digit milliseconds for the `rev-parse`s, and are emphatically not
 * for `status --porcelain` on a large checkout with `core.fsmonitor` cleared,
 * which is what the ceiling above is really about. Everything else uses `git()`
 * below.
 */
export function gitSync(cwd: string, args: string[]): GitResult {
  const res = spawnSync(GIT_BIN, gitArgs(args), {
    cwd,
    env: gitEnv(),
    ...childCredentials(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_SYNC_TIMEOUT_MS,
  });

  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    code: res.status,
  };
}

/**
 * Async twin of `gitSync`, for everything outside the admission decision.
 *
 * `worktree add` is a full checkout — minutes on a large repository — and the
 * synchronous form would hold the event loop for all of it, stalling every
 * other run's event stream and every poll in every open tab.
 *
 * `maxBytes` bounds stdout for the callers that read a diff: an unbounded read
 * of a generated-file change is a heap the server does not have. Hitting it
 * kills the child and reports `ok: false` rather than returning a patch that is
 * short by an unstated amount.
 *
 * `trim: false` is for the one output shape where leading whitespace carries
 * meaning: `git status --porcelain` writes an unstaged edit as `" M path"`, and
 * trimming the stream eats that first space — which shifts the whole record and
 * reads the status letters off the middle of a filename.
 *
 * `timeoutMs: 0` runs with **no clock at all**, and it exists for the landing
 * path. A timeout here is a `SIGKILL`, which arrives at the caller as
 * `ok: false` and is indistinguishable from git having refused — so a merge on
 * a large repository was rolled back and reported as "git refused the merge"
 * for the sole reason that it took longer than a number nobody measured. There
 * is no length of time after which merging somebody's work becomes the wrong
 * thing to do, so `land.ts` passes this on every call that decides or performs
 * one. Memory is still bounded by `maxBytes` where a caller reads a diff, and
 * an unbounded call is still killed when the process ends.
 *
 * **It never rejects, and that is a contract the whole app was already reading
 * it as having.** Not every failure to start a child reaches the `error` event:
 * `spawn` demotes exactly `EACCES`/`EAGAIN`/`EMFILE`/`ENFILE`/`ENOENT` to one,
 * and throws every other errno synchronously — `ENOTDIR` from a `cwd` that has
 * become a file, `EPERM` from `childCredentials()`. `EMFILE` and `ENFILE` are
 * worse than a throw from `spawn`: they *return*, having deliberately skipped
 * the stdio wiring, so `child.stdout` is `undefined` and the `setEncoding`
 * below is what throws — and file descriptors are the resource this app is
 * closest to spending, at four merge workers each running a dozen git children
 * beside a fleet of agents. Every caller in `land.ts` reads a `GitResult` and
 * none of them has a `catch`, so a rejection propagated out of the merge
 * worker's loop and left the row it was landing stuck on `landing` for ever.
 * A child that could not be started is reported as the failed call it is.
 */
export function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBytes?: number; trim?: boolean } = {},
): Promise<GitResult & { overflowed: boolean }> {
  const { timeoutMs = 20_000, maxBytes = 0, trim = true } = opts;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0 && !overflowed,
        stdout: trim ? stdout.trim() : stdout,
        stderr: stderr.trim(),
        code,
        overflowed,
      });
    };

    try {
      const child = spawn(GIT_BIN, gitArgs(args), {
        cwd,
        env: gitEnv(),
        ...childCredentials(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (overflowed) return;
        stdout += c;
        if (maxBytes > 0 && stdout.length > maxBytes) {
          overflowed = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (c: string) => (stderr += c));

      // Zero is "no clock", not "kill immediately" — see the note above.
      timer = timeoutMs > 0 ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
      timer?.unref?.();

      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
    } catch (err) {
      // The child never started, and the errno said so by throwing rather than
      // by the `error` event. `stderr` is where a caller already looks for why
      // a git call failed, so the reason goes there rather than into a rejection
      // nothing above is written to catch.
      stderr = err instanceof Error ? err.message : String(err);
      finish(null);
    }
  });
}
