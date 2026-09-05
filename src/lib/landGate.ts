import { spawn } from "node:child_process";

import { childCredentials } from "./privsep";

/**
 * The check an operator can put in front of Land.
 *
 * ## The gap this closes
 *
 * `docs/agent/isolation-and-landing.md` describes every condition Land already
 * enforces about the *checkout* — clean, on target, nobody working in it — and
 * none about the *work*. An operator cannot say "do not land this unless the
 * tests pass": there is no field for it, no gate in `landRun`, and the one
 * setting whose name suggests otherwise, `resolveVerifyTools`, has a single
 * reader that is the conflict-resolution assist and ships as `[]`
 * (`settings.ts:871`, read at `land.ts:1336`).
 *
 * That asymmetry is the point. This app will spend an afternoon of an
 * operator's allowance producing a branch unattended, then let it into their
 * checkout on a button that has checked the tree and nothing else.
 *
 * ## Off unless asked for, and a refusal rather than a warning
 *
 * `landVerifyCommand` is `""` by default and an empty command is not a check
 * that passes — it is no check, and Land behaves exactly as it does today.
 * When it is set, a non-zero exit REFUSES the land. A gate that warned would be
 * advice, and the invariant an operator wants here is the one they cannot
 * forget to read.
 *
 * ## Never a shell
 *
 * `docs/agent/security.md` states it for spawn argv and it holds here: the
 * command is split into argv and any shell metacharacter is refused at parse
 * time rather than escaped. An operator who wants `a && b` is asking for a
 * shell, and the honest answer is to say so and point at a script, not to
 * interpolate their string into `sh -c` where a repository name with a
 * backtick in it becomes execution.
 */

/** Characters that only mean anything to a shell. Refused, never escaped. */
const SHELL_METACHARACTERS = /[;&|<>$`(){}[\]!#*?~\n\r\\]/;

export type VerifyCommand =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

/**
 * Split an operator's verify command into argv, or say why it cannot be one.
 *
 * Pure, and its failure mode is the silent kind this repository tests for: a
 * parser that quietly dropped a metacharacter would run a DIFFERENT command
 * from the one the operator read back to themselves in Settings, and it would
 * pass its own tests while doing it.
 */
export function parseVerifyCommand(raw: string): VerifyCommand {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "no verify command is configured" };
  if (SHELL_METACHARACTERS.test(text)) {
    return {
      ok: false,
      reason:
        "a verify command is argv, never a shell line — remove the shell " +
        "characters, or put them in a script and name the script here",
    };
  }
  const argv = text.split(/\s+/).filter(Boolean);
  if (!argv.length) return { ok: false, reason: "no verify command is configured" };
  return { ok: true, argv };
}

export type VerifyOutcome = {
  ran: boolean;
  passed: boolean;
  /** What to show the operator. Empty when there is nothing to say. */
  reason: string;
};

/**
 * What Land should do with a finished check.
 *
 * Separated from running it so the decision is testable without a subprocess,
 * which is the half that decides whether somebody's work merges.
 */
export function landVerdict(o: {
  configured: boolean;
  parse: VerifyCommand;
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
}): VerifyOutcome {
  if (!o.configured) return { ran: false, passed: true, reason: "" };
  if (!o.parse.ok) {
    // A command that cannot be parsed is NOT a pass. The operator asked for a
    // gate; handing them an open door because their string was malformed is the
    // failure this whole module exists to prevent, and it would be silent.
    return {
      ran: false,
      passed: false,
      reason: `The verify command is not runnable: ${o.parse.reason}.`,
    };
  }
  if (o.timedOut) {
    return {
      ran: true,
      passed: false,
      reason:
        "The verify command did not finish in time, so nothing here knows " +
        "whether this branch is good. Land refused rather than guessed.",
    };
  }
  if (o.exitCode === 0) return { ran: true, passed: true, reason: "" };
  const tail = o.tail.trim();
  return {
    ran: true,
    passed: false,
    reason:
      `The verify command exited ${o.exitCode ?? -1}, so this branch was not ` +
      `landed.` + (tail ? ` Its last output was: ${tail}` : ""),
  };
}

/** How long a check may take before Land stops waiting on it. */
export const VERIFY_TIMEOUT_MS = 15 * 60_000;

/** How much of a failing check's output the refusal carries. */
export const VERIFY_TAIL_BYTES = 2000;

/**
 * Run the configured check in the checkout Land is about to merge into.
 *
 * As the child uid, not the server's: this runs a command an operator wrote
 * against a tree an agent produced, and `docs/agent/security.md`'s reason for
 * separating those uids does not stop applying because the command came from
 * Settings rather than from a model.
 */
export function runVerify(
  cwd: string,
  raw: string,
  deps: { timeoutMs?: number } = {},
): Promise<VerifyOutcome> {
  const configured = Boolean((raw ?? "").trim());
  const parse = parseVerifyCommand(raw);
  if (!configured || !parse.ok) {
    return Promise.resolve(
      landVerdict({ configured, parse, exitCode: null, timedOut: false, tail: "" }),
    );
  }
  const [bin, ...args] = parse.argv;
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(landVerdict({ configured, parse, exitCode, timedOut, tail: out }));
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd,
        ...childCredentials(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ran: false,
        passed: false,
        reason: `The verify command could not start: ${
          err instanceof Error ? err.message : String(err)
        }.`,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deps.timeoutMs ?? VERIFY_TIMEOUT_MS);
    const take = (chunk: string) => {
      out = (out + chunk).slice(-VERIFY_TAIL_BYTES);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) =>
      resolve({
        ran: false,
        passed: false,
        reason: `The verify command could not start: ${err.message}.`,
      }),
    );
    child.on("close", (code) => finish(code));
  });
}
