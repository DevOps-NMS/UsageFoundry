import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

// Types only: an `import` of a *value* from `./chat` is hoisted above the
// environment set below, which is what the `require` further down exists to
// avoid. `import type` is erased and loads nothing.
import type {
  BatchProposal,
  ChatProposalRow,
  ChatRow,
  DecisionTally,
  SettledProposal,
} from "./chat";
import type { RunTemplate } from "./templates";
import type { RunGuards } from "./settings";
import type { RegistryAgent } from "./agents";

/**
 * Covers `planProposal`, `planApprovalBatch`, `chatPrompt`, `decisionNote`,
 * `githubSlug`, `settleOnExit`, `staleTurn`, the three that decide what the
 * operator is asked and what an answer settles — `normalizeChoices`,
 * `answerMessage`, `settleQuestions` — and the turn claim in `sendChatMessage`.
 *
 * Each is the same class of failure the rest of this suite is reserved for —
 * silent, and expensive:
 *
 *  - `planProposal` is where text a model wrote becomes a process with write
 *    access to a directory. The branch that matters most is the one that is not
 *    there: nothing on a proposal may set a guard, a permission mode or an
 *    isolation choice, because the whole approval gate rests on those coming
 *    from something a person wrote — a template, or the untemplated guard set
 *    in settings. A regression here type-checks perfectly and shows up as an
 *    agent running somewhere nobody chose. The agent is the second thing
 *    a proposal may name and it is on the other side of that line — it decides
 *    who the run *is* — so what is pinned about it is both
 *    directions at once: the whole definition reaches the run, no guard and no
 *    word of the prompt moves, and one that has been deleted is refused **by
 *    name** rather than falling back to none. That fallback is the expensive
 *    one, because a run that is not the agent it was proposed as is bit-for-bit a
 *    run that was never given one, and nothing downstream can tell them apart.
 *  - `planApprovalBatch` has no agent dimension by construction — `BatchProposal`
 *    carries a label, a title and its edges and nothing else — which is why
 *    there is no case for one below. A proposal whose agent has gone is refused
 *    inside `approveProposal`, and the dependents behind it are then failed by
 *    the same `stillborn` cascade any other failed creation triggers, with no
 *    agent-specific branch anywhere in it. It decides the order one click
 *    creates its runs in and
 *    what each one waits for, and both ways of being wrong are silent. Out of
 *    order, a proposal names a run that does not exist yet and is refused as a
 *    missing run — an artefact of what the page happened to display, reported
 *    as a fact about the work. A dependency silently dropped is worse: a run
 *    told to wait and started immediately is bit-for-bit a run that was never
 *    told, and the two agents then work in the same checkout in whatever order
 *    the queue felt like.
 *  - `composeTask` decides what the agent is actually told. It is the one half
 *    of a run the chat may write, and getting the two halves the wrong way
 *    round — or dropping one — is a run that does something adjacent to the
 *    task, expensively, without failing.
 *  - `decisionNote` is the only account the operator gets of what a click on
 *    Approve did. The route refuses to act on an id that is not pending in
 *    this chat, which is the right defence and also the reason the failure is
 *    silent: the request succeeds, nothing runs, and the thread keeps whatever
 *    sentence this function wrote. Reporting another thread's proposals as
 *    "already decided" is a permanent, wrong record in a conversation the
 *    operator reads back as what they authorised.
 *  - `chatPrompt` decides whether a turn is billed with the thread or without
 *    it. Getting it wrong is invisible: a model that silently lost the
 *    conversation still answers confidently, and the reply reads as a
 *    misunderstanding rather than as amnesia.
 *  - `githubSlug` names the repository the chat then reads issues out of. A
 *    wrong answer is not an error — it is proposals for somebody else's
 *    project, described convincingly.
 *  - `sendChatMessage` is the only check-then-act in this file, and the one
 *    thing it decides is whether a second billed child joins a conversation
 *    that already has one. It is not pure, so it is driven against a temporary
 *    database with `spawn` replaced — the assertion is the number of children,
 *    which is what the failure costs.
 *  - `settleOnExit` decides whether a turn ever ends. It is the other impure
 *    one, and the only one that earns a *real* subprocess: the fault it guards
 *    against cannot be reproduced without one, because pipes a grandchild
 *    holds open are the whole mechanism — which is also why it takes `spawn`
 *    from the handle saved before the counter above replaced it. Wired to
 *    `close` alone, a chat whose
 *    answer is already sitting in the buffer reads as "Thinking…" for ten
 *    minutes and then as a timeout — or for ever, with no error recorded.
 *  - `staleTurn` is what is left when even that does not fire: the only thing
 *    enforcing the ten-minute bound on a turn whose child this process can no
 *    longer hear from at all. Wrong in one direction it kills a live turn
 *    mid-answer; wrong in the other it never fires, and the bound quietly stops
 *    existing — a thread that says "Thinking…" for ever, refusing every
 *    message, with nothing short of a server restart able to clear it.
 *  - The three about questions to the operator earn their place together,
 *    because each of them fails as a *question* rather than as an error. A
 *    choices list that arrived holding a null is a button reading "null" that
 *    somebody can press, and their answer then means something the model never
 *    offered. An answer sent without the question above it is a bare string a
 *    fresh child has to guess the referent of, and the guess is silent — it
 *    proposes against whichever question it decided that answered. And an id
 *    dropped rather than refused is the operator's typed answer missing from
 *    the text the model reads, which the model then answers as though the
 *    questions that survived were all it asked.
 *  - What settles the rows is a query rather than any of those, so the
 *    supersede rule is driven against the database instead, on
 *    `chatOrder.test.ts`'s grounds — as is the order a set of questions comes
 *    back in, which is that file's own defect one table over.
 */

/* ------------------------------------------------------------------ */
/* Harness for the impure one                                          */
/* ------------------------------------------------------------------ */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-chat-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Belt to the fake `spawn` below: if the replacement ever stopped taking
// effect, this is a path that cannot be executed rather than a real, billed CLI.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above, and
// `config.ts` fixes `DATA_DIR` and `CLAUDE_HOME` at load. Same reason
// `orchestrator.test.ts` does it.
const {
  CHAT_TIMEOUT_MS,
  MAX_QUESTION_CHOICES,
  STALE_TURN_MARGIN_MS,
  answerChatQuestions,
  answerMessage,
  chatOwnsRun,
  chatPrompt,
  composeTask,
  createChat,
  createProposal,
  createQuestions,
  markProposal,
  decisionNote,
  getChat,
  listMessages,
  listProposals,
  listQuestions,
  normalizeChoices,
  proposalDeps,
  proposalGuards,
  parseTurnOutput,
  planApprovalBatch,
  planProposal,
  questionChoices,
  removeMcpConfig,
  sendChatMessage,
  settleOnExit,
  settleQuestions,
  staleTurn,
  writeMcpConfig,
  MCP_CONFIG_BASE,
} = require("./chat") as typeof import("./chat");
const { githubSlug } = require("./workspace") as typeof import("./workspace");

/**
 * Count the children a turn would start, without starting one.
 *
 * `chat.ts` calls `spawn` through the module object under the test build's
 * CommonJS emit, so replacing it here is what every turn below gets. The fake
 * closes with no output, which lands the turn exactly as a CLI that printed
 * nothing would — the MCP config file is unlinked and the capability revoked,
 * rather than left behind by a turn that never finished.
 *
 * `realSpawn` is kept rather than only restored: the `settleOnExit` case below
 * needs a genuine subprocess, and reading `spawn` off the module there would
 * get this counter instead — a test of the grandchild fault that never starts
 * a grandchild, passing whatever the wiring does.
 */
