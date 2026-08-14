import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import { CLAUDE_CONFIG_DIR } from "./config";
import {
  MAX_AGENT_DESCRIPTION,
  MAX_AGENT_NAME,
  type RunAgentDTO,
} from "./apiTypes";

/**
 * Named agents: the role a run itself takes.
 *
 * An agent is **form input, not a run** — `run_templates`' rule, and this file
 * is modelled on `templates.ts` for that reason. It holds no folder claim,
 * consumes no concurrency slot, nothing derived from `activeRuns()` can see it,
 * and deleting one cannot reach a child that has already been spawned, because
 * every spawn writes the whole definition onto its own argv.
 *
 * **It reaches a child as two flags, and that pair is the whole feature.** This
 * app was built on `--agents <json>` alone, which *offers* a definition to the
 * session's own main agent as a specialist it may hand a subtask to. What the
 * operator wants instead is `--agent <name>`, which makes the session itself
 * that agent — the run's own system prompt, not a role inside it. The two go
 * together rather than one replacing the other, because a name is only
 * selectable once something has defined it: measured against the pinned CLI
 * (`@anthropic-ai/claude-code@2.1.226`), a member supplied on the same argv by
 * `--agents` joins the set `--agent` resolves against, alongside the built-ins
 * and whatever is on disk.
 *
 *     $ claude --agents '{"uf-probe-agent":{"description":"…","prompt":"…"}}' \
 *         --agent uf-probe-typo -p hi
 *     --agent 'uf-probe-typo' not found. Available agents: claude, Explore,
 *     general-purpose, Plan, statusline-setup, typescript, uf-probe-agent
 *
 * So `agentsFlagValue` is still the one encoder and still the one place that
 * knows the shape; `sessionAgentArgs` is the selection built on top of it. See
 * both for what the verification found, which is the reason this file validates
 * as strictly as it does — and note that the singular flag changes the *failure
 * mode* of getting the shape wrong from silent to loud. A member the CLI will
 * not register used to cost a run its specialist at exit 0; named on `--agent`
 * it now fails the spawn outright, with a non-zero exit and no API call.
 *
 * What an agent deliberately does **not** hold:
 *
 * - **A tool list.** `--agents` accepts one; this refuses it at the door. See
 *   `TOOLS_REFUSAL` below — it is the capability decision, and the singular
 *   flag makes it matter more rather than less, because the run *is* the agent
 *   now and a list on it would decide what the run may do.
 * - **A permission mode.** There are exactly two routes to `--permission-mode`
 *   in this app (the run form and a template), and `reopenRun` already refuses
 *   to become a third. An agent is not the fourth: it names no mode, no column
 *   holds one, and nothing on the wire could carry one.
 * - **A folder, a budget or an isolation choice.** Those bound a *run*. An
 *   agent is what the run is asked to be, and the run's own guards are
 *   unchanged by asking it.
 */

/* ------------------------------------------------------------------ */
/* What a saved agent is                                               */
/* ------------------------------------------------------------------ */

