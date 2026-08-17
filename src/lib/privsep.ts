import fs from "node:fs";
import { currentSandbox } from "./sandbox";

/**
 * Which uid the children run as, and why it is not the server's.
 *
 * Everything this app spawns — the work cycle, the reviewer, the chat, an
 * orchestrator block's turn, and every git this app runs on its own behalf —
 * used to run as the same uid as the server. That made three separate defences
 * decorative at once, because all three are file modes and a mode says nothing
 * to the process that owns the file:
 *
 *   - `childEnv` deletes `UF_*`, `ANTHROPIC_ADMIN_KEY` and `DATA_DIR` from the
 *     child's environment, and `/proc/<server pid>/environ` handed every one of
 *     them straight back. That file is mode 0400 owned by the *server's* uid,
 *     so the strip is enforceable exactly when the child is a different uid.
 *   - `/data` held the database, the settings the guards read and the lock
 *     `serverLock.ts` uses to decide whether a second writer exists. An agent
 *     that can write it can rewrite a budget, a status or a permission mode
 *     with no HTTP request and no token.
 *   - the MCP capability file is written 0600, which excludes nobody at all
 *     when the reader is the owner.
 *
 * So the container starts as root and the server stays root, while every child
 * is dropped to `UF_AGENT_UID`/`UF_AGENT_GID` — which compose fills from the
 * operator's own `UF_UID`/`UF_GID`, i.e. the uid that owns the bind mounts.
 * That direction is forced rather than chosen. The child must be the uid that
 * owns the workspace, because an isolated run is *ordered* to commit and its
 * commits land in the operator's own `<repo>/.git`; and the server must be able
 * to read `~/.claude/.credentials.json`, which the CLI keeps at 0600 owned by
 * that same uid. Two processes, one of which must be the mount owner and the
 * other of which must out-rank it: the server is therefore root, and the
 * privileged half is the one this app wrote rather than the twenty-five
 * unattended agents reading repository content nobody here reviewed.
 *
 * What this does *not* buy is written down beside it in `docs/security.md`: the
 * child is still the uid that owns `~/.claude`, so a work cycle can still read
 * the account's own OAuth credential — it has to, that credential is what it
 * bills against.
 *
 * **The third defence needed a second cut, and it is a gid rather than a uid.**
 * Moving the MCP capability file out of `/tmp` closed enumeration and nothing
 * else: `--mcp-config <path>` is an argv element, `/proc/<pid>/cmdline` is
 * world-readable, and a work-cycle agent that reads the path out of a sibling's
 * command line was handed a file its own uid owned. A second *uid* for the chat
 * would need a second Claude credential to authenticate as, which a
 * subscription install does not have. A second *gid* needs nothing: the chat and
 * block child keeps `UF_AGENT_UID`, so it still bills against the same account
 * and still writes the operator's files as the uid they expect, while the
 * per-turn directory and file are handed to `UF_CHAT_GID` and mode 0710/0040 —
 * so a work-cycle agent fails the owner check (root), fails the group check (it
 * is not in that group), and is left with the "other" bits, which are zero.
 * `resolveChatGid` is that decision, and it is separate from the pair above
 * because it is inert on its own: a gid sharpens a boundary the uid split makes,
 * and without that split there is nothing to sharpen.
 *
 * Inert unless the server is actually root. `npm run dev` on a laptop, the test
 * suite, and a container an operator has pinned back to `user: "1000:1000"` all
 * get today's behaviour, because `setuid` needs a privilege none of them has.
 * The last of those three is a *silent* loss of a boundary, which is the shape
 * of failure this codebase refuses to ship, so it is the one case that throws:
 * an environment that names an agent uid the process cannot switch to is a
 * misconfiguration, not a degradation.
 */

/** The identity a spawned child runs under. Both halves, never just the uid. */
export interface ChildCredentials {
  uid: number;
  gid: number;
}

function parseId(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `${name} must be a numeric id; got ${JSON.stringify(raw)}. ` +
        `docker-compose.yml fills it from UF_UID/UF_GID.`,
    );
  }
  return n;
}

