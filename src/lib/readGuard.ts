import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { randomBytes } from "node:crypto";

import { BYTES_PER_TOKEN } from "./fileCostNotice";
import { privilegeSeparated } from "./privsep";
import { getSettings, type Settings } from "./settings";

/**
 * A `PreToolUse` hook on `Read` that refuses a repeat of a read this session
 * has already made, and refuses a whole read past a size the operator picked.
 *
 * ## Why a hook rather than more words in the prompt
 *
 * `fileCostNotice.ts` next door is the persuasion half of this and states the
 * measurement both halves rest on: 58% of this fleet's spend is cache **read**
 * and 20% cache write, so 83% of the bill is carrying context rather than
 * generating anything, and `Read` alone placed 27.4M tokens over 9,334 calls on
 * this machine. Nothing shrinks a main thread between compactions, so a file
 * read on turn 12 is paid for again on every turn after it — which is why the
 * same tool call costs 12.0c at turns 1-10 and 20.4c past turn 200.
 *
 * A price list can only ask. This refuses, and the difference is the class of
 * mistake it catches: a model that has genuinely forgotten it already read a
 * file cannot be talked out of reading it again by a sentence it was given two
 * hundred turns ago. The ledger remembers for it.
 *
 * ## Why it ships off, and what would have to be measured to change that
 *
 * **Nothing here is measured.** The savings above are measured; that *denying*
 * a read produces them is not. Two things could make it a loss and neither is
 * hypothetical. A denied read the agent works around with four ranged reads of
 * the same file costs more than the read did, and the ledger cannot see that
 * happen. And a denial spends a turn — the deny reason is a tool result the
 * agent pays for on every later turn, exactly like the read it prevented,
 * except smaller.
 *
 * What would settle it is the same shape `docs/verification.md` used for
 * `--autocompact`: a matched pair of runs on one task, one arm each way,
 * compared on total spend **and** on whether the task finished. Not a
 * within-run before/after — a run's cost per call climbs with position all on
 * its own, so the second half of any run is dearer than the first whatever this
 * setting says.
 *
 * ## What is confirmed about the mechanism, and what is not
 *
 * The hook **contract** is read out of the CLI's own bundle rather than from
 * prose: `PreToolUse` output is validated against a discriminated union keyed on
 * `hookSpecificOutput.hookEventName`, carrying `permissionDecision` of
 * allow/deny/ask/defer and `permissionDecisionReason` — so a refusal missing the
 * event name is not a refusal, it is output the CLI discards. The plugin file's
 * shape is `{"hooks": {"PreToolUse": [{matcher, hooks: [...]}]}}`, which is what
 * every plugin under Anthropic's own marketplace ships and what the bundle's
 * "the standard hooks/hooks.json is loaded automatically" path reads.
 *
 * What has **not** been observed running here is that a plugin delivered by
 * `--plugin-dir` registers its *hooks* — as opposed to its skills, which
 * `vaultSkill.ts` measured. The evidence is indirect and one-sided: the CLI
 * carries a `--plugin-dir-no-mcp` variant, which only means anything if the
 * plain flag loads every component, and the hooks loader is generic over plugin
 * objects rather than over installed ones. Confirming it costs a billed run, so
 * it is stated rather than assumed. If it turns out to be false the symptom is
 * this feature doing nothing at all, which is the same thing as being off —
 * which is what it ships as.
 *
 * ## Why it is generated, and why not into `DATA_DIR`
 *
 * Both answers are `vaultSkill.ts`'s, unchanged, and the second one is the
 * silent failure of the pair. Never `claude plugin install`: compose binds the
 * operator's `~/.claude` onto `/home/node/.claude`, so the CLI's registry is one
 * file shared by host and container and it records **absolute** paths —
 * whichever side installs last breaks the other with a skip and exit 0. And the
 * generated directory goes to `/run` rather than `DATA_DIR`, which is 0700 root
 * and on the CLI's managed `denyRead` list: a plugin directory there is
 * unreadable by the agent uid on exactly the hardened install this is for, and
 * the CLI's answer to a plugin directory it cannot read is a skip and exit 0. It
 * would work on a laptop and be absent in production.
 *
 * It rides `--plugin-dir` beside the enabled plugins and the vault skill rather
 * than a mechanism of its own, so the "not restored by `--resume`, therefore on
 * every cycle's argv" rule covers it in the same breath.
 *
 * ## Why this one is a key of `Settings` when the plugin list is not
 *
 * `plugins.ts` and `vaultSkill.ts` keep their switches in their own settings
 * rows because the settings page PUTs the whole blob on Save, so a stale tab
 * silently clears a field in it — and for the switch deciding *what third-party
 * code every agent loads*, being silently cleared is the failure the separation
 * exists to prevent. Neither half of that argument holds here. The code loaded
 * is this app's own, generated from this module, and a stale tab clearing the
 * switch reverts to the behaviour every install has today, which is the safe
 * direction. A cleared plugin list is an agent quietly running less than it was
 * told to; a cleared read guard is an agent quietly reading as much as it likes.
 */