export interface SavedAgent {
  id: string;
  /**
   * The key the CLI registers it under, and the handle `--agent` takes.
   *
   * It travels as its own argv word, so a name with a space in it is selected
   * as it stands — verified: `--agents '{"uf spaced":{…}}' --agent "uf spaced"`
   * resolves. Nothing here is quoted into a syntax the CLI does not speak,
   * because nothing here goes through a shell.
   */
  name: string;
  /**
   * What a person reads on a picker when they choose this agent for a run.
   *
   * Under the plural flag this was what the *delegating model* read, and it was
   * required for that reason. Nothing chooses on it now — the operator does —
   * but it stays required on a stronger ground than the one it lost: the CLI
   * will not register a member without one at all, so `--agent` cannot select
   * it. See `normalizeAgentInput`, which measures that rather than assuming it.
   */
  description: string;
  /** The agent's own system prompt. */
  prompt: string;
  /**
   * The model the agent asks for, or null to inherit whatever the session has.
   *
   * **This changed meaning with the flag, and it is the one field that did.**
   * Under `--agents` alone it was the model a *delegated sub-turn* ran on, which
   * is why this file departs from `run_templates`' "`settings.defaultModel` is
   * the single place" rule at all — a sub-turn's model is a thing nothing else
   * here can express. Selected with `--agent` it is the **session's** model, so
   * it is now a way of setting the run's own. Measured on the pin, off the
   * `system`/`init` event, before any request is made:
   *
   *     --agents '{"uf-m":{…,"model":"sonnet"}}'                 → claude-opus-5[1m]
   *     --agents '{"uf-m":{…,"model":"sonnet"}}' --agent uf-m    → claude-sonnet-5
   *
   * What keeps that from being a second route to the run's model in the sense
   * `run_templates` refuses is the next measurement: an explicit `--model`
   * outranks it, and `buildArgs` passes one whenever the run has one. So the
   * agent's model fills a gap the run left rather than overriding a choice the
   * operator made —
   *
   *     --model opus  … --agent uf-m  → claude-opus-5
   *     --model haiku … --agent uf-m  → claude-haiku-4-5-20251001
   *
   * — and it still moves cost rather than capability, which is what makes it
   * tolerable at all: every cost guard already covers it, since the run's spend
   * lands on its own `result` event and in its telemetry whatever model produced
   * it. It is worth knowing that a run with no model of its own, started as an
   * agent that names one, runs on the agent's.
   *
   * Free-form, like `settings.defaultModel`: an alias (`sonnet`), a full id
   * (`claude-opus-5`) and the literal `inherit` are all accepted by the CLI, and
   * narrowing to a list this build knows would refuse the model that ships next
   * week. An unrecognised one fails inside the CLI rather than here.
   */
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

/** An agent stripped of its identity — everything a save or an edit supplies. */
export type AgentInput = Omit<SavedAgent, "id" | "createdAt" | "updatedAt">;

/**
 * A registry row as every door that resolves one reads it.
 *
 * The record plus `usable`, which is `rowToAgent`'s verdict rather than a
 * column — a row that has decayed into something the CLI would drop is reported
 * rather than repaired. Named once here because three callers now take one and
 * pass it to `agentRefusal`: the run door, a template being saved, and the two
 * planners that turn a proposal or a node into a run.
 */
export type RegistryAgent = SavedAgent & { usable: boolean };

/** Exactly what goes onto a child's argv. Nothing here bounds what it may do. */
export type AgentDefinition = Pick<
  SavedAgent,
  "name" | "description" | "prompt" | "model"
>;

export type AgentNormalization =
  | { ok: true; value: AgentInput }
  | { ok: false; error: string };

/**
 * Agent names the pinned CLI already answers to.
 *
 * Read off `claude --agent <unknown>` on 2.1.226, which refuses with the list
 * before it makes any API call.
 *
 * **The refusal survives the move to the singular flag, and the reason narrows
 * rather than disappearing.** Under `--agents` alone the argument was that a
 * member named `general-purpose` either did nothing or silently replaced a
 * built-in the main thread delegates to, and the CLI did not say which. The
 * first half of that no longer applies — a name that is selected is plainly in
 * play — but the second half is now the *whole* run rather than one delegated
 * subtask, and it is still unanswered. Re-measured on the pin:
 *
 *     $ claude --agents '{"Explore":{"description":"shadow","prompt":"p"}}' \
 *         --agent uf-typo -p hi
 *     --agent 'uf-typo' not found. Available agents: claude, Explore,
 *     general-purpose, Plan, statusline-setup, typescript
 *
 * One `Explore` in the list, not two. So `--agent Explore` would select *an*
 * Explore and there is no way to tell from outside whether it is the operator's
 * prompt or the built-in one — which is now the difference between a run that is
 * the agent the operator wrote and a run that is something else entirely, under
 * a name they chose. Refused at the door for that.
 *
 * This list can go stale when the CLI pin moves, and the direction it goes stale
 * in is the cheap one — a name added upstream would be accepted here and shadow
 * something, which is what happens today with no list at all.
 */
const BUILT_IN_AGENTS = [
  "claude",
  "Explore",
  "general-purpose",
  "Plan",
  "statusline-setup",
];

/**
 * Why a tool list is refused rather than stored.
 *
 * `--agents` members accept a `tools` array and this app will not save one.
 * A tool list is capability, and capability in this app comes from a guard set a
 * person wrote — the permission mode, `ISOLATED_GIT_TOOLS`, `PROCESS_KILLERS` —
 * reached through exactly two routes and re-narrowed at every one of them. An
 * agent record is a *third* kind of thing that would carry it, and it is within
 * reach of a model: a chat proposal, a proposed graph, a workflow block and an
 * emitted spec all name saved records, and `planProposal`'s rule is that prompt
 * text is the one half of a run a model may write. A tool list is the other
 * half.
 *
 * **The singular flag strengthens this rather than weakening it, and that is
 * worth stating because the opposite reading is available.** With `--agents`
 * alone a `tools` list would have bounded one delegated subtask inside a run
 * whose own mode and lists still stood over it. Selected with `--agent` the run
 * *is* this agent, so a list here would be a statement about what the whole
 * session may do — which is precisely the third route to that decision the
 * two-routes-to-`--permission-mode` rule exists to prevent, arriving through a
 * record a chat proposal or a workflow block can name. There is no reading of
 * the new semantics under which this field becomes safer to store.
 *
 * There is also a concrete failure it would risk. `PROCESS_KILLERS` is a
 * `--disallowedTools` entry, and CLAUDE.md records that deny beats
 * `--permission-mode` — verified. Whether it also beats a *sub*-agent's own
 * `tools: ["Bash"]` is **not** verified, and the incident behind that deny list
 * is one `pkill` that restarted the container and failed fourteen runs. A field
 * whose interaction with the one deny that matters is unknown does not belong in
 * a saved record reachable from a proposal.
 *
 * Refused by name rather than dropped, for `normalizeTemplateInput`'s reason: an
 * operator who typed a tool list and got a saved agent that silently ignored it
 * would believe their agent was narrowed when it was not.
 */
const TOOLS_REFUSAL =
  "An agent cannot carry a tool list. What a run may do comes from its own " +
  "guard set — the permission mode and this app's own allow and deny lists — " +
  "and since a run is started as the agent it names, a per-agent list would be " +
  "a second place deciding what the whole session may do, reachable from a " +
  "saved record that a chat proposal or a workflow block can name. Remove " +
  "`tools` and set the guards on the run.";

/* ------------------------------------------------------------------ */
/* Validation — pure, and the reason this file has a test              */
/* ------------------------------------------------------------------ */

/**
 * Read an agent off the wire, refusing anything the CLI would drop in silence.
 *
 * Total in the sense that matters: it never throws, and every refusal names
 * something the operator can change. It is stricter than it looks like it needs
 * to be, and the strictness is measured rather than defensive — every one of
 * these was tried against the pinned CLI and the CLI said **nothing**:
 *
 *   - a member with an empty or missing `description` is dropped, exit 0
 *   - a member with an empty or missing `prompt` is dropped, exit 0
 *   - a member whose `model` is JSON `null` is dropped, exit 0
 *   - an entry with an empty name registers as an empty entry
 *   - `--agents` that is not JSON at all is ignored, exit 0
 *
 * **Every one of those refusals is now load-bearing twice over**, and this is
 * the one place the singular flag makes the app's own behaviour better rather
 * than merely different. "Dropped" above means dropped from the set `--agent`
 * resolves against, which was invisible when the member was only being offered
 * and is a hard start failure when it is being selected. Re-measured on the pin
 * — a member with no `description`, named on `--agent`:
 *
 *     $ claude --agents '{"uf-nodesc":{"prompt":"p"}}' --agent uf-nodesc -p hi
 *     --agent 'uf-nodesc' not found. Available agents: claude, Explore,
 *     general-purpose, Plan, statusline-setup, typescript
 *     $ echo $?
 *     1
 *
 * Non-zero, before any API call, and identically for a missing `prompt` and for
 * `"model": null`. So a definition that is wrong here no longer produces a run
 * whose agent is quietly absent — it produces a run whose every work cycle dies
 * at the spawn. Both are failures worth moving to the form where a person is
 * looking, which is what this function is; the second is merely louder about it.
 */
export function normalizeAgentInput(raw: unknown): AgentNormalization {
  const o = (raw ?? {}) as Record<string, unknown>;

  // Refused before anything else, so an operator who sent one is told about
  // that rather than about whichever field they also got wrong.
  if (o.tools !== undefined && o.tools !== null) {
    return { ok: false, error: TOOLS_REFUSAL };
  }

  const name = String(o.name ?? "").trim();
  if (!name) return { ok: false, error: "An agent needs a name." };
  if (name.length > MAX_AGENT_NAME) {
    return {
      ok: false,
      error: `An agent name is at most ${MAX_AGENT_NAME} characters.`,
    };
  }
  if (BUILT_IN_AGENTS.some((b) => b.toLowerCase() === name.toLowerCase())) {
    return {
      ok: false,
      error:
        `Claude Code already answers to “${name}”. A saved agent under that ` +
        `name either does nothing or replaces the built-in one, and it does ` +
        `not say which. Pick another name.`,
    };
  }

  const description = String(o.description ?? "").trim();
  if (!description) {
    return {
      ok: false,
      error:
        "An agent needs a description. Claude Code will not register an " +
        "agent that has none, so a run started as this one would fail the " +
        "moment it spawned — and it is what you will be reading when you pick " +
        "this agent for a run.",
    };
  }
  if (description.length > MAX_AGENT_DESCRIPTION) {
    return {
      ok: false,
      error:
        `An agent description is at most ${MAX_AGENT_DESCRIPTION} ` +
        `characters. It is carried in the session's context for the whole run ` +
        `rather than only at the moment it is chosen, so it is paid for on ` +
        `every request the run makes.`,
    };
  }

  const prompt = String(o.prompt ?? "").trim();
  if (!prompt) {
    return {
      ok: false,
      error:
        "An agent needs a prompt. It is the whole of what makes this agent " +
        "different from the one that would have done the work anyway.",
    };
  }

  // Blank is null, the way every optional string here is: `null`, `""` and a
  // missing key all mean "inherit the session's model", and only a real value
  // reaches the flag. It is never sent as JSON `null` — see `agentsFlagValue`.
  const rawModel = o.model === null || o.model === undefined ? "" : String(o.model).trim();
  const model = rawModel === "" ? null : rawModel;
  if (model !== null && model.length > MAX_AGENT_NAME) {
    return { ok: false, error: `That does not look like a model id: ${model}` };
  }

  return { ok: true, value: { name, description, prompt, model } };
}

/* ------------------------------------------------------------------ */
/* The argv encoder — the one definition of the shape                  */
/* ------------------------------------------------------------------ */

/**
 * The value of `--agents`, or null when there is nothing to attach.
 *
 * One function rather than one per caller, and it stays one after the move to
 * `--agent`: this is what *defines* a member, `sessionAgentArgs` below is what
 * *selects* one, and the selection is built on this rather than beside a second
 * JSON builder. Three modules can carry agents and four callers reach them —
 * `buildArgs` for a work cycle, `runOrchestratorChild` for a chat turn or an
 * orchestrator block, `spawnAssist` for a review or a conflict resolution — and
 * the CLI's failure mode makes a second copy of this shape expensive in a way
 * nothing would report. Two of the four hand one over today, and both of those
 * two now select it: a work cycle and an orchestrator block's deciding turn.
 * `runTurn` withholds one deliberately (see the note above it), and no caller of
 * `startAssist` supplies one, so a review has never been given an agent.
 * Measured against 2.1.226:
 *
 *   `{"<name>": {"description": "…", "prompt": "…", "model": "…"?}}`
 *
 * `description` and `prompt` are required strings, `model` an optional string,
 * unknown keys are ignored, and **every** violation is silent: a member missing
 * a required key is dropped and the run carries on without it, and a payload
 * that is not JSON is ignored entirely. There is no error, no warning and a zero
 * exit. So the encoder never emits a key it does not have a value for — a
 * `"model": null` drops the member it is on — and `normalizeAgentInput` refuses
 * the empty strings at the door.
 *
 * It **merges** with what the CLI finds on disk rather than replacing it; see
 * `listAmbientAgents` for what that means and why it is left that way.
 *
 * Duplicate names collapse into one entry, first wins. The registry's unique
 * index makes that unreachable from the database, so a duplicate here is a
 * caller passing the same agent twice — deterministic rather than last-wins, so
 * two spawns of one run cannot disagree about which definition was sent.
 */
export function agentsFlagValue(agents: AgentDefinition[]): string | null {
  if (agents.length === 0) return null;

  const payload: Record<string, Record<string, string>> = {};
  for (const agent of agents) {
    if (agent.name in payload) continue;
    payload[agent.name] = {
      description: agent.description,
      prompt: agent.prompt,
      ...(agent.model ? { model: agent.model } : {}),
    };
  }
  return JSON.stringify(payload);
}

/**
 * `["--agents", "…"]`, or nothing — a definition *offered*, not selected.
 *
 * This is the plural flag on its own, which hands the session's main agent a
 * role it may delegate a subtask to. The one caller left on it is `spawnAssist`,
 * and see the note there for why a review is not given a selected agent.
 */
export function agentsArgs(agents: AgentDefinition[]): string[] {
  const value = agentsFlagValue(agents);
  return value === null ? [] : ["--agents", value];
}

/**
 * `["--agents", "…", "--agent", "<name>"]`, or nothing: the run **is** this one.
 *
 * The singular semantics, and the pair is not redundant. `--agent` takes a name
 * and resolves it against the built-ins plus whatever is on disk plus whatever
 * this argv defined, so the definition still has to travel — dropping `--agents`
 * and sending only the name would select a saved agent this app never wrote down
 * anywhere the CLI can see, which on a stock install is a spawn that fails by
 * name. Both flags, from one place, so the shape has one definition.
 *
 * Singular in its argument rather than taking a list and picking one, because
 * the thing it describes is singular: `runs.agent` freezes one definition, a
 * workflow node names one, and "the first of the array wins" is a rule that
 * could be quietly wrong the day an array arrived with two in it.
 *
 * What it deliberately does **not** do is bound anything. `--agent` sets the
 * session's system prompt and its model (the latter only where the run named no
 * model of its own — see `SavedAgent.model`); the permission mode, the allow
 * list and the deny list are argued at the spawn sites and are untouched by it.
 * Two measurements on the pin are what make that safe to say, and both are
 * load-bearing enough that `orchestrator.test.ts` pins the argv they justify:
 *
 *   - `--append-system-prompt` still reaches a `--agent` session. The agent's
 *     own prompt does not swallow it: an agent told to answer with a secret word
 *     stated only in the appended text answered `BANANA ZEBRA`. That is what
 *     keeps `SELF_HOSTING_NOTICE` — the `pkill` deny list's explanation — in
 *     front of a run that has been started as an agent.
 *   - `--agent` survives `--resume`, so every work cycle after the first still
 *     gets it. The same probe resumed answered `BANANA ZEBRA` again.
 */
export function sessionAgentArgs(agent: AgentDefinition | null | undefined): string[] {
  if (!agent) return [];
  return [...agentsArgs([agent]), "--agent", agent.name];
}

/* ------------------------------------------------------------------ */
/* Attaching a saved agent to a run                                    */
/* ------------------------------------------------------------------ */

/** Everything a caller needs to know about a saved agent to refuse naming it. */
export interface AgentFacts {
  name: string;
  /** False for a row that has decayed into something the CLI would drop. */
  usable: boolean;
}

/**
 * The registry as a pure validator sees it, keyed by id.
 *
 * `WorkflowKnowledge`'s shape and its reason: the doors that decide whether an
 * agent may be named — a template being saved and a run being started — pass the
 * *same* knowledge read at two different moments, which is what makes "saved,
 * then no longer startable" a sentence rather than a surprise.
 */
export type AgentKnowledge = ReadonlyMap<string, AgentFacts>;

/**
 * Why a saved agent cannot be attached to a run, or null when it can.
 *
 * Pure, and the single wording for both doors. There is deliberately no third
 * answer: an id that names nothing is **refused**, never quietly dropped. That
 * is `planProposal`'s rule for a template deleted between the proposal and the
 * click, and the reason is the same one that runs through the whole of this
 * file — the operator started the run that said "as the reviewer", and a run
 * that silently is not the reviewer is bit-for-bit a run that was never given
 * one. Falling back to none would put this app's own behaviour in the same class
 * as the CLI's silent drop, which is the failure the registry exists to end.
 *
 * The second refusal used to say the CLI drops such an agent "without a word",
 * which was measured and is no longer true of a *selected* one: an unregistrable
 * member named on `--agent` fails the spawn with a non-zero exit. Refusing here
 * is still the right answer and for the better reason — this door is in front of
 * a person who can fix it, where the spawn failure is a run that dies at every
 * cycle with a message only the event log carries.
 */
export function agentRefusal(agentId: string, known: AgentKnowledge): string | null {
  const facts = known.get(agentId);
  if (!facts) {
    return (
      `That agent no longer exists (id ${agentId.slice(0, 8)}), so there is ` +
      `nothing for the run to be. Pick another one, or start with none.`
    );
  }
  if (!facts.usable) {
    return (
      `The “${facts.name}” agent is missing its description or its prompt, ` +
      `and Claude Code will not register an agent like that — a run started ` +
      `as it would fail the moment it spawned. Fix it, or start with none.`
    );
  }
  return null;
}

/** The registry as `agentRefusal` wants it. One read, both doors. */
export function currentAgentKnowledge(): AgentKnowledge {
  const known = new Map<string, AgentFacts>();
  for (const agent of listAgents()) {
    known.set(agent.id, { name: agent.name, usable: agent.usable });
  }
  return known;
}

export type AgentResolution =
  | { ok: true; agent: AgentDefinition | null }
  | { ok: false; error: string };

/**
 * Read the agent named on a request, and refuse one that is not there.
 *
 * The door `POST /api/runs` narrows at, the way it narrows `permissionMode`
 * against its four literals. What crosses the wire is an **id**, never a
 * definition: a definition off the wire would be a route to an agent nobody
 * saved, and the registry is the only place an agent comes from precisely so
 * that what a run may delegate to is something a person wrote down.
 *
 * What comes back is the whole definition rather than the id, because that is
 * what the run stores — see the `agent` column in `db.ts`.
 */
export function resolveAgentForRun(raw: unknown): AgentResolution {
  const id = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!id) return { ok: true, agent: null };