/**
 * The decision, separated from the environment that feeds it.
 *
 * Pure and unit-tested because both ways of getting it wrong are silent in
 * opposite directions: credentials the process cannot apply fail every spawn
 * with EPERM, and no credentials at all is a container that looks separated on
 * the page and shares one uid in fact. The gid is required rather than defaulted
 * to the uid for the same reason — libuv sets gid and uid and never calls
 * `setgroups`, so a child that is handed no gid keeps root's group 0.
 *
 * @param serverUid `process.getuid?.() ?? null` — null on a platform with no uids.
 */
export function resolveChildCredentials(o: {
  serverUid: number | null;
  agentUid: string | undefined;
  agentGid: string | undefined;
}): ChildCredentials | null {
  const wanted = (o.agentUid ?? "").trim();
  // Nothing asked for. This is `npm run dev`, the test suite, and any
  // deployment predating the split: one uid, exactly as before.
  if (!wanted) return null;

  const uid = parseId(wanted, "UF_AGENT_UID");
  // Root asked for, so there is no boundary to build: dropping a child to the
  // server's own identity is the arrangement the split replaced. This is not a
  // typo to refuse — compose fills it from `UF_UID`, and an operator whose host
  // uid really is 0 has root-owned bind mounts and no separable uid to run an
  // agent as. Refusing would take a working install down over something they
  // cannot change; `describeSeparation()` says the boundary is absent instead.
  if (uid === 0) return null;

  const gidRaw = (o.agentGid ?? "").trim();
  if (!gidRaw) {
    throw new Error(
      "UF_AGENT_UID is set but UF_AGENT_GID is not. A child spawned with a uid " +
        "and no gid keeps the server's groups, which on this image is group 0.",
    );
  }
  const gid = parseId(gidRaw, "UF_AGENT_GID");

  if (o.serverUid !== 0) {
    throw new Error(
      `UF_AGENT_UID asks for children to run as uid ${uid}, but this server is ` +
        `uid ${o.serverUid ?? "unknown"} and cannot switch to another. Either ` +
        `run the container as root (docker-compose.yml's user: "0:0"), or ` +
        `clear UF_AGENT_UID and accept that agents share the server's uid.`,
    );
  }

  return { uid, gid };
}

/**
 * The gid a chat or orchestrator-block child runs under, when it is not the
 * agents' — or null for "one group for every child", which is what every
 * install had before this existed.
 *
 * Pure and unit-tested for the same reason `resolveChildCredentials` is: the way
 * this fails is that the capability file is handed to a group every agent is
 * already in, which looks identical from the page, from the boot log and from
 * `ls -l`.
 *
 * Three refusals, and each is an environment asking for a boundary that would
 * not be one:
 *
 *   - **group 0.** That is the server's own group on this image, so the file
 *     would be handed back to the half of the split it is being kept from.
 *   - **the agents' own gid.** The mode pair would then grant exactly what it
 *     was written to refuse. This is why the shipped default is 65533 rather
 *     than 1001: a gid one above the operator's is a gid an operator plausibly
 *     already has, and a stock install must not refuse to boot on a host whose
 *     `UF_GID` happens to collide with a number this repository picked.
 *   - **a name where an id belongs**, as everywhere else here.
 *
 * @param separated what `resolveChildCredentials` decided, or null.
 */
export function resolveChatGid(o: {
  separated: ChildCredentials | null;
  chatGid: string | undefined;
}): number | null {
  // No uid split, so every child is the server's uid and a gid buys nothing: a
  // sibling reads what this process can write whatever group it carries. Not a
  // refusal, because compose sets this unconditionally and an install with
  // `UF_UID=0` — no separable uid to run an agent as — is entitled to boot.
  if (!o.separated) return null;

  const wanted = (o.chatGid ?? "").trim();
  // Nothing asked for: the chat's config is chowned to the agents as it was, and
  // `describeSeparation()` says the capability is reachable by a sibling.
  if (!wanted) return null;

  const gid = parseId(wanted, "UF_CHAT_GID");
  if (gid === 0) {
    throw new Error(
      "UF_CHAT_GID is 0, which is the server's own group on this image. A " +
        "capability file handed to group 0 is one the server's own children " +
        "can read. Name a group no agent is in, or clear it.",
    );
  }
  if (gid === o.separated.gid) {
    throw new Error(
      `UF_CHAT_GID is ${gid}, which is the gid every agent already runs as ` +
        `(UF_AGENT_GID). The MCP capability file would be handed to the group ` +
        `it is being kept from. Name a different group, or clear UF_CHAT_GID ` +
        `and accept that a concurrent agent can read a live capability.`,
    );
  }
  return gid;
}

