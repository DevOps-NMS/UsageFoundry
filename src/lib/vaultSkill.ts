import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { randomBytes } from "node:crypto";

import { getJSON, setJSON } from "./db";
import { resolveKnowledgeRoot } from "./knowledge";
import { privilegeSeparated } from "./privsep";
import { getSettings, type Settings } from "./settings";

/**
 * The vault-lookup skill: a plugin directory this app generates per spawn and
 * hands to the child with `--plugin-dir`.
 *
 * ## Why it is not installed
 *
 * `plugins.ts` states the constraint at length and it applies here unchanged:
 * compose bind-mounts the operator's `~/.claude` into the container, the CLI's
 * registry records **absolute** paths, and whichever side installs last breaks
 * the other silently — a skip logged, exit 0, and every session afterwards
 * running with no skill, no error and entirely normal-looking output. So
 * nothing here writes into `~/.claude/skills`, and delivery is per spawn.
 *
 * Measured against the pinned CLI (2.1.226) rather than assumed: a directory
 * carrying `.claude-plugin/plugin.json` and `skills/<name>/SKILL.md`, passed as
 * `--plugin-dir`, is loaded as a session-only plugin ("Loaded 1 skills from
 * plugin … default directory") and the skill reaches the model's skill list as
 * `<plugin>:<skill>`. The namespace is not cosmetic: the operator may have a
 * skill of the same name in `~/.claude/skills` — this container does — and the
 * prefix is what keeps the two apart instead of one silently shadowing the
 * other.
 *
 * ## Why it is generated rather than shipped as a file
 *
 * The skill has to name the vault's absolute path *as the child will see it*,
 * and that path is a setting. The two candidate mechanisms were a generated
 * SKILL.md and a fixed one reading an environment variable, and generation wins
 * on three counts. The path lands in the file as literal text, so the agent can
 * `Read` it without a shell round trip and an operator can `cat` the file to see
 * exactly what a run was told. Whether the vault has a ranked search script is a
 * property of *that* vault, discoverable only by looking, so a fixed file would
 * have to carry both branches and hope the model picked the right one. And the
 * text is a template string in this module rather than an asset on disk, so it
 * is in git, reviewable, unit-testable as a pure function, and cannot go missing
 * from a standalone build.
 *
 * **`DATA_DIR` is the one place it must not be written.** The image creates
 * `/data` `chown root:root` + `chmod 0700` and the entrypoint re-reclaims it on
 * every boot, precisely so agents dropped to `UF_AGENT_UID` cannot read this
 * app's database; the same entrypoint names it in the CLI's managed
 * `permissions.deny` read list. A plugin directory there is unreadable by the
 * child on exactly the hardened install this feature is for — and the CLI's
 * response to a plugin directory it cannot read is a skip and exit 0. It would
 * work on a laptop and be silently absent in production, which is the failure
 * this whole area exists to avoid.
 *
 * ## Its own settings row
 *
 * `plugins.ts`'s reason, unchanged: the settings page sends the whole object on
 * Save, so a field in that blob is one that an unrelated edit from a stale tab
 * silently clears. For a preference that is a nuisance; for the switch deciding
 * whether unattended agents are told a vault exists it is the failure the
 * separation exists to prevent.
 */

const KEY = "knowledge.skillEnabled";

/** The plugin's name, and so the prefix the skill is offered under. */
const PLUGIN_NAME = "usagefoundry";

/** The skill's own name, under that prefix. */
const SKILL_NAME = "knowledge-vault";

/**
 * Where the generated plugin directory goes when children are a different uid.
 *
 * `chat.ts`'s `MCP_CONFIG_BASE` one door over, with the ownership argument
 * running the other way: that file is a capability and is kept *from* the
 * agents, this one is instructions and has to reach them. So root-owned and
 * 0755 — every agent reads it, no agent writes it. That asymmetry is the point:
 * a SKILL.md is text a model follows, and a sibling agent able to rewrite one
 * would be able to put words into another run's mouth.
 *
 * Without separation there is no boundary to build and no point pretending
 * otherwise, so it falls back to `os.tmpdir()`, exactly as the MCP config does:
 * one uid means a sibling can write whatever this process can write, wherever
 * it is put.
 */
