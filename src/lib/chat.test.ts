import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CHAT_TIMEOUT_MS,
  STALE_TURN_MARGIN_MS,
  chatPrompt,
  composeTask,
  parseTurnOutput,
  planProposal,
  settleOnExit,
  staleTurn,
  type ChatProposalRow,
  type ChatRow,
} from "./chat";
import { githubSlug } from "./workspace";
import type { RunTemplate } from "./templates";
import type { RunGuards } from "./settings";

/**
 * Covers `planProposal`, `chatPrompt`, `githubSlug` and `settleOnExit`, and only
 * those.
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
 *  - `settleOnExit` decides whether a turn ever ends. It is the only one here
 *    that is not a pure function, and it earns the subprocess because the fault
 *    it guards against cannot be reproduced without one: pipes a grandchild
 *    holds open are the whole mechanism. Wired to `close` alone, a chat whose
 *    answer is already sitting in the buffer reads as "Thinking…" for ten
 *    minutes and then as a timeout — or for ever, with no error recorded.
 *  - `staleTurn` is what is left when even that does not fire: the only thing
 *    enforcing the ten-minute bound on a turn whose child this process can no
 *    longer hear from at all. Wrong in one direction it kills a live turn
 *    mid-answer; wrong in the other it never fires, and the bound quietly stops
 *    existing — a thread that says "Thinking…" for ever, refusing every
 *    message, with nothing short of a server restart able to clear it.
 */

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
      // runner unable to exit.
      const child = spawn(bin, [], {
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
