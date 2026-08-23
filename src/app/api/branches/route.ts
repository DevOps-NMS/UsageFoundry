import { branchInventory } from "@/lib/land";
import { getSettings } from "@/lib/settings";
import { jsonMaybeGzipped } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every branch this app has produced, across runs.
 *
 * The gap this fills: a branch is created per *run*, not per checkout slot, so
 * a few dozen runs leave a few dozen `uf/*` refs and the only record of which
 * ones mattered was a run detail page opened one at a time.
 *
 * Deliberately not polled by its page — the inventory costs a `rev-list` per
 * branch and nothing in it changes on its own. The merge queue is the one thing
 * on that page that does, and it has its own route.
 *
 * `repo` and `offset` are what make the whole set reachable rather than only its
 * newest page. They move *which* branches are paid for and never how many: the
 * per-request git cost is bounded by the same `MAX_INVENTORY` and
 * `MAX_PENDING_PROBES` whatever is asked for, which is why the answer carries a
 * `total` counted over every branch-bearing run rather than over a page.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const repo = params.get("repo");
  // Gzipped: 254,752 bytes to 75,613, measured. Not polled, but it is the one
  // response here whose size is set by how many branches a repository has
  // rather than by a page size — `MAX_INVENTORY` bounds the git work, not the
  // row count.
  return jsonMaybeGzipped(req, {
    ...(await branchInventory({
      // A blank `repo=` is every repository, not a repository named "". The
      // picker's own "All repositories" option submits exactly that.
      repo: repo ? repo : null,
      offset: Number(params.get("offset") ?? 0),
      limit: Number(params.get("limit") ?? 0),
    })),
    // Carried here so the queue form can default to it without a second
    // request. The queue still narrows whatever comes back on the wire.
    defaultStrategy: getSettings().landStrategy,
  });
}
