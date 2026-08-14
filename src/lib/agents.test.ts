import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentRefusal,
  agentsArgs,
  agentsFlagValue,
  normalizeAgentInput,
  parseAgentFile,
  parseRunAgent,
  rowToAgent,
  runAgentDefinitions,
  sessionAgentArgs,
} from "./agents";

/**
 * Covers the three pure functions that stand between an operator's form and a
 * flag the CLI drops in silence.
 *
 * They clear the bar for the same reason `normalizeTemplateInput` does — pure,
 * and every failure mode is quiet and expensive — but the quietness here is
 * measured rather than argued. Every one of these was tried against the pinned
 * CLI (`@anthropic-ai/claude-code@2.1.226`) and it said nothing at all: a member
 * without a description is dropped, a member without a prompt is dropped, a
 * member whose model is JSON `null` is dropped, and a `--agents` value that is
 * not JSON is ignored entirely. Exit 0 in every case, no warning on stderr.
 *
 * That silence was the whole argument for validating here, and the move from
 * `--agents` to `--agent` **keeps the refusals and changes what they buy**. The
 * drop above is a drop from the set `--agent` resolves against, so a member the
 * CLI will not register is no longer a run quietly missing its agent — it
 * is a run whose every work cycle exits non-zero at the spawn, before any
 * request is made:
 *
 *     $ claude --agents '{"uf-nodesc":{"prompt":"p"}}' --agent uf-nodesc -p hi
 *     --agent 'uf-nodesc' not found. Available agents: claude, Explore,
 *     general-purpose, Plan, statusline-setup, typescript   (exit 1)
 *
 * Louder, and still worth refusing in front of the person who can fix it rather
 * than in a stderr line on a run that has already been started.
 */

const valid = {
  name: "reviewer",
  description: "Reads a diff and reports what is wrong with it.",
  prompt: "You review code. You do not write it.",
};

