import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_TEMPLATE_NAME } from "./apiTypes";
import { normalizeTemplateInput, rowToTemplate } from "./templates";

/**
 * Covers the two narrowings a template does, and only those.
 *
 * They earn a test on the same grounds as the rest of the short list here:
 * pure functions whose failure modes are silent and expensive, and a template
 * multiplies both. It is saved once and applied many times, so a value that
 * slips through is not one wrong run — it is every run started from that
 * template afterwards, under guards the operator believes they set.
 *
 * Specifically: a `permissionMode` that reaches `--permission-mode` without
 * being one of the four literals; a template that can be saved but never
 * instantiated, because `maxIterations: null` with no time limit is refused by
 * `POST /api/runs` and again as `no_terminus`; and a folder whose "not
 * recorded" collapses into "the whole workspace", which is the one selection
 * that blocks every other run in the tree.
 */

const OK = {
  name: "Weekly deps",
  prompt: "Update dependencies and fix what breaks.",
  permissionMode: "acceptEdits",
  budget: { maxIterations: 5, maxDurationMinutes: 60 },
};

/** Unwrap a normalization that is expected to succeed. */
function value(raw: unknown) {
  const res = normalizeTemplateInput(raw);
  assert.ok(res.ok, `expected ok, got: ${res.ok ? "" : res.error}`);
  return res.value;
}

/** The refusal message for input expected to be rejected. */
function error(raw: unknown): string {
  const res = normalizeTemplateInput(raw);
  assert.ok(!res.ok, "expected a refusal");
  return res.error;
}

/* ------------------------------------------------------------------ */
/* Identity and substance                                              */
/* ------------------------------------------------------------------ */

describe("normalizeTemplateInput — name and prompt", () => {
  it("requires a name", () => {
    assert.match(error({ ...OK, name: "   " }), /needs a name/);
    assert.match(error({ ...OK, name: undefined }), /needs a name/);
  });

  it("trims the name rather than storing the whitespace", () => {
    assert.equal(value({ ...OK, name: "  Weekly deps  " }).name, "Weekly deps");
  });

  it("bounds the name, so the picker stays one line", () => {
    const long = "x".repeat(MAX_TEMPLATE_NAME + 1);
    assert.match(error({ ...OK, name: long }), /at most/);
    assert.equal(
      value({ ...OK, name: "x".repeat(MAX_TEMPLATE_NAME) }).name.length,
      MAX_TEMPLATE_NAME,
    );
  });

  it("requires a prompt — it is the part worth saving", () => {
    assert.match(error({ ...OK, prompt: "" }), /needs a task/);
    assert.match(error({ ...OK, prompt: "\n \t " }), /needs a task/);
  });
});

/* ------------------------------------------------------------------ */
/* The flag that decides what a spawned agent may do                   */
/* ------------------------------------------------------------------ */