/**
 * Where the generated plugin directory goes when children are a different uid.
 *
 * `VAULT_SKILL_BASE`'s reasoning and its modes: root-owned and 0755, so every
 * agent reads it and no agent writes it. That asymmetry is what makes the hook
 * a rule rather than a suggestion — a sibling agent able to rewrite the script
 * could switch off another run's guard, or worse, put its own code on the
 * `PreToolUse` path of every tool call that run makes.
 *
 * The **ledger** below is the opposite and has to be, which is why it is a
 * separate directory rather than a file in here.
 */
export const READ_GUARD_BASE = "/run/uf-read-guard";

/** The plugin's name, which is also the directory's. */
const PLUGIN_NAME = "usagefoundry-read-guard";

/**
 * What the CLI itself already refuses, read out of the pinned bundle rather
 * than assumed.
 *
 * `claude` 2.1.235's own file-reading limits carry `maxTokens: 25000`, and a
 * whole read past it comes back as "File content (N tokens) exceeds maximum
 * allowed tokens (25000). Use offset and limit parameters…" — the same advice
 * this hook gives, at a threshold nobody here chose. A cap set at or above this
 * therefore changes **nothing**, and an operator who set 50,000 would be
 * looking at a switch that reads as on and does nothing at all. So the number
 * is exported, the settings page states it, and the route clamps to it.
 *
 * It is the *default*, and a `settings.json` on the install could move it, so
 * this is a ceiling on what is worth asking for rather than a claim about what
 * the CLI will do.
 */
export const CLI_MAX_READ_TOKENS = 25_000;

/**
 * How many lines a `Read` with no `limit` actually returns, from the same
 * bundle: "was too large and has been truncated to the first 2000 lines".
 *
 * Load-bearing for the cap, and the reason it estimates from the *read* rather
 * than from the file. A 9,500-line file is 116,000 tokens on the price list and
 * a whole read of it returns 2,000 lines — perhaps 25,000 — so a cap that
 * compared the file's size would refuse reads that were never going to cost
 * what it thought. Over-refusal is the failure mode that makes an agent fight
 * the guard instead of using it.
 */
export const CLI_DEFAULT_READ_LINES = 2_000;

/** What the generated hook needs baked into it. */
export interface ReadGuardConfig {
  /**
   * The cap on one whole read, in tokens, or null for no cap.
   *
   * Null leaves the repeat-read half running on its own, which is the half that
   * needs no number from anybody.
   */
  maxWholeReadTokens: number | null;
  /** Absolute path of the directory the hook keeps its per-session ledgers in. */
  ledgerDir: string;
}

/** What this cycle's spawn should be handed. */
export type ReadGuardDelivery =
  | { kind: "off" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; pluginDir: string };

/**
 * The manifest. Constant, because everything that varies is in the script.
 *
 * It ships hooks and nothing else — no skills, no agents, no commands, no MCP
 * server — and that is a property worth keeping rather than an accident of
 * scope. A plugin that contributed a skill listing would put text into every
 * session's context, and this feature exists to take text out of it.
 */
export function renderManifest(): string {
  return `${JSON.stringify(
    {
      name: PLUGIN_NAME,
      version: "1.0.0",
      description:
        "UsageFoundry's read guard: refuses a repeated Read and caps one whole read.",
    },
    null,
    2,
  )}\n`;
}

/**
 * `hooks/hooks.json`, in the shape a **plugin** uses.
 *
 * The wrapper is the trap. A plugin's file is `{"hooks": {"PreToolUse": […]}}`
 * while `settings.json` takes the events at the top level, and the CLI's answer
 * to the wrong one is to load the plugin and register no hook — no error, no
 * warning, and a run that behaves exactly like one with the guard switched off.
 * The shape here is the one every plugin under
 * `claude-plugins-official` on this machine actually ships, checked rather than
 * taken from prose.
 *
 * The command is an absolute path rather than `${CLAUDE_PLUGIN_ROOT}`. The
 * variable is the documented portable form and is right for a plugin somebody
 * distributes; this directory is generated per install by the process writing
 * this file, so its path is already known here, and baking it removes one
 * expansion nobody on this install can test. `node` is the interpreter because
 * the CLI is a Node program and the image is `node:22-bookworm-slim`, so it is
 * the one runtime the container is guaranteed to have.
 *
 * The CLI runs a command hook through a shell, so the path is double-quoted.
 * That is safe for what can actually appear in it — a compile-time constant
 * under `/run`, or `os.tmpdir()` on an install with no privilege separation —
 * and it is the one place in this app where a path reaches a shell rather than
 * an argv array. It is stated because the containment argument next door does
 * not cover it: nothing here proves a path with a `$` in it, and the reason
 * that is acceptable is that neither of the two roots can contain one.
 */
