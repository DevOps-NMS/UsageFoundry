import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentDTO } from "../../../lib/apiTypes";

/**
 * What `POST /api/agents` answers with, on the way in and on the way back.
 *
 * The registry had no page for as long as it existed, so these routes were
 * reachable by `curl` and by nothing else — and the refusals below are written
 * to be *shown*: `normalizeAgentInput` spends a paragraph on each because every
 * one of them is a mistake Claude Code itself accepts in silence, and the whole
 * point of putting the check here is that a person is looking at a form when it
 * fires. Now that a form is what sends this, the shape of the answer is load
 * bearing rather than incidental. The page reads `agent` on the way back and
 * `error` on a refusal; a route that answered `{ message: … }` instead would
 * leave the operator looking at "Could not save the agent" with the reason —
 * which field, and what the CLI would do about it — thrown away, and nothing
 * would fail, throw or typecheck differently.
 *
 * The duplicate-name refusal is the other half and cannot be reached any other
 * way: `withNameConflict` turns SQLite's unique-index violation into the
 * sentence the form shows, so it is only a sentence at all once there is a
 * database with a row already in it.
 *
 * It opens one for that reason, into a throwaway directory, `chatTurn.test.ts`'
 * harness — `DATA_DIR` and `CLAUDE_HOME` are read into `config.ts` at module
 * load, so they are set before anything requires it and the assertion in
 * `before` is what makes a change to that fail loudly rather than write into the
 * operator's own database. `CLAUDE_HOME` as well as `DATA_DIR` because `GET`
 * walks `$CLAUDE_CONFIG_DIR/agents` for the definitions this app did not write,
 * and a suite that read the machine's own would report a different answer on
 * every machine.
 */

