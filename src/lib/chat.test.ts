import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

import type { ChatProposalRow } from "./chat";
import type { RunTemplate } from "./templates";
import type { RunGuards } from "./settings";

/**
 * Covers `planProposal`, `chatPrompt`, `githubSlug` and the turn claim in
 * `sendChatMessage`, and only those.
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
 *    agent running somewhere nobody chose.
 *  - `composeTask` decides what the agent is actually told. It is the one half
 *    of a run the chat may write, and getting the two halves the wrong way
 *    round — or dropping one — is a run that does something adjacent to the
 *    task, expensively, without failing.
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
  chatPrompt,
  composeTask,
  createChat,
  getChat,
  listMessages,
  planProposal,
  sendChatMessage,
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
 */
const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn;
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
  budget: {
    maxIterations: 4,
    maxDurationMinutes: 60,
    maxRunCostUSD: 5,
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
    prompt_override: null,
    mount_id: null,
    folder: null,
    status: "pending",
    title: "Fix #412",
    ...over,
  }) as Pick<
    ChatProposalRow,
    | "task"
    | "mount_id"
    | "folder"
    | "status"
    | "title"
    | "template_id"
    | "prompt_override"
  >;

describe("planProposal", () => {
  it("takes every guard from the template and none from the proposal", () => {
    const plan = planProposal(proposal(), template, defaults);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    assert.equal(plan.input.permissionMode, "acceptEdits");
    assert.equal(plan.input.isolate, true);
    assert.deepEqual(plan.input.budget, template.budget);
  });

  it("leads with the template's prompt and marks where the chat's task starts", () => {
    const plan = planProposal(proposal(), template, defaults);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    assert.ok(plan.input.prompt.startsWith("Work carefully and commit as you go."));
    assert.ok(plan.input.prompt.includes("## This run specifically"));
    assert.ok(plan.input.prompt.includes("Fix the flaky auth test in #412."));
  });

  it("falls back to the template's folder when the proposal names none", () => {
    const plan = planProposal(proposal(), template, defaults);
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
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.folder, "");
  });

  it("refuses when the named template is gone, rather than using the defaults", () => {
    // The quiet failure this rules out: a proposal the operator approved
    // because the card said "Fix a bug" starting under a different permission
    // mode entirely, because the template was tidied away in between.
    const plan = planProposal(proposal(), null, defaults);
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /no longer exists/);
  });

  it("refuses when nothing names a folder", () => {
    const plan = planProposal(
      proposal(),
      { ...template, mountId: null, folder: null },
      defaults,
    );
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /names a folder/);
  });

  it("refuses a proposal that was already decided", () => {
    for (const status of ["approved", "rejected", "failed"] as const) {
      const plan = planProposal(proposal({ status }), template, defaults);
      assert.equal(plan.ok, false, `${status} should not be approvable`);
    }
  });

  it("refuses an empty task", () => {
    const plan = planProposal(proposal({ task: "   " }), template, defaults);
    assert.equal(plan.ok, false);
  });

  const untemplated = (over: Partial<ChatProposalRow> = {}) =>
    proposal({ template_id: null, mount_id: "workspace", folder: "acme/api", ...over });

  it("takes every guard from the operator's defaults when there is no template", () => {
    const plan = planProposal(untemplated(), null, defaults);
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
    const plan = planProposal(untemplated(), null, defaults);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.input.prompt, "Fix the flaky auth test in #412.");
  });

  it("refuses an untemplated proposal that names no folder", () => {
    const plan = planProposal(
      proposal({ template_id: null }),
      null,
      defaults,
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
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.ok(plan.input.prompt.startsWith("Work carefully and commit as you go."));
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
