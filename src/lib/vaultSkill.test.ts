import { strict as assert } from "node:assert";
import { test } from "node:test";

import { findSearchScript, renderVaultSkill, SEARCH_SCRIPT_CANDIDATES } from "./vaultSkill";

/**
 * The generated vault-lookup skill.
 *
 * Every failure mode in this file is silent, which is the bar
 * `docs/agent/testing.md` sets — and here it is silent twice over. A SKILL.md
 * whose frontmatter does not parse is not loaded by the CLI at all: the spawn
 * succeeds, the argv is right, the debug log says one plugin was found and
 * nothing says the skill was rejected. And a SKILL.md that *is* loaded but has
 * lost the vault path, or the instruction to stop when the vault cannot be
 * read, produces a run that answers from its own knowledge in the vault's name
 * — which is indistinguishable, from anywhere downstream, from a run that
 * consulted the vault and agreed with itself. Neither shows up in a typecheck,
 * a smoke test, or the run's own log.
 *
 * What is asserted is therefore the *contract with the reader*, not the prose:
 * the frontmatter's shape, that the resolved path is present verbatim, which
 * of the two search branches was taken, and the two instructions the feature
 * would be actively harmful without.
 */

const ctx = {
  vaultPath: "/workspace/notes/Knowledge Vault",
  vaultLabel: "Documents / Knowledge Vault",
  searchScript: null,
};

/** The `---`-delimited block, or null if the file does not open with one. */
function frontmatter(text: string): string | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 3);
  return end === -1 ? null : text.slice(4, end);
}

test("the frontmatter is one line per key, whatever the vault is called", () => {
  // The load-bearing detail, and the one a later edit is most likely to undo by
  // wrapping the description to fit the file's margin. YAML reads a wrapped
  // value as a continuation only under rules this does not follow; what a
  // second unindented line actually produces is a parse failure, and the CLI's
  // answer to a skill it cannot parse is to skip it and carry on.
  const text = renderVaultSkill({
    ...ctx,
    vaultLabel: "A vault: with a colon, and — dashes",
  });
  const fm = frontmatter(text);
  assert.ok(fm, "the file must open with a frontmatter block");
  for (const line of fm.split("\n")) {
    assert.match(line, /^[a-z][a-z-]*: \S/, `frontmatter line is not one key: ${line}`);
  }
  assert.match(fm, /^name: knowledge-vault$/m);
});

test("names the resolved vault path in the body, verbatim", () => {
  // The reason this skill is generated rather than shipped as a file. A path
  // that arrives mangled — or, worse, as the template's own placeholder — is a
  // skill that sends the run looking somewhere that does not exist.
  const text = renderVaultSkill(ctx);
  assert.ok(text.includes("/workspace/notes/Knowledge Vault"));
});

test("tells the run to stop rather than answer from memory", () => {
  // The instruction the whole feature exists for. Without it the skill's
  // failure mode is a confident answer with a vault's name on it.
  const text = renderVaultSkill(ctx);
  assert.match(text, /stop and report/i);
  assert.match(text, /memory/i);
});

test("forbids writing into the vault", () => {
  // `--add-dir` was measured to add the directory to the session's *write* set,
  // not a read-only one, so this sentence is the only thing standing between an
  // agent and the operator's notes.
  assert.match(renderVaultSkill(ctx), /Never write to the vault/);
});

test("names the one job that does write, rather than claiming nothing does", () => {
  // It used to say "Nothing in this app writes into the vault and neither do
  // you", and Dreaming made the first half false. Every run gets this skill,
  // including the nightly writer whose whole task is to write here — so the
  // flat claim left that run holding two instructions that contradict each
  // other, and it obeyed the right one by luck rather than by design. A skill
  // is persuasion; a sentence in it that the reader can see is untrue is worth
  // less than one that is narrower and true.
  const text = renderVaultSkill(ctx);
  assert.doesNotMatch(text, /Nothing in this app writes into the vault/);
  assert.match(text, /your task text governs/i);
});

test("tells a run to search before investigating, not only when asked", () => {
  // The trigger, and the reason the description is worth its place in every
  // cycle's context. Measured: a run told to search first answered the same
  // question at $0.75 in 83s against $1.63 in 369s, and the unsteered one
  // never searched at all despite having the skill available.
  const text = renderVaultSkill(ctx);
  const fm = frontmatter(text) ?? "";
  assert.match(fm, /before investigating/i, "the description carries the trigger");
  assert.match(text, /Check before you investigate/);
});

test("uses the vault's ranked search when it has one", () => {
  const text = renderVaultSkill({
    ...ctx,
    searchScript: "/workspace/notes/Knowledge Vault/_Meta/vault_search.py",
  });
  // Quoted, because the only vault anybody has pointed this at lives under a
  // path with a space in it and an unquoted argument would split.
  assert.ok(
    text.includes('python3 "/workspace/notes/Knowledge Vault/_Meta/vault_search.py"'),
    "the ranked search must be named as a runnable, quoted command",
  );
  assert.match(text, /Believe the abstention/);
});

test("says it is unranked when the vault has no search script", () => {
  // The degradation has to be stated rather than performed quietly: grep
  // returns a phrase match, and a run relaying an unranked hit as though it
  // were a ranked one is making a claim about relevance nothing measured.
  const text = renderVaultSkill(ctx);
  assert.match(text, /no ranked search/i);
  assert.match(text, /unranked/);
  assert.ok(!text.includes("python3"), "no script means no command naming one");
});

test("finds a search script in candidate order, under the vault root", () => {
  const root = "/vault";
  const both = new Set(SEARCH_SCRIPT_CANDIDATES.map((c) => `${root}/${c}`));
  assert.equal(
    findSearchScript(root, (p) => both.has(p)),
    "/vault/_Meta/vault_search.py",
    "the conventional location wins over the fallback",
  );
  assert.equal(
    findSearchScript(root, (p) => p === "/vault/vault_search.py"),
    "/vault/vault_search.py",
  );
  // Absent reads as absent rather than as a path that happens not to exist:
  // naming a script that is not there would make every cycle open with a
  // command that fails.
  assert.equal(
    findSearchScript(root, () => false),
    null,
  );
});
