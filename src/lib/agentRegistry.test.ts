import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_AGENT_DRAFT,
  agentDraft,
  agentIncompleteReason,
  agentPayload,
  ambientClash,
  type AgentDraft,
} from "./agentRegistry";
import type { AgentDTO, AmbientAgentDTO } from "./apiTypes";

/**
 * The three decisions the agents page makes for itself.
 *
 * Each is silent in the way the rest of this module is: nothing throws, it
 * typechecks, and the page renders — the failure is a sentence the operator
 * needed and did not get, or a field on the wire nobody meant to put there.
 */

function saved(over: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    name: "reviewer",
    description: "Reads a diff for correctness bugs.",
    prompt: "You review changes.",
    model: null,
    usable: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function onDisk(over: Partial<AmbientAgentDTO> = {}): AmbientAgentDTO {
  return {
    name: "reviewer",
    description: "The one in ~/.claude",
    scope: "user",
    path: "/home/me/.claude/agents/reviewer.md",
    ...over,
  };
}

describe("agentPayload — what a saved agent may carry onto the wire", () => {
  /**
   * The capability boundary, as an assertion rather than a paragraph.
   *
   * An agent is a name, a description, a prompt and optionally a model. It holds
   * no tool list, no permission mode, no budget, no folder and no isolation
   * choice, and the absence is what lets a chat proposal, a workflow block and a
   * template all name one without any of them becoming a route to
   * `--permission-mode`. A form is where such a field would first appear, and it
   * would appear quietly: an extra key on the draft, a spread into the body, a
   * column added to match, and nothing in this app would report it.
   */
  it("sends four fields and no fifth", () => {
    assert.deepEqual(Object.keys(agentPayload(EMPTY_AGENT_DRAFT)).sort(), [
      "description",
      "model",
      "name",
      "prompt",
    ]);
  });

  it("cannot carry a field the draft picked up from somewhere else", () => {
    // What a widened form would look like from here: the extra key exists on the
    // object being handed over, and the projection is what stops it travelling.
    const widened = {
      ...EMPTY_AGENT_DRAFT,
      name: "reviewer",
      permissionMode: "bypassPermissions",
      tools: ["Bash"],
    } as AgentDraft;

    const body = agentPayload(widened) as unknown as Record<string, unknown>;
    assert.equal(body.permissionMode, undefined);
    assert.equal(body.tools, undefined);
    assert.equal(body.name, "reviewer");
  });

  it("sends a blank model as null rather than as an empty id", () => {
    assert.equal(agentPayload({ ...EMPTY_AGENT_DRAFT, model: "   " }).model, null);
    assert.equal(
      agentPayload({ ...EMPTY_AGENT_DRAFT, model: " claude-sonnet-5 " }).model,
      "claude-sonnet-5",
    );
  });

  it("loads a saved row back into the form it was typed in", () => {
    assert.deepEqual(agentDraft(saved({ model: "sonnet" })), {
      name: "reviewer",
      description: "Reads a diff for correctness bugs.",
      prompt: "You review changes.",
      model: "sonnet",
    });
    // A null model is an empty box, not the string "null".
    assert.equal(agentDraft(saved()).model, "");
  });
});

describe("ambientClash — a saved name a file on disk also answers to", () => {
  /**
   * Not a refusal, and it must not become one: which definition the CLI uses is
   * unverified, the ambient set is per-cwd, and the operator is the only one who
   * can resolve it. What this pins is that the page can *see* it — with no
   * annotation, a saved agent and a file on disk under one name are two records
   * this app shows separately and never says anything about.
   */
  it("finds the definition on disk under the same name", () => {
    assert.equal(ambientClash("reviewer", [onDisk()])?.path, onDisk().path);
  });

  it("folds case, because the registry and the CLI both key one agent per name", () => {
    assert.ok(ambientClash("Reviewer", [onDisk()]));
    assert.ok(ambientClash("  reviewer  ", [onDisk()]));
    assert.ok(ambientClash("reviewer", [onDisk({ name: "REVIEWER" })]));
  });

  it("says nothing about a name nothing on disk uses", () => {
    assert.equal(ambientClash("tidier", [onDisk()]), null);
    assert.equal(ambientClash("reviewer", []), null);
  });

  it("treats an empty box as no name rather than matching an empty file", () => {
    assert.equal(ambientClash("   ", [onDisk({ name: "" })]), null);
  });
});

describe("agentIncompleteReason — a row that has decayed", () => {
  it("says nothing about a row every door will accept", () => {
    assert.equal(agentIncompleteReason(saved()), null);
  });

  /**
   * Which field is missing is the half `agentRefusal` cannot say. That sentence
   * is shown at a door where the agent was *named* — a run form, a template — so
   * it can only say "its description or its prompt"; this one is shown on the
   * row, beside the box that is empty.
   */
  it("names the missing field", () => {
    const noPrompt = agentIncompleteReason(saved({ prompt: "", usable: false }));
    assert.match(noPrompt ?? "", /no prompt/);
    assert.doesNotMatch(noPrompt ?? "", /description/);

    const noDescription = agentIncompleteReason(
      saved({ description: "  ", usable: false }),
    );
    assert.match(noDescription ?? "", /no description/);
  });

  it("names both when both are gone", () => {
    const reason =
      agentIncompleteReason(saved({ description: "", prompt: "", usable: false })) ?? "";
    assert.match(reason, /description/);
    assert.match(reason, /prompt/);
  });

  /**
   * `usable` is the server's verdict and this reads it rather than deriving a
   * second one. A row the server calls unusable for a reason this build cannot
   * see still has to say *something* — silence would render as a row that is
   * fine, which is the one reading that is certainly wrong.
   */
  it("still says something about a row it cannot explain", () => {
    assert.ok(agentIncompleteReason(saved({ usable: false })));
  });
});