  const saved = getAgent(id);
  const refusal = agentRefusal(id, agentKnowledgeOf(saved));
  if (refusal || !saved) return { ok: false, error: refusal ?? "No such agent." };

  return { ok: true, agent: agentDefinition(saved) };
}

/**
 * The definition frozen onto a run, read back for its next spawn.
 *
 * Total: a column that cannot be read is no agent at all, because the only
 * alternative is putting a half-formed member on an argv the CLI drops in
 * silence. It re-applies `rowToAgent`'s narrowing rather than trusting the blob,
 * for that function's reason — what is on the row outlives the build that wrote
 * it, and the safe reading of something this build does not understand is the
 * least it could have meant.
 */
export function parseRunAgent(raw: string | null | undefined): AgentDefinition | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const o = parsed as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  const description = String(o.description ?? "").trim();
  const prompt = String(o.prompt ?? "").trim();
  const model = String(o.model ?? "").trim();
  if (!name || !description || !prompt) return null;

  return { name, description, prompt, model: model === "" ? null : model };
}

/**
 * `[]` or the one agent this run carries, as the *plural* flag wants it.
 *
 * **Nothing calls this any more**, and that is worth stating rather than leaving
 * to be discovered — `spawnableAgents` below is kept on the same terms. It was
 * the shape every spawn site took while `--agents` was the only flag; a work
 * cycle and an orchestrator block now select their agent instead and go through
 * `parseRunAgent` into `sessionAgentArgs`, which is singular because what it
 * describes is. The one caller still on the plural flag (`spawnAssist`) is
 * handed its list by its own caller and does not read a run's column.
 *
 * Left in place because removing an export is a decision about the module's
 * surface and because `agents.test.ts` uses it to pin that a run with no agent
 * puts no flag on the argv at all — the branch that would otherwise be an empty
 * JSON object where every existing run had nothing.
 */
