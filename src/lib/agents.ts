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
 * Named specialised agents: a role the delegating model may hand a subtask to.
 *
 * An agent is **form input, not a run** — `run_templates`' rule, and this file
 * is modelled on `templates.ts` for that reason. It holds no folder claim,
 * consumes no concurrency slot, nothing derived from `activeRuns()` can see it,
 * and deleting one cannot reach a child that has already been spawned, because
 * every spawn writes the whole definition onto its own argv.
 *
 * It reaches a child as one `--agents <json>` flag, verified against the pinned
 * CLI (`@anthropic-ai/claude-code@2.1.226`) rather than read from the docs. See
 * `agentsFlagValue` for the shape and for what that verification found, which is
 * the reason this file validates as strictly as it does.
 *
 * What an agent deliberately does **not** hold:
 *
 * - **A tool list.** `--agents` accepts one; this refuses it at the door. See
 *   `TOOLS_REFUSAL` below — it is the capability decision, and it is the whole
 *   reason this record can be reached by the surfaces runs 2-5 will build.
 * - **A permission mode.** There are exactly two routes to `--permission-mode`
 *   in this app (the run form and a template), and `reopenRun` already refuses
 *   to become a third. An agent is not the fourth: it names no mode, no column
 *   holds one, and nothing on the wire could carry one.
 * - **A folder, a budget or an isolation choice.** Those bound a *run*. An
 *   agent is a role inside one, and the run's own guards already cover every
 *   turn it delegates.
 */

/* ------------------------------------------------------------------ */
/* What a saved agent is                                               */
/* ------------------------------------------------------------------ */

export interface SavedAgent {
  id: string;
  /** The key the CLI registers it under, and the handle `--agent` would take. */
  name: string;
  /** What the delegating model reads to decide whether to hand it the subtask. */
  description: string;
  /** The agent's own system prompt. */
  prompt: string;
  /**
   * The model one delegated turn runs on, or null to inherit the session's.
   *
   * This is the one place this file departs from `run_templates`, which holds no
   * model on the grounds that `settings.defaultModel` is the single place to set
   * one and a second place is how the two drift. That argument does not reach
   * here, because this is not the run's model: it is the model a *sub*-turn uses,
   * which nothing else in this app can express, and setting it is the whole
   * reason to have a cheap specialist. It changes cost and not capability, and
   * every cost guard already covers it — a delegated turn's spend lands on the
   * run's own `result` event and in its telemetry like any other.
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
 * before it makes any API call. Saving one of these is refused because the
 * measured behaviour is silent either way: a `--agents` member named
 * `general-purpose` does not appear as a second entry in that list, so the saved
 * definition either does nothing at all — while the operator believes their
 * specialist is in play — or silently replaces a built-in the main agent
 * delegates to. Which of the two it is was not determined, and that is the
 * point: neither outcome reports anything.
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
 * agent record is a *third* kind of thing that would carry it, and the surfaces
 * runs 2-5 build put it within reach of a model: a chat proposal and a workflow
 * block both name saved records, and `planProposal`'s rule is that prompt text
 * is the one half of a run a model may write. A tool list is the other half.
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
 * would believe their specialist was narrowed when it was not.
 */
const TOOLS_REFUSAL =
  "An agent cannot carry a tool list. What an agent may do comes from the " +
  "guard set on the run it is delegated inside — the permission mode and this " +
  "app's own allow and deny lists — and a per-agent list would be a second " +
  "place that decides it, reachable from a saved record that a chat proposal " +
  "or a workflow block can name. Remove `tools` and set the guards on the run.";

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
 * So a definition that is wrong here does not fail a run — it produces a run
 * whose specialist simply is not there, which is bit-for-bit a run that was
 * never given one. That is the failure this function exists to move to the form,
 * where a person is looking.
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
        "An agent needs a description. It is the only thing the delegating " +
        "model reads when it decides whether this is the agent for a subtask, " +
        "so an agent without one is an agent that never gets chosen.",
    };
  }
  if (description.length > MAX_AGENT_DESCRIPTION) {
    return {
      ok: false,
      error:
        `An agent description is at most ${MAX_AGENT_DESCRIPTION} ` +
        `characters. It is carried in the delegating model's context for the ` +
        `whole session rather than only at the moment of a delegation, so it ` +
        `is paid for on every request the run makes.`,
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
 * One function rather than three, because there are three spawn sites that can
 * carry agents — `buildArgs` for a work cycle, `runOrchestratorChild` for a chat
 * turn or an orchestrator block, `spawnAssist` for a review or a conflict
 * resolution — and the CLI's failure mode makes a second copy of this shape
 * expensive in a way nothing would report. Measured against 2.1.226:
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

/** `["--agents", "…"]`, or nothing. Spread into an argv at each spawn site. */
export function agentsArgs(agents: AgentDefinition[]): string[] {
  const value = agentsFlagValue(agents);
  return value === null ? [] : ["--agents", value];
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
 * file — the operator started the run that said "as the reviewer agent", and a
 * run that silently has no specialist is bit-for-bit a run that was never given
 * one. Falling back to none would put this app's own behaviour in the same class
 * as the CLI's silent drop, which is the failure the registry exists to end.
 */
export function agentRefusal(agentId: string, known: AgentKnowledge): string | null {
  const facts = known.get(agentId);
  if (!facts) {
    return (
      `That agent no longer exists (id ${agentId.slice(0, 8)}), so there is ` +
      `nothing to hand a subtask to. Pick another one, or start with none.`
    );
  }
  if (!facts.usable) {
    return (
      `The “${facts.name}” agent is missing its description or its prompt, ` +
      `and Claude Code drops such an agent without a word — the run would ` +
      `look exactly like one that was never given a specialist. Fix it, or ` +
      `start with none.`
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
  const known = new Map<string, AgentFacts>();
  if (saved) known.set(saved.id, { name: saved.name, usable: saved.usable });

  const refusal = agentRefusal(id, known);
  if (refusal || !saved) return { ok: false, error: refusal ?? "No such agent." };

  return {
    ok: true,
    agent: {
      name: saved.name,
      description: saved.description,
      prompt: saved.prompt,
      model: saved.model,
    },
  };
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

/** `[]` or the one agent this run carries — what the four spawn sites want. */
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
 * wrote it. What it narrows is the pair the CLI drops in silence. A row whose
 * description or prompt is empty would produce a spawn whose specialist is
 * simply absent, so it is reported as `usable: false` rather than repaired with
 * a placeholder, and `spawnableAgents` is what keeps it off an argv.
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
 * The definitions for a set of saved ids, ready for an argv.
 *
 * Unusable rows are left out rather than sent, because the CLI would drop them
 * anyway and without saying so — this is where that silence becomes something a
 * caller can count. Ids that name nothing are simply absent: what to say about a
 * deleted agent is a decision for the surface that named it, and `planProposal`
 * already sets the rule those surfaces follow, which is to refuse by name rather
 * than fall back.
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
