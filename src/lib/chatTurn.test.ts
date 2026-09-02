import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";

/**
 * Three things a chat does that fail expensively and say nothing: what happens
 * to the row when starting a turn throws, what happens to a proposal when the
 * approval it is clicked into is refused by something that will have cleared by
 * the time anyone looks again, and which turn a child's answer is allowed to
 * settle.
 *
 * The first earns a place in this suite on the same grounds as the rest of it —
 * a silent, expensive failure with no other way out. `runTurn` mints the
 * capability and writes the MCP config *before* it constructs the promise it
 * returns, and it is not `async`, so a throw from either happens while the call
 * expression is being evaluated and skips the `.catch` attached to its result.
 * The row has already been set to `thinking` by then, `sendChatMessage` refuses
 * to send into a thinking chat, and the only other thing in the codebase that
 * clears that flag is `reconcileChatsOnBoot` — a server restart. One failed
 * `fs.writeFileSync` into `os.tmpdir()` and the thread is dead for good.
 *
 * The second is the same shape one gate along, and its cost is the work rather
 * than the thread: `failed` is terminal on a proposal — `planProposal` refuses
 * anything not `pending` and the route only ever offers what is pending — so a
 * proposal marked that way by the install ceiling or by a lost data-directory
 * claim is gone, and getting it back is a billed turn asking the chat to
 * propose it again. Nothing throws, the operator is told the ceiling stopped
 * their run, and every word of that sentence is true except what it implies
 * about the proposal.
 *
 * The third is the same shape as the first — a state transition rather than a
 * return value — and it is the one nothing in the process can notice. `endTurn`
 * settles the row to `failed` and returns while the child it signalled is still
 * working through an eight-second ladder, and `failed` is what invites the
 * operator to retry; so the stopped turn's child can exit into a row a *later*
 * turn has claimed. Latched on status alone, it settled that row: the answer to
 * a question nobody asked, its cost and session id adopted, the live child left
 * unwatched by a sweeper that reads only `thinking` rows, that child's own
 * answer discarded in silence against an `idle` row, and a third billed message
 * admitted by a guard that reads the row rather than the process. Every step is
 * a successful write; nothing throws and the page looks right.
 *
 * Both live in their own file rather than in `chat.test.ts` because they touch
 * SQLite: `DATA_DIR` and `CLAUDE_HOME` are read into `config.ts` at module
 * load, so they have to be set before anything requires it, which a file that
 * statically imports `./chat` cannot do. `node --test` gives each file its own
 * process; the assertion in `before` is what makes a change to that fail loudly
 * instead of writing into the operator's own database.
 */

let chat: typeof import("./chat");
let settings: typeof import("./settings");
let dbMod: typeof import("./db");
let installBudget: typeof import("./installBudget");
let root: string;
let mountId: string;
let tmpdirBefore: string | undefined;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-chat-turn-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  // Wins over WORKSPACE_ROOT, and any container this ships in has it set —
  // including the one an agent editing this file runs in, whose mounts are real.
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
  // Nothing in here should reach a spawn. A `claude` that does not exist is
  // what makes a regression that gets that far a failed test rather than a
  // billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  mountId = config.WORKSPACE_MOUNTS[0].id;

  chat = await import("./chat");
  settings = await import("./settings");
  dbMod = await import("./db");
  installBudget = await import("./installBudget");

  // The snapshot a creation path reads asks the provider for its own
  // utilisation, and there is no network here — see the same line in
  // `runOrigin.test.ts`.
  settings.saveSettings({ planUsageFromApi: false });
});