export function runAgentDefinitions(raw: string | null | undefined): AgentDefinition[] {
  const agent = parseRunAgent(raw);
  return agent ? [agent] : [];
}

/**
 * The run's frozen agent as the wire carries it — name, description, no prompt.
 *
 * Here rather than in either run route because both of them answer with a run,
 * and two copies of "what a run says about its agent" would be two payloads that
 * could disagree about the same row.
 */
export function runAgentDTO(raw: string | null | undefined): RunAgentDTO | null {
  const agent = parseRunAgent(raw);
  if (!agent) return null;
  return {
    name: agent.name,
    description: agent.description,
    model: agent.model,
  };
}

/* ------------------------------------------------------------------ */
/* Ambient agents — the ones this app did not put there                */
/* ------------------------------------------------------------------ */

/** Where an ambient definition came from. */
export type AgentScope = "user" | "project";

/**
 * An agent definition Claude Code finds on disk, which this app did not write.
 *
 * These reach every child this app spawns and always have — `docker-compose.yml`
 * bind-mounts the operator's `~/.claude`, so `$CLAUDE_CONFIG_DIR/agents/**` is
 * in play for every run, chat turn, orchestrator block and review, and an
 * isolated run's worktree carries the repository's own `.claude/agents/` for the
 * same reason. Nothing in this app recorded that, which is the state this type
 * exists to end.
 *
 * **They are deliberately left in play, and declared instead of excluded.** The
 * `--strict-mcp-config` precedent argues the other way, and the only mechanism
 * the pinned CLI offers for it does not read like that flag does: agent
 * discovery is governed by `--setting-sources`, and `--setting-sources ""` is
 * the *only* value that drops both scopes — verified, along with the fact that
 * `--setting-sources user` keeps the user scope and `project` keeps the
 * project's. That flag governs settings whole: permissions, hooks, environment,
 * status line. Passing it to exclude agents would silently drop the operator's
 * own `settings.json` from every child this app spawns, which is a much larger
 * change than the one being made and one nothing here would report. There is no
 * agent-scoped exclusion in 2.1.226.
 *
 * The second reason is that these are not new. `--strict-mcp-config` withholds a
 * tool surface the operator never granted *this feature*; a repository's own
 * `.claude/agents/` is part of the repository the agent was pointed at, and
 * removing it would make a run behave differently from the same repository
 * opened in a terminal — a divergence in the direction of surprise.
 *
 * So the registry is not the whole set, and the app has to say so rather than
 * imply it. This is what a surface reads to say it.
 */