const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;
let spawnCount = 0;

childProcess.spawn = () => {
  spawnCount++;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  setImmediate(() => child.emit("close", 0));
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Let a landed turn finish writing before the next assertion reads the row. */
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

const template: RunTemplate = {
  id: "tpl1",
  name: "Fix a bug",
  prompt: "Work carefully and commit as you go.",
  mountId: "workspace",
  folder: "acme/api",
  isolate: true,
  permissionMode: "acceptEdits",
  agentId: null,
  // Different from the agent's below, so a test that reads the template's model
  // cannot be passing on one read off the agent.
  model: "claude-sonnet-5",
  budget: {
    maxIterations: 4,
    maxDurationMinutes: 60,
    maxRunCostUSD: 5,
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
  },
  createdAt: 0,
  updatedAt: 0,
};

/**
 * The untemplated guard set, deliberately different from the template's in
 * every field — so a test that passes is a test that read the right one.
 */
const defaults: RunGuards = {
  permissionMode: "plan",
  isolate: false,
  budget: {
    maxIterations: 1,
    maxDurationMinutes: 30,
    maxRunCostUSD: 2,
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    enforcement: "live",
    continueAfterDone: false,
  },
};

const proposal = (over: Partial<ChatProposalRow> = {}) =>
  ({
    task: "Fix the flaky auth test in #412.",
    template_id: "tpl1",
    agent_id: null,
    model: null,
    prompt_override: null,
    mount_id: null,
    folder: null,
    status: "pending",
    title: "Fix #412",
    guards_json: null,
    ...over,
  }) as Pick<
    ChatProposalRow,
    | "task"
    | "mount_id"
    | "folder"
    | "status"
    | "title"
    | "template_id"
    | "agent_id"
    | "model"
    | "prompt_override"
    | "guards_json"
  >;

/**
 * A registry row as `planProposal` takes one.
 *
 * Every field deliberately different from the template's and the defaults', so
 * a test that reads the agent cannot be passing on something read off either.
 */
const agent: RegistryAgent = {
  id: "agent1",
  name: "Reviewer",
  description: "Reads a diff and reports what is wrong with it.",
  prompt: "You review code. Report; do not edit.",
  model: "claude-haiku-4-5-20251001",
  usable: true,
  createdAt: 0,
  updatedAt: 0,
};

describe("planProposal", () => {
  it("takes every guard from the template and none from the proposal", () => {
    const plan = planProposal(proposal(), template, defaults, null);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    assert.equal(plan.input.permissionMode, "acceptEdits");
    assert.equal(plan.input.isolate, true);
    assert.deepEqual(plan.input.budget, template.budget);
  });

  /**
   * The whole precedence, pinned rung by rung: proposal, then template, then
   * null for `createRun` to resolve.
   *
   * Worth pinning because every way of getting it wrong is silent and is a
   * differently-priced run wearing the right task, which nothing on the page
   * would report. The rung this one adds is the top: a model the chat named
   * displaces the operator's own default, so a proposal whose model was read
   * second — or not at all — spends the operator's money at a price the card
   * stated and the run never used.
   */
  it("runs a proposal on the model the chat named, over the template's", () => {
    const plan = planProposal(
      proposal({ model: "claude-opus-5" }),
      template,
      defaults,
      null,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.model, "claude-opus-5");
    // The guards are still the template's, which is the whole point of the
    // field being allowed at all: it moved the price and nothing else.
    assert.equal(plan.input.permissionMode, "acceptEdits");
    assert.equal(plan.input.isolate, true);
  });

  it("runs an untemplated proposal on the model the chat named", () => {
    const plan = planProposal(
      proposal({
        template_id: null,
        mount_id: "workspace",
        folder: "acme/api",
        model: "haiku",
      }),
      null,
      defaults,
      null,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.model, "haiku");
  });

  it("reads a blank model on the proposal as naming none", () => {
    // Two rows arrive this way and neither means "the empty model": one
    // written before the column existed, which reads `undefined` on an install
    // that has not restarted, and one whose argument trimmed to nothing. Read
    // as a value, both become `--model ""` — a spawn the CLI refuses — and
    // neither would reach the template's own answer.
    for (const blank of [undefined, "", "   "]) {
      const plan = planProposal(
        proposal({ model: blank as string | null }),
        template,
        defaults,
        null,
      );
      assert.equal(plan.ok, true);
      if (!plan.ok) return;
      assert.equal(plan.input.model, "claude-sonnet-5");
    }
  });

  it("runs a proposal on the template's model", () => {
    const plan = planProposal(proposal(), template, defaults, null);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.model, "claude-sonnet-5");
  });

  it("leaves the model to createRun when the template names none", () => {
    // Null rather than a default read here: `createRun`'s
    // `input.model ?? settings.defaultModel` is the one place that fallback is
    // applied, and applying it twice is how the two stop agreeing.
    const plan = planProposal(
      proposal(),
      { ...template, model: null },
      defaults,
      null,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.model, null);
  });

  it("names no model for an untemplated proposal", () => {
    // `settings.chatDefaultGuards` is a guard set and holds no model, so a
    // proposal against no template has nothing to inherit and must not invent
    // one from the guards it did inherit.
    const plan = planProposal(
      // Its own folder, because there is no template to take one from.
      proposal({ template_id: null, mount_id: "workspace", folder: "acme/api" }),
      null,
      defaults,
      null,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.model, null);
    // The guards it did inherit, so "no model" is not "nothing was applied".
    assert.equal(plan.input.permissionMode, "plan");
  });

  it("leads with the template's prompt and marks where the chat's task starts", () => {
    const plan = planProposal(proposal(), template, defaults, null);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    assert.ok(plan.input.prompt.startsWith("Work carefully and commit as you go."));
    assert.ok(plan.input.prompt.includes("## This run specifically"));
    assert.ok(plan.input.prompt.includes("Fix the flaky auth test in #412."));
  });

  it("falls back to the template's folder when the proposal names none", () => {
    const plan = planProposal(proposal(), template, defaults, null);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.mountId, "workspace");
    assert.equal(plan.input.folder, "acme/api");
  });

  it("uses the proposal's folder when it names one", () => {
    const plan = planProposal(
      proposal({ mount_id: "other", folder: "acme/web" }),
      template,
      defaults,
      null,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.mountId, "other");
    assert.equal(plan.input.folder, "acme/web");
  });

  it("treats an empty proposal folder as the mount root, not as unset", () => {
    // The mount root is the one selection that blocks every other run in the
    // tree, so reading "" as "fall back to the template" would silently narrow
    // a run the chat asked to be broad — and reading it as unset when the
    // template has a folder would silently widen one.
    const plan = planProposal(
      proposal({ mount_id: "workspace", folder: "" }),
      template,
      defaults,
      null,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.folder, "");
  });

  it("refuses when the named template is gone, rather than using the defaults", () => {
    // The quiet failure this rules out: a proposal the operator approved
    // because the card said "Fix a bug" starting under a different permission
    // mode entirely, because the template was tidied away in between.
    const plan = planProposal(proposal(), null, defaults, null);
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /no longer exists/);
  });

  it("refuses when nothing names a folder", () => {
    const plan = planProposal(
      proposal(),
      { ...template, mountId: null, folder: null },
      defaults,
      null,
    );
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /names a folder/);
  });

  it("refuses a proposal that was already decided", () => {
    for (const status of ["approved", "rejected", "failed"] as const) {
      const plan = planProposal(proposal({ status }), template, defaults, null);
      assert.equal(plan.ok, false, `${status} should not be approvable`);
    }
  });

  it("refuses an empty task", () => {
    const plan = planProposal(proposal({ task: "   " }), template, defaults, null);
    assert.equal(plan.ok, false);
  });

  const untemplated = (over: Partial<ChatProposalRow> = {}) =>
    proposal({ template_id: null, mount_id: "workspace", folder: "acme/api", ...over });

  it("takes every guard from the operator's defaults when there is no template", () => {
    const plan = planProposal(untemplated(), null, defaults, null);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    assert.equal(plan.input.permissionMode, "plan");
    assert.equal(plan.input.isolate, false);
    assert.deepEqual(plan.input.budget, defaults.budget);
  });

  it("sends only the task when there is no template and no override", () => {
    // No heading with nothing above it: the section marker exists to separate
    // standing instructions from this run's brief, and with no standing
    // instructions it would be a marker for a section that is not there.
    const plan = planProposal(untemplated(), null, defaults, null);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.prompt, "Fix the flaky auth test in #412.");
  });

  it("refuses an untemplated proposal that names no folder", () => {
    const plan = planProposal(
      proposal({ template_id: null }),
      null,
      defaults,
      null,
    );
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /names no folder/);
  });

  it("uses the proposal's prompt over the template's, and keeps its guards", () => {
    // The whole point of the split: prompt text is the half a model may write,
    // and every guard beside it still comes from the template.
    const plan = planProposal(
      proposal({ prompt_override: "Read only. Report, do not edit." }),
      template,
      defaults,
      null,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    assert.ok(plan.input.prompt.startsWith("Read only. Report, do not edit."));
    assert.ok(!plan.input.prompt.includes("Work carefully"));
    assert.equal(plan.input.permissionMode, template.permissionMode);
    assert.deepEqual(plan.input.budget, template.budget);
  });

  it("ignores a blank override rather than dropping the template's prompt", () => {
    const plan = planProposal(
      proposal({ prompt_override: "   " }),
      template,
      defaults,
      null,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.ok(plan.input.prompt.startsWith("Work carefully and commit as you go."));
  });

  it("carries the named agent's whole definition onto the run", () => {
    // The definition rather than the id, because that is what `createRun`
    // freezes onto the row: an id there would leave cycle 4 of this run with no
    // agent the moment somebody tidies the registry, which is the CLI's own
    // silent drop performed by this app.
    const plan = planProposal(
      proposal({ agent_id: "agent1" }),
      template,
      defaults,
      agent,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.deepEqual(plan.input.agent, {
      name: "Reviewer",
      description: "Reads a diff and reports what is wrong with it.",
      prompt: "You review code. Report; do not edit.",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("takes no guard from the agent, and does not put it in the prompt", () => {
    // The branch that matters is the one that is not there. An agent carries a
    // description and a prompt, so naming one must move nothing about what the
    // run may do — and it must not silently reach the agent's own instructions
    // into the run's task either, which would be a second prompt nobody wrote
    // into `composeTask`'s two halves.
    const withAgent = planProposal(
      proposal({ agent_id: "agent1" }),
      template,
      defaults,
      agent,
    );
    const without = planProposal(proposal(), template, defaults, null);
    assert.equal(withAgent.ok, true);
    assert.equal(without.ok, true);
    if (!withAgent.ok || !without.ok) return;

    assert.equal(withAgent.input.permissionMode, without.input.permissionMode);
    assert.equal(withAgent.input.isolate, without.input.isolate);
    assert.deepEqual(withAgent.input.budget, without.input.budget);
    assert.equal(withAgent.input.prompt, without.input.prompt);
    assert.ok(!withAgent.input.prompt.includes("You review code"));
    assert.equal(without.input.agent ?? null, null);
  });

  it("refuses a proposal whose agent has been deleted, by name", () => {
    // Never a fallback to no agent: the operator approved the card that
    // said "and hand the review to the reviewer", and a run that quietly has
    // none is bit-for-bit a run that was never given one.
    const plan = planProposal(
      proposal({ agent_id: "agent1" }),
      template,
      defaults,
      null,
    );
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /no longer exists/);
  });

  it("refuses an agent the CLI would drop, naming it", () => {
    // `rowToAgent` reports rather than repairs, so a decayed row arrives here
    // resolvable and unusable — and sending it is the one outcome with no
    // symptom at all: a spawn the CLI refuses by name, cycle after cycle.
    const plan = planProposal(
      proposal({ agent_id: "agent1" }),
      template,
      defaults,
      { ...agent, description: "", usable: false },
    );
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /Reviewer/);
  });

  it("ignores a resolved agent the proposal did not ask for", () => {
    // The row decides, not the argument: a caller that resolved an agent for
    // the wrong proposal must not attach it to this one.
    const plan = planProposal(proposal(), template, defaults, agent);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.agent ?? null, null);
  });

  /**
   * What an untemplated proposal freezes, and what the click does with it.
   *
   * `proposalGuards(row) ?? chatGuards()` is the expression `approveProposal`
   * and the card are both built on, so the composition is what these drive
   * rather than the helper alone. The failure it exists to catch is the one
   * nothing reports: the card spells out `plan · own checkout · 3 cycles ·
   * $5.00`, the operator edits Settings in the other tab, and the run that
   * starts is `bypassPermissions` in their own folder with no cap on money —
   * every write successful, nothing in the thread, nothing on the run.
   */
  describe("the guard set an untemplated proposal froze", () => {
    /** Deliberately unlike `defaults` in every field, for `defaults`' reason. */
    const frozen: RunGuards = {
      permissionMode: "acceptEdits",
      isolate: true,
      budget: {
        maxIterations: 3,
        maxDurationMinutes: null,
        maxRunCostUSD: 5,
        maxRunCostFactor: null,
        maxRunTokens: null,
        maxWeeklyFraction: null,
        maxSessionFraction: null,
        enforcement: "between-cycles",
        continueAfterDone: false,
      },
    };
    const snapshot = (guards: unknown = frozen) =>
      untemplated({ guards_json: JSON.stringify(guards) });

    it("is what the run starts under, whatever Settings says by the click", () => {
      const row = snapshot();
      const plan = planProposal(
        row,
        null,
        proposalGuards(row) ?? defaults,
        null,
      );
      assert.equal(plan.ok, true);
      if (!plan.ok) return;

      assert.equal(plan.input.permissionMode, "acceptEdits");
      assert.equal(plan.input.isolate, true);
      assert.deepEqual(plan.input.budget, frozen.budget);
      // The control: `defaults` is what the live set would have supplied, and
      // reading it would have produced a different run in all four fields.
      assert.notEqual(plan.input.permissionMode, defaults.permissionMode);
    });

    it("falls back to today's defaults when the row froze none", () => {
      // Every proposal already pending when the column arrived, and every
      // workflow one. Refusing them, or running them under an empty guard set,
      // are the two ways this could have been worse than the drift it fixes.
      const row = untemplated();
      assert.equal(proposalGuards(row), null);

      const plan = planProposal(row, null, proposalGuards(row) ?? defaults, null);
      assert.equal(plan.ok, true);
      if (!plan.ok) return;
      assert.equal(plan.input.permissionMode, "plan");
      assert.deepEqual(plan.input.budget, defaults.budget);
    });

    it("falls back rather than half-applying a blob it cannot read", () => {
      for (const raw of ["{not json", '"acceptEdits"', "null", "[]"]) {
        const row = untemplated({ guards_json: raw });
        assert.equal(proposalGuards(row), null, raw);
      }
    });

    it("narrows a partial snapshot rather than widening to what it omits", () => {
      // The other half of the line above, and the direction that matters: a
      // blob written by an older build, or edited by hand, must resolve to less
      // than it names and never to more. `{}` is the extreme of it.
      const bare = proposalGuards(snapshot({}));
      assert.equal(bare?.permissionMode, "plan");
      assert.equal(bare?.isolate, true);
      assert.equal(bare?.budget.maxIterations, 1);

      // An unrecognised mode is `plan` too — the one of the four that cannot
      // write — rather than whatever the string says.
      assert.equal(
        proposalGuards(snapshot({ ...frozen, permissionMode: "wide-open" }))
          ?.permissionMode,
        "plan",
      );
      // And a policy with neither terminus is one work cycle rather than an
      // uncapped loop, `chatGuards`' rule reached through the same narrowing.
      assert.equal(
        proposalGuards(
          snapshot({
            ...frozen,
            budget: { maxIterations: null, maxDurationMinutes: null },
          }),
        )?.budget.maxIterations,
        1,
      );
    });

    it("does not reach a templated proposal, which still resolves live", () => {
      // A template is a handle the operator can go and read, so its guards are
      // read at the click on purpose. A row that carries a snapshot anyway —
      // written before it named a template, or by hand — must not be able to
      // move that.
      const plan = planProposal(
        proposal({ guards_json: JSON.stringify(frozen) }),
        template,
        defaults,
        null,
      );
      assert.equal(plan.ok, true);
      if (!plan.ok) return;
      assert.equal(plan.input.permissionMode, template.permissionMode);
      assert.deepEqual(plan.input.budget, template.budget);
    });
  });
});

describe("composeTask", () => {
  it("puts the standing instructions first and the task under a heading", () => {
    const out = composeTask("Standing orders.", "This one thing.");
    assert.equal(
      out,
      "Standing orders.\n\n## This run specifically\n\nThis one thing.",
    );
  });

  it("is the task alone when there are no standing instructions", () => {
    assert.equal(composeTask(null, "This one thing."), "This one thing.");
    assert.equal(composeTask("  ", "This one thing."), "This one thing.");
  });
});

describe("planApprovalBatch", () => {
  const p = (
    id: string,
    dependsOn: BatchProposal["dependsOn"] = [],
  ): BatchProposal => ({ id, specId: id, title: id, dependsOn });

  const after = (specId: string, continueBranch = false) => ({
    specId,
    edge: "on-success" as const,
    continueBranch,
  });

  const none = new Map<string, SettledProposal>();

  /** Ids of the steps that will be created, in the order they will be. */
  const created = (steps: ReturnType<typeof planApprovalBatch>) =>
    steps.filter((s) => s.ok).map((s) => s.id);

  const refusal = (steps: ReturnType<typeof planApprovalBatch>, id: string) =>
    steps.find((s) => !s.ok && s.id === id) as
      | { ok: false; reason: string }
      | undefined;

  it("creates every proposal after the one it waits for, whatever order it was sent in", () => {
    // The page sends creation order, which for a chain the chat thought of
    // backwards is the reverse of what `createRun` needs — and the failure is
    // not an ordering complaint, it is "no such run to depend on" about a run
    // that was going to exist one line later.
    const steps = planApprovalBatch([p("c", [after("b")]), p("b", [after("a")]), p("a")], none);
    assert.deepEqual(created(steps), ["a", "b", "c"]);
  });

  it("keeps the sent order when nothing depends on anything", () => {
    const steps = planApprovalBatch([p("x"), p("y"), p("z")], none);
    assert.deepEqual(created(steps), ["x", "y", "z"]);
  });

  it("resolves a label to a sibling in the batch, not to a run", () => {
    const steps = planApprovalBatch([p("a"), p("b", [after("a")])], none);
    const b = steps.find((s) => s.ok && s.id === "b") as {
      ok: true;
      dependsOn: Array<{ on: string; proposalId?: string }>;
    };
    assert.deepEqual(b.dependsOn, [
      { on: "proposal", proposalId: "a", edge: "on-success", continueBranch: false },
    ]);
  });

  it("resolves a label to the run an earlier click already started", () => {
    const steps = planApprovalBatch(
      [p("b", [after("a", true)])],
      new Map([["a", { status: "approved", runId: "run-1" }]]),
    );
    const b = steps.find((s) => s.ok) as {
      ok: true;
      dependsOn: Array<Record<string, unknown>>;
    };
    assert.deepEqual(b.dependsOn, [
      { on: "run", runId: "run-1", edge: "on-success", continueBranch: true },
    ]);
  });

  it("refuses a label still waiting for a decision, and says to approve them together", () => {
    // The expensive silent alternative: dropping the edge and starting the
    // dependent anyway, which looks exactly like a run nobody ordered.
    const steps = planApprovalBatch(
      [p("b", [after("a")])],
      new Map([["a", { status: "pending", runId: null }]]),
    );
    assert.equal(created(steps).length, 0);
    assert.match(refusal(steps, "b")!.reason, /still waiting for a decision/);
  });

  it("tells a label that never became a run apart from one that was never proposed", () => {
    const failedDep = planApprovalBatch(
      [p("b", [after("a")])],
      new Map([["a", { status: "failed", runId: null }]]),
    );
    assert.match(refusal(failedDep, "b")!.reason, /was failed and never became a run/);

    const unknown = planApprovalBatch([p("b", [after("ghost")])], none);
    assert.match(refusal(unknown, "b")!.reason, /not a proposal in this chat/);
  });

  it("cascades a refusal to everything behind it, naming the one in front", () => {
    const steps = planApprovalBatch(
      [p("a", [after("ghost")]), p("b", [after("a")]), p("c", [after("b")])],
      none,
    );
    assert.deepEqual(created(steps), []);
    assert.match(refusal(steps, "b")!.reason, /“a”/);
    assert.match(refusal(steps, "c")!.reason, /“b”/);
  });

  it("starts the rest of the batch when one chain cannot be wired", () => {
    const steps = planApprovalBatch([p("a", [after("ghost")]), p("solo")], none);
    assert.deepEqual(created(steps), ["solo"]);
  });

  it("refuses a loop rather than leaving it to createRun's missing-run error", () => {
    // In a loop there is no first member to create, so every member would be
    // refused for naming a run that does not exist — a sentence about the
    // wrong thing entirely.
    const steps = planApprovalBatch([p("a", [after("b")]), p("b", [after("a")])], none);
    assert.deepEqual(created(steps), []);
    assert.match(refusal(steps, "a")!.reason, /wait for each other in a loop/);
    assert.match(refusal(steps, "b")!.reason, /wait for each other in a loop/);
  });

  it("refuses a proposal set to start after itself", () => {
    const steps = planApprovalBatch([p("a", [after("a")])], none);
    assert.match(refusal(steps, "a")!.reason, /start after itself/);
  });

  it("refuses both proposals sharing a label, since an edge naming it names both", () => {
    const steps = planApprovalBatch(
      [{ id: "one", specId: "dup", title: "one", dependsOn: [] },
       { id: "two", specId: "dup", title: "two", dependsOn: [] }],
      none,
    );
    assert.deepEqual(created(steps), []);
    assert.match(refusal(steps, "one")!.reason, /labelled “dup”/);
  });

  it("leaves an unlabelled proposal alone", () => {
    const steps = planApprovalBatch(
      [{ id: "x", specId: null, title: "x", dependsOn: [] }],
      none,
    );
    assert.deepEqual(created(steps), ["x"]);
  });
});

describe("decisionNote", () => {
  const nothing: DecisionTally = {
    action: "approve",
    started: 0,
    rejected: 0,
    failed: [],
    saved: 0,
    decided: 0,
    foreign: 0,
  };

  it("reports an id from another thread as such, never as already decided", () => {
    // The selection carried across a chat switch: two proposals still pending
    // in the thread they were ticked in, sent to one that has never held them.
    const note = decisionNote({ ...nothing, foreign: 2 });
    assert.doesNotMatch(note, /already been decided/);
    assert.match(note, /2 selected proposal\(s\) are not in this chat/);
  });

  it("says nothing happened when nothing did, for either action", () => {
    assert.match(decisionNote({ ...nothing, foreign: 2 }), /^Nothing was approved\./);
    assert.match(
      decisionNote({ ...nothing, action: "reject", decided: 1 }),
      /^Nothing was rejected\./,
    );
  });

  it("keeps the two reasons apart in one batch", () => {
    const note = decisionNote({ ...nothing, started: 1, decided: 1, foreign: 3 });
    assert.match(note, /Approved and queued 1 run\(s\)\./);
    assert.match(note, /1 proposal\(s\) had already been decided/);
    assert.match(note, /3 selected proposal\(s\) are not in this chat/);
    assert.doesNotMatch(note, /Nothing was/);
  });

  it("says only what happened when every id was actionable", () => {
    assert.equal(
      decisionNote({ ...nothing, started: 2 }),
      "Approved and queued 2 run(s).",
    );
    assert.equal(
      decisionNote({ ...nothing, action: "reject", rejected: 2 }),
      "Rejected 2 proposal(s).",
    );
  });

  it("names a run that could not start, and does not call that nothing", () => {
    const note = decisionNote({
      ...nothing,
      failed: [{ title: "Fix a bug", reason: "That folder is not in any mount." }],
    });
    assert.match(note, /Could not start .Fix a bug.: That folder is not in any mount\./);
    assert.doesNotMatch(note, /Nothing was/);
  });
});

describe("chatPrompt", () => {
  const history = [
    { role: "user" as const, text: "check the issues" },
    { role: "assistant" as const, text: "there are three" },
  ];

  it("sends the message alone when there is a session to resume", () => {
    assert.equal(
      chatPrompt({ sessionId: "abc", history }, "propose runs for them"),
      "propose runs for them",
    );
  });

  it("replays the thread, oldest first, when there is no session", () => {
    const out = chatPrompt({ sessionId: null, history }, "propose runs for them");
    assert.ok(out.includes("<thread>"));
    assert.ok(
      out.indexOf("check the issues") < out.indexOf("there are three"),
      "history must read oldest first",
    );
    assert.ok(out.trimEnd().endsWith("propose runs for them"));
  });

  it("sends the message alone when there is no session and no history", () => {
    assert.equal(chatPrompt({ sessionId: null, history: [] }, "hello"), "hello");
  });

  it("keeps the newest history when the replay budget is short", () => {
    // Filling from the newest backwards is what makes a truncated replay useful:
    // the part nearest the question survives, not the opening pleasantries.
    const long = [
      { role: "user" as const, text: "x".repeat(25_000) },
      { role: "assistant" as const, text: "the recent bit" },
    ];
    const out = chatPrompt({ sessionId: null, history: long }, "and now?");
    assert.ok(out.includes("the recent bit"));
    assert.ok(!out.includes("x".repeat(25_000)));
  });
});

describe("staleTurn", () => {
  const NOW = 1_700_000_000_000;
  const deadline = CHAT_TIMEOUT_MS + STALE_TURN_MARGIN_MS;

  const row = (over: Partial<ChatRow> = {}) =>
    ({
      status: "thinking",
      turn_started_at: NOW - 60_000,
      updated_at: NOW - 60_000,
      ...over,
    }) as Pick<ChatRow, "status" | "turn_started_at" | "updated_at">;

  it("leaves a turn inside the bound alone", () => {
    // Turns legitimately run for minutes: the sweeper must not be a shorter
    // auto-cancel wearing a timeout's name.
    assert.equal(staleTurn(row(), NOW), false);
    assert.equal(
      staleTurn(row({ turn_started_at: NOW - deadline + 1 }), NOW),
      false,
    );
  });

  it("fails out a turn that has run past it", () => {
    assert.equal(staleTurn(row({ turn_started_at: NOW - deadline }), NOW), true);
    assert.equal(
      staleTurn(row({ turn_started_at: NOW - deadline * 4 }), NOW),
      true,
    );
  });

  it("never touches a chat that is not working on anything", () => {
    // The row is the only input, and an old idle thread is old by definition —
    // reading the age without the status would fail out every chat on the page.
    for (const status of ["idle", "failed"] as const) {
      assert.equal(
        staleTurn(row({ status, turn_started_at: NOW - deadline * 10 }), NOW),
        false,
        status,
      );
    }
  });

  it("falls back to updated_at for a row written before the column existed", () => {
    // Not "never stale": a null start instant read as no deadline is exactly
    // the stuck thread this exists to clear, and it would be silent.
    assert.equal(
      staleTurn(row({ turn_started_at: null, updated_at: NOW - deadline }), NOW),
      true,
    );
    assert.equal(
      staleTurn(row({ turn_started_at: null, updated_at: NOW - 60_000 }), NOW),
      false,
    );
  });

  it("prefers the turn's own start over updated_at", () => {
    // `save_template` appends a system message mid-turn, which moves
    // `updated_at`. Reading that as the turn's start would push the deadline
    // out every time the chat used the tool — the bound would come off exactly
    // on the longest turns.
    assert.equal(
      staleTurn(
        row({ turn_started_at: NOW - deadline, updated_at: NOW - 1_000 }),
        NOW,
      ),
      true,
    );
  });
});

describe("githubSlug", () => {
  it("reads both forms the same repository is cloned with", () => {
    for (const url of [
      "git@github.com:acme/api.git",
      "https://github.com/acme/api.git",
      "https://github.com/acme/api",
      "ssh://git@github.com/acme/api.git",
      "https://user@github.com/acme/api.git",
    ]) {
      assert.equal(githubSlug(url), "acme/api", url);
    }
  });

  it("returns null for anything that is not GitHub", () => {
    // A slug claimed here becomes `gh issue list --repo <slug>`, which for a
    // GitLab remote would either fail confusingly or — worse — succeed against
    // an unrelated public repository that happens to share the path.
    for (const url of [
      "git@gitlab.com:acme/api.git",
      "https://bitbucket.org/acme/api.git",
      "/srv/git/api.git",
      "https://github.example.com/acme/api.git",
      "",
    ]) {
      assert.equal(githubSlug(url), null, url);
    }
  });
});

describe("chatOwnsRun — what a capability may ask for the patch of", () => {
  // The scope `/api/mcp` applies to `get_run_diff`, and its two failures are
  // opposite and unequal. Refusing a thread's own run is loud: the model says
  // it cannot read the diff of the run it just started. Answering for someone
  // else's is silent and is the whole point of the scope — a capability token
  // *is* its holder's identity, so a token read out of a turn in flight asks
  // this question as the chat, and an unfiltered query hands a work-cycle agent
  // the patch of every run in every repository this install has ever worked in.
  it("answers for the runs this thread started, and for no others", () => {
    const mine = createChat();
    const theirs = createChat();

    const proposal = createProposal(mine.id, {
      templateId: null,
      title: "Fix it",
      task: "Fix the thing.",
      promptOverride: null,
      mountId: "work",
      folder: "repo",
      specId: "fix",
    });
    const other = createProposal(theirs.id, {
      templateId: null,
      title: "Fix theirs",
      task: "Fix their thing.",
      promptOverride: null,
      mountId: "work",
      folder: "other",
      specId: "fix",
    });
    markProposal(proposal.id, "approved", { runId: "run-mine" });
    markProposal(other.id, "approved", { runId: "run-theirs" });

    assert.equal(chatOwnsRun(mine.id, "run-mine"), true);
    assert.equal(chatOwnsRun(mine.id, "run-theirs"), false);
    assert.equal(chatOwnsRun(theirs.id, "run-mine"), false);

    // A run nobody proposed — every run started from the UI, which is most of
    // them — belongs to no thread rather than to all of them.
    assert.equal(chatOwnsRun(mine.id, "run-from-the-page"), false);
  });

  it("does not count a proposal that was never approved", () => {
    // `run_id` is null until `approveProposal` writes one, and SQL equality
    // against null is null rather than true — asserted rather than assumed,
    // because the failure would be a scope that admits every id it is asked
    // about as soon as one pending proposal exists in the thread.
    const chat = createChat();
    createProposal(chat.id, {
      templateId: null,
      title: "Pending",
      task: "Not approved.",
      promptOverride: null,
      mountId: "work",
      folder: "repo",
      specId: "pending",
    });
    assert.equal(chatOwnsRun(chat.id, "run-mine"), false);
  });
});

describe("a proposal's label, dependencies and graph survive the round trip", () => {
  // The one thing in this feature that is neither a pure decision nor a
  // spawn: `migrate()` adds five columns by ALTER and `proposalDeps` reads one
  // of them back as JSON. A shape mismatch there does not throw — it returns
  // an empty list, which is a dependent started immediately instead of after
  // the run it was told to wait for, and that is bit-for-bit what a proposal
  // with no dependency looks like from every page in this app.
  it("reads back what was written, and defaults a bare proposal to a run", () => {
    const chat = createChat();
    createProposal(chat.id, {
      templateId: null,
      title: "Fix it",
      task: "Fix the thing.",
      promptOverride: null,
      mountId: "work",
      folder: "repo",
      specId: "fix",
    });
    createProposal(chat.id, {
      templateId: null,
      agentId: "agent1",
      title: "Prove it",
      task: "Add the test.",
      promptOverride: null,
      mountId: "work",
      folder: "repo",
      specId: "prove",
      dependsOn: [{ specId: "fix", edge: "on-success", continueBranch: true }],
    });
    createProposal(chat.id, {
      kind: "workflow",
      templateId: null,
      title: "Nightly",
      task: "A workflow of 1 block.",
      promptOverride: null,
      mountId: null,
      folder: null,
      graph: JSON.stringify({ nodes: [], edges: [] }),
    });

    // Looked up by title rather than by position: all three are written inside
    // one synchronous block, so they share `created_at` and `listProposals`
    // falls through to the primary key — a random UUID.
    const rows = listProposals(chat.id);
    const byTitle = (t: string) => rows.find((p) => p.title === t)!;
    const fix = byTitle("Fix it");
    const prove = byTitle("Prove it");
    const nightly = byTitle("Nightly");

    assert.equal(fix.kind, "run", "a proposal that says nothing is a run");
    assert.equal(fix.spec_id, "fix");
    assert.deepEqual(proposalDeps(fix), []);
    // The column `planProposal` reads to decide whether to refuse: a proposal
    // that named no agent must read back as null rather than as an id that
    // resolves to nothing, which would refuse every untargeted proposal.
    assert.equal(fix.agent_id, null);

    assert.deepEqual(proposalDeps(prove), [
      { specId: "fix", edge: "on-success", continueBranch: true },
    ]);
    assert.equal(prove.agent_id, "agent1");

    assert.equal(nightly.kind, "workflow");
    assert.equal(nightly.graph, '{"nodes":[],"edges":[]}');
    assert.equal(nightly.workflow_id, null);
  });

  it("reads an unusable dependency list as none rather than throwing", () => {
    // A row from a build that wrote something else, or a hand edit. The page
    // must render; the card then shows no dependency, which is the fact the
    // operator can act on.
    assert.deepEqual(proposalDeps({ depends_on: "not json" }), []);
    assert.deepEqual(proposalDeps({ depends_on: '{"specId":"a"}' }), []);
    assert.deepEqual(
      proposalDeps({ depends_on: '[{"specId":"a","edge":"whenever"}]' }),
      [],
    );
  });
});

describe("normalizeChoices", () => {
  // Every case here produces a *question* rather than an error, which is why
  // this is a function and not a cast at the call site: a choices array that
  // arrived holding a null renders as a button reading "null", and an operator
  // who clicks it has answered with something the model never offered.
  it("keeps what a person could be shown and drops the rest", () => {
    assert.deepEqual(normalizeChoices(["pnpm", "  npm  "]), ["pnpm", "npm"]);
    assert.deepEqual(normalizeChoices(["a", "a", "  a"]), ["a"]);
    assert.deepEqual(normalizeChoices(["a", null, 3, "", "  ", "b"]), ["a", "b"]);
  });

  it("reads anything that is not a list as no choices at all", () => {
    // The reading that fails safe: a question with no shortlist is still
    // answerable when `allow_text` is set, where an invented one is not
    // answerable *correctly* at all.
    assert.deepEqual(normalizeChoices("pnpm"), []);
    assert.deepEqual(normalizeChoices(undefined), []);
    assert.deepEqual(normalizeChoices({ 0: "pnpm" }), []);
  });

  it("does not truncate, because the caller refuses instead", () => {
    // Deliberately uncapped: a silent truncation here leaves the model
    // believing it offered choices the operator was never shown, where
    // `askOperator` refuses the whole question and says how many it counted.
    const many = Array.from({ length: MAX_QUESTION_CHOICES + 4 }, (_, i) => `c${i}`);
    assert.deepEqual(normalizeChoices(many), many);
    // And what makes that refusal accurate: twenty copies of one choice is one
    // choice, which is a different mistake with a different sentence.
    assert.deepEqual(normalizeChoices(Array(20).fill("a")), ["a"]);
  });
});

describe("answerMessage", () => {
  // What this pins is that the answer is not a bare string. The turn that reads
  // it is a fresh child: it has the thread by `--resume`, but the tool call it
  // made lives in a process that has exited, and "pnpm" on its own is a message
  // whose referent it has to guess. The guess is silent — it proposes against
  // whichever question it decided that answered.
  it("quotes each question above the answer to it", () => {
    const text = answerMessage([
      { question: "Which package manager?", answer: "pnpm" },
      { question: "Update the lockfile too?", answer: "yes" },
    ]);
    assert.match(text, /Q: Which package manager\?\nA: pnpm/);
    assert.match(text, /Q: Update the lockfile too\?\nA: yes/);
  });

  it("names a question the operator left alone rather than omitting it", () => {
    // Omitted, it is indistinguishable from a question that was never asked,
    // and the model's next move is to ask it again — a second turn and a second
    // card for something the operator has already declined once.
    const text = answerMessage([
      { question: "Which package manager?", answer: "pnpm" },
      { question: "Should it push?", answer: null },
    ]);
    assert.match(text, /Q: Should it push\?\nA: \(not answered\)/);
  });
});

describe("settleQuestions", () => {
  const open = [
    { id: "q1", question: "Which package manager?" },
    { id: "q2", question: "Should it push?" },
    { id: "q3", question: "Which folder?" },
  ];

  it("carries every open question into the message, answered or not", () => {
    // Answering two of three still sends all three. The one left out would be
    // indistinguishable from a question that was never asked, and the model's
    // next move is to ask it again — a second turn for something the operator
    // has already declined once. Asked order, not answered order.
    const settled = settleQuestions(open, [
      { id: "q3", answer: "acme/api" },
      { id: "q1", answer: "pnpm" },
    ]);
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.deepEqual(settled.entries, [
      { question: "Which package manager?", answer: "pnpm" },
      { question: "Should it push?", answer: null },
      { question: "Which folder?", answer: "acme/api" },
    ]);
    // Only the answered ones close; the rest are superseded by the query.
    assert.deepEqual(settled.answered, [
      { id: "q1", answer: "pnpm" },
      { id: "q3", answer: "acme/api" },
    ]);
  });

  it("fails the whole call rather than dropping an id it cannot place", () => {
    // Where this diverges from the approval batch, which drops a stale id and
    // reports it. These compose one message, so a dropped id is the operator's
    // typed answer silently missing from the text the model reads — and the
    // model then answers as though the questions that survived were all it
    // asked.
    const stale = settleQuestions(open, [
      { id: "q1", answer: "pnpm" },
      { id: "gone", answer: "yes" },
    ]);
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.match(stale.reason, /no longer waiting/);

    const twice = settleQuestions(open, [
      { id: "q1", answer: "pnpm" },
      { id: "q1", answer: "npm" },
    ]);
    assert.equal(twice.ok, false);
  });
});

describe("a question's choices survive the round trip", () => {
  // `proposalDeps`' case one column over, and the same silent failure: a JSON
  // column written by this module and read back by it, where a shape mismatch
  // returns an empty list rather than throwing. Here that is a question card
  // with no buttons on it — which, on a question the model asked as a
  // pick-one, is a question nobody can answer.
  it("reads back what was written, and an unreadable list as none", () => {
    const chat = createChat();
    createQuestions(chat.id, [
      { question: "Which package manager?", choices: ["pnpm", "npm"], allowText: false },
      { question: "Anything else?", choices: [], allowText: true },
    ]);

    const rows = listQuestions(chat.id);
    const byText = (q: string) => rows.find((r) => r.question === q)!;

    assert.deepEqual(questionChoices(byText("Which package manager?")), [
      "pnpm",
      "npm",
    ]);
    assert.equal(byText("Which package manager?").allow_text, 0);
    assert.deepEqual(questionChoices(byText("Anything else?")), []);
    // The two must stay distinguishable: a free-text question and a pick-one
    // whose list did not survive look identical on `choices` alone.
    assert.equal(byText("Anything else?").allow_text, 1);

    assert.deepEqual(questionChoices({ choices: "not json" }), []);
    assert.deepEqual(questionChoices({ choices: '{"a":1}' }), []);
    assert.deepEqual(questionChoices({ choices: '["a", null, 2]' }), ["a"]);
  });

  it("keeps a set in the order it was asked in", () => {
    // `chatOrder.test.ts`'s defect one table over: every question of one call
    // shares a `created_at`, so the tiebreak is the whole of what orders them,
    // and a random UUID shuffles a numbered list of questions the model wrote
    // in a deliberate order — and shuffles the answer message quoting them
    // back at it.
    // Ten, which is more than `askOperator` would accept — the cap is the
    // tool's and not the table's — because a burst is what makes the
    // regression fail every time rather than five times in six.
    const chat = createChat();
    const asked = Array.from({ length: 10 }, (_, i) => ({
      question: `question ${i}`,
      choices: [],
      allowText: true,
    }));
    createQuestions(chat.id, asked);

    const rows = listQuestions(chat.id);
    assert.equal(
      new Set(rows.map((q) => q.created_at)).size,
      1,
      "the tie this orders through has to actually be there",
    );
    assert.deepEqual(
      rows.map((q) => q.question),
      asked.map((q) => q.question),
    );
  });
});

describe("what a message does to an open question", () => {
  // The supersede rule is in the SQL rather than in the pure function above it —
  // `settleQuestions` decides the refusal and composes the message, and the
  // UPDATE settles the rows — so it is pinned here for `chatOrder.test.ts`'s
  // reason: the decision *is* the query, and both ways of getting it wrong are
  // silent. Left pending, the card sends the same answer again; superseded when
  // it was answered, the thread claims the operator never said what they said.
  it("supersedes it when the operator sends an ordinary message instead", async () => {
    const chat = createChat();
    createQuestions(chat.id, [
      { question: "Which package manager?", choices: [], allowText: true },
    ]);

    assert.equal((await sendChatMessage(chat.id, "never mind, do the other thing")).ok, true);

    const [question] = listQuestions(chat.id);
    assert.equal(question.status, "superseded");
    // Never answered, so nothing may claim an instant at which it was.
    assert.equal(question.answer, null);
    assert.equal(question.answered_at, null);

    await settle();
  });

  it("answers the ones named and supersedes the rest, in one turn", async () => {
    const chat = createChat();
    const [first, second] = createQuestions(chat.id, [
      { question: "Which package manager?", choices: ["pnpm", "npm"], allowText: true },
      { question: "Should it push?", choices: [], allowText: true },
    ]);

    const before = spawnCount;
    const res = await answerChatQuestions(chat.id, [
      { id: first.id, answer: "pnpm" },
    ]);
    assert.equal(res.ok, true);
    // One turn for the whole set, not one per answer: the message carries both
    // questions and the model reads them together.
    assert.equal(spawnCount - before, 1);

    const rows = listQuestions(chat.id);
    const answered = rows.find((q) => q.id === first.id)!;
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer, "pnpm");
    assert.ok(answered.answered_at !== null);
    assert.equal(rows.find((q) => q.id === second.id)!.status, "superseded");

    // And what the model is actually sent, which is the point of the whole
    // mechanism: the question, not a bare "pnpm".
    const sent = listMessages(chat.id).filter((m) => m.role === "user").pop()!;
    assert.match(sent.text, /Q: Which package manager\?\nA: pnpm/);
    assert.match(sent.text, /Q: Should it push\?\nA: \(not answered\)/);

    await settle();
  });

  it("refuses an answer to a question that is no longer open", async () => {
    const chat = createChat();
    const [question] = createQuestions(chat.id, [
      { question: "Which package manager?", choices: [], allowText: true },
    ]);
    assert.equal((await sendChatMessage(chat.id, "something else")).ok, true);
    await settle();

    // What a stale card sends. It must not start a turn: the conversation has
    // moved past the question, and the answer would read as a non sequitur the
    // model then proposes against.
    const before = spawnCount;
    const res = await answerChatQuestions(chat.id, [
      { id: question.id, answer: "pnpm" },
    ]);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /no longer waiting/);
    assert.equal(spawnCount - before, 0);
  });
});