let route: typeof import("./route");
let byId: typeof import("./[id]/route");
let root: string;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-agents-route-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Both, because `CLAUDE_CONFIG_DIR` only *falls back* to `CLAUDE_HOME` — an
  // environment that sets it (this one does) would otherwise send the walk into
  // the machine's own `~/.claude/agents` and answer differently per machine.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");

  fs.mkdirSync(path.join(root, "claude", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "claude", "agents", "not-its-name.md"),
    "---\nname: on-disk-one\ndescription: The one this app did not write.\n---\n\nBody.\n",
  );

  const config = await import("../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  route = await import("./route");
  byId = await import("./[id]/route");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function read(res: Response): Promise<{ agent?: AgentDTO; error?: string }> {
  return (await res.json()) as { agent?: AgentDTO; error?: string };
}

/** A definition the routes accept, so each test only varies what it is about. */
function definition(over: Record<string, unknown> = {}) {
  return {
    name: "reviewer",
    description: "Reads a diff for correctness bugs. Use before landing.",
    prompt: "You review changes. Report what is wrong and nothing else.",
    model: "claude-sonnet-5",
    ...over,
  };
}

describe("POST /api/agents — the create path", () => {
  it("answers with the saved agent, and lists it afterwards", async () => {
    const res = await post(definition());
    const body = await read(res);

    assert.equal(res.status, 200, body.error ?? "(no message)");
    assert.ok(body.agent, "the create answered without an agent to show");
    assert.equal(body.agent.name, "reviewer");
    assert.equal(body.agent.model, "claude-sonnet-5");
    assert.equal(
      body.agent.usable,
      true,
      "a row the routes just accepted must be one every door will accept",
    );
    assert.ok(body.agent.id, "a saved agent with no id cannot be edited or deleted");

    const listed = (await (await route.GET()).json()) as {
      agents: AgentDTO[];
      ambient: { name: string }[];
    };
    assert.deepEqual(
      listed.agents.map((a) => a.name),
      ["reviewer"],
    );
    // The other half of the payload, and the reason the page can say the
    // registry is a part of the set rather than the whole of it: the ambient
    // definitions are reported beside the saved ones and never merged into them.
    assert.deepEqual(
      listed.ambient.map((a) => a.name),
      ["on-disk-one"],
    );
  });

  it("stores a blank model as inherit rather than as an id", async () => {
    const body = await read(await post(definition({ name: "tidier", model: "" })));
    assert.equal(body.agent?.model, null);
  });
});

describe("POST /api/agents — the refusal paths", () => {
  /**
   * Each of these is a sentence rather than a status, and the sentence is the
   * deliverable: the operator has typed something Claude Code would accept and
   * then ignore, so "400" on its own returns them to the same form with the same
   * text in it and no idea which field is wrong.
   */
  it("refuses a tool list, and says why capability is not an agent's to carry", async () => {
    const res = await post(definition({ name: "armed", tools: ["Bash"] }));
    const body = await read(res);

    assert.equal(res.status, 400);
    assert.match(body.error ?? "", /cannot carry a tool list/);
    assert.match(body.error ?? "", /guard set/);
  });

  it("refuses a name Claude Code already answers to, and names it", async () => {
    const res = await post(definition({ name: "general-purpose" }));
    const body = await read(res);

    assert.equal(res.status, 400);
    assert.match(body.error ?? "", /general-purpose/);
  });

  it("refuses a missing description, and says what it is for", async () => {
    const res = await post(definition({ name: "quiet", description: "  " }));
    const body = await read(res);

    assert.equal(res.status, 400);
    // The ground the field stands on moved with the singular `--agent` flag:
    // nothing chooses on a description any more, but the CLI will not register
    // a member without one, so the run fails at the spawn rather than quietly
    // starting as nobody. The sentence has to say that, not the old one about
    // a specialist never being picked.
    assert.match(body.error ?? "", /will not register/);
    assert.match(body.error ?? "", /fail the moment it spawned/);
  });

  it("refuses a missing prompt", async () => {
    const res = await post(definition({ name: "empty", prompt: "" }));
    assert.equal(res.status, 400);
    assert.match((await read(res)).error ?? "", /needs a prompt/);
  });

  /**
   * The one refusal that is not `normalizeAgentInput`'s: it comes off the unique
   * index, through `withNameConflict`, and it is the answer to the form's own
   * idiom — typing a name that already exists is how somebody asks to edit that
   * agent, so the sentence has to say that rather than only refusing.
   */
  it("refuses a duplicate name, and points at the agent that has it", async () => {
    await post(definition({ name: "twice" }));
    const res = await post(definition({ name: "TWICE", description: "Another." }));
    const body = await read(res);

    assert.equal(res.status, 400);
    assert.match(body.error ?? "", /already exists/);
    assert.match(body.error ?? "", /update it/);
  });
});

describe("PUT and DELETE /api/agents/[id] — editing and removing one", () => {
  it("replaces the definition and refuses the same things a create does", async () => {
    const created = (await read(await post(definition({ name: "editable" })))).agent;
    assert.ok(created);

    const ok = await byId.PUT(
      new Request(`http://localhost/api/agents/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(definition({ name: "edited", description: "Now this." })),
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    const edited = await read(ok);
    assert.equal(ok.status, 200, edited.error ?? "(no message)");
    assert.equal(edited.agent?.name, "edited");
    assert.equal(edited.agent?.description, "Now this.");

    // An edit into a shape the CLI would drop is the same mistake as saving one
    // that way, and the CLI reports neither.
    const refused = await byId.PUT(
      new Request(`http://localhost/api/agents/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(definition({ name: "edited", prompt: "" })),
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    assert.equal(refused.status, 400);
    assert.match((await read(refused)).error ?? "", /needs a prompt/);
  });

  it("deletes one, and says so rather than reporting success twice", async () => {
    const created = (await read(await post(definition({ name: "doomed" })))).agent;
    assert.ok(created);

    const gone = await byId.DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ id: created.id }),
    });
    assert.equal(gone.status, 200);

    const again = await byId.DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ id: created.id }),
    });
    assert.equal(again.status, 404);
  });
});