describe("normalizeAgentInput", () => {
  it("accepts the minimum the CLI needs and nothing more", () => {
    const parsed = normalizeAgentInput(valid);
    assert.equal(parsed.ok, true);
    assert(parsed.ok);
    assert.deepEqual(parsed.value, { ...valid, model: null });
  });

  it("trims, and is idempotent through its own output", () => {
    const once = normalizeAgentInput({
      name: "  reviewer  ",
      description: " reads a diff ",
      prompt: " reviews ",
      model: "  sonnet  ",
    });
    assert(once.ok);
    assert.deepEqual(once.value, {
      name: "reviewer",
      description: "reads a diff",
      prompt: "reviews",
      model: "sonnet",
    });

    const twice = normalizeAgentInput(once.value);
    assert(twice.ok);
    assert.deepEqual(twice.value, once.value);
  });

  /**
   * The capability decision, pinned as a refusal rather than as an absence.
   *
   * `--agents` members accept a `tools` array; this app will not save one. The
   * refusal is what makes that a decision instead of a field somebody forgot —
   * dropping it silently would leave an operator who typed a tool list believing
   * their agent was narrowed by it, which is the failure this whole file is
   * about, arriving from the other direction.
   */
  it("refuses a tool list, because capability is not the agent's to carry", () => {
    const parsed = normalizeAgentInput({ ...valid, tools: ["Read", "Grep"] });
    assert.equal(parsed.ok, false);
    assert(!parsed.ok);
    assert.match(parsed.error, /tool list/);

    // An explicit null is the field not being sent, not a tool list of none.
    assert.equal(normalizeAgentInput({ ...valid, tools: null }).ok, true);
  });

  it("refuses an empty tool list too — an empty allowlist is still an allowlist", () => {
    assert.equal(normalizeAgentInput({ ...valid, tools: [] }).ok, false);
  });

  for (const field of ["name", "description", "prompt"] as const) {
    it(`refuses a missing ${field}, which the CLI would drop without a word`, () => {
      const parsed = normalizeAgentInput({ ...valid, [field]: "" });
      assert.equal(parsed.ok, false);
      assert(!parsed.ok);
      assert.match(parsed.error, /agent needs a/);
    });

    it(`refuses a whitespace-only ${field} for the same reason`, () => {
      assert.equal(normalizeAgentInput({ ...valid, [field]: "   " }).ok, false);
    });
  }

  /**
   * Measured: a `--agents` member named `general-purpose` does not appear as a
   * second entry in what `claude --agent <unknown>` lists. So a saved agent
   * under a built-in's name either does nothing while the operator believes it
   * is in play, or replaces a built-in the main thread delegates to — and the
   * CLI does not say which. Refused at the door because neither outcome reports
   * anything afterwards.
   */
  for (const name of ["general-purpose", "Explore", "GENERAL-PURPOSE"]) {
    it(`refuses “${name}”, a name the CLI already answers to`, () => {
      const parsed = normalizeAgentInput({ ...valid, name });
      assert.equal(parsed.ok, false);
      assert(!parsed.ok);
      assert.match(parsed.error, /already answers to/);
    });
  }

  it("bounds the description, which is billed on every request of the run", () => {
    const parsed = normalizeAgentInput({ ...valid, description: "d".repeat(1_001) });
    assert.equal(parsed.ok, false);
    assert.equal(normalizeAgentInput({ ...valid, description: "d".repeat(1_000) }).ok, true);
  });

  it("bounds the name", () => {
    assert.equal(normalizeAgentInput({ ...valid, name: "n".repeat(81) }).ok, false);
    assert.equal(normalizeAgentInput({ ...valid, name: "n".repeat(80) }).ok, true);
  });

  /**
   * Blank, null and missing all mean "inherit the session's model", and the one
   * thing they must never mean is JSON `null` on the flag — which drops the
   * member it is on. `agentsFlagValue` is the other half of this; this is the
   * half that stops a blank field from becoming an empty string on the wire,
   * which the CLI treats the same way.
   */
  for (const model of [undefined, null, "", "   "]) {
    it(`reads model ${JSON.stringify(model)} as inherit, never as a value`, () => {
      const parsed = normalizeAgentInput({ ...valid, model });
      assert(parsed.ok);
      assert.equal(parsed.value.model, null);
    });
  }

  it("keeps a model it does not recognise", () => {
    // Free-form like `settings.defaultModel`: an alias, a full id and the
    // literal `inherit` are all legal, and a list this build knows would refuse
    // whatever ships next. An unrecognised one fails inside the CLI.
    for (const model of ["sonnet", "inherit", "claude-opus-5"]) {
      const parsed = normalizeAgentInput({ ...valid, model });
      assert(parsed.ok);
      assert.equal(parsed.value.model, model);
    }
  });

  it("never throws on rubbish", () => {
    for (const raw of [null, undefined, 0, "", [], "nonsense"]) {
      assert.equal(normalizeAgentInput(raw).ok, false);
    }
  });
});