export function renderHookConfig(scriptPath: string): string {
  return `${JSON.stringify(
    {
      description:
        "Refuses a Read this session has already made and whose file has not changed, and caps a whole read.",
      hooks: {
        PreToolUse: [
          {
            // Exact and case-sensitive, which is what the CLI documents. A
            // broader matcher would put a Node spawn in front of every tool
            // call the run makes.
            matcher: "Read",
            hooks: [
              {
                type: "command",
                command: `node ${JSON.stringify(scriptPath)}`,
                // Generous against a cold filesystem and far under anything a
                // person would notice: the hook stats one file and reads at
                // most a few tens of kilobytes of it. What the timeout is
                // really for is the case where it hangs — the CLI carries on
                // when a hook times out, which is the direction this must fail
                // in.
                timeout: 10,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The hook itself, as the text written to disk.
 *
 * Generated rather than shipped as an asset for `vaultSkill.ts`'s three
 * reasons, of which the last is the one that would bite: `next build` emits
 * `.next/standalone`, and a `.mjs` beside this module is not something the
 * standalone trace has any reason to copy. A file that is silently missing in
 * production is exactly the failure this whole area is built around. As a
 * template string it is in git, reviewable, and — because the script it emits
 * is executable on its own — testable by running it.
 *
 * ## The three rules the body cannot break
 *
 * **It fails open.** Every path that is not a deliberate refusal exits 0 having
 * printed nothing, which the CLI reads as "no opinion". A hook that threw and
 * refused would stop a run dead over a missing ledger directory, and this is a
 * cost optimisation.
 *
 * **A ranged read is never refused.** That is what keeps a denial recoverable:
 * whatever this says no to, `offset` and `limit` still reach every byte of the
 * file. A guard that could make a file unreadable would burn work cycles — the
 * one failure that is strictly worse than the tokens it saves.
 *
 * **It ignores a sub-agent.** `agent_id` is present on the hook's stdin only
 * when the call comes from inside a sub-agent, and a sub-agent's context is
 * discarded when it answers — so a read there is not carried forward and is not
 * what this is for. It would also be *wrong*: the ledger is the main thread's
 * memory, and telling a fresh sub-agent that a file is "already in context"
 * would be a lie it cannot check.
 *
 * ## Why the estimate is of the read and not of the file
 *
 * See `CLI_DEFAULT_READ_LINES`. The script reads at most one token-budget's
 * worth of bytes and asks whether the 2,000th newline arrives inside it; if it
 * does, the read stops there and is under the cap whatever the rest of the file
 * weighs. The bound on that scan is the point — the hook must not become a way
 * to read a gigabyte per tool call.
 */
export function renderHookScript(config: ReadGuardConfig): string {
  const ledger = JSON.stringify(config.ledgerDir);
  const cap = config.maxWholeReadTokens === null ? "null" : String(config.maxWholeReadTokens);
  // Concatenation rather than template literals inside the emitted script, so
  // that nothing in it can be mistaken for an interpolation of *this* file's
  // template and every quote survives review unchanged.
  return `// Generated by UsageFoundry. Edits here are overwritten on the next spawn.
import fs from "node:fs";
import path from "node:path";

const LEDGER_DIR = ${ledger};
const MAX_WHOLE_READ_TOKENS = ${cap};
const BYTES_PER_TOKEN = ${BYTES_PER_TOKEN};
const CLI_DEFAULT_READ_LINES = ${CLI_DEFAULT_READ_LINES};
const MAX_LEDGER_ENTRIES = 512;
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const NEWLINE = 10;

/** Refuse, in the one shape the CLI's PreToolUse union accepts. */
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/** Say nothing, which is how a hook expresses no opinion. */
function pass() {
  process.exit(0);
}

function thousands(tokens) {
  return tokens >= 1000 ? Math.round(tokens / 1000) + "k" : String(tokens);
}

/**
 * Would a whole read of this file cost more than the cap?
 *
 * A boolean rather than a figure, because a bounded scan cannot produce an
 * honest figure: past the budget all it knows is that the CLI's line cap did
 * not arrive first. A message naming a token count it had not measured would be
 * the one kind of wrong this guard cannot afford — the agent is being asked to
 * change what it does on the strength of it.
 */
function exceedsCap(file, size, capTokens) {
  const budget = Math.ceil(capTokens * BYTES_PER_TOKEN);
  if (size <= budget) return false;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(budget + 1);
    const got = fs.readSync(fd, buf, 0, budget + 1, 0);
    let lines = 0;
    for (let i = 0; i < got; i += 1) {
      if (buf[i] === NEWLINE) {
        lines += 1;
        // The read stops at the CLI's own line cap, inside the byte budget, so
        // it costs less than the cap however large the rest of the file is.
        if (lines >= CLI_DEFAULT_READ_LINES) return false;
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return true;
}

function ledgerFile(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
  if (!safe) return null;
  return path.join(LEDGER_DIR, safe + ".json");
}

function loadLedger(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
      return parsed.files;
    }
  } catch {
    // A ledger that is missing, truncated or half-written is a session with no
    // history, which is the state every session starts in.
  }
  return null;
}

/**
 * Temp-then-rename, because a reader is another process's hook running now.
 * Two reads racing can lose one entry; the cost of that is one denial that did
 * not happen, which is the direction to lose in.
 */
function saveLedger(file, files) {
  const keys = Object.keys(files);
  if (keys.length > MAX_LEDGER_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_LEDGER_ENTRIES)) delete files[key];
  }
  const tmp = file + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), files: files }));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

