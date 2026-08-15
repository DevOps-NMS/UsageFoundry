import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MOUNTED_WORKSPACE_SLOTS,
  matchFolderKey,
  selectGithubToken,
  unmountedWorkspaceRefusal,
} from "./config";

/**
 * The refusal that stops a workspace slot from being configured and ignored.
 *
 * It earns a test on the same grounds every other pure function here does: the
 * failure it replaces is silent and reads as a different, ordinary state. A
 * fifth slot in `.env` is interpolated by nothing, so the directory is never
 * mounted and never reaches the picker — which is exactly what a mounted
 * directory with nothing in it looks like. The operator's evidence that their
 * configuration took effect is an empty list either way.
 */

describe("unmountedWorkspaceRefusal", () => {
  it("says nothing when compose mounted everything .env configured", () => {
    assert.equal(unmountedWorkspaceRefusal(""), null);
    // Compose emits the separator-only string when every `:+` is unset.
    assert.equal(unmountedWorkspaceRefusal("   "), null);
  });

  it("names the variable it cannot honour", () => {
    const refusal = unmountedWorkspaceRefusal("UF_WORKSPACE_5_NAME ");
    assert.ok(refusal, "a configured fifth slot must refuse the boot");
    assert.match(refusal, /UF_WORKSPACE_5_NAME/);
    // The count is the fact an operator has to act on, so it is in the sentence
    // rather than only in the file that enforces it.
    assert.match(refusal, new RegExp(`${MOUNTED_WORKSPACE_SLOTS} workspace slots`));
  });

  it("names every one of them, and reads as a list", () => {
    const refusal = unmountedWorkspaceRefusal(
      "UF_WORKSPACE_5_NAME UF_WORKSPACE_6_NAME UF_WORKSPACE_7_NAME ",
    );
    assert.ok(refusal);
    assert.match(refusal, /UF_WORKSPACE_5_NAME, UF_WORKSPACE_6_NAME, UF_WORKSPACE_7_NAME are set/);
  });

  it("tolerates whatever separator compose leaves behind", () => {
    // The forwarded value is assembled from four `:+` expansions, so the
    // separators depend on which of them expanded. Splitting on any run of
    // whitespace, comma or pipe means a change to that line cannot turn the
    // refusal into one variable named `UF_WORKSPACE_5_NAMEUF_WORKSPACE_6_NAME`.
    const refusal = unmountedWorkspaceRefusal("UF_WORKSPACE_5_NAME|UF_WORKSPACE_6_NAME");
    assert.ok(refusal);
    assert.match(refusal, /UF_WORKSPACE_5_NAME, UF_WORKSPACE_6_NAME/);
  });

  it("never repeats a value — only names travel", () => {
    // Compose forwards names, not paths. Pinned because the obvious "improvement"
    // is to forward the value so the message can quote the directory, which puts
    // a host path into a boot error and into every log that scrapes one.
    const refusal = unmountedWorkspaceRefusal("UF_WORKSPACE_5_NAME");
    assert.ok(refusal);
    assert.doesNotMatch(refusal, /\/home\/|\/Users\//);
  });
});

/**
 * Which GitHub credential a child working in a given repository is handed.
 *
 * There was one token for the whole install and every agent got it, so a run
 * told to fix a test in one repository held a credential that could force-push
 * to the other fourteen. Nothing downstream can see that go wrong: the push
 * succeeds, the run completes, and the only evidence is a commit in somebody
 * else's history — which is the bar every pure function in this suite clears.
 */
describe("selectGithubToken", () => {
  const mounts = [
    { id: "work", label: "Work", path: "/workspace" },
    { id: "notes", label: "Notes", path: "/workspace2" },
  ];
  const install = "ghp_install";

  it("hands a run the token its own repository is configured with", () => {
    const perRepo = new Map([
      ["acme/web", "ghp_web"],
      ["acme/api", "ghp_api"],
    ]);
    const web = selectGithubToken("/workspace/acme/web", perRepo, install, mounts);
    assert.deepEqual(web, { token: "ghp_web", scope: "repository", key: "acme/web" });

    // The whole finding, stated as an assertion: A's environment must not carry
    // B's credential.
    assert.notEqual(web.token, perRepo.get("acme/api"));
    assert.equal(
      selectGithubToken("/workspace/acme/api", perRepo, install, mounts).token,
      "ghp_api",
    );
  });

  it("keeps the install-wide token for a folder nothing names", () => {
    // What makes an existing deployment's behaviour exactly what it was: with
    // no map at all, every folder takes this path.
    assert.deepEqual(selectGithubToken("/workspace/other", new Map(), install, mounts), {
      token: install,
      scope: "install",
      key: null,
    });
    assert.equal(
      selectGithubToken("/workspace/other", new Map([["acme/web", "ghp_web"]]), install, mounts)
        .scope,
      "install",
    );
  });

  it("reads an entry with no token as 'this repository gets none'", () => {
    // The narrowest thing an operator can write must not be the widest thing it
    // does: falling through to the install-wide token here would make an
    // explicit exclusion into a grant.
    const perRepo = new Map([["acme/secret", ""]]);
    assert.deepEqual(selectGithubToken("/workspace/acme/secret", perRepo, install, mounts), {
      token: "",
      scope: "none",
      key: "acme/secret",
    });
  });

  it("hands nothing over when nothing is configured at all", () => {
    assert.deepEqual(selectGithubToken("/workspace/acme/web", new Map(), "", mounts), {
      token: "",
      scope: "none",
      key: null,
    });
  });

  it("covers a subdirectory of a configured repository", () => {
    // A run's folder can be inside the repository rather than its root, and a
    // credential that stopped applying one directory down would be a run in the
    // same repository authenticating as the whole install.
    const perRepo = new Map([["acme/web", "ghp_web"]]);
    assert.equal(
      selectGithubToken("/workspace/acme/web/packages/api", perRepo, install, mounts).token,
      "ghp_web",
    );
  });

  it("takes a key absolute as well as relative to a mount", () => {
    const perRepo = new Map([["/workspace2/scratch", "ghp_scratch"]]);
    assert.equal(
      selectGithubToken("/workspace2/scratch", perRepo, install, mounts).token,
      "ghp_scratch",
    );
  });

  it("gives a child with no repository the install-wide token", () => {
    // The orchestrator chat roams every mount by design, so there is no
    // repository to narrow to. Narrowing it to a cwd would withhold the
    // credential from every question about a repository it had not been
    // pointed at yet.
    assert.equal(selectGithubToken(null, new Map([["acme/web", "x"]]), install, mounts).scope, "install");
  });
});

describe("matchFolderKey", () => {
  const mounts = [{ id: "work", label: "Work", path: "/workspace" }];

  it("prefers the longest key, so a parent is a default and not a verdict", () => {
    const keys = ["acme", "acme/web"];
    assert.equal(matchFolderKey("/workspace/acme/api", keys, mounts), "acme");
    assert.equal(matchFolderKey("/workspace/acme/web", keys, mounts), "acme/web");
  });

  it("compares case-folded, because these are paths a person typed", () => {
    assert.equal(matchFolderKey("/workspace/Acme/Web", ["acme/web"], mounts), "acme/web");
  });

  it("does not match a sibling whose name merely starts the same", () => {
    // Segment-wise rather than by prefix: `acme/web` must not claim
    // `acme/web-legacy`, which is a different repository with a different token.
    assert.equal(matchFolderKey("/workspace/acme/web-legacy", ["acme/web"], mounts), null);
  });
});