let decided = false;
let credentials: ChildCredentials | null = null;
let chatGidDecided = false;
let chatGid: number | null = null;

/**
 * The credentials, decided once. Throws on a misconfiguration, every time it is
 * asked, so a run fails loudly rather than starting an agent with the server's
 * authority.
 */
function separation(): ChildCredentials | null {
  if (!decided) {
    credentials = resolveChildCredentials({
      serverUid: process.getuid?.() ?? null,
      agentUid: process.env.UF_AGENT_UID,
      agentGid: process.env.UF_AGENT_GID,
    });
    decided = true;
  }
  return credentials;
}

/** The chat gid, decided once, on the same terms as `separation()`. */
function chatSeparation(): number | null {
  if (!chatGidDecided) {
    chatGid = resolveChatGid({
      separated: separation(),
      chatGid: process.env.UF_CHAT_GID,
    });
    chatGidDecided = true;
  }
  return chatGid;
}

/** Is a child a different uid from this process? */
export function privilegeSeparated(): boolean {
  return separation() !== null;
}

/**
 * Spread into `spawn`/`spawnSync` options at every site that starts a child.
 *
 * `{}` when there is no separation, so the call is unchanged on a laptop and in
 * the tests. Every spawn site in the app takes this — `orchestrator.ts`'s work
 * cycle, `review.ts`, both of `chat.ts`'s, and both of `git.ts`'s. The git ones
 * are not an afterthought: they write into the operator's own repository, so a
 * root git would leave root-owned objects in a tree the operator has to be able
 * to use afterwards.
 */
export function childCredentials(): { uid?: number; gid?: number } {
  const c = separation();
  return c ? { uid: c.uid, gid: c.gid } : {};
}

/**
 * The same, for the one child that is not a work cycle: the orchestrator chat
 * and a workflow's orchestrator block, which share `runOrchestratorChild`.
 *
 * Identical uid, deliberately — it authenticates with the same `~/.claude` and
 * writes the same mounts, so a different uid would need a second Claude
 * credential — and a different gid, which is the whole of what keeps a
 * work-cycle agent out of this turn's capability file.
 *
 * What makes that hold is the same libuv behaviour called out above: `setgid`
 * and `setuid` are called and `setgroups` never is, so a child's group set is
 * the gid handed here plus whatever *supplementary* groups this process already
 * carries — which on this image is root's, and root is in no group but 0.
 * Neither side is therefore in the other's group, which is what makes the
 * 0710/0040 pair in `mcpConfigOwnership` decide anything. An image that gave the
 * server supplementary membership of either group would undo it silently.
 */
export function chatChildCredentials(): { uid?: number; gid?: number } {
  const c = separation();
  if (!c) return {};
  return { uid: c.uid, gid: chatSeparation() ?? c.gid };
}

/** How a turn's MCP config is owned, when there is a group to own it. */
export interface McpConfigOwnership {
  /** The group the per-turn directory and the config file are handed to. */
  gid: number;
  /** 0710: the chat child traverses by group. Nothing else resolves a name. */
  dirMode: number;
  /**
   * 0040: group read, and *nothing* for the owner.
   *
   * The owner is root, which ignores these bits entirely, so a 0440 here would
   * suggest the owner bit was doing work that the kernel never consults. What
   * decides is the group, and it is the only thing set.
   */
  fileMode: number;
}

/**
 * The ownership a turn's MCP config takes, or null for "as the agents own it".
 *
 * Null in two cases that are one case: no uid split (nothing to defend against
 * — a sibling is this process's own uid), and a uid split with no chat gid
 * (`UF_CHAT_GID` cleared, which `describeSeparation()` states). Both leave
 * `chat.ts` on its previous behaviour rather than half-applying a boundary.
 */
