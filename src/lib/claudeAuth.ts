import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { CLAUDE_BIN } from "./config";
import { childCredentials } from "./privsep";

/**
 * The fifth kind of child process, and the only one that starts no agent.
 *
 * `docs/agent/architecture.md` names four — the work cycle, the reviewer, the
 * orchestrator chat and git — and says a fifth is a decision. This is that
 * decision, and what makes it one rather than a detail is that it is the first
 * child spawned for its *side effect on disk* instead of for its output: it
 * rewrites the credential every other child authenticates with. It costs
 * nothing, holds no context window, reads no repository and takes no prompt, so
 * `maxConcurrentAssists` does not bound it; what bounds it is that at most one
 * login may be pending per install, below.
 *
 * It exists because the alternative was a shell. Signing the container in meant
 * `docker compose exec -it usagefoundry claude` and `/login` — a terminal, on
 * the host, for the one step that has to happen before any run can work at all,
 * and no way back out again short of editing the mounted directory by hand.
 *
 * Three commands, all of which the pinned CLI already answers non-interactively
 * given pipes rather than a tty:
 *
 *   `claude auth status --json`  a single JSON object, exit 0 either way
 *   `claude auth login`          prints an authorize URL, then reads the code
 *                                the browser hands back from **stdin**
 *   `claude auth logout`         prints one line, exit 0
 *
 * The middle one is why this module holds state. The CLI keeps the PKCE
 * verifier for a login in the memory of the process that printed the URL, so
 * the URL and the code are halves of one live child — a second `claude auth
 * login` would print a second URL whose code the first process cannot redeem.
 * That is the bound: one pending login, and starting another cancels it.
 */

/** What the CLI answered about who, if anyone, is signed in. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  /** `claude.ai` for a subscription, `none` when signed out. */
  method: string | null;
  email: string | null;
  organization: string | null;
  /** `subscriptionType` — `team`, `max`, `pro`. */
  plan: string | null;
  /**
   * The environment variable an API key was found in, when one was.
   *
   * Surfaced rather than hidden because it *outranks* the login: with a key set
   * the CLI reports `loggedIn` with no email and no organisation, and that key
   * is what every work cycle bills against. A panel that showed only the
   * subscription would name a credential no run uses.
   */
  apiKeySource: string | null;
}

export type ClaudeAuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * The hosts a printed login URL may point at.
 *
 * Checked because this string is rendered as a link the operator is asked to
 * open and sign in on, and it arrives as parsed text rather than as a value the
 * CLI hands over in a structured field. The CLI is pinned in the image, so the
 * realistic failure this guards is not an attacker but a version that changes
 * what it prints — and a mismatch fails loudly with the offending line rather
 * than presenting some other URL as the place to enter Anthropic credentials.
 */
const LOGIN_URL_DOMAINS = ["claude.com", "claude.ai", "anthropic.com"];

/** Long enough for a slow first run of the CLI, short enough to report. */
const URL_TIMEOUT_MS = 30_000;
/** A login nobody finished. The authorize code expires long before this. */
const PENDING_TIMEOUT_MS = 10 * 60_000;
/** The token exchange is one HTTPS round trip. */
const EXCHANGE_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** Enough of the CLI's own words to quote back; a bound so a wedge cannot grow. */
const CAPTURE_LIMIT = 16_384;

interface PendingLogin {
  child: ChildProcess;
  url: string;
  startedAt: number;
  /** Everything the child has said, for the error message if it fails. */
  output: () => string;
  /** Resolves once the child exits, whatever the code. */
  exited: Promise<{ code: number | null; output: string }>;
  timer: NodeJS.Timeout;
}

/**
 * On `globalThis` like every other long-lived handle here: a module-level `let`
 * silently resets on each request in dev, which would strand the child holding
 * the verifier and leave the pasted code with nothing to redeem it.
 */
