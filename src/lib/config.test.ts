import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MOUNTED_WORKSPACE_SLOTS, unmountedWorkspaceRefusal } from "./config";

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
