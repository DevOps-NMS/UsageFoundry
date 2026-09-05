import { GITHUB_TOKEN } from "./config";

/**
 * The exit this app does not have.
 *
 * ## What is missing
 *
 * An agent finishes and its branch is a local `uf/*` ref. The operator's only
 * route to getting that work anywhere is **Land**, which merges it into their
 * own checkout on the recorded target branch and requires that checkout to be
 * clean and standing on the target. There is no other exit: `grep` over `src/`
 * for `git push`, `gh pr create` and `createPullRequest` returns prose only.
 *
 * So the app's premise — work happens while nobody watches — stops one step
 * short of being true. The work happens, and then a person has to be present,
 * at that machine, with that checkout in that state, to move it.
 *
 * ## Why this is a press and never a policy
 *
 * Delivery is the one thing here that leaves the machine, and an outward-facing
 * action taken by a loop is a different product from one taken by a person. So
 * there is no "deliver on success" setting, no schedule, and nothing in the run
 * loop calls this: it is reached by one endpoint, on one run, on one press.
 *
 * It also never force-pushes and never deletes. The remote is somebody's, the
 * branch name is derived from the run, and the failure this refuses to have is
 * the one where an app that was asked to publish a branch quietly rewrote one.
 *
 * ## The credential is the one that already exists
 *
 * `UF_GITHUB_TOKEN` is documented as the agent's push credential and
 * `githubEnv()` already builds the git config that uses it. Nothing new enters
 * the trust boundary here; what changes is that the *app* can now use a
 * capability its children already had. With the variable unset this whole
 * module refuses, which is the honest default for a feature that publishes.
 */

export type Remote = { owner: string; repo: string };

const SSH = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/;
const HTTPS = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/;

/**
 * Read an owner and repository out of a git remote URL.
 *
 * Both spellings, because `githubEnv` rewrites `git@github.com:` to the https
 * form for the credential helper and a checkout can be configured either way —
 * so a parser that knew one of them would work until somebody cloned over SSH.
 *
 * Returns null rather than throwing, and null means "not a GitHub remote",
 * which is a thing to say to an operator rather than an error: a GitLab remote
 * is not a malformed one.
 */
export function parseRemote(url: string): Remote | null {
  const text = (url ?? "").trim();
  if (!text) return null;
  const m = SSH.exec(text) ?? HTTPS.exec(text);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo || repo.includes("/")) return null;
  return { owner, repo };
}

export type DeliveryPlan =
  | { ok: true; remote: Remote; head: string; base: string }
  | { ok: false; reason: string };

/**
 * Whether this run can be delivered, and where to.
 *
 * Pure, and every refusal here is one an operator should read rather than one
 * they should discover from a failed push. The order is deliberate: the
 * credential first, because without it nothing else matters and the message is
 * the only actionable one in the list.
 */
export function planDelivery(o: {
  token: string;
  remoteUrl: string;
  branch: string | null;
  target: string | null;
}): DeliveryPlan {
  if (!o.token) {
    return {
      ok: false,
      reason:
        "No UF_GITHUB_TOKEN is set, so this install cannot publish anything. " +
        "Set it in .env and restart to enable delivery.",
    };
  }
  if (!o.branch) {
    return { ok: false, reason: "This run has no branch to deliver." };
  }
  if (!o.target) {
    return { ok: false, reason: "This run has no recorded target branch to open against." };
  }
  if (o.branch === o.target) {
    return {
      ok: false,
      reason:
        `This run's work is already on ${o.target}; there is nothing to open a ` +
        `pull request from.`,
    };
  }
  const remote = parseRemote(o.remoteUrl);
  if (!remote) {
    return {
      ok: false,
      reason:
        `\`${o.remoteUrl || "origin"}\` is not a GitHub remote, and GitHub is ` +
        `the only forge this knows how to open a pull request on. The branch ` +
        `can still be pushed by hand.`,
    };
  }
  return { ok: true, remote, head: o.branch, base: o.target };
}

export type PullRequest = { number: number; url: string };

/**
 * Open the pull request, or say why GitHub would not.
 *
 * Separated from the push so a branch that is already on the remote can have a
 * pull request opened without pushing again, which is the ordinary second press
 * after a first attempt failed at this step rather than the one before it.
 *
 * A 422 with "already exists" is reported as success with the existing pull
 * request, because from the operator's side pressing twice should not be an
 * error — the thing they wanted is true.
 */
export async function openPullRequest(o: {
  remote: Remote;
  head: string;
  base: string;
  title: string;
  body: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; pr: PullRequest } | { ok: false; reason: string }> {
  const token = o.token ?? GITHUB_TOKEN;
  if (!token) return { ok: false, reason: "No UF_GITHUB_TOKEN is set." };
  const doFetch = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(
      `https://api.github.com/repos/${o.remote.owner}/${o.remote.repo}/pulls`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "UsageFoundry",
        },
        body: JSON.stringify({
          title: o.title,
          body: o.body,
          head: o.head,
          base: o.base,
        }),
      },
    );
  } catch (err) {
    return {
      ok: false,
      reason: `GitHub could not be reached: ${
        err instanceof Error ? err.message : String(err)
      }.`,
    };
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const payload = parsed as {
    number?: number;
    html_url?: string;
    message?: string;
    errors?: { message?: string }[];
  };
  if (res.ok && payload.number && payload.html_url) {
    return { ok: true, pr: { number: payload.number, url: payload.html_url } };
  }
  const detail =
    payload.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
    payload.message ||
    `HTTP ${res.status}`;
  if (res.status === 422 && /already exists/i.test(detail)) {
    return {
      ok: false,
      reason:
        "A pull request for this branch is already open. GitHub will not open " +
        "a second one, which is the state you were asking for.",
    };
  }
  return { ok: false, reason: `GitHub refused to open the pull request: ${detail}` };
}
