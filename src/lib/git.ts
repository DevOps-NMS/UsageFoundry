import { spawn, spawnSync } from "node:child_process";
import { GIT_BIN } from "./config";

/**
 * The one way this app runs git.
 *
 * Extracted from `orchestrator.ts` when reviewing and landing a run's branch
 * became things the app does too: three modules now shell out to git, and the
 * scrubbing below is the whole reason it is safe to. Arguments go as an array
 * and never through a shell, and the environment is stripped of this app's
 * secrets because git runs repository-controlled code — `core.fsmonitor` is a
 * command git executes, `worktree add` fires `post-checkout`, and `merge` fires
 * `pre-merge-commit`/`commit-msg`. Terminal prompting is disabled because these
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

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of Object.keys(env)) {
    if (k.startsWith("ANTHROPIC_") || k.startsWith("UF_")) delete env[k];
  }
  return env;
}

/**
 * `core.fsmonitor` is a command git runs, so it is cleared on every call.
 *
 * `safe.directory` is waived for the same reason the image waives it: a
 * bind-mounted repository carries the host's uid, which need not be this
 * process's, and git's refusal is indistinguishable from "not a repository" by
 * the time `probeIsolation` sees it. The check it disables guards against
 * repositories reached by surprise on a shared host; every path that gets here
 * has already been proved to sit inside a configured mount by `resolveInMount`.
 */
const gitArgs = (args: string[]) => [
  "-c",
  "core.fsmonitor=",
  "-c",
  "safe.directory=*",
  ...args,
];

/**
 * Synchronous git, for the admission decision only.
 *
 * `createRun` runs from entry to INSERT with no `await`, and that is what makes
 * its folder claim atomic — so the calls it makes have to be synchronous. These
 * are single-digit milliseconds. Everything else uses `git()` below.
 */
export function gitSync(cwd: string, args: string[]): GitResult {
  const res = spawnSync(GIT_BIN, gitArgs(args), {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
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
 */
export function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBytes?: number; trim?: boolean } = {},
): Promise<GitResult & { overflowed: boolean }> {
  const { timeoutMs = 20_000, maxBytes = 0, trim = true } = opts;

  return new Promise((resolve) => {
    const child = spawn(GIT_BIN, gitArgs(args), {
      cwd,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let overflowed = false;
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

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();

    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !overflowed,
        stdout: trim ? stdout.trim() : stdout,
        stderr: stderr.trim(),
        code,
        overflowed,
      });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}