describe("sendChatMessage", () => {
  it("starts one child when two messages race into one chat", async () => {
    const chat = createChat();
    const before = spawnCount;

    // Both callers read the row before either writes it: the first suspends on
    // `assistRefusal()`, which rescans every transcript under `CLAUDE_HOME`,
    // and the second runs its whole synchronous prefix while it is suspended.
    // Two tabs produce this, and so does one tab reloaded mid-turn — the page's
    // own `busy` flag is per-tab React state and guards nothing here.
    const outcomes = await Promise.all([
      sendChatMessage(chat.id, "first"),
      sendChatMessage(chat.id, "second"),
    ]);

    // The assertion that survives a change of interleaving: however the two
    // callers resume, one billed child joins the conversation and not two.
    assert.equal(spawnCount - before, 1, "a second child must not be spawned");

    assert.equal(outcomes.filter((o) => o.ok).length, 1);
    const loser = outcomes.find((o) => !o.ok);
    assert.ok(loser, "one of the two must be refused");
    if (loser.ok) return;
    assert.match(loser.reason, /still working on the last message/);

    const users = listMessages(chat.id).filter((m) => m.role === "user");
    assert.equal(users.length, 1, "the losing request must add nothing to the thread");
    assert.equal(getChat(chat.id)?.status, "thinking");

    await settle();
  });

  it("still takes a message after a turn that failed", async () => {
    // The claim is `status <> 'thinking'`, not `= 'idle'`: a failed turn is
    // exactly when an operator retries, and a claim that matched only 'idle'
    // would leave the chat permanently unusable with nothing said about why.
    const chat = createChat();

    const first = await sendChatMessage(chat.id, "hello");
    assert.equal(first.ok, true);
    await settle();
    assert.equal(getChat(chat.id)?.status, "failed");

    const before = spawnCount;
    const second = await sendChatMessage(chat.id, "again");
    assert.equal(second.ok, true);
    assert.equal(spawnCount - before, 1);
    await settle();
  });

  it("refuses a message sent while a turn is in flight", async () => {
    const chat = createChat();
    assert.equal((await sendChatMessage(chat.id, "hello")).ok, true);

    const before = spawnCount;
    const second = await sendChatMessage(chat.id, "and another thing");
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.match(second.reason, /still working on the last message/);
    assert.equal(spawnCount - before, 0);

    await settle();
  });
});