export const VAULT_SKILL_BASE = "/run/uf-skills";

/**
 * Where a vault keeps its own ranked search, in the order they are tried.
 *
 * Two entries and no more, because this is a convention rather than a standard
 * — the only vault anybody has measured keeps it at `_Meta/vault_search.py` —
 * and a longer list would be guessing on an operator's behalf. A vault with the
 * script somewhere else reads as a vault with none, which degrades to grep with
 * the degradation stated in the skill rather than silently pretending to rank.
 */
export const SEARCH_SCRIPT_CANDIDATES = ["_Meta/vault_search.py", "vault_search.py"] as const;

/** What the skill needs to know about the vault it is being pointed at. */
export interface VaultSkillContext {
  /** Absolute path of the vault, as the child process will see it. */
  vaultPath: string;
  /** How the settings page names it — "Documents / Knowledge Vault". */
  vaultLabel: string;
  /** Absolute path of the vault's own ranked search, or null if it has none. */
  searchScript: string | null;
}

/**
 * What this cycle's spawn should be handed.
 *
 * A result union rather than a nullable pair because the three readings need
 * different things done about them: `off` is silent, `unavailable` is a line on
 * the run's own log — an agent that stops receiving a skill behaves exactly
 * like one that never had it — and only `ready` puts anything on the argv.
 */
export type VaultSkillDelivery =
  | { kind: "off" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; pluginDir: string; vaultPath: string; searchScript: string | null };

/** Is the vault skill switched on for this install? */
export function vaultSkillEnabled(): boolean {
  return getJSON<unknown>(KEY, false) === true;
}

/**
 * Switch the vault skill on or off.
 *
 * Switching it on with no knowledge base configured is refused where the person
 * is, which is `defaultAgentId`'s rule: stored, it would be a switch reading as
 * on while every cycle silently passed no skill at all. Being switched on
 * against a mount that has since gone is deliberately *not* refused — a compose
 * edit or an unplugged drive is a temporary fault the settings section already
 * reports, and forcing the operator to press the switch again once it comes
 * back would make the state say something it does not mean.
 */
export function setVaultSkillEnabled(enabled: boolean, s: Settings = getSettings()): void {
  if (enabled) {
    const root = resolveKnowledgeRoot(s);
    if (!root.ok && !root.configured) {
      throw new Error(
        "No knowledge base is configured, so there is no vault for the skill to look in. " +
          "Pick a folder under Where the vault is first.",
      );
    }
  }
  setJSON(KEY, enabled);
}

/**
 * The vault's own ranked search, if it has one.
 *
 * Named rather than executed: what comes back goes into the skill as a command
 * for the agent to run with its own authority, over content the operator owns —
 * so this is a question about what the vault ships, not a containment decision.
 * The vault root it is joined onto was proved contained twice by
 * `resolveKnowledgeRoot` before this is reached.
 */
