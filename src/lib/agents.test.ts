import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentsArgs,
  agentsFlagValue,
  normalizeAgentInput,
  parseAgentFile,
  rowToAgent,
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
 * So the whole class of fault is one shape: a run that was given a specialist
 * and does not have one, which is bit-for-bit a run that was never given one.
 * Nothing downstream can tell the difference — not the event log, not the cost,
 * not the transcript's own `attributionAgent`, which simply never names it.
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
   * specialist and nothing anywhere says so. The key is omitted rather than
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
