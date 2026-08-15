import type { AgentDTO, AmbientAgentDTO } from "./apiTypes";

/**
 * The agents page's own model — client-safe and pure.
 *
 * `canvasGraph.ts`' shape and its reason: the page that edits a saved record
 * needs a few decisions of its own, and a decision written inside a `"use
 * client"` component is a decision nothing can test — `src/lib` is what
 * `tsconfig.test.json` compiles.
 *
 * What is deliberately **not** here is validation. `normalizeAgentInput` is the
 * authority on what an agent may be, it lives beside a database and a
 * filesystem so a page cannot import it, and a second copy of those refusals in
 * the browser would be a second set of rules to keep in step — the workflow
 * editor already settled that question the same way, by sending the draft to the
 * server and rendering the sentence that comes back. Every refusal the operator
 * sees on this page is the server's own words.
 */

/* ------------------------------------------------------------------ */
/* What the form holds, and what it is allowed to send                 */
/* ------------------------------------------------------------------ */

/**
 * The four fields an agent has, as strings a form can hold.
 *
 * `model` is a string here where `AgentDTO.model` is nullable: an empty box and
 * "inherit the run's model" are the same answer, and `agentPayload` is where
 * that collapses.
 */
export interface AgentDraft {
  name: string;
  description: string;
  prompt: string;
  model: string;
}

export const EMPTY_AGENT_DRAFT: AgentDraft = {
  name: "",
  description: "",
  prompt: "",
  model: "",
};

/** A saved row loaded back into the form. */
export function agentDraft(agent: AgentDTO): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    prompt: agent.prompt,
    model: agent.model ?? "",
  };
}

/** Exactly what `POST`/`PUT /api/agents` is sent. Nothing else may ride along. */
export interface AgentPayload {
  name: string;
  description: string;
  prompt: string;
  model: string | null;
}

/**
 * The draft as the wire carries it.
 *
 * A named projection rather than a spread, and that is the whole point of the
 * function: an agent carries a role and never a capability, so the one thing
 * this form must never grow is a control that widens what a run may do. There
 * are no columns for a tool list, a permission mode, a budget, a folder or an
 * isolation choice — the routes to `--permission-mode` are two and this is not
 * a third — and a spread would make the payload whatever the draft object
 * happened to be carrying, which is how a field added upstream reaches an argv
 * nobody meant it to. Written out by name, adding one is a decision somebody has
 * to make here, in front of the test that counts the keys.
 *
 * The values themselves are sent as they were typed. `normalizeAgentInput`
 * trims, bounds and refuses; sending it something already half-normalized here
 * would put two readings of the same field in two places.
 */
export function agentPayload(draft: AgentDraft): AgentPayload {
  const model = draft.model.trim();
  return {
    name: draft.name,
    description: draft.description,
    prompt: draft.prompt,
    // Blank is "inherit", and null is how that is spelled everywhere else in
    // this app. It is never sent as an empty string, which the CLI reads as a
    // model id it does not know.
    model: model === "" ? null : model,
  };
}

/* ------------------------------------------------------------------ */
/* What the page has to say about a row it did not decide              */
/* ------------------------------------------------------------------ */

/**
 * The definition on disk that answers to this name, or null for no collision.
 *
 * A saved agent sharing a name with one in `~/.claude/agents/` is deliberately
 * **not refused** — the ambient set is per-cwd and a validator that runs before
 * a folder is chosen cannot see it — so which definition Claude Code actually
 * uses is unverified, and a surface that shows both is the whole of how that
 * becomes visible. This is what that surface reads. It is an annotation and
 * never a refusal: the operator is the only one who can resolve it, and the app
 * refusing to save the row would remove the row without removing the clash.
 *
 * Case-folded because `idx_agents_name` is, and because the CLI registers one
 * key per name: `Reviewer` and `reviewer` are one agent to both, so a clash that
 * differed only in case would be a clash this said nothing about.
 */
export function ambientClash(
  name: string,
  ambient: readonly AmbientAgentDTO[],
): AmbientAgentDTO | null {
  const key = name.trim().toLowerCase();
  if (key === "") return null;
  return ambient.find((a) => a.name.trim().toLowerCase() === key) ?? null;
}

/**
 * Why a saved row cannot be attached to a run, or null when it can.
 *
 * `usable` is the server's verdict and this reads it rather than re-deriving
 * one — `rowToAgent` reports a decayed row rather than repairing it, and two
 * answers to "is this row usable" would be two answers that can disagree. What
 * this adds is *which* field is missing, which `agentRefusal` cannot say: that
 * sentence is shown at a door where the agent was named and the operator may be
 * nowhere near it, where this one is shown on the row itself, next to the box
 * that is empty.
 */
export function agentIncompleteReason(agent: AgentDTO): string | null {
  if (agent.usable) return null;

  const missing: string[] = [];
  if (agent.name.trim() === "") missing.push("name");
  if (agent.description.trim() === "") missing.push("description");
  if (agent.prompt.trim() === "") missing.push("prompt");

  const list =
    missing.length === 0
      ? "one of the fields Claude Code needs"
      : missing.length === 1
        ? `no ${missing[0]}`
        : `no ${missing.slice(0, -1).join(", ")} and no ${missing[missing.length - 1]}`;

  return (
    `This agent has ${list}, so Claude Code would drop it without a word — a ` +
    `run that named it would look exactly like one that was never given a ` +
    `specialist. Every door in this app refuses it until it is fixed.`
  );
}