export interface AmbientAgent {
  name: string;
  /** Null when the file declares none. The CLI still registers it. */
  description: string | null;
  scope: AgentScope;
  /** Absolute path, so a surface can name the file rather than only the agent. */
  path: string;
}

/**
 * Read one agent file the way the CLI does.
 *
 * Pure — it takes the text rather than a path — and it is the half of the walk
 * that can be wrong quietly. Measured against 2.1.226: the name comes from the
 * frontmatter `name:` key and **not** from the filename (a `filename-stem.md`
 * declaring `name: frontmatter-name` registers as the latter), and a file with
 * no `name:` key is not registered at all. Reading the stem instead would name
 * agents that do not exist and miss the ones that do.
 *
 * Deliberately not a YAML parser. The two keys read here are the two the CLI
 * needs to register anything, both are scalars in every definition this reads,
 * and a dependency to parse two lines is a dependency to keep in step with a
 * format belonging to another program.
 */
export function parseAgentFile(contents: string): {
  name: string;
  description: string | null;
} | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
  if (!match) return null;

  const read = (key: string): string | null => {
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(":");
      if (at === -1) continue;
      if (line.slice(0, at).trim() !== key) continue;
      // Quoted scalars are legal YAML and the CLI accepts them, so the quotes
      // are stripped rather than becoming part of the name.
      const value = line.slice(at + 1).trim().replace(/^["'](.*)["']$/, "$1");
      return value === "" ? null : value;
    }
    return null;
  };

  const name = read("name");
  return name === null ? null : { name, description: read("description") };
}

