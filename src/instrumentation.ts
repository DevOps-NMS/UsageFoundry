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

    const { reconcileOnBoot } = await import("./lib/orchestrator");
    reconcileOnBoot();
  }
}
