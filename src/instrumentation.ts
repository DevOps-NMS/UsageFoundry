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
    // Before anything else, and before the reconcile guard below, so a dev
    // server that re-evaluates this module says it again: an install with no
    // `UF_AUTH_TOKEN` serves every route in this app to anyone who can reach
    // the port, and the whole of what was wrong with that was that nothing
    // anywhere said so. Read from `process.env` rather than through
    // `lib/config` so the refusal cannot be delayed behind a module that
    // touches the filesystem.
    const { authBootSignal } = await import("./lib/authGuard");
    const signal = authBootSignal({
      token: process.env.UF_AUTH_TOKEN ?? "",
      allowNoAuth: process.env.UF_ALLOW_NO_AUTH ?? "",
    });
    if (signal.kind === "refused") {
      console.error(signal.message);
      // Exit rather than throw. A rejected `register()` is logged by Next and
      // the server carries on listening, which is precisely the state this
      // refusal exists to make unreachable.
      process.exit(1);
    }
    if (signal.kind === "unauthenticated") console.warn(signal.message);

    const g = globalThis as unknown as { __ufReconciled?: boolean };
    if (g.__ufReconciled) return;
    g.__ufReconciled = true;

    // Before anything opens the database or claims the directory it lives in.
    // `configCheck.ts` carries the reasoning for which of these refuses and
    // which warns; what is decided here is only what a refusal *does*.
    //
    // It exits rather than throwing. A rejected `register()` is logged by Next
    // and the server then serves anyway, which for a `DATA_DIR` this process
    // cannot write — or one it was never given — means a container that answers
    // /login and writes every row to a file the next rebuild deletes. Exiting
    // is what makes "refuses to start" true; `restart: unless-stopped` turns it
    // into a visible restart loop with this message at the top of every attempt,
    // which is louder than any log line and is the point.
    const { configProblems } = await import("./lib/configCheck");
    const problems = configProblems();
    for (const p of problems.filter((x) => x.severity === "warn")) {
      console.warn(`[usagefoundry] Configuration: ${p.message}`);
    }
    const refusals = problems.filter((p) => p.severity === "refuse");
    if (refusals.length > 0) {
      for (const p of refusals) {
        console.error(`[usagefoundry] Refusing to start. ${p.message}`);
      }
      process.exit(1);
    }

    const { backfillTaskSignatures, reconcileOnBoot, shutdownRuns } =
      await import("./lib/orchestrator");

    // Once, at boot, and idempotent. Without it the relative cost guard is
    // silent on an install that already has the history to speak from - which
    // is the operator most likely to try the feature and conclude it does
    // nothing. Bounded, so a very large `runs` table costs one bounded pass
    // per boot rather than one long one.
    const backfilled = backfillTaskSignatures();
    if (backfilled) {
      console.log(
        `[usagefoundry] gave ${backfilled} existing run(s) a task signature, ` +
          `so the relative cost guard can read their history.`,
      );
    }

    // Which arrangement this install is in, said once, before anything spawns.
    // The unseparated case is a *silent* absence of a boundary — the app looks
    // and behaves identically — and an operator who has pinned `user:` back to
    // their own uid, or who runs this outside the container, has no other way
    // to find out that `/proc`, `DATA_DIR` and the capability file are reachable
    // by every agent. A misconfiguration throws instead, out of this same call,
    // so it stops the boot rather than the first run.
    // The sandbox line beside it says the other half of the same question —
    // which uid a child runs as, and then what confines what it may touch. It
    // reads "none" today and is here anyway, because that is the reading an
    // operator has to be able to see; a line that only appears once a sandbox
    // exists says nothing at all about the installs that have none.
    const { describeSeparation, describeSandbox } = await import("./lib/privsep");
    console.warn(`[usagefoundry] ${describeSeparation()}`);
    console.warn(`[usagefoundry] ${describeSandbox()}`);

    // Every reconciler below reads "this row says running, therefore the
    // process that owned it died with my predecessor". That inference is only
    // available to the server that owns this data directory, and it stopped
    // being true the day an agent ran `npm run dev` inside a worktree of this
    // app: `next dev` runs this very file, inherited DATA_DIR pointed it at the
    // live database, and it closed out three runs whose agents were mid-cycle
    // and went on working for another minute. So the claim gates all four,
    // rather than each of them re-deriving it.
    const { claimDataDir, ownsDataDir, releaseDataDir } = await import(
      "./lib/serverLock"
    );
    await claimDataDir();

    // `ownsDataDir()` rather than the boolean `claimDataDir` just returned.
    // They agree here — nothing can take the directory in the microtask between
    // them — and the point is that ownership is a thing this app *asks*, at the
    // moment it acts on it, everywhere. A captured boot-time answer was how the
    // heartbeat came to restamp a lock that had changed hands.
    if (ownsDataDir()) {
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

      // The same rule for the other clock in this app. Dreaming's cursor is a
      // night rather than an instant, and a boot moves it to the current night
      // whatever it finds — so a server coming back at noon writes nothing
      // about a 03:04 that passed while it was down. Its timer is started here
      // for the schedules' reason: two processes deciding one night would point
      // two agents at one vault, and the vault has no version control behind it.
      const { reconcileDreamingOnBoot, startDreaming } = await import("./lib/dreamingRun");
      reconcileDreamingOnBoot();
      startDreaming();

      // And the one sweep that deletes rather than reconciles. Gated on the
      // same claim as everything above, for a reason of its own: it decides
      // what is safe to discard from the *live* state — which runs have
      // settled, which checkouts nothing holds — and a process that does not
      // own this directory is reading another server's answers to both.
      const { startRetentionSweeper } = await import("./lib/retention");
      startRetentionSweeper();
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
    //
    // It is `await`ed now, and that is the change: this used to be
    // `killAllAgents(sig)` and `process.exit(0)` on the next line, so not one
    // of the suspended `startRun` frames ever resumed and nothing after
    // `await runIteration(...)` ever ran. Every in-flight cycle's spend went
    // with it — `reconcileKilledCycle` exists for exactly that and was
    // unreachable from here — along with the two columns saying a cycle is open.
    // `shutdownRuns` is bounded (`SHUTDOWN_GRACE_MS`) and returns as soon as
    // nothing is left in flight, so an idle server still exits at once.
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        void (async () => {
          try {
            const { closed, recovered } = await shutdownRuns(sig);
            if (closed > 0) {
              console.warn(
                `[usagefoundry] Stopped ${closed} run(s) on ${sig}; recovered the ` +
                  `spend of ${recovered} interrupted work cycle(s). They are on the ` +
                  "runs page, and can be picked up together.",
              );
            }
          } catch (err) {
            // A shutdown that cannot account for its cycles still has to be a
            // shutdown. Reported rather than swallowed, because the alternative
            // is a container that hangs until Docker's grace period kills it.
            console.error("[usagefoundry] Shutdown reconciliation failed:", err);
          } finally {
            // Hand the directory back explicitly. Without this the next boot —
            // which for `restart: unless-stopped` is immediate — finds a lock
            // that is still inside its stale window and has to watch a dead pid
            // for four seconds before it may reconcile anything.
            releaseDataDir();
            process.exit(0);
          }
        })();
      });
    }
  }
}