/** Every `*.md` under a directory, recursively — the CLI scans subfolders too. */
function agentFilesIn(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // No agents directory is the ordinary case, not a fault.
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...agentFilesIn(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

/**
 * What the CLI will find on disk for a child started in `projectDir`.
 *
 * The user scope is read from `CLAUDE_CONFIG_DIR`, which is where the CLI reads
 * it from — verified by pointing that variable at a directory holding an
 * `agents/` folder and watching the definition appear. `projectDir` is optional
 * because the user scope reaches *every* child whatever its cwd, where the
 * project scope depends on where the child is being started; a caller that has
 * already resolved a folder passes it, and one that has not gets the half of the
 * answer that is true everywhere.
 *
 * Never throws: an unreadable directory is reported as no agents, because this
 * feeds a sentence on a page rather than a decision. Nothing here bounds what a
 * child may do — the app's own registry does not either.
 */
export function listAmbientAgents(projectDir?: string | null): AmbientAgent[] {
  const sources: { dir: string; scope: AgentScope }[] = [
    { dir: path.join(CLAUDE_CONFIG_DIR, "agents"), scope: "user" },
  ];
  if (projectDir) {
    sources.push({ dir: path.join(projectDir, ".claude", "agents"), scope: "project" });
  }

  const found: AmbientAgent[] = [];
  for (const source of sources) {
    for (const file of agentFilesIn(source.dir)) {
      let parsed: ReturnType<typeof parseAgentFile> = null;
      try {
        parsed = parseAgentFile(fs.readFileSync(file, "utf8"));
      } catch {
        // Unreadable mid-walk. A file this app cannot read is one it cannot
        // report on, and failing the whole list over it would take the ones it
        // can read with it.
      }
      if (!parsed) continue;
      found.push({ ...parsed, scope: source.scope, path: file });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

interface AgentRow {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * A stored row as the rest of the app sees it.
 *
 * Pure — it takes the row rather than reading one — and it has a job beyond
 * renaming columns, for `rowToTemplate`'s reason: a row outlives the build that
 * wrote it. What it narrows is the pair the CLI will not register. A row whose
 * description or prompt is empty would produce a spawn the CLI refuses by name —
 * and, offered rather than selected, one whose member is simply absent — so it
 * is reported as `usable: false` rather than repaired with a placeholder. What
 * keeps such a row off an argv is every door reading that
 * flag through `agentRefusal` and refusing the run by name, plus `parseRunAgent`
 * re-applying the same narrowing to what a run froze — not this function, which
 * only reports.
 */
export function rowToAgent(row: AgentRow): SavedAgent & { usable: boolean } {
  const description = (row.description ?? "").trim();
  const prompt = (row.prompt ?? "").trim();
  const model = (row.model ?? "").trim();

  return {
    id: row.id,
    name: row.name,
    description,
    prompt,
    // Blank collapses to null here as well as at the door: `""` on the argv is
    // a dropped member, and null is the value that omits the key.
    model: model === "" ? null : model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    usable: row.name.trim() !== "" && description !== "" && prompt !== "",
  };
}

const COLUMNS = `id, name, description, prompt, model, created_at, updated_at`;

/**
 * Turn SQLite's unique-index violation into the sentence the form should show.
 *
 * `templates.ts`' rule: the constraint is the check, so this is where "already
 * exists" becomes readable rather than a check-then-insert that would say the
 * same thing less reliably.
 */
function withNameConflict<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = String((err as { code?: unknown } | null)?.code ?? "");
    if (code.startsWith("SQLITE_CONSTRAINT")) {
      throw new Error(
        `An agent called “${name}” already exists. Rename this one, or pick ` +
          `that agent and update it.`,
      );
    }
    throw err;
  }
}

export function listAgents(): (SavedAgent & { usable: boolean })[] {
  const rows = db()
    .prepare(`SELECT ${COLUMNS} FROM agents ORDER BY name COLLATE NOCASE`)
    .all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function getAgent(id: string): (SavedAgent & { usable: boolean }) | null {
  const row = db()
    .prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ?`)
    .get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

/**
 * One saved agent by the name it answers to, case-folded as the index is.
 *
 * By name rather than by id because of the one caller that has no id: an
 * orchestrator block's turn names the agent a run it is emitting starts as, and
 * what that child was shown is a list of *names* — an id is a thing only this
 * app's own forms ever hold, and putting one in front of a model would be
 * inviting it to guess at an identifier. Case-folded because `idx_agents_name`
 * is, so the name the turn typed and the name the operator saved are one agent
 * here for the same reason they are one row there.
 */
export function getAgentByName(
  name: string,
): (SavedAgent & { usable: boolean }) | null {
  const row = db()
    .prepare(`SELECT ${COLUMNS} FROM agents WHERE name = ? COLLATE NOCASE`)
    .get(name.trim()) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

/** The four fields a spawn carries, out of the row the registry holds. */
export function agentDefinition(agent: SavedAgent): AgentDefinition {
  return {
    name: agent.name,
    description: agent.description,
    prompt: agent.prompt,
    model: agent.model,
  };
}

/**
 * The registry as `agentRefusal` reads it, for one row a caller has resolved.
 *
 * `currentAgentKnowledge`'s shape for a caller that already knows which agent it
 * is asking about — a saved graph's block, an emitted run — so the refusal for
 * "that agent is gone" is the same sentence whether it was reached by listing
 * the registry or by looking up one row.
 */
export function agentKnowledgeOf(
  agent: (SavedAgent & { usable: boolean }) | null,
): AgentKnowledge {
  const known = new Map<string, AgentFacts>();
  if (agent) known.set(agent.id, { name: agent.name, usable: agent.usable });
  return known;
}

/**
 * The definitions for a set of saved ids, ready for an argv.
 *
 * **Nothing calls this**, and that is worth stating rather than leaving to be
 * discovered: every surface that names an agent settled on refusing a missing or
 * decayed one *by name* through `agentRefusal`, which is the opposite of what
 * this does — it drops them silently, which is the CLI's own behaviour and the
 * thing this module exists to stop. It was written for a caller that turned out
 * not to want it. Left in place rather than deleted because removing an export
 * is a decision about the module's surface; do not reach for it without deciding
 * that question, and do not read it as the guard that keeps an unusable row off
 * an argv — the doors are that guard.
 *
 * Ids that name nothing are simply absent: what to say about a deleted agent is
 * a decision for the surface that named it, and `planProposal` already sets the
 * rule those surfaces follow.
 */
export function spawnableAgents(ids: string[]): AgentDefinition[] {
  const defs: AgentDefinition[] = [];
  for (const id of ids) {
    const agent = getAgent(id);
    if (!agent || !agent.usable) continue;
    defs.push({
      name: agent.name,
      description: agent.description,
      prompt: agent.prompt,
      model: agent.model,
    });
  }
  return defs;
}

export function createAgent(input: AgentInput): SavedAgent & { usable: boolean } {
  const id = randomUUID();
  const now = Date.now();
  withNameConflict(input.name, () =>
    db()
      .prepare(
        `INSERT INTO agents
           (id, name, description, prompt, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.description, input.prompt, input.model, now, now),
  );
  return getAgent(id)!;
}

/** Null when there is no such agent — the caller answers 404. */
export function updateAgent(
  id: string,
  input: AgentInput,
): (SavedAgent & { usable: boolean }) | null {
  if (!getAgent(id)) return null;
  withNameConflict(input.name, () =>
    db()
      .prepare(
        `UPDATE agents
            SET name = ?, description = ?, prompt = ?, model = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(input.name, input.description, input.prompt, input.model, Date.now(), id),
  );
  return getAgent(id);
}

/**
 * Deleting an agent touches nothing that is running. Every spawn carries the
 * whole definition on its own argv, so there is no cascade and no child left
 * pointing at a row that is gone.
 */
export function deleteAgent(id: string): boolean {
  const res = db().prepare("DELETE FROM agents WHERE id = ?").run(id);
  return res.changes > 0;
}
