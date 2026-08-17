import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "./settings";

/**
 * Covers what `saveSettings` writes, which is not what it returns.
 *
 * The effective object is `{...DEFAULTS, ...stored}`, so a stored value and an
 * absent one are indistinguishable *today* and differ only the day the shipped
 * default changes. That is the whole failure: writing the effective object
 * verbatim pinned all thirty-three keys on the first Save, and from then on
 * every `DEFAULT_*` in the module was dead for that install. Nothing throws,
 * nothing fails to typecheck, and `getSettings()` keeps answering correctly —
 * the divergence only appears weeks later, as a fix that shipped and never took.
 * It has already happened here once, to `maxConcurrentRuns`.
 *
 * So the assertions are about the stored *blob*, not about the round trip. A
 * test that only checked `getSettings()` after `saveSettings()` passes either
 * way, which is exactly why this survived as long as it did.
 *
 * A throwaway database for the reason the settings route's test opens one — the
 * defect is in what was persisted, so only something that reads storage can see
 * it — and dynamic imports because `DATA_DIR` is fixed at first import.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-settings-"));
process.env.DATA_DIR = DATA_DIR;

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

let saveSettings: (patch: Partial<Settings>) => Settings;
let getSettings: () => Settings;
let stored: () => unknown;
/** The shipped defaults, read off an empty store before anything is written. */
let shipped: Settings;

before(async () => {
  const settings = await import("./settings");
  const db = await import("./db");
  saveSettings = settings.saveSettings;
  getSettings = settings.getSettings;
  stored = () => db.getJSON<unknown>("settings", null);
  shipped = settings.getSettings();
  assert.equal(stored(), null, "the fixture must start with nothing written");
});

describe("what a Save actually persists", () => {
  it("stores nothing at all when every value is the shipped one", () => {
    // The settings page PUTs the whole *effective* object, so this is an
    // ordinary press of Save with nothing edited — the exact call that used to
    // pin all thirty-three keys.
    saveSettings(getSettings());
    assert.deepEqual(stored(), {});
  });

  it("stores only the keys that differ", () => {
    saveSettings({ maxConcurrentRuns: 9 });
    assert.deepEqual(stored(), { maxConcurrentRuns: 9 });
    // …and the effective object is unchanged by the omission of the rest.
    assert.equal(getSettings().maxConcurrentAssists, shipped.maxConcurrentAssists);
    assert.equal(getSettings().maxConcurrentRuns, 9);
  });

  it("drops a key again once it is set back to the default", () => {
    // Without this, returning a setting to its shipped value would leave the pin
    // behind — the state that is invisible and permanent.
    saveSettings({ maxConcurrentRuns: shipped.maxConcurrentRuns });
    assert.deepEqual(stored(), {});
  });

  it("compares an object value structurally, not by reference", () => {
    // `chatDefaultGuards`, `weeklyAnchor` and the two glob lists are objects and
    // arrays, and every one of them arrives off the wire as a fresh instance.
    // Reference inequality would keep all of them forever, which is the bug
    // intact for the keys that carry the most.
    saveSettings({ chatDefaultGuards: structuredClone(shipped.chatDefaultGuards) });
    assert.deepEqual(stored(), {});
    saveSettings({ isolationCopyGlobs: [...shipped.isolationCopyGlobs] });
    assert.deepEqual(stored(), {});
  });

  it("is not fooled by key order inside an object value", () => {
    // JSON off the wire preserves no declaration order. A `JSON.stringify`
    // comparison would read a reordered object as an edit and store it forever
    // — the original failure arriving through its own fix.
    const guards = shipped.chatDefaultGuards;
    const reordered = {
      budget: Object.fromEntries(
        Object.entries(guards.budget).reverse(),
      ) as typeof guards.budget,
      isolate: guards.isolate,
      permissionMode: guards.permissionMode,
    };
    saveSettings({ chatDefaultGuards: reordered });
    assert.deepEqual(stored(), {});
  });

  it("keeps a nested value that really did change", () => {
    const guards = shipped.chatDefaultGuards;
    const edited = { ...guards, budget: { ...guards.budget, maxRunCostUSD: 12 } };
    saveSettings({ chatDefaultGuards: edited });
    assert.deepEqual(stored(), { chatDefaultGuards: edited });
    saveSettings({ chatDefaultGuards: guards });
  });

  it("keeps an explicit null that shadows a shipped number", () => {
    // The case that started this. `maxConcurrentRuns` ships as a number, and an
    // operator who genuinely wants no cap says so with `null` — which differs
    // from the default, is therefore stored, and must keep being stored. What
    // changed is only that a *stale* null, left behind by a Save that predates
    // the shipped number, is no longer rewritten on every press.
    saveSettings({ maxConcurrentRuns: null });
    assert.deepEqual(stored(), { maxConcurrentRuns: null });
    saveSettings({ maxConcurrentRuns: shipped.maxConcurrentRuns });
    assert.deepEqual(stored(), {});
  });
});