const store = globalThis as typeof globalThis & {
  __ufClaudeLogin?: PendingLogin | null;
  __ufClaudeAuthRead?: Promise<ClaudeAuthResult<ClaudeAuthStatus>> | null;
};

/**
 * Terminal escapes, removed before anything is read out of CLI output.
 *
 * `FORCE_COLOR=0` and a pipe get us plain text today, but the URL is also
 * printed as an OSC 8 hyperlink when the CLI thinks it has a terminal, which
 * puts the same URL in the stream twice — once inside the escape, once as the
 * visible label. Dropping the escape and its payload leaves exactly one copy;
 * leaving both in would have `extractLoginUrl` return the first, which is
 * terminated by a control character rather than by whitespace.
 */
function stripEscapes(raw: string): string {
  return (
    raw
      // OSC: ESC ] … terminated by BEL or by ST (ESC \\). Its payload is the
      // href, so it goes with the wrapper and the visible label survives.
      .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
      // CSI: ESC [ … final byte. Colour, cursor moves, a spinner redrawing.
      .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
  );
}

/**
 * The authorize URL out of `claude auth login`'s first lines, or `null`.
 *
 * Pure, and tested, because every way of getting it wrong is silent in the same
 * direction: a Sign in button that opens nothing, or — worse — opens somewhere
 * else. The host check is why `null` is returned rather than the first `https:`
 * match; the caller reports the raw output when this is `null`.
 */
