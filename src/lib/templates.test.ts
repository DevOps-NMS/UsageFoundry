import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_TEMPLATE_NAME } from "./apiTypes";
import {
  normalizeTemplateInput,
  rowToTemplate,
  type TemplateKnowledge,
} from "./templates";

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

/**
 * The registry as the save door reads it.
 *
 * Passed in rather than read, which is what keeps this function pure — and what
 * lets the two agents below stand for the two things that can be wrong with one:
 * gone, and present but in a shape the CLI drops without a word.
 */
const KNOWN: TemplateKnowledge = {
  agents: new Map([
    ["a1", { name: "reviewer", usable: true }],
    ["a2", { name: "half-written", usable: false }],
  ]),
};

/** Unwrap a normalization that is expected to succeed. */
function value(raw: unknown, known: TemplateKnowledge = KNOWN) {
  const res = normalizeTemplateInput(raw, known);
  assert.ok(res.ok, `expected ok, got: ${res.ok ? "" : res.error}`);
  return res.value;
}

/** The refusal message for input expected to be rejected. */
function error(raw: unknown, known: TemplateKnowledge = KNOWN): string {
  const res = normalizeTemplateInput(raw, known);
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
/* The agent a template names                                          */
/* ------------------------------------------------------------------ */

/**
 * The refusals here are the `no_terminus` rule applied to a second field: a
 * template that can be saved and never instantiated fails weeks away from the
 * form that caused it. What makes it worth a test rather than a comment is that
 * the *other* reading is silent — a template naming a deleted agent, quietly
 * saved with none, starts runs that look exactly like runs that were never given
 * an agent, which is the one shape the whole agent registry exists to end.
 */
describe("normalizeTemplateInput — the agent", () => {
  it("names none by default, and reads blank as none", () => {
    assert.equal(value(OK).agentId, null);
    assert.equal(value({ ...OK, agentId: null }).agentId, null);
    assert.equal(value({ ...OK, agentId: "" }).agentId, null);
    assert.equal(value({ ...OK, agentId: "   " }).agentId, null);
  });

  it("keeps an agent that is in the registry, trimmed", () => {
    assert.equal(value({ ...OK, agentId: "a1" }).agentId, "a1");
    assert.equal(value({ ...OK, agentId: "  a1  " }).agentId, "a1");
  });

  it("is idempotent through its own output", () => {
    const once = value({ ...OK, agentId: " a1 " });
    assert.equal(value(once).agentId, "a1");
  });

  it("refuses an agent that is not there, rather than saving none", () => {
    assert.match(error({ ...OK, agentId: "gone" }), /no longer exists/);
    // And with an empty registry, which is what a fresh install looks like.
    assert.match(
      error({ ...OK, agentId: "a1" }, { agents: new Map() }),
      /no longer exists/,
    );
  });

  it("refuses one the CLI would not register, and names it", () => {
    const message = error({ ...OK, agentId: "a2" });
    assert.match(message, /half-written/);
    // One wording for every door, so this is `agentRefusal`'s sentence arriving
    // here rather than a second copy of it. It changed with the flag: a member
    // the CLI will not register used to be dropped in silence, and a run that
    // names one on `--agent` now fails at the spawn.
    assert.match(message, /will not register/);
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
  agent_id: null as string | null,
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

  it("reads a blank agent column as no agent", () => {
    assert.equal(rowToTemplate(ROW).agentId, null);
    assert.equal(rowToTemplate({ ...ROW, agent_id: "" }).agentId, null);
    assert.equal(rowToTemplate({ ...ROW, agent_id: "   " }).agentId, null);
  });

  /**
   * The one narrowing this function deliberately does *not* do. An agent that
   * has since been deleted is still what the template says, and the doors that
   * instantiate it refuse it by name; repairing it to null here would turn that
   * refusal into a run quietly started as no agent, which is exactly the
   * failure the refusal exists to prevent.
   */
  it("keeps an agent id whose agent may be gone, rather than repairing it", () => {
    assert.equal(rowToTemplate({ ...ROW, agent_id: "deleted" }).agentId, "deleted");
  });
});