/** Drop ledgers from sessions that ended, so the directory does not grow for ever. */
function sweep() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(LEDGER_DIR)) {
      const full = path.join(LEDGER_DIR, name);
      try {
        if (now - fs.statSync(full).mtimeMs > LEDGER_TTL_MS) fs.rmSync(full, { force: true });
      } catch {}
    }
  } catch {}
}

let raw = "";
try {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  pass();
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  pass();
}

if (!input || typeof input !== "object") pass();
if (input.tool_name !== "Read") pass();
// Present only inside a sub-agent, whose context is discarded when it answers.
if (typeof input.agent_id === "string" && input.agent_id) pass();

const toolInput = input.tool_input;
if (!toolInput || typeof toolInput !== "object") pass();
const file = toolInput.file_path;
if (typeof file !== "string" || !file) pass();

// The escape hatch, and it is checked before anything else can refuse: a read
// that names a range is always allowed, so nothing this hook does can put a
// byte of any file out of reach.
if (toolInput.offset !== undefined || toolInput.limit !== undefined) pass();

let stat;
try {
  stat = fs.statSync(file);
} catch {
  // Let Read report its own missing file. A hook that answered for it would
  // turn "no such file" into "refused", which reads as a policy decision.
  pass();
}
if (!stat.isFile()) pass();

if (MAX_WHOLE_READ_TOKENS !== null) {
  let over = false;
  try {
    over = exceedsCap(file, stat.size, MAX_WHOLE_READ_TOKENS);
  } catch {
    // A file that cannot be scanned is not a file to refuse over.
    over = false;
  }
  if (over) {
    deny(
      "Reading " + file + " whole would add more than " + thousands(MAX_WHOLE_READ_TOKENS) +
      " tokens to this conversation, which is what this run allows for one read. Nothing " +
      "shrinks this conversation, so that is not a one-off charge: every later turn of this " +
      "work cycle carries it again. Find what you need with Grep or Glob, or read the part " +
      "you want with Read and offset and limit — a read that names a range is never refused, " +
      "however large the range, so nothing here is out of reach."
    );
  }
}

const ledgerPath = ledgerFile(input.session_id);
if (!ledgerPath) pass();

const existing = loadLedger(ledgerPath);
const files = existing === null ? {} : existing;
const seen = files[file];

if (
  seen &&
  typeof seen === "object" &&
  seen.size === stat.size &&
  seen.mtimeMs === Math.floor(stat.mtimeMs)
) {
  deny(
    "You have already made this exact read of " + file + " in this session, and the file has " +
    "not changed since — same size, same modification time. Re-reading it would put a second " +
    "identical copy into this conversation, and every later turn of this work cycle would " +
    "carry both. Use what is already in your context. If you have genuinely lost it, or you " +
    "want one region rather than the file, read it again with offset and limit — a read that " +
    "names a range is never refused."
  );
}

