import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openPullRequest, parseRemote, planDelivery } from "./delivery";

/**
 * The exit, and the three ways it could be wrong quietly.
 *
 * `parseRemote` decides WHERE something is published. Getting it wrong does not
 * throw — it opens a pull request on somebody else's repository, or refuses a
 * perfectly good remote because it was cloned over SSH rather than HTTPS.
 *
 * `planDelivery` decides WHETHER. Its dangerous failure is the permissive one:
 * a plan that said yes without a token produces a push that fails half-way,
 * and a plan that did not notice head === base opens a pull request with no
 * commits in it.
 */
describe("parseRemote reads both spellings and refuses the rest", () => {
  it("reads the HTTPS form, with and without .git", () => {
    for (const url of [
      "https://github.com/Xapicc/UsageFoundry",
      "https://github.com/Xapicc/UsageFoundry.git",
      "https://github.com/Xapicc/UsageFoundry/",
      "https://token@github.com/Xapicc/UsageFoundry.git",
    ]) {
      assert.deepEqual(parseRemote(url), { owner: "Xapicc", repo: "UsageFoundry" }, url);
    }
  });

  it("reads the SSH form, which is what a checkout cloned over SSH has", () => {
    for (const url of [
      "git@github.com:Xapicc/UsageFoundry.git",
      "git@github.com:Xapicc/UsageFoundry",
      "ssh://git@github.com/Xapicc/UsageFoundry.git",
    ]) {
      assert.deepEqual(parseRemote(url), { owner: "Xapicc", repo: "UsageFoundry" }, url);
    }
  });

  it("returns null for a remote that is not GitHub, rather than guessing", () => {
    for (const url of [
      "",
      "   ",
      "https://gitlab.com/x/y.git",
      "git@bitbucket.org:x/y.git",
      "/srv/git/local.git",
      "https://github.com/onlyowner",
    ]) {
      assert.equal(parseRemote(url), null, url);
    }
  });
});

describe("planDelivery refuses before anything leaves the machine", () => {
  const ok = {
    token: "t",
    remoteUrl: "https://github.com/o/r.git",
    branch: "uf/run-1",
    target: "main",
  };

  it("plans a delivery when everything is present", () => {
    const plan = planDelivery(ok);
    assert.equal(plan.ok, true);
    if (plan.ok) {
      assert.deepEqual(plan.remote, { owner: "o", repo: "r" });
      assert.equal(plan.head, "uf/run-1");
      assert.equal(plan.base, "main");
    }
  });

  it("refuses with no token, and says the one actionable thing", () => {
    const plan = planDelivery({ ...ok, token: "" });
    assert.equal(plan.ok, false);
    assert.match(plan.ok === false ? plan.reason : "", /UF_GITHUB_TOKEN/);
  });

  it("refuses when the branch is already the target", () => {
    // A pull request from main into main has no commits and GitHub answers 422.
    // Saying so here is a sentence; discovering it there is a failed push first.
    const plan = planDelivery({ ...ok, branch: "main" });
    assert.equal(plan.ok, false);
    assert.match(plan.ok === false ? plan.reason : "", /already on main/);
  });

  it("refuses a non-GitHub remote without calling it malformed", () => {
    const plan = planDelivery({ ...ok, remoteUrl: "https://gitlab.com/o/r.git" });
    assert.equal(plan.ok, false);
    assert.match(plan.ok === false ? plan.reason : "", /not a GitHub remote/);
  });

  it("refuses a run with no branch or no target", () => {
    assert.equal(planDelivery({ ...ok, branch: null }).ok, false);
    assert.equal(planDelivery({ ...ok, target: null }).ok, false);
  });
});

describe("openPullRequest reports GitHub's answer rather than its own", () => {
  const args = {
    remote: { owner: "o", repo: "r" },
    head: "uf/x",
    base: "main",
    title: "t",
    body: "b",
    token: "tok",
  };
  const reply = (status: number, payload: unknown) =>
    (async () =>
      new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;

  it("returns the pull request on success", async () => {
    const out = await openPullRequest({
      ...args,
      fetchImpl: reply(201, { number: 7, html_url: "https://github.com/o/r/pull/7" }),
    });
    assert.deepEqual(out, { ok: true, pr: { number: 7, url: "https://github.com/o/r/pull/7" } });
  });

  it("carries GitHub's own message when it refuses", async () => {
    const out = await openPullRequest({
      ...args,
      fetchImpl: reply(422, { message: "Validation Failed", errors: [{ message: "No commits between main and uf/x" }] }),
    });
    assert.equal(out.ok, false);
    assert.match(out.ok === false ? out.reason : "", /No commits between/);
  });

  it("treats an already-open pull request as the state that was wanted", async () => {
    const out = await openPullRequest({
      ...args,
      fetchImpl: reply(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for o:uf/x." }] }),
    });
    assert.equal(out.ok, false);
    assert.match(out.ok === false ? out.reason : "", /already open/);
  });

  it("says the network failed rather than that GitHub refused", async () => {
    const out = await openPullRequest({
      ...args,
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND api.github.com");
      }) as unknown as typeof fetch,
    });
    assert.equal(out.ok, false);
    assert.match(out.ok === false ? out.reason : "", /could not be reached/);
  });
});
