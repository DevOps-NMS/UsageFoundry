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
    reconcileOnBoot();

    // Same problem, different table: a review is a child process too, and a row
    // left saying `running` would spin a progress indicator for ever. Called
    // from here rather than from inside `reconcileOnBoot` so that
    // `orchestrator.ts` does not have to import `review.ts`, which imports it.
    const { reconcileReviewsOnBoot } = await import("./lib/review");
    reconcileReviewsOnBoot();

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
        process.exit(0);
      });
    }
  }
}
