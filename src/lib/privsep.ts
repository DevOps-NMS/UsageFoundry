import fs from "node:fs";

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
 * bills against — and every child shares one uid, so a capability minted for
 * one of them is reachable by a sibling that knows where to look.
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

let decided = false;
let credentials: ChildCredentials | null = null;

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
  return c
    ? `privilege separation on: children run as ${c.uid}:${c.gid}, server as ${process.getuid?.() ?? "?"}`
    : "privilege separation off: children share this process's uid, so /proc, " +
        "DATA_DIR and the MCP capability file are reachable by every agent";
}