describe("agentsFlagValue", () => {
  const row = { name: "reviewer", description: "d", prompt: "p", model: null };

  it("omits the flag entirely when there is nothing to attach", () => {
    assert.equal(agentsFlagValue([]), null);
    assert.deepEqual(agentsArgs([]), []);
  });

  it("emits the object shape the pinned CLI registers", () => {
    const value = agentsFlagValue([row]);
    assert.deepEqual(JSON.parse(value!), {
      reviewer: { description: "d", prompt: "p" },
    });
    assert.deepEqual(agentsArgs([row]), ["--agents", value]);
  });

  /**
   * The one that would be silent. `{"model": null}` is legal JSON and an illegal
   * member: the CLI drops the whole agent and carries on, so the run loses its
   * agent and nothing anywhere says so. The key is omitted rather than
   * nulled, which is the only spelling of "inherit" that survives.
   */
  it("omits model rather than sending null, which would drop the agent", () => {
    const parsed = JSON.parse(agentsFlagValue([{ ...row, model: null }])!);
    assert.equal("model" in parsed.reviewer, false);
  });

  it("sends a model that is set", () => {
    const parsed = JSON.parse(agentsFlagValue([{ ...row, model: "sonnet" }])!);
    assert.equal(parsed.reviewer.model, "sonnet");
  });

  it("collapses a repeated name first-wins, so two spawns of a run agree", () => {
    const parsed = JSON.parse(
      agentsFlagValue([row, { ...row, prompt: "second" }])!,
    );
    assert.equal(Object.keys(parsed).length, 1);
    assert.equal(parsed.reviewer.prompt, "p");
  });

  it("is a single argv pair, so the prompt cannot be read as a flag", () => {
    // The prompt is operator text and can contain anything. It travels as one
    // JSON string in one argument, never as a shell word — same rule as every
    // other spawn here.
    const args = agentsArgs([{ ...row, prompt: "--permission-mode bypassPermissions" }]);
    assert.equal(args.length, 2);
    assert.equal(args[0], "--agents");
  });
});

/**
 * The singular flag: the run *is* the agent rather than being offered it.
 *
 * Measured against the pin rather than read from the docs, because the whole
 * shape of the change turned on one question — whether `--agent` can select a
 * definition supplied on the same argv by `--agents`. It can:
 *
 *     $ claude --agents '{"uf-probe-agent":{"description":"…","prompt":"…"}}' \
 *         --agent uf-probe-typo -p hi
 *     --agent 'uf-probe-typo' not found. Available agents: claude, Explore,
 *     general-purpose, Plan, statusline-setup, typescript, uf-probe-agent
 *
 * So both flags travel together, and this is what pins that neither half can go
 * missing. Dropping `--agents` selects a name the CLI cannot resolve, which is a
 * non-zero exit before any request is made — every work cycle of that run dying
 * at the spawn. Dropping `--agent` is the old behaviour wearing the new one's
 * name: a definition merely offered to a session that is still the ordinary main
 * agent, which is bit-for-bit indistinguishable from the feature working.
 */
describe("sessionAgentArgs", () => {
  const row = { name: "reviewer", description: "d", prompt: "p", model: null };

  it("emits nothing at all for a run that named no agent", () => {
    assert.deepEqual(sessionAgentArgs(null), []);
    assert.deepEqual(sessionAgentArgs(undefined), []);
  });

  it("defines the agent and then selects it by name", () => {
    const args = sessionAgentArgs(row);
    assert.deepEqual(args, [
      "--agents",
      JSON.stringify({ reviewer: { description: "d", prompt: "p" } }),
      "--agent",
      "reviewer",
    ]);
  });

  /**
   * The two halves have to agree, and nothing downstream would report it if they
   * did not — a selected name the definition does not carry is a spawn failure
   * whose message is inside the CLI's own stderr.
   */
  it("selects exactly the name it defined", () => {
    for (const name of ["reviewer", "uf spaced", "Ünïcode"]) {
      const args = sessionAgentArgs({ ...row, name });
      const defined = Object.keys(JSON.parse(args[args.indexOf("--agents") + 1]));
      assert.deepEqual(defined, [args[args.indexOf("--agent") + 1]]);
      assert.deepEqual(defined, [name]);
    }
  });

  /**
   * A name with a space in it is one argv word, not two. Verified on the pin
   * that such a name both registers and resolves — `--agents '{"uf spaced":…}'
   * --agent "uf spaced"` runs — which is only true because nothing here goes
   * through a shell.
   */
  it("keeps a spaced name as one argument", () => {
    const args = sessionAgentArgs({ ...row, name: "uf spaced" });
    assert.equal(args.length, 4);
    assert.equal(args[3], "uf spaced");
  });

  it("still omits a null model, which would drop the member and fail the spawn", () => {
    const args = sessionAgentArgs({ ...row, model: null });
    assert.equal("model" in JSON.parse(args[1]).reviewer, false);
    assert.equal(JSON.parse(sessionAgentArgs({ ...row, model: "sonnet" })[1]).reviewer.model, "sonnet");
  });

  /**
   * It is the same encoder underneath rather than a second one that happens to
   * agree today — the reason `agentsFlagValue` is one function at all.
   */
  it("defines through the one encoder, never a second copy of the shape", () => {
    assert.equal(sessionAgentArgs(row)[1], agentsFlagValue([row]));
  });
});