export function mcpConfigOwnership(): McpConfigOwnership | null {
  if (!separation()) return null;
  const gid = chatSeparation();
  return gid === null ? null : { gid, dirMode: 0o710, fileMode: 0o040 };
}

/**
 * Hand a path the server created to a group, leaving its owner alone.
 *
 * The counterpart to `chownForChild` for the one thing the child must read and
 * must not own: owning it is what let a *sibling* open it, because every child
 * this app spawns is one uid.
 */
export function chownToGroup(target: string, gid: number): void {
  fs.chownSync(target, process.getuid?.() ?? 0, gid);
}

/**
 * Hand a path the server created inside a bind mount to the uid that has to use
 * it afterwards.
 *
 * The server is root, so anything it writes into the workspace lands root-owned
 * and the agent — a different uid now — cannot touch it. Two places do that:
 * the `.uf-worktrees` store, and the gitignored config files `seedWorktree`
 * copies into a fresh checkout. Everything else in a worktree is written by git
 * running as the child, so it is already the right uid.
 *
 * It throws rather than warning. A failure here is a checkout the agent cannot
 * write, and that failure would otherwise arrive inside a tool call the run loop
 * does not read — the run would simply not do the work.
 */
export function chownForChild(target: string): void {
  const c = separation();
  if (!c) return;
  fs.chownSync(target, c.uid, c.gid);
}

/** One line for the boot log, so an install states which arrangement it is in. */
export function describeSeparation(): string {
  const c = separation();
  if (!c) {
    return (
      "privilege separation off: children share this process's uid, so /proc, " +
      "DATA_DIR and the MCP capability file are reachable by every agent"
    );
  }
  const gid = chatSeparation();
  // The chat gid is named either way. Absent, it is the one part of the split
  // that is missing, and a line that only mentioned what is on would read as a
  // complete boundary — which is how the /tmp defect survived a review.
  const chat =
    gid === null
      ? ", chat and block turns in the agents' own group (UF_CHAT_GID unset, so " +
        "a concurrent agent can read a live MCP capability)"
      : `, chat and block turns as ${c.uid}:${gid}`;
  return (
    `privilege separation on: children run as ${c.uid}:${c.gid}` +
    chat +
    `, server as ${process.getuid?.() ?? "?"}`
  );
}

/**
 * The second line of the same boot statement: whether anything confines what a
 * child may touch, as opposed to which uid it touches it as.
 *
 * A sandbox has the property the uid split has, which is why it is said here and
 * not left to be noticed. Absent, it costs nothing visible — every page renders
 * the same, every run works, and the only difference is how far a
 * prompt-injected agent gets past the task it was given. A boundary that
 * disappears quietly is the shape of failure this codebase says out loud.
 *
 * Its own function rather than a clause inside `describeSeparation()` because
 * the two are independent: an install can have either without the other, and
 * what a later change fills in is this sentence alone, where a clause would mean
 * editing one `docs/security.md` quotes verbatim.
 *
 * Nothing in this app wraps a child in `bwrap`. What it does do is name each
 * child's write set on the argv — `sandboxSettings` in `orchestrator.ts` — and
 * that is a *narrowing* of a policy rather than a policy: it configures a
 * sandbox the managed file switched on, and is withheld entirely on an install
 * whose reading is `none`. So on a stock install the sentence is still that
 * there is no sandbox, and nothing about a tool call is bounded below the
 * container's own uid there: `--add-dir` names every mount, a `Bash` call is not
 * bounded by its cwd, and the checkout store holds every concurrent run's
 * worktree at one uid. What this line is no longer is a *constant*: the
 * arrangement is read rather than asserted, so an install that has been given a
 * managed policy says a different sentence than one that has not, which is the
 * whole of what it is for. `sandbox.ts` owns the reading and states what it does
 * not claim; the wording of each state lives there beside the reasoning for it.
 */
export function describeSandbox(): string {
  const { state, detail } = currentSandbox();
  return `sandbox: ${state === "empty" ? "enabled but empty" : state} — ${detail}`;
}
