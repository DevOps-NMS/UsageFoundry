import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePluginManifest, pluginDirArgs } from "./plugins";

/**
 * Two pure functions, both earning a test the same way: their failure is
 * silent. A manifest wrongly accepted yields a plugin the page reports as
 * enabled and the CLI ignores, and a malformed argv fragment changes what a
 * spawn is permitted to do without changing anything visible.
 */

describe("pluginDirArgs", () => {
  it("emits nothing at all for an empty list", () => {
    // The failure this pins is not cosmetic. A bare `--plugin-dir` with no
    // value takes the *next* argv entry as its path, which in `buildArgs` is
    // whatever flag follows — so an install with no plugins enabled would hand
    // the run a permission mode nobody chose.
    assert.deepEqual(pluginDirArgs([]), []);
    assert.deepEqual(pluginDirArgs([""]), []);
  });

  it("repeats the flag per directory rather than joining them", () => {
    // `claude --help`: "repeatable: --plugin-dir A --plugin-dir B". A joined
    // list is accepted as a single path that does not exist, and a plugin path
    // that does not exist is skipped with a warning and exit 0.
    assert.deepEqual(pluginDirArgs(["/workspace/a", "/workspace/b"]), [
      "--plugin-dir",
      "/workspace/a",
      "--plugin-dir",
      "/workspace/b",
    ]);
  });

  it("keeps the caller's order", () => {
    const dirs = ["/workspace/z", "/workspace/a"];
    assert.deepEqual(pluginDirArgs(dirs), [
      "--plugin-dir",
      "/workspace/z",
      "--plugin-dir",
      "/workspace/a",
    ]);
  });
});

describe("parsePluginManifest", () => {
  it("reads the fields the page shows", () => {
    const out = parsePluginManifest(
      JSON.stringify({ name: "orient", version: "0.1.0", description: "  git state  " }),
    );
    assert.deepEqual(out, { name: "orient", version: "0.1.0", description: "git state" });
  });

  it("refuses a manifest with no name", () => {
    // The CLI needs a name to address the plugin by. Without one the directory
    // loads as nothing, which from the outside is indistinguishable from the
    // plugin having no effect.
    const out = parsePluginManifest(JSON.stringify({ version: "1.0.0" }));
    assert.ok("error" in out && /no name/i.test(out.error));
    assert.ok("error" in parsePluginManifest(JSON.stringify({ name: "   " })));
  });

  it("refuses malformed JSON rather than treating it as absent", () => {
    const out = parsePluginManifest("{ not json");
    assert.ok("error" in out && /not valid JSON/i.test(out.error));
  });

  it("refuses a manifest that is not an object", () => {
    // `JSON.parse("null")` and `JSON.parse("[]")` both succeed, and a plain
    // property read on either yields undefined rather than throwing — so
    // without this branch an array would fall through to the no-name refusal
    // by accident rather than by decision.
    assert.ok("error" in parsePluginManifest("null"));
    assert.ok("error" in parsePluginManifest("[]"));
    assert.ok("error" in parsePluginManifest('"orient"'));
  });

  it("treats absent optional fields as null, not as empty strings", () => {
    // The page distinguishes "no version declared" from a blank one, and a
    // blank string renders as a version that exists and is empty.
    const out = parsePluginManifest(JSON.stringify({ name: "x", description: "  " }));
    assert.deepEqual(out, { name: "x", version: null, description: null });
  });
});