export function extractLoginUrl(raw: string): string | null {
  for (const match of stripEscapes(raw).matchAll(/https:\/\/[^\s<>"']+/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    const allowed = LOGIN_URL_DOMAINS.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    if (allowed) return url.toString();
  }
  return null;
}

/**
 * `claude auth status --json` into the shape the page renders.
 *
 * A result union rather than a boolean, because "signed out" and "the CLI did
 * not answer in a shape we know" are different facts and only one of them is
 * fixed by signing in. Collapsing them would put a Sign in button in front of
 * an operator whose real problem is a missing binary.
 */
export function parseAuthStatus(raw: string): ClaudeAuthResult<ClaudeAuthStatus> {
  const text = stripEscapes(raw).trim();
  // The CLI may print a warning line before the object, so parse from the first
  // brace rather than from the first byte.
  const start = text.indexOf("{");
  if (start === -1) {
    return { ok: false, error: describeOutput(text) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return { ok: false, error: describeOutput(text) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: describeOutput(text) };
  }

  const o = parsed as Record<string, unknown>;
  if (typeof o.loggedIn !== "boolean") {
    return {
      ok: false,
      error: "`claude auth status --json` answered without a loggedIn field",
    };
  }

  return {
    ok: true,
    value: {
      loggedIn: o.loggedIn,
      method: str(o.authMethod),
      email: str(o.email),
      organization: str(o.orgName),
      plan: str(o.subscriptionType),
      apiKeySource: str(o.apiKeySource),
    },
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** What went wrong, in the CLI's own words where it left any. */
function describeOutput(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line
    ? `\`${CLAUDE_BIN} auth\` answered: ${line.slice(0, 300)}`
    : `\`${CLAUDE_BIN} auth\` answered nothing`;
}

/**
 * The pasted authorize code, or why it was refused.
 *
 * The code reaches the child on **stdin**, never in argv, so this is not
 * guarding a command line — the CLI reads one line, and a value carrying a
 * newline would answer this prompt with its first half and whatever comes next
 * with the second. Whitespace around a paste is the normal case and is trimmed;
 * whitespace inside it means the paste picked up surrounding text.
 */
export function normalizeCode(input: unknown): ClaudeAuthResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "No code was sent." };
  }
  const code = input.trim();
  if (code === "") return { ok: false, error: "Paste the code from the browser." };
  if (/\s/.test(code)) {
    return {
      ok: false,
      error: "That looks like more than the code — paste only the code itself.",
    };
  }
  if (code.length > 512) {
    return { ok: false, error: "That is too long to be an authorize code." };
  }
  return { ok: true, value: code };
}

/**
 * Environment for an auth child — the same denylist the three agent spawn sites
 * use, deliberately including its omissions.
 *
 * `ANTHROPIC_API_KEY` is **not** stripped, and that is the point rather than an
 * oversight: `childEnv` passes it to every work cycle, so a status read that
 * hid it would report the subscription login while runs billed a key. The panel
 * has to answer for the credential runs actually get.
 *
 * A copy rather than an import of `orchestrator.ts`'s, for the reason
 * `review.ts` keeps its own `settleOnExit`: an auth route has no business
 * pulling the run loop in behind it.
 */
function authEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("UF_") ||
      key.startsWith("OTEL_") ||
      key === "ANTHROPIC_ADMIN_KEY" ||
      key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      key === "DATA_DIR" ||
      key === "NODE_OPTIONS"
    ) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Spawn options shared by all three commands.
 *
 * `childCredentials()` is load-bearing here in a way it is not at the other
 * spawn sites, where it is a containment measure. The CLI writes
 * `.credentials.json` at mode 0600 owned by whoever wrote it, and every work
 * cycle runs as `UF_AGENT_UID` — so a login performed with the server's own
 * authority produces a root-owned credential that the server can read, the
 * panel reports as signed in, and no agent can open. The failure would be a
 * fleet of runs ending on `Not logged in` under a page saying the opposite.
 */
function spawnOptions(): SpawnOptions {
  return {
    env: authEnv(),
    ...childCredentials(),
    stdio: ["pipe", "pipe", "pipe"],
  };
}

/** Run one auth command to completion. Never throws; a failure is a value. */
function runAuth(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; output: string; spawnError: string | null }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(CLAUDE_BIN, args, spawnOptions());
    } catch (err) {
      resolve({
        code: null,
        output: "",
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let output = "";
    const take = (chunk: Buffer) => {
      if (output.length < CAPTURE_LIMIT) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    // Nothing to say to these two, and an open stdin leaves a command that
    // decides to prompt waiting for a line that will never come.
    child.stdin?.end();

    let settled = false;
    const done = (r: {
      code: number | null;
      output: string;
      spawnError: string | null;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({
        code: null,
        output,
        spawnError: `\`${CLAUDE_BIN} ${args.join(" ")}\` did not answer within ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (err) =>
      done({ code: null, output, spawnError: err.message }),
    );
    child.on("close", (code) => done({ code, output, spawnError: null }));
  });
}

/**
 * Who the container's Claude Code is signed in as.
 *
 * Callers arriving while a read is already running share it, the way
 * `currentSnapshot()` shares a transcript scan. This is a spawn on a route with
 * no rate limit in front of it, and the answer cannot differ between two reads
 * a few milliseconds apart — without the share, a page opened in five tabs is
 * five processes for one fact.
 */
export function readAuthStatus(): Promise<ClaudeAuthResult<ClaudeAuthStatus>> {
  if (store.__ufClaudeAuthRead) return store.__ufClaudeAuthRead;
  const read = statusOnce().finally(() => {
    store.__ufClaudeAuthRead = null;
  });
  store.__ufClaudeAuthRead = read;
  return read;
}

async function statusOnce(): Promise<ClaudeAuthResult<ClaudeAuthStatus>> {
  const res = await runAuth(["auth", "status", "--json"], COMMAND_TIMEOUT_MS);
  if (res.spawnError) {
    return {
      ok: false,
      error: `Could not run \`${CLAUDE_BIN}\`: ${res.spawnError}`,
    };
  }
  return parseAuthStatus(res.output);
}

/** Is a login waiting for its code right now? */
export function pendingLogin(): { url: string; startedAt: number } | null {
  const p = store.__ufClaudeLogin;
  return p ? { url: p.url, startedAt: p.startedAt } : null;
}

/**
 * Drop the pending login, killing the child that holds its verifier.
 *
 * Called on cancel, on timeout, and at the start of every new login. Safe to
 * call when there is none.
 */
export function cancelLogin(): void {
  const p = store.__ufClaudeLogin;
  if (!p) return;
  store.__ufClaudeLogin = null;
  clearTimeout(p.timer);
  p.child.kill("SIGKILL");
}

/**
 * Start a login and return the URL to open.
 *
 * The child stays alive afterwards, holding the verifier, until `submitCode`
 * feeds it a line or something cancels it.
 */
export async function beginLogin(): Promise<ClaudeAuthResult<{ url: string }>> {
  // Any earlier attempt is dead to us the moment a second URL exists: only one
  // of the two verifiers can redeem a code, and the operator is about to be
  // shown the newer one.
  cancelLogin();

  let child: ChildProcess;
  try {
    child = spawn(CLAUDE_BIN, ["auth", "login"], spawnOptions());
  } catch (err) {
    return {
      ok: false,
      error: `Could not run \`${CLAUDE_BIN}\`: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let output = "";
  const take = (chunk: Buffer) => {
    if (output.length < CAPTURE_LIMIT) output += chunk.toString("utf8");
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);

  const exited = new Promise<{ code: number | null; output: string }>(
    (resolve) => {
      child.on("close", (code) => resolve({ code, output }));
      child.on("error", (err) => {
        output += `\n${err.message}`;
        resolve({ code: null, output });
      });
    },
  );

  const url = await waitForUrl(child, () => output, exited);
  if (!url.ok) {
    child.kill("SIGKILL");
    return url;
  }

  const timer = setTimeout(() => cancelLogin(), PENDING_TIMEOUT_MS);
  timer.unref?.();

  store.__ufClaudeLogin = {
    child,
    url: url.value,
    startedAt: Date.now(),
    output: () => output,
    exited,
    timer,
  };
  return { ok: true, value: { url: url.value } };
}

/** Poll the captured output until the URL appears, the child dies, or we give up. */
function waitForUrl(
  child: ChildProcess,
  output: () => string,
  exited: Promise<{ code: number | null; output: string }>,
): Promise<ClaudeAuthResult<string>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ClaudeAuthResult<string>) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(r);
    };

    const look = () => {
      const url = extractLoginUrl(output());
      if (url) finish({ ok: true, value: url });
    };

    // Polled rather than driven off `data`, because the listener that
    // accumulates `output` is already attached and a second one would have to
    // agree with it about ordering. The URL is the second line the CLI prints.
    const poll = setInterval(look, 100);
    poll.unref?.();

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `\`${CLAUDE_BIN} auth login\` printed no sign-in link within ${Math.round(URL_TIMEOUT_MS / 1000)}s. ${describeOutput(stripEscapes(output()))}`,
      });
    }, URL_TIMEOUT_MS);
    timer.unref?.();

    void exited.then(() => {
      // One last look: a child that printed the URL and exited immediately is
      // not the shape we expect, but the URL would still be there.
      look();
      finish({
        ok: false,
        error: `\`${CLAUDE_BIN} auth login\` exited before printing a sign-in link. ${describeOutput(stripEscapes(output()))}`,
      });
    });

    look();
  });
}

/**
 * A submitted code either finished the sign-in or did not, and the second case
 * splits in a way the page has to see.
 *
 * `stillPending` is the difference between "paste it again" and "start again",
 * and it is not cosmetic: the CLI validates the code's shape locally *before*
 * spending it, and on a short or truncated paste it says so and **keeps
 * waiting on the same prompt**. That child still holds the only verifier that
 * can redeem a code from the link already open in the operator's browser, so
 * killing it over a typo would cost them the whole round trip.
 */
export type SubmitOutcome =
  | { ok: true; value: ClaudeAuthStatus }
  | { ok: false; error: string; stillPending: boolean };

/** How long a locally-rejected code's message is given to arrive. */
const REJECTION_GRACE_MS = 1_500;

/**
 * Hand the pasted code to the waiting child and report what it made of it.
 *
 * The child owns the exchange — it holds the verifier, it writes the credential
 * — so success here is its exit code and nothing this module computes.
 */
export async function submitCode(input: unknown): Promise<SubmitOutcome> {
  const code = normalizeCode(input);
  if (!code.ok) return { ok: false, error: code.error, stillPending: true };

  const pending = store.__ufClaudeLogin;
  if (!pending) {
    return {
      ok: false,
      error: "That sign-in has expired or was cancelled. Start it again.",
      stillPending: false,
    };
  }

  if (!pending.child.stdin || pending.child.stdin.destroyed) {
    cancelLogin();
    return {
      ok: false,
      error: "The sign-in process is no longer listening. Start it again.",
      stillPending: false,
    };
  }

  const mark = pending.output().length;
  pending.child.stdin.write(`${code.value}\n`);

  const outcome = await Promise.race([
    pending.exited.then((e) => ({ kind: "exit" as const, ...e })),
    // Only resolves while the child is still on the prompt, so an exit always
    // wins this race even when the CLI prints a parting line before it goes.
    waitForRejection(pending, mark).then(() => ({ kind: "rejected" as const })),
    after(EXCHANGE_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
  ]);

  if (outcome.kind === "rejected") {
    return {
      ok: false,
      error: describeOutput(stripEscapes(pending.output().slice(mark))),
      stillPending: true,
    };
  }

  // Everything below is terminal for this child, so the pending login goes.
  store.__ufClaudeLogin = null;
  clearTimeout(pending.timer);

  if (outcome.kind === "timeout") {
    pending.child.kill("SIGKILL");
    return {
      ok: false,
      error: "The sign-in did not complete in time. Start it again.",
      stillPending: false,
    };
  }
  if (outcome.code !== 0) {
    // The CLI says why — "Login failed: Request failed with status code 400" —
    // and its sentence is better than any this module could reconstruct. Sliced
    // at the mark like the rejection path, so what is quoted is what it said
    // about *this* code rather than the sign-in link printed a minute earlier.
    return {
      ok: false,
      error: describeOutput(stripEscapes(outcome.output.slice(mark))),
      stillPending: false,
    };
  }

  // The exit code says the exchange worked; the status read is what proves the
  // credential landed somewhere the next child can read.
  const status = await readAuthStatus();
  return status.ok
    ? { ok: true, value: status.value }
    : { ok: false, error: status.error, stillPending: false };
}

/**
 * Resolve once the CLI has answered a submitted code *without* exiting — its
 * "Invalid code" path.
 *
 * The grace period is what keeps this from firing on a success that prints a
 * parting line: the child is re-checked after it, and a process that has left
 * is left to the `exited` branch of the race by never resolving here.
 */
function waitForRejection(pending: PendingLogin, mark: number): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (pending.output().length <= mark) return;
      clearInterval(poll);
      const settle = setTimeout(() => {
        const gone =
          pending.child.exitCode !== null || pending.child.signalCode !== null;
        if (!gone) resolve();
      }, REJECTION_GRACE_MS);
      settle.unref?.();
    }, 100);
    poll.unref?.();
  });
}

function after(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Sign the container's Claude Code out.
 *
 * Destructive to work in flight and deliberately not guarded here: this module
 * cannot see runs, and a sign-out that refused while any run existed would be
 * unreachable exactly when a leaked credential most needs revoking. The page
 * confirms instead.
 */
export async function signOut(): Promise<ClaudeAuthResult<ClaudeAuthStatus>> {
  cancelLogin();
  const res = await runAuth(["auth", "logout"], COMMAND_TIMEOUT_MS);
  if (res.spawnError) {
    return {
      ok: false,
      error: `Could not run \`${CLAUDE_BIN}\`: ${res.spawnError}`,
    };
  }
  if (res.code !== 0) {
    return { ok: false, error: describeOutput(stripEscapes(res.output)) };
  }
  return readAuthStatus();
}
