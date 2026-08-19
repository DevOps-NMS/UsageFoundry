import fs from "node:fs";
import type { SandboxDTO, SandboxRefusalKindDTO } from "./apiTypes";

/**
 * What confines a tool call below the uid it runs as, and how a run says when
 * that confinement refused something.
 *
 * Nothing here turns a sandbox on. This app configures none — `proposals/
 * Sandboxing/09-implementation-sketch.md` calls that Phase 2 — and this module
 * is the phase that has to ship *first*, because the failures the later ones
 * introduce arrive inside a tool call the run loop does not read. A too-narrow
 * allowlist and an agent that gave up produce the same run: cycles that spend
 * money and write nothing. `seedReport` exists for that reason on the seeding
 * path, and this is the same argument one boundary over.
 *
 * Two readers, both of which have to be honest in the same direction. The
 * detector below says a tool call failed *because of a sandbox*, and must not
 * say it about an ordinary permission error. The arrangement reader says what
 * this install is confined by, and must not report a sandbox that is not there.
 */

/* ------------------------------------------------------------------ */
/* A sandbox reason inside a failed tool call                          */
/* ------------------------------------------------------------------ */

/**
 * What the matched text says happened. Each is a distinct operator action, and
 * none of them is "the agent gave up".
 *
 * Every one of these is a sandbox that is *not working*, and that is the honest
 * shape of what can be recognised today rather than an omission. A policy
 * denial — an allowlist that does not name the path a command wanted — comes
 * back out of a bubblewrap mount namespace as an ordinary `EACCES`, which is
 * bit-for-bit what a file the agent may genuinely not have produces. Matching
 * that would relabel every permission error in every run as a policy decision,
 * which is the second of the two ways this can be wrong and the more expensive
 * one: a signal that fires on everything is not a signal. What closes the gap is
 * a measurement, not a looser matcher — `docs/verification.md` carries the
 * command, and the marker table below is where its result goes.
 *
 * Declared in `apiTypes.ts` because the log renders one word per kind and this
 * module reads `node:fs`; re-exported here so the matcher and its table read as
 * one thing.
 */
export type SandboxRefusalKind = SandboxRefusalKindDTO;

export interface SandboxRefusal {
  kind: SandboxRefusalKind;
  /**
   * The literal that matched. On the event beside the reason, so a mislabelled
   * line can be seen for what it is rather than argued about.
   */
  matched: string;
  /** The tool's own words, carried through rather than paraphrased. */
  reason: string;
}

/**
 * The literals, and the whole of what this recognises.
 *
 * **The table has two provenances now, and the comment on each entry says
 * which.** The CLI's own messages were read out of the pinned binary with
 * `strings` and have never been executed (`proposals/Sandboxing/10-validation.md`,
 * "What this validation did not check"). The `bwrap:` entries below were read
 * off this install's own `run_events` after a sandbox that could not start went
 * unnoticed for thirteen hours — which is the measurement the paragraph above
 * asks for, arriving the expensive way.
 *
 * The matching rule does not change with the provenance. Every needle is a
 * literal, case-sensitive substring and nothing is inferred from it: no regular
 * expression, no lowercasing, no matching on the word "sandbox" — which appears
 * in this repository's own source, and a run working on this repository is a
 * case that has already happened here. `bwrap: ` alone is refused for the same
 * reason and more sharply, since this file, its test and
 * `scripts/sandbox-probe/` all carry the literal.
 *
 * Ordered specific-first, and the order is the answer when several match: the
 * apply-seccomp message carries the `[Sandbox Linux]` tag as well, and
 * "the seccomp applier is missing" is the more useful of the two true things to
 * say about it. The tag is last so that a tagged message nobody has read yet is
 * reported as a sandbox message rather than missed — the direction that costs a
 * precise label rather than the whole signal.
 */