export function findSearchScript(
  vaultPath: string,
  exists: (p: string) => boolean = isFile,
): string | null {
  for (const candidate of SEARCH_SCRIPT_CANDIDATES) {
    const full = path.join(vaultPath, candidate);
    if (exists(full)) return full;
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The skill, as the text that is written to disk.
 *
 * Pure, and the reason it is worth a unit test is that every way of getting it
 * wrong is silent: a SKILL.md naming a path the run cannot read produces an
 * agent that answers from memory in the vault's name, which is exactly the
 * failure this feature exists to prevent and is indistinguishable, from the
 * outside, from an agent that consulted the vault and agreed with itself.
 *
 * The rules kept from the operator's own skill are the ones that generalise:
 * ranked search before grep, believe an abstention, read whole notes rather
 * than grep fragments, and carry the confidence grade with every claim. What is
 * dropped is everything true only of that vault — its host path, its index
 * layout, and its inbox, which is a *write* path and out of scope here.
 *
 * The description is the one part that rides in every session's context on
 * every cycle of every run, so it is three sentences rather than the operator's
 * paragraph of topics: a topic list would be both larger and wrong for whatever
 * vault an operator actually points this at.
 */
export function renderVaultSkill(v: VaultSkillContext): string {
  const search = v.searchScript
    ? `1. **Ranked search first**, one command:

   \`\`\`bash
   python3 ${JSON.stringify(v.searchScript)} "<the question, in the asker's own words>"
   \`\`\`

   Run it with \`--help\` if you need more than the ranked list. If the script
   itself fails, say so in your answer, fall back to the grep below, and state
   that what you are relaying is unranked.

2. **Believe the abstention.** No confident match usually means the vault does
   not cover the question, and saying so is a correct answer. Do not paper over
   it with general knowledge.`
    : `1. **This vault ships no ranked search**, so searching it is grep and grep is
   unranked. Say that whenever you relay a result: a hit is evidence that a
   phrase occurs in a note, not evidence that the note is about the question.

   \`\`\`bash
   grep -ril "<phrase>" ${JSON.stringify(v.vaultPath)} --include="*.md"
   \`\`\`

2. **A search that returns nothing is an answer.** It usually means the vault
   does not cover the question. Say so rather than filling the gap with general
   knowledge.`;

  return `---
name: ${SKILL_NAME}
description: Search the knowledge vault at ${v.vaultLabel} — the operator's own graded notes — instead of answering from general knowledge. Use when asked what is known, settled or already researched about something, or when a claim needs the evidence behind it rather than a confident summary. Also use before asserting anything the vault is likely to have an opinion on.
---

Answer from the vault, not from memory. If the vault does not cover the
question, say so: an absence is a correct answer, and general knowledge relayed
as a finding is the one failure this skill exists to prevent.

## The vault

\`\`\`
${v.vaultPath}
\`\`\`

List that directory before anything else.

**If it fails, stop and report it.** Say that the vault could not be read at
that path, quote the error, and answer nothing from memory in its place. Do not
go looking for the vault somewhere else, and do not carry on without it: a run
that answers as though it consulted the vault when it could not is worse than a
run that fails, because nothing downstream can tell the two apart.

## Search

${search}

3. **Read whole notes, never grep fragments.** A hit inside a \`> [!warning]\`
   block often says the opposite of the note's own claim.

4. **Follow \`[[wikilinks]]\` by resolving them yourself** — a link is a note
   title, not a path, so find the file whose name or \`aliases\` matches it.
   Skip \`\`\`dataview\`\`\` blocks; they render to nothing when read as text.

## Report trust, not just content

Every claim you relay carries its grade. This is the point of a graded vault;
stripping the grade makes the answer worse than no answer.

| Marker in the note's frontmatter | What to say |
|---|---|
| \`confidence: high\` | State it plainly |
| \`confidence: medium\` | Attribute it — "the vault's note, resting on a vendor report, says…" |
| \`confidence: low\` | Flag as unsettled; give the framing, not a conclusion |
| \`status: seed\` | A hypothesis with research steps, not a finding. Never cite as established |
| \`evidence: vendor\` | Name the commercial interest |
| a contradiction tag | Report both sides and what would settle it |

Keep the note's own distinctions: \`> [!quote]\` is a source, \`> [!note]\` is the
author's inference, \`> [!warning]\` is uncertainty. Do not flatten them into
"the vault says".

## What to return

1. **The answer**, with each claim's confidence and the vault-relative path of
   the note it came from.
2. **What the vault does not cover**, if the question ran past its edges.
3. **Any open question** the vault records on the subject — often more useful
   than the answer, because it says what is genuinely undecided.

## Never write to the vault

Nothing in this app writes into the vault and neither do you. Do not create,
edit, move or delete anything under the vault path — not a note, not an inbox
entry, not a typo you noticed on the way past. If the work turns up something
the vault should record, say so in your answer and leave the writing to a
person.
`;
}

/** The manifest, which is constant: only the SKILL.md varies per install. */
function manifest(): string {
  return `${JSON.stringify(
    {
      name: PLUGIN_NAME,
      version: "1.0.0",
      description: "UsageFoundry's own skills, delivered per spawn rather than installed.",
    },
    null,
    2,
  )}\n`;
}

/**
 * Write a file so that a child reading it concurrently sees one whole version.
 *
 * Temp-then-rename in the same directory, because the alternative — truncating
 * the file a spawn a millisecond behind is about to read — is a SKILL.md whose
 * frontmatter has arrived and whose vault path has not. The mode is set after
 * the write rather than requested in it: `writeFile`'s mode is masked by the
 * umask, so 0644 arrives as 0644 by luck and as something narrower under any
 * umask an operator changed — and a file the agent's uid cannot read is a skill
 * that silently is not there.
 */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The rename is what matters; a leftover temp file is not worth masking
      // the error that caused it.
    }
    throw err;
  }
}