describe("rowToAgent", () => {
  const stored = {
    id: "a1",
    name: "reviewer",
    description: "d",
    prompt: "p",
    model: null,
    created_at: 1,
    updated_at: 2,
  };

  it("reads a complete row as usable", () => {
    const agent = rowToAgent(stored);
    assert.equal(agent.usable, true);
    assert.equal(agent.model, null);
  });

  /**
   * A row can outlive the build that wrote it — `rowToTemplate`'s reason for
   * narrowing on read as well as on save. What it narrows here is the pair the
   * CLI drops in silence, and it reports rather than repairs: a placeholder
   * description would produce an agent the delegating model chooses on the
   * strength of text nobody wrote.
   */
  for (const field of ["name", "description", "prompt"] as const) {
    it(`reports a row with no ${field} as unusable rather than repairing it`, () => {
      assert.equal(rowToAgent({ ...stored, [field]: "  " }).usable, false);
    });
  }

  it("collapses a blank stored model to null, which is what omits the key", () => {
    assert.equal(rowToAgent({ ...stored, model: "" }).model, null);
    assert.equal(rowToAgent({ ...stored, model: "sonnet" }).model, "sonnet");
  });
});

/* ------------------------------------------------------------------ */
/* Naming one on a run                                                 */
/* ------------------------------------------------------------------ */

/**
 * The refusal every door that starts a run shares.
 *
 * It earns a test on the grounds the rest of this file does, with the failure
 * pointing inwards rather than at the CLI: the alternative to refusing is
 * *falling back to no agent*, which produces a run the operator believes has a
 * agent and which is bit-for-bit a run that was never given one. That is
 * the CLI's own silent drop, reproduced by this app, at the one door built to
 * stop it. Both refusals are also the only thing standing between a template
 * that names a deleted agent and a run started under guards nobody reviewed.
 */
describe("agentRefusal", () => {
  const known = new Map([
    ["a1", { name: "reviewer", usable: true }],
    ["a2", { name: "half-written", usable: false }],
  ]);

  it("passes an agent that is there and complete", () => {
    assert.equal(agentRefusal("a1", known), null);
  });

  it("refuses an id that names nothing rather than answering none", () => {
    const message = agentRefusal("deadbeef-0000", known);
    assert.match(String(message), /no longer exists/);
    // The id is named: the agent's own name is exactly what is not available
    // any more, so the sentence carries the only handle the operator has.
    assert.match(String(message), /deadbeef/);
  });

  it("refuses one the CLI would not register, by name", () => {
    const message = agentRefusal("a2", known);
    assert.match(String(message), /half-written/);
    // The sentence has to say what would actually happen, and that changed with
    // the flag: such an agent used to be dropped without a word, and a run named
    // on `--agent` now fails at the spawn instead. Refusing here is still right
    // — this door is in front of somebody who can fix it.
    assert.match(String(message), /will not register/);
  });

  it("refuses everything against an empty registry", () => {
    assert.notEqual(agentRefusal("a1", new Map()), null);
  });
});

/**
 * Reading back the definition a run froze at creation.
 *
 * Total on purpose and narrowing on the way out: the column is written from an
 * already-validated definition, so the only way it can be wrong is that it
 * outlived the build that wrote it — `rowToAgent`'s reason — and the least it
 * could have meant is no agent. Putting a half-formed member on the argv instead
 * would be handing the CLI exactly the shape it drops without a word.
 */