after(async () => {
  // The approval below creates a real run, and `createRun` ends in
  // `promoteQueued`, which starts one in the background against a `claude` that
  // does not exist. Given a tick to fall over on its own before the directory
  // it is working in is removed.
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (tmpdirBefore === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = tmpdirBefore;
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * First in the file deliberately: the case below breaks `TMPDIR` for the rest
 * of the process, and a run promoted under a `TMPDIR` that does not exist fails
 * for a reason this has nothing to say about.
 */
describe("approving under a refusal that clears on its own", () => {
  // The ceiling is install-wide state in a database every other case here
  // shares. Left up by an assertion that failed before the line putting it
  // back, it refuses every run and every turn the rest of the file starts, and
  // what anybody reads first is a failure somewhere this change never touched.
  after(() => settings.saveSettings({ installDailyCostLimitUSD: null }));

  it("refuses the click and leaves the proposal pending", () => {
    const thread = chat.createChat();
    const proposal = chat.createProposal(thread.id, {
      templateId: null,
      title: "Fix the flaky test",
      task: "Find out why the suite is flaky and fix it.",
      promptOverride: null,
      mountId,
      folder: "project",
    });

    // The operator's install-wide ceiling, and enough spend inside its rolling
    // window to have reached it. A settled turn's own spend row is the cheapest
    // money to put in that window without inventing a run to have spent it.
    settings.saveSettings({ installDailyCostLimitUSD: 1 });
    dbMod
      .db()
      .prepare(
        "INSERT INTO chat_turn_spend (chat_id, ts, cost_usd) VALUES (?, ?, ?)",
      )
      .run(thread.id, Date.now(), 5);
    assert.ok(
      installBudget.installBudgetRefusal(),
      "the ceiling must be tripped for this case to mean anything",
    );

    const refused = chat.approveRunBatch(thread.id, [proposal.id]);
    assert.match(
      refused.refused ?? "",
      /in the last 24 hours/,
      "the click must be refused as a whole, with the reason on it",
    );
    assert.deepEqual(refused.started, []);
    assert.deepEqual(
      refused.failed,
      [],
      "a click that decided nothing must report no proposal as having failed",
    );

    assert.equal(chat.getProposal(proposal.id)?.status, "pending");
    assert.deepEqual(
      chat.pendingProposals(thread.id).map((p) => p.id),
      [proposal.id],
      "the proposal must still be offered for decision",
    );

    // The window rolls, or the operator raises the ceiling. Nothing about the
    // proposal was ever wrong, so the same click now starts it.
    settings.saveSettings({ installDailyCostLimitUSD: null });
    const started = chat.approveRunBatch(thread.id, [proposal.id]);
    assert.equal(started.refused, undefined);
    assert.deepEqual(started.failed, []);
    assert.equal(started.started.length, 1, "the run must start on the retry");
    assert.equal(chat.getProposal(proposal.id)?.status, "approved");
  });
});

/**
 * The control, and the half more easily broken: "a refusal must not decide a
 * proposal" applied to *every* refusal would leave a proposal that can never
 * start pending for ever, offered on the page at every reload. Its own suite so
 * it runs after the ceiling above has been put back whatever that one did.
 */
describe("approving something that can never start", () => {
  it("still marks the proposal failed", () => {
    const thread = chat.createChat();
    const proposal = chat.createProposal(thread.id, {
      templateId: null,
      title: "Work in a folder nobody mounted",
      task: "do the thing",
      promptOverride: null,
      mountId,
      folder: "no-such-project",
    });

    const outcome = chat.approveRunBatch(thread.id, [proposal.id]);
    assert.equal(outcome.refused, undefined, "this is a verdict, not a hold");
    assert.equal(outcome.failed.length, 1);
    assert.equal(chat.getProposal(proposal.id)?.status, "failed");
    assert.deepEqual(chat.pendingProposals(thread.id), []);
  });
});

/**
 * `chat.ts` calls `spawn` through the module object under the test build's
 * CommonJS emit, so replacing it here is what the turns below get — the same
 * device `chat.test.ts` uses to count children, with the closing left to the
 * case: which child exits, and *when* relative to the other one, is the whole
 * fault.
 *
 * Kept out of `before` and restored in `after` so it stands for one `describe`
 * rather than for the file: the approval above starts a real run, and a fake
 * `claude` standing in for the one that is supposed to be missing would make
 * that case pass for a reason it is not testing.
 */
const childProcess = require("node:child_process") as Record<string, unknown>;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (sig: NodeJS.Signals) => boolean;
}

describe("a stopped turn's child exiting into the turn that replaced it", () => {
  const realSpawn = childProcess.spawn;
  const started: FakeChild[] = [];

  before(() => {
    childProcess.spawn = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        // What `endTurn`'s ladder re-checks between its signals. A fake dies
        // when this case says so and not when it is asked to.
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        // `signalTree` falls through to this because there is no `pid`, and a
        // throw from here would be swallowed rather than reported.
        kill: () => true,
      }) as FakeChild;
      started.push(child);
      return child;
    };
  });

  after(() => {
    childProcess.spawn = realSpawn;
    // Anything still open would hold a capability and an MCP config file that
    // only a settle removes.
    for (const child of started) {
      if (child.exitCode === null) {
        child.exitCode = 0;
        child.emit("close", 0);
      }
    }
  });

  /** Let a landed turn finish writing before the next assertion reads the row. */
  const drain = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  };

  /** The CLI's final JSON object, which is the only thing `land` reads. */
  const finalJson = (reply: string, session: string) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: reply,
      session_id: session,
      total_cost_usd: 0.25,
    });

  /**
   * The child answers and goes. The tick between the two is load-bearing: a
   * `PassThrough` delivers `data` on the next turn of the loop, so a `close`
   * emitted in the same one would land an empty answer and test nothing.
   */
  async function answer(child: FakeChild, stdout: string): Promise<void> {
    child.stdout.write(stdout);
    await new Promise((r) => setImmediate(r));
    child.exitCode = 0;
    child.emit("close", 0);
    await drain();
  }

  it("changes nothing, and leaves the live turn settleable", async () => {
    const row = chat.createChat();
    const turns = (globalThis as unknown as {
      __ufChatTurns?: Map<string, FakeChild>;
    }).__ufChatTurns;

    const first = await chat.sendChatMessage(row.id, "message one");
    if (!first.ok) assert.fail(`turn one did not start: ${first.reason}`);
    assert.equal(chat.getChat(row.id)?.status, "thinking");
    const childOne = turns?.get(row.id);
    assert.ok(childOne, "turn one registered no child to stop");

    // Stop. The row is usable immediately and on purpose — `endTurn` does not
    // wait for the child, because the turns that need ending are the ones whose
    // `close` is not coming.
    const stop = chat.cancelChatTurn(row.id);
    assert.equal(stop.ok, true);
    assert.equal(chat.getChat(row.id)?.status, "failed");

    // Which is what invites the retry, inside the eight seconds child one has
    // left to live.
    const second = await chat.sendChatMessage(row.id, "message two");
    if (!second.ok) assert.fail(`turn two did not start: ${second.reason}`);
    assert.equal(chat.getChat(row.id)?.status, "thinking");
    const childTwo = turns?.get(row.id);
    assert.ok(childTwo && childTwo !== childOne, "turn two started no child of its own");

    // Child one answers now, into a row turn two owns.
    await answer(childOne, finalJson("reply-from-the-stopped-turn", "session-one"));

    const mid = chat.getChat(row.id);
    assert.equal(mid?.status, "thinking", "the stopped turn's child settled the live turn");
    assert.equal(mid?.session_id, null, "the stopped turn's session id was adopted");
    assert.equal(mid?.cost_usd, 0, "the stopped turn's cost was charged to the live turn");
    assert.notEqual(
      mid?.turn_started_at,
      null,
      "the live turn lost the deadline the sweeper reads, so nothing is watching it",
    );
    assert.ok(
      !chat.listMessages(row.id).some((m) => m.text.includes("reply-from-the-stopped-turn")),
      "the stopped turn's answer was appended to the conversation that replaced it",
    );

    // The guard that keeps one billed child per conversation reads the row, so
    // a row settled early opens it while child two is still running.
    const third = await chat.sendChatMessage(row.id, "message three");
    assert.equal(third.ok, false, "a third billed child was admitted beside the live one");
    assert.equal(
      turns?.get(row.id),
      childTwo,
      "the refused message started a child anyway",
    );

    // And the live turn still settles, which is the direction the repair breaks
    // in: a latch that matched nothing would strand every turn at `thinking`.
    await answer(childTwo, finalJson("reply-from-the-live-turn", "session-two"));

    const settled = chat.getChat(row.id);
    assert.equal(settled?.status, "idle");
    assert.equal(settled?.session_id, "session-two");
    assert.equal(settled?.cost_usd, 0.25);
    assert.equal(settled?.turn_started_at, null);
    assert.ok(
      chat.listMessages(row.id).some((m) => m.text === "reply-from-the-live-turn"),
      "the live turn's answer never reached the conversation",
    );

    // The install-wide ceiling reads the dated rows rather than the running
    // total, so a settle refused above must have left none behind here either.
    const spend = dbMod
      .db()
      .prepare("SELECT cost_usd FROM chat_turn_spend WHERE chat_id=?")
      .all(row.id) as { cost_usd: number }[];
    assert.deepEqual(
      spend.map((s) => s.cost_usd),
      [0.25],
      "the stopped turn's spend was dated into the live turn's window",
    );
  });
});