/**
 * A `claude` of the shape the fault needs: it prints a complete result object,
 * leaves a child holding the stdout it inherited, and exits straight away.
 */
const FAKE_CLAUDE = `#!/bin/sh
printf '{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"s1","total_cost_usd":0.01}\\n'
sleep 30 &
exit 0
`;

describe("settleOnExit", () => {
  it(
    "settles once the child exits, with a grandchild still holding stdout",
    {
      // POSIX shell and process groups; nothing here is meaningful on Windows.
      skip: process.platform === "win32" ? "no process groups on Windows" : false,
      // Without this the pre-fix wiring does not fail, it hangs: `node --test`
      // waits for ever on a promise nothing is going to resolve.
      timeout: 20_000,
    },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-chat-settle-"));
      const bin = path.join(dir, "fake-claude");
      fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });

      // Detached so the cleanup below can reach the grandchild through the
      // group: a test that leaks a process holding this pipe open leaves the
      // runner unable to exit. `realSpawn`, not the module's `spawn`, which is
      // the counter this file installed for the turn-claim case above.
      const child = realSpawn(bin, [], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      try {
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c: string) => (stdout += c));

        // Recorded rather than awaited. If `close` fires, the wiring this
        // replaces would have settled the turn too and the test proves nothing.
        let closed = false;
        child.on("close", () => {
          closed = true;
        });

        const startedAt = Date.now();
        const code = await new Promise<number | null>((resolve) =>
          settleOnExit(child, resolve),
        );
        const elapsed = Date.now() - startedAt;

        assert.equal(closed, false, "the grandchild should still hold stdout open");
        assert.ok(elapsed < 10_000, `settled after ${elapsed}ms`);
        assert.equal(code, 0);

        // The answer was in the buffer the whole time: parsed as an answer,
        // not thrown away as a timeout.
        const result = parseTurnOutput(stdout, "", code);
        assert.equal(result.status, "idle");
        assert.equal(result.text, "hi");
        assert.equal(result.sessionId, "s1");
        assert.equal(result.costUSD, 0.01);
      } finally {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        child.stdout.destroy();
        child.stderr.destroy();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

/* ------------------------------------------------------------------ */
/* Where the capability token is written down                          */
/* ------------------------------------------------------------------ */

describe("writeMcpConfig — the capability never lands in a shared directory", () => {
  it("puts the config in a directory of its own, not loose in the tmpdir", () => {
    // `/tmp/uf-mcp-<random>.json` was the whole defect: 1777 and world
    // readable, so `ls /tmp/uf-mcp-*.json` found a live capability without
    // guessing the random name, and any of the concurrent agents could run it.
    // The random name was never the protection; the directory was the leak.
    const file = writeMcpConfig("cap-token-abc");
    try {
      const dir = path.dirname(file);
      assert.notEqual(
        dir,
        os.tmpdir(),
        "the config is loose in the shared temp directory again",
      );
      assert.equal(path.basename(path.dirname(dir)), path.basename(os.tmpdir()));
      assert.deepEqual(fs.readdirSync(dir), ["config.json"]);

      // 0600 on the file and 0700 on the directory. Neither excluded anything
      // while the server and the agents were one uid — which is why this landed
      // with the split rather than before it.
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

      const written = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(
        written.mcpServers.uf.headers.Authorization,
        "Bearer cap-token-abc",
      );
    } finally {
      removeMcpConfig(file);
    }
  });

  it("names a base outside the shared tmpdir when the uids differ", () => {
    // The test process is not root, so `writeMcpConfig` above took the
    // unseparated fallback: with one uid there is no boundary to build and
    // pretending otherwise would be worse than saying so. What the constant
    // pins is that the separated path is not a directory every agent can list.
    assert.equal(path.isAbsolute(MCP_CONFIG_BASE), true);
    assert.notEqual(MCP_CONFIG_BASE, os.tmpdir());
    assert.equal(MCP_CONFIG_BASE.startsWith(`${os.tmpdir()}/`), false);
  });

  it("hands the config to a group, never to the uid that would read it", () => {
    // The half `0600` never did. Every child in this app is one uid, so a
    // config owned by the agents' uid is one a *work-cycle* agent can open the
    // moment it reads `--mcp-config <path>` out of a sibling's
    // /proc/<pid>/cmdline — which is public. What excludes it is a group it is
    // not in: 0710 on the directory (traverse, never list) and 0040 on the file.
    //
    // The ownership is a parameter precisely so this can be checked, because a
    // unit test in this process has one uid and cannot observe the refusal
    // itself. What is pinned is the decision — the modes, and that neither the
    // directory nor the file is left owned by the reader's group. The container
    // check that observes the EACCES is in docs/verification.md.
    const gid = process.getgid?.() ?? 0;
    const file = writeMcpConfig("cap-token-grouped", {
      gid,
      dirMode: 0o710,
      fileMode: 0o040,
    });
    const dir = path.dirname(file);
    try {
      const dirStat = fs.statSync(dir);
      const fileStat = fs.statSync(file);

      assert.equal(dirStat.mode & 0o777, 0o710);
      assert.equal(fileStat.mode & 0o777, 0o040);
      // Nothing for "other" on either, which is what a work-cycle agent is
      // reduced to once the owner and group checks have both refused it.
      assert.equal(dirStat.mode & 0o007, 0);
      assert.equal(fileStat.mode & 0o007, 0);
      assert.equal(dirStat.gid, gid);
      assert.equal(fileStat.gid, gid);
    } finally {
      removeMcpConfig(file);
    }
    assert.equal(fs.existsSync(dir), false);
  });

  it("takes the directory with it when the turn ends", () => {
    // A per-turn directory left behind is a slow leak in a path nothing else
    // sweeps, and one still holding its file is the original defect with an
    // extra step. `removeMcpConfig` runs on every settle path, including the
    // partial-write one inside `writeMcpConfig` itself.
    const file = writeMcpConfig("cap-token-xyz");
    const dir = path.dirname(file);
    removeMcpConfig(file);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(dir), false);

    // Idempotent: `land` can be reached twice (a timeout racing an exit), and a
    // second removal must not throw out of a settle path.
    removeMcpConfig(file);
  });
});