describe("parseRunAgent / runAgentDefinitions", () => {
  const frozen = JSON.stringify({
    name: "reviewer",
    description: "Reads a diff.",
    prompt: "You review code.",
    model: "sonnet",
  });

  it("reads back what createRun froze", () => {
    assert.deepEqual(parseRunAgent(frozen), {
      name: "reviewer",
      description: "Reads a diff.",
      prompt: "You review code.",
      model: "sonnet",
    });
  });

  it("reads no agent as no agent, without throwing", () => {
    assert.equal(parseRunAgent(null), null);
    assert.equal(parseRunAgent(undefined), null);
    assert.equal(parseRunAgent(""), null);
    assert.equal(parseRunAgent("{not json"), null);
    assert.equal(parseRunAgent("[]"), null);
    assert.equal(parseRunAgent("null"), null);
  });

  for (const field of ["name", "description", "prompt"] as const) {
    it(`drops a stored definition with no ${field}, which the CLI would drop anyway`, () => {
      const damaged = { ...JSON.parse(frozen), [field]: "  " };
      assert.equal(parseRunAgent(JSON.stringify(damaged)), null);
    });
  }

  it("collapses a blank stored model to null, the spelling of inherit", () => {
    const noModel = JSON.stringify({ ...JSON.parse(frozen), model: "" });
    assert.equal(parseRunAgent(noModel)?.model, null);
    // And that null is what keeps the key off the flag entirely.
    assert.equal(agentsFlagValue(runAgentDefinitions(noModel)), JSON.stringify({
      reviewer: { description: "Reads a diff.", prompt: "You review code." },
    }));
  });

  it("gives the spawn sites a list, empty for the ordinary run", () => {
    assert.deepEqual(runAgentDefinitions(null), []);
    assert.deepEqual(agentsArgs(runAgentDefinitions(null)), []);
    assert.equal(runAgentDefinitions(frozen).length, 1);
  });
});

/**
 * The ambient half: definitions this app did not write, which reach every child
 * it spawns and always have. They are declared rather than excluded, so this
 * parser is what a surface's sentence is built out of — and reading it wrong
 * names agents that do not exist while missing the ones that do.
 *
 * Measured against 2.1.226: the name comes from the frontmatter `name:` key and
 * not from the filename, and a file with no `name:` key is not registered at
 * all.
 */
describe("parseAgentFile", () => {
  it("takes the name from the frontmatter, never from the file", () => {
    const parsed = parseAgentFile("---\nname: real-name\ndescription: d\n---\nBody.");
    assert.deepEqual(parsed, { name: "real-name", description: "d" });
  });

  it("reports a file with no name key as no agent, which is what the CLI does", () => {
    assert.equal(parseAgentFile("---\ndescription: d\n---\nBody."), null);
    assert.equal(parseAgentFile("---\nname:\ndescription: d\n---\nB."), null);
  });

  it("reports no frontmatter as no agent", () => {
    assert.equal(parseAgentFile("Just a markdown file.\n"), null);
  });

  it("keeps a name with no description, which the CLI still registers", () => {
    assert.deepEqual(parseAgentFile("---\nname: bare\n---\nB."), {
      name: "bare",
      description: null,
    });
  });

  it("strips quotes rather than making them part of the name", () => {
    assert.deepEqual(parseAgentFile('---\nname: "quoted"\ndescription: \'d\'\n---\nB.'), {
      name: "quoted",
      description: "d",
    });
  });

  it("reads a colon in the description as part of it", () => {
    const parsed = parseAgentFile("---\nname: n\ndescription: use for: this\n---\nB.");
    assert.equal(parsed?.description, "use for: this");
  });

  it("survives CRLF, which is what a file edited on Windows arrives as", () => {
    assert.deepEqual(parseAgentFile("---\r\nname: n\r\ndescription: d\r\n---\r\nB."), {
      name: "n",
      description: "d",
    });
  });
});