describe("normalizeTemplateInput — permission mode", () => {
  it("accepts each of the four literals", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan"]) {
      assert.equal(value({ ...OK, permissionMode: mode }).permissionMode, mode);
    }
  });

  it("refuses anything else rather than coercing it", () => {
    assert.match(
      error({ ...OK, permissionMode: "bypassPermission" }),
      /Unknown permission mode/,
    );
    // Case matters: `--permission-mode` is not case-insensitive, so a value
    // that differs only in case would be accepted here and rejected by the CLI.
    assert.match(
      error({ ...OK, permissionMode: "AcceptEdits" }),
      /Unknown permission mode/,
    );
  });

  it("defaults to acceptEdits, matching the run form", () => {
    assert.equal(
      value({ ...OK, permissionMode: undefined }).permissionMode,
      "acceptEdits",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

describe("normalizeTemplateInput — budget", () => {
  it("refuses a template nothing would ever end", () => {
    assert.match(
      error({
        ...OK,
        budget: { maxIterations: null, maxDurationMinutes: null },
      }),
      /needs a time limit/,
    );
  });

  it("allows an uncapped cycle count alongside a time limit", () => {
    const v = value({
      ...OK,
      budget: { maxIterations: null, maxDurationMinutes: 120 },
    });
    assert.equal(v.budget.maxIterations, null);
    assert.equal(v.budget.maxDurationMinutes, 120);
  });

  it("refuses an unrecognised enforcement mode rather than downgrading it", () => {
    assert.match(
      error({ ...OK, budget: { ...OK.budget, enforcement: "live-pause" } }),
      /Unknown enforcement mode/,
    );
  });

  it("carries the three enforcement modes through unchanged", () => {
    for (const mode of ["between-cycles", "live", "live-resume"]) {
      const v = value({ ...OK, budget: { ...OK.budget, enforcement: mode } });
      assert.equal(v.budget.enforcement, mode);
    }
  });

  it("reads continueAfterDone strictly, so a string 'false' stays off", () => {
    assert.equal(
      value({ ...OK, budget: { ...OK.budget, continueAfterDone: "false" } })
        .budget.continueAfterDone,
      false,
    );
    assert.equal(
      value({ ...OK, budget: { ...OK.budget, continueAfterDone: true } }).budget
        .continueAfterDone,
      true,
    );
  });

  it("stores window guards as fractions, however they arrive", () => {
    const v = value({
      ...OK,
      budget: { ...OK.budget, maxSessionFraction: 0.8, maxWeeklyFraction: 60 },
    });
    assert.equal(v.budget.maxSessionFraction, 0.8);
    assert.equal(v.budget.maxWeeklyFraction, 0.6);
  });
});

/* ------------------------------------------------------------------ */
/* Where it runs                                                       */
/* ------------------------------------------------------------------ */

describe("normalizeTemplateInput — target", () => {
  it("drops a folder that names no mount", () => {
    // A path within a mount means nothing without the mount, and a template
    // that half-remembers a target is worse than one that asks.
    const v = value({ ...OK, folder: "api", mountId: null });
    assert.equal(v.mountId, null);
    assert.equal(v.folder, null);
  });

  it("keeps the mount root distinct from 'no folder recorded'", () => {
    // "" is the whole workspace — the selection that blocks every other run in
    // the tree. Collapsing it into null (or null into it) picks the wrong one.
    const root = value({ ...OK, mountId: "main", folder: "" });
    assert.equal(root.mountId, "main");
    assert.equal(root.folder, "");

    const unset = value({ ...OK, mountId: "", folder: "" });
    assert.equal(unset.mountId, null);
    assert.equal(unset.folder, null);
  });

  it("defaults a mount with no folder to that mount's root", () => {
    assert.equal(value({ ...OK, mountId: "main" }).folder, "");
  });

  it("isolates unless told otherwise", () => {
    assert.equal(value(OK).isolate, true);
    assert.equal(value({ ...OK, isolate: false }).isolate, false);
    // Anything but an explicit false asks for the isolated checkout — the
    // choice that cannot touch the operator's own working tree.
    assert.equal(value({ ...OK, isolate: "false" }).isolate, true);
  });
});

/* ------------------------------------------------------------------ */
/* Reading a row back                                                  */
/* ------------------------------------------------------------------ */

const ROW = {
  id: "t1",
  name: "Weekly deps",
  prompt: "Update dependencies.",
  mount_id: "main",
  folder: "api",
  isolate: 1,
  permission_mode: "acceptEdits",
  budget: JSON.stringify({ maxIterations: 5, maxDurationMinutes: 60 }),
  created_at: 1,
  updated_at: 2,
};

describe("rowToTemplate", () => {
  it("round-trips a well-formed row", () => {
    const t = rowToTemplate(ROW);
    assert.equal(t.permissionMode, "acceptEdits");
    assert.equal(t.isolate, true);
    assert.equal(t.folder, "api");
    assert.equal(t.budget.maxIterations, 5);
  });

  it("narrows an unrecognised permission mode downwards, never upwards", () => {
    // A row can outlive the build that wrote it. `plan` is the only one of the
    // four that cannot write, so it is the safe reading of a value this build
    // does not understand.
    assert.equal(
      rowToTemplate({ ...ROW, permission_mode: "bypassEverything" })
        .permissionMode,
      "plan",
    );
    assert.equal(
      rowToTemplate({ ...ROW, permission_mode: "" }).permissionMode,
      "plan",
    );
  });

  it("degrades an unknown enforcement mode to the one that loses no work", () => {
    const t = rowToTemplate({
      ...ROW,
      budget: JSON.stringify({ maxIterations: 5, enforcement: "live-kill" }),
    });
    assert.equal(t.budget.enforcement, "between-cycles");
  });

  it("survives an unreadable budget blob as one work cycle", () => {
    const t = rowToTemplate({ ...ROW, budget: "{not json" });
    assert.equal(t.budget.maxIterations, 1);
    assert.equal(t.budget.maxRunCostUSD, null);
    assert.equal(t.budget.enforcement, "between-cycles");
  });

  it("keeps a null folder null", () => {
    const t = rowToTemplate({ ...ROW, mount_id: null, folder: null });
    assert.equal(t.mountId, null);
    assert.equal(t.folder, null);
  });
});