const MARKERS: ReadonlyArray<{ needle: string; kind: SandboxRefusalKind }> = [
  // `02x-option-cli-sandbox.md:52`, at wrap time.
  {
    needle: "apply-seccomp binary not available",
    kind: "seccomp-unavailable",
  },
  // `02x-option-cli-sandbox.md:51`, from the binary's own dependency check.
  {
    needle: "seccomp not available - unix socket access not restricted",
    kind: "seccomp-unavailable",
  },
  // `10-validation.md`, finding 16: the result envelope, and stderr.
  { needle: "Sandbox required but unavailable", kind: "sandbox-unavailable" },
  {
    needle: "refusing to start without a working sandbox",
    kind: "sandbox-unavailable",
  },
  // `10-validation.md`, finding 2: both are errors rather than warnings.
  { needle: "bubblewrap (bwrap) not installed", kind: "dependency-missing" },
  { needle: "socat not installed", kind: "dependency-missing" },
  // The two above are the CLI's own availability check, and it only asks
  // whether the binaries exist and are executable — it never runs one. So an
  // installed `bwrap` the kernel refuses passes that check, `failIfUnavailable`
  // never fires, and every command is wrapped in a program that exits 1 before
  // the command runs. **Measured, not read**: 214 of this install's 484
  // `tool_error` rows carry the first of these verbatim, and not one `sandbox`
  // row was written beside them.
  {
    needle: "bwrap: No permissions to create new namespace",
    kind: "bwrap-failed",
  },
  // The next one along rather than a recorded one, and named here because it is
  // what a container gets *after* the seccomp profile lets the namespace be
  // created: Docker masks parts of `/proc`, and a fresh procfs mount inside a
  // new user namespace is refused while those over-mounts hide the current view.
  { needle: "bwrap: Can't mount proc on", kind: "bwrap-failed" },
  // Every other way bubblewrap says it could not build its namespace. Broad
  // within its own sentence and safe to be: it is bwrap's own prefix, and the
  // program is only ever on an argv this app's children did not write.
  { needle: "bwrap: Creating new namespace failed", kind: "bwrap-failed" },
  // The CLI's own tag on a wrap-time message. Broad on purpose and safe to be:
  // no ordinary tool failure carries it.
  { needle: "[Sandbox Linux]", kind: "sandbox-message" },
];

/**
 * Whether a failed tool call failed for a sandbox reason, and which.
 *
 * Pure and unit-tested on `CLAUDE.md`'s rule, because both ways of being wrong
 * are silent and they fail in opposite directions. Miss a refusal and the
 * operator is back where they started, reading a run that spent money and wrote
 * nothing with no way to tell a policy from an unproductive agent. Match too
 * eagerly and an ordinary permission error is filed as a policy decision, which
 * sends somebody to widen an allowlist that was never the problem.
 *
 * `null` is a non-match and means only that — the caller records the tool
 * failure either way. Nothing here may swallow a tool result.
 */