files[file] = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
if (existing === null) sweep();
saveLedger(ledgerPath, files);
pass();
`;
}

/**
 * Write a file so a child reading it concurrently sees one whole version.
 *
 * `vaultSkill.ts`'s `writeAtomic`, and its note on the mode applies here twice
 * over: `writeFile`'s mode is masked by the umask, so 0644 arrives narrower
 * under any umask an operator changed — and a hook script the agent uid cannot
 * read is a plugin the CLI skips with exit 0.
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

function base(separated = privilegeSeparated()): string {
  if (!separated) return os.tmpdir();
  fs.mkdirSync(READ_GUARD_BASE, { recursive: true, mode: 0o755 });
  // `mkdir` masks the mode through the umask and does nothing at all when the
  // directory already exists, so the mode is set rather than requested.
  fs.chmodSync(READ_GUARD_BASE, 0o755);
  return READ_GUARD_BASE;
}

/**
 * Where the per-session ledgers live, and the one directory here the agents
 * write.
 *
 * `1777` — world-writable with the sticky bit — rather than 0755, and the two
 * halves are separate decisions. Writable, because the ledger is written by the
 * hook, which runs as the agent uid; the plugin directory beside it stays
 * root-owned precisely so that the *code* cannot be rewritten by what runs it.
 * Sticky, because without it one agent could unlink or replace another's
 * ledger by name.
 *
 * What a sibling can still do is write into a ledger whose session id it
 * guessed, and the worst that buys is a refused read in another run — which
 * that run recovers from with a ranged read. That asymmetry is the whole reason
 * this file holds *denials* and never grants.
 */
function ledgerDir(root: string, separated: boolean): string {
  const dir = path.join(root, "uf-read-guard-ledger");
  // 0700 without separation, `VAULT_SKILL_BASE`'s reasoning inverted: one uid
  // means a sibling can already write whatever this process can, so a
  // world-writable directory in the shared `os.tmpdir()` would be a hole opened
  // for a boundary that does not exist.
  const mode = separated ? 0o1777 : 0o700;
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chmodSync(dir, mode);
  return dir;
}

/**
 * Materialise the plugin directory and answer with its path.
 *
 * One directory for the install rather than one per run, `writeVaultSkill`'s
 * arrangement: the contents are a function of one setting, so two runs spawning
 * together write identical bytes and `writeAtomic` is what makes a concurrent
 * reader see one of them whole. Not cleaned up when a run ends — the CLI reads
 * `hooks.json` when the session starts and the script on every matching tool
 * call, so a directory removed after the spawn is a guard that exists until the
 * moment it is used.
 */
export function writeReadGuard(maxWholeReadTokens: number | null): string {
  const separated = privilegeSeparated();
  const root = base(separated);
  const dir = path.join(root, `uf-${PLUGIN_NAME}`);
  const hooksDir = path.join(dir, "hooks");
  const manifestDir = path.join(dir, ".claude-plugin");
  for (const d of [dir, manifestDir, hooksDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o755 });
    fs.chmodSync(d, 0o755);
  }
  const scriptPath = path.join(hooksDir, "read-guard.mjs");
  writeAtomic(
    scriptPath,
    renderHookScript({ maxWholeReadTokens, ledgerDir: ledgerDir(root, separated) }),
  );
  writeAtomic(path.join(hooksDir, "hooks.json"), renderHookConfig(scriptPath));
  writeAtomic(path.join(manifestDir, "plugin.json"), renderManifest());
  return dir;
}

/**
 * What this cycle's spawn gets, resolved now rather than when the run started.
 *
 * Per cycle for `enabledPluginDirs`' and `prepareVaultSkill`'s reason: a run
 * outlives the settings it started under, and an operator switching this off
 * because a run is fighting it should get that at the next cycle rather than at
 * the next restart. Safe to move mid-run in a way the file price list is not —
 * a hook is code the CLI runs, not text in the cached prefix, so changing it
 * between two cycles of one run costs nothing.
 */
export function prepareReadGuard(s: Settings = getSettings()): ReadGuardDelivery {
  if (!s.readGuard) return { kind: "off" };
  try {
    return { kind: "ready", pluginDir: writeReadGuard(s.readGuardMaxTokens) };
  } catch (err) {
    // Named rather than swallowed, `prepareVaultSkill`'s rule: a guard that
    // failed to be written is a cycle that reads as much as it likes, and
    // nothing else in this app would ever mention it.
    return {
      kind: "unavailable",
      reason: `The read guard could not be written: ${(err as Error).message}`,
    };
  }
}