describe("sendChatMessage when the turn cannot be started", () => {
  it("leaves the row failed, not thinking, and says why", async () => {
    const row = chat.createChat();

    // The issue's own reproduction, without patching anything: `writeMcpConfig`
    // writes into `os.tmpdir()`, which reads `TMPDIR` on every call.
    tmpdirBefore = process.env.TMPDIR;
    process.env.TMPDIR = path.join(root, "no-such-directory");

    const res = await chat.sendChatMessage(row.id, "propose some work");

    assert.equal(res.ok, false, "the caller must be told the turn never started");
    if (res.ok) return;
    assert.match(res.reason, /Could not start the turn/);

    const after = chat.getChat(row.id);
    assert.equal(after?.status, "failed");
    assert.match(after?.error ?? "", /Could not start the turn/);
    assert.match(after?.error ?? "", /ENOENT/, "the underlying error must survive");

    // And in the thread, where the operator is looking.
    const said = chat.listMessages(row.id).map((m) => m.text);
    assert.ok(
      said.some((t) => /Could not start the turn/.test(t)),
      "the failure must be visible in the conversation",
    );

    // The capability outlives the turn otherwise: `revokeCapability` is only
    // reachable through `land`, inside the promise this failure never reaches.
    // Read off the singleton because the public reader takes the token, and the
    // token belonged to the turn that failed.
    const caps = (globalThis as unknown as { __ufChatCaps?: Map<string, unknown> })
      .__ufChatCaps;
    assert.equal(caps?.size ?? 0, 0, "a turn that never spawned left a live capability");

    // A second message must go out — the point of not stranding the row.
    assert.notEqual(chat.getChat(row.id)?.status, "thinking");
  });
});