export function sandboxRefusal(text: string): SandboxRefusal | null {
  if (!text) return null;
  for (const { needle, kind } of MARKERS) {
    if (text.includes(needle)) return { kind, matched: needle, reason: text };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* What this install is confined by                                    */
/* ------------------------------------------------------------------ */

/**
 * The one policy surface an agent cannot rewrite.
 *
 * The CLI reads sandbox settings from several sources; this is the only one a
 * run cannot edit, since agents are `UF_AGENT_UID` and `/etc` is root's. The
 * repository's own `.claude/settings.json` is ignored for these keys, and
 * `~/.claude/settings.json` is **not** — it is an honored source and it is
 * agent-writable today (`10-validation.md`, finding 1). That one is deliberately
 * not read here: a policy a run can append to is not an arrangement this app can
 * report as an arrangement, and understating a boundary is the safe direction
 * for a row whose whole job is that "off" cannot look like "on".
 */
const MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";

/** What was at that path, separated from reading it so the decision is pure. */
export type ManagedSettings =
  | { kind: "absent" }
  | { kind: "unreadable"; problem: string }
  | { kind: "present"; json: unknown };

/** A record, or null for anything else — including an array, which is not one. */
function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  const parent = value as Record<string, unknown> | null;
  const child = parent && typeof parent === "object" ? parent[key] : undefined;
  return child && typeof child === "object" && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : null;
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Whether an enabled policy actually names anything to confine.
 *
 * `10-validation.md` read `if(!n&&!M&&!N&&!D&&!U) return t;` out of the binary:
 * with no network entry, no read or write restriction and no credential entry,
 * the wrapper hands the command back **unwrapped**. So `enabled: true` over a
 * policy that resolved to nothing is a sandbox that silently does nothing, and
 * `failIfUnavailable` does not catch it, because a sandbox that was never asked
 * for anything is not one that failed. That is exactly the reading this row must
 * not print as "on", so it is its own state rather than a footnote.
 *
 * Unexecuted, like everything else read out of that binary: a key this misses
 * makes a real policy read as an empty one, which understates the boundary.
 */
function policyNamesSomething(sandbox: Record<string, unknown>): boolean {
  const filesystem = objectAt(sandbox, "filesystem");
  const network = objectAt(sandbox, "network");
  const credentials = objectAt(sandbox, "credentials");

  return (
    ["allowRead", "allowWrite", "denyRead", "denyWrite"].some((k) =>
      hasEntries(filesystem?.[k]),
    ) ||
    ["allowedDomains", "deniedDomains"].some((k) => hasEntries(network?.[k])) ||
    network?.allowManagedDomainsOnly === true ||
    ["files", "envVars"].some((k) => hasEntries(credentials?.[k]))
  );
}

/**
 * What confines this install's agents, from what the managed policy says.
 *
 * Pure, and unit-tested for the reason the detector is: every way of getting it
 * wrong is silent and reads as a working boundary. The states are four rather
 * than a boolean because two of the four are the ways a sandbox lies about
 * itself — a policy that names nothing runs every command unwrapped, and a file
 * that cannot be read is not evidence of absence. An unknown reading says
 * unknown, the same rule the meters take against a window with no figure in it.
 *
 * What it does **not** claim is that a sandbox is *working*. That is a property
 * of a process rather than of a file — bubblewrap has to be installed and the
 * container's seccomp profile has to permit the namespace — and the thing that
 * makes that failure loud is `failIfUnavailable`, which is carried alongside
 * rather than folded in.
 */
export function sandboxArrangement(found: ManagedSettings): SandboxDTO {
  if (found.kind === "unreadable") {
    return {
      state: "unknown",
      detail: `${MANAGED_SETTINGS_PATH} exists and could not be read (${found.problem}), so what confines a tool call here is not known`,
      failIfUnavailable: null,
    };
  }

  const sandbox = found.kind === "present" ? objectAt(found.json, "sandbox") : null;

  if (!sandbox || sandbox.enabled !== true) {
    return {
      state: "none",
      detail:
        "nothing confines an agent's commands below this container's own uid, " +
        "so every mount, the whole network and a concurrent run's checkout are " +
        "reachable from any run",
      failIfUnavailable: null,
    };
  }

  // Absent defaults to on — the binary rewrites `{enabled: true}` to carry
  // `failIfUnavailable: true` (`10-validation.md`, finding 16) — so reading a
  // missing key as off would report a refusal to start as a warning.
  const failIfUnavailable = sandbox.failIfUnavailable !== false;
  const loudness = failIfUnavailable
    ? "a sandbox that cannot start stops the CLI"
    : "a sandbox that cannot start is a warning and the command still runs";

  return policyNamesSomething(sandbox)
    ? {
        state: "on",
        detail: `enabled by ${MANAGED_SETTINGS_PATH}; ${loudness}`,
        failIfUnavailable,
      }
    : {
        state: "empty",
        detail: `enabled by ${MANAGED_SETTINGS_PATH}, but it names no path, domain or credential to confine, and a policy that resolves to nothing runs every command unwrapped; ${loudness}`,
        failIfUnavailable,
      };
}

/**
 * The read, on every call rather than memoised once at boot: the file is written
 * by the image and edited by hand on the host, and a page that reports a stale
 * reading of a policy is the failure this row exists to prevent.
 */
function readManagedSettings(): ManagedSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(MANAGED_SETTINGS_PATH, "utf8");
  } catch (err) {
    // The stock install, and the only case that is not a problem: no managed
    // policy at all. Anything else — a permission, a directory where a file
    // should be — is a file this app cannot vouch for and says so.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", problem: (err as Error).message };
  }

  try {
    return { kind: "present", json: JSON.parse(raw) };
  } catch (err) {
    return { kind: "unreadable", problem: (err as Error).message };
  }
}

/** What confines this install right now. */
export function currentSandbox(): SandboxDTO {
  return sandboxArrangement(readManagedSettings());
}