function base(): string {
  if (!privilegeSeparated()) return os.tmpdir();
  fs.mkdirSync(VAULT_SKILL_BASE, { recursive: true, mode: 0o755 });
  // `mkdir` masks the mode through the umask and does nothing at all when the
  // directory already exists, so the mode is set rather than requested.
  fs.chmodSync(VAULT_SKILL_BASE, 0o755);
  return VAULT_SKILL_BASE;
}

/**
 * Materialise the plugin directory and answer with its path.
 *
 * One directory for the install rather than one per run: the content is a
 * function of the two settings that name the vault, so two runs spawning
 * together write identical bytes, and `writeAtomic` is what makes a concurrent
 * reader see one of them whole. It is deliberately not cleaned up when a run
 * ends — the CLI reads SKILL.md when the model invokes the skill, not at
 * startup, so a directory removed after the spawn is a skill that exists until
 * the moment it is used.
 */
export function writeVaultSkill(v: VaultSkillContext): string {
  const dir = path.join(base(), `uf-${PLUGIN_NAME}-skills`);
  const skillDir = path.join(dir, "skills", SKILL_NAME);
  const manifestDir = path.join(dir, ".claude-plugin");
  for (const d of [dir, manifestDir, path.join(dir, "skills"), skillDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o755 });
    fs.chmodSync(d, 0o755);
  }
  writeAtomic(path.join(manifestDir, "plugin.json"), manifest());
  writeAtomic(path.join(skillDir, "SKILL.md"), renderVaultSkill(v));
  return dir;
}

/**
 * What this cycle's spawn gets, resolved now rather than when the run started.
 *
 * Per cycle for `enabledPluginDirs`' reason: a run outlives the settings it
 * started under, and the vault is re-proved contained at the moment it is used
 * rather than trusted from when it was switched on.
 */
export function prepareVaultSkill(s: Settings = getSettings()): VaultSkillDelivery {
  if (!vaultSkillEnabled()) return { kind: "off" };

  const root = resolveKnowledgeRoot(s);
  if (!root.ok) return { kind: "unavailable", reason: root.reason };

  const searchScript = findSearchScript(root.root);
  const vaultLabel = root.subpath ? `${root.mountLabel} / ${root.subpath}` : root.mountLabel;
  let pluginDir: string;
  try {
    pluginDir = writeVaultSkill({ vaultPath: root.root, vaultLabel, searchScript });
  } catch (err) {
    // Named rather than swallowed. A skill that failed to be written is a run
    // that will answer from memory without knowing it was supposed to do
    // otherwise, and nothing else in this app would ever mention it.
    return {
      kind: "unavailable",
      reason: `The vault skill could not be written: ${(err as Error).message}`,
    };
  }

  return { kind: "ready", pluginDir, vaultPath: root.root, searchScript };
}
