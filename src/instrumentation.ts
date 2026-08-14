/**
 * Boot hook. Runs once per server process, before the first request.
 *
 * Exists for restart recovery: a run that was in progress when the process died
 * still holds its folder in the database, and the folder claim would keep every
 * later run out of it until someone noticed.
 *
 * Next compiles this file for the edge runtime as well as node, so the import
 * has to be both dynamic *and* nested inside a positive `NEXT_RUNTIME` check —
 * that exact shape is what lets the bundler drop it from the edge build. An
 * early return instead leaves the import reachable, and webpack then tries to
 * resolve better-sqlite3's `node:fs` for the edge and fails.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const g = globalThis as unknown as { __ufReconciled?: boolean };
    if (g.__ufReconciled) return;
    g.__ufReconciled = true;

    const { reconcileOnBoot, killAllAgents } = await import("./lib/orchestrator");

    // Every reconciler below reads "this row says running, therefore the
    // process that owned it died with my predecessor". That inference is only
    // available to the server that owns this data directory, and it stopped
    // being true the day an agent ran `npm run dev` inside a worktree of this
    // app: `next dev` runs this very file, inherited DATA_DIR pointed it at the
    // live database, and it closed out three runs whose agents were mid-cycle
    // and went on working for another minute. So the claim gates all four,
    // rather than each of them re-deriving it.
    const { claimDataDir, releaseDataDir } = await import("./lib/serverLock");
    const owned = await claimDataDir();

    if (owned) {
      reconcileOnBoot();

      // Same problem, different table: a review is a child process too, and a
      // row left saying `running` would spin a progress indicator for ever.
      // Called from here rather than from inside `reconcileOnBoot` so that
      // `orchestrator.ts` does not have to import `review.ts`, which imports it.
      const { reconcileReviewsOnBoot } = await import("./lib/review");
      reconcileReviewsOnBoot();

      // And once more for the merge queue, where the rule is stricter than for
      // either of those: a queued merge is *cancelled*, never resumed. It writes
      // into the operator's own checkout, and a server coming back up and merging
      // four branches into the tree someone is working in is the one thing a
      // queue must never do by itself.
      const { reconcileMergeQueueOnBoot } = await import("./lib/mergeQueue");
      reconcileMergeQueueOnBoot();

      // The fourth child process, and the same rule as the first three: the chat
      // turn died with the process, so the row says so. Nothing is re-asked — a
      // chat turn is a question somebody put minutes ago, and answering it
      // unattended is spend nobody is present to want.
      const { reconcileChatsOnBoot } = await import("./lib/chat");
      reconcileChatsOnBoot();

      // Last, because it reads what the others left: a workflow instance the
      // process died half way through halting. `reconcileOnBoot` has already
      // closed out its running, queued and waiting members; a *paused* one
      // inside the resume grace period survives that on purpose, and without
      // this the sweeper would re-queue it under a workflow the page says is
      // stopped.
      const { reconcileBlocksOnBoot, reconcileHaltsOnBoot } = await import(
        "./lib/workflows"
      );
      // A block deciding what to start when the process died, and every block
      // behind it in an instance this boot left nothing alive in. Same rule as
      // a `waiting` run and for the same reason: what it was waiting for has
      // just been closed out, and re-deciding hours later, unattended, is spend
      // nobody is present to want. After `reconcileOnBoot` for a second reason
      // as well as the first: that pass keeps a recently `paused` member on
      // purpose, and this one mirrors that grace rather than overriding it, so
      // it has to be able to read what survived. Before the halt reconciler, so
      // what that one finds live is only the runs — a `stopping` instance's
      // blocks come down here whatever its members are doing.
      reconcileBlocksOnBoot();
      reconcileHaltsOnBoot();

      // And the schedules, which are the one thing here that would otherwise
      // start an agent *because* the server restarted. Every fire time that
      // passed while this process was not running is recorded as missed and the
      // cursor jumps to now — the queued-run rule and the queued-merge rule
      // arrived at from a third direction. It also starts the timer, gated on
      // the same claim as everything above: two servers firing one schedule is
      // one window pressed twice.
      const { reconcileSchedulesOnBoot } = await import("./lib/schedules");
      reconcileSchedulesOnBoot();
    } else {
      // Not "starting without closing anything out" any more, which read like a
      // benign notice on a process that then admitted runs and spawned billed
      // agents. This server is read-only for as long as it is up: every writer
      // asks `ownsDataDir()` at the moment it would write, and the same
      // sentence is on `/api/health` and above every page, because a warning
      // into a container's stdout is not a signal anybody receives.
      console.warn(
        "[usagefoundry] Another server process already holds this data " +
          "directory. This one is read-only: it serves every page, and refuses " +
          "to start, resume, merge or spend anything. Only one process may " +
          "write to a UsageFoundry data directory — it cannot be scaled to a " +
          "second replica. Stop the other server and restart this one if that " +
          "is not what you meant.",
      );
    }

    // Agents are spawned into their own process group so a kill reaches the
    // commands they started. That also takes them out of the terminal's
    // foreground group, so Ctrl-C during `npm run dev` no longer reaches them
    // on its own — without this, quitting the dev server would leave a real,
    // billed agent running. Under Docker the container cgroup already handles
    // it and this is redundant.
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        const n = killAllAgents(sig);
        if (n > 0) {
          console.warn(`[usagefoundry] Signalled ${n} running agent(s) on ${sig}.`);
        }
        // Hand the directory back explicitly. Without this the next boot — which
        // for `restart: unless-stopped` is immediate — finds a lock that is
        // still inside its stale window and has to watch a dead pid for four
        // seconds before it may reconcile anything.
        releaseDataDir();
        process.exit(0);
      });
    }
  }
}
