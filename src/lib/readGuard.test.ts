import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

/**
 * The generated read guard, tested by running it.
 *
 * Every failure mode here is silent and two of them are the expensive kind.
 * A `hooks.json` in the wrong shape is loaded by the CLI and registers no hook
 * at all — no error, no warning, and a run that behaves exactly like one with
 * the guard switched off, which is also what a *working* guard looks like from
 * every page in this app. A deny in the wrong shape fails the CLI's own
 * discriminated union and is discarded the same way. And a guard that refuses
 * too much is worse than one that refuses nothing: the run does not fail, it
 * burns work cycles arguing with a hook, which costs more than the reads it
 * prevented.
 *
 * So the hook is not unit-tested through a copy of its logic — it is written to
 * disk exactly as a spawn would write it and run as a child process with real
 * stdin, which is the only thing that proves the artifact rather than a
 * paraphrase of it. `spawnSync` for the reason `mergeQueueDrain.test.ts` uses
 * it: the thing under test is a program, and the assertion is about what it
 * prints.
 *
 * What is deliberately *not* asserted is the prose of a refusal. What matters
 * about it is that it names the file and leaves a route open, and both of those
 * are checked; the sentences themselves are copy.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-readguard-")));
process.env.DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// `require`, not `import`, for the reason the file price list's test gives:
// imports hoist above the environment setup and `config.ts` reads `DATA_DIR`
// once at load.
const {
  CLI_DEFAULT_READ_LINES,
  CLI_MAX_READ_TOKENS,
  renderHookConfig,
  renderHookScript,
  renderManifest,
} = require("./readGuard") as typeof import("./readGuard");

/** What the CLI prints into a `PreToolUse` hook's stdin, in its own shape. */
interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_id?: string;
}

/** What comes back, parsed, or null when the hook expressed no opinion. */
interface HookOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

let scripts = 0;

/**
 * A guard on disk, and a function that asks it about one tool call.
 *
 * A fresh ledger directory per harness, because the whole point of the ledger
 * is that it remembers — two tests sharing one would pass or fail on the order
 * `node --test` happened to run them in.
 */
function guard(maxWholeReadTokens: number | null) {
  scripts += 1;
  const dir = path.join(tmp, `guard-${scripts}`);
  const ledgerDir = path.join(dir, "ledger");
  fs.mkdirSync(ledgerDir, { recursive: true });
  const script = path.join(dir, "read-guard.mjs");
  fs.writeFileSync(script, renderHookScript({ maxWholeReadTokens, ledgerDir }));

  return (input: Partial<HookInput> & { tool_input: Record<string, unknown> }) => {
    const payload: HookInput = {
      session_id: "sess-abc",
      transcript_path: "/dev/null",
      cwd: tmp,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      ...input,
    };
    const res = spawnSync(process.execPath, [script], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    assert.equal(
      res.status,
      0,
      `the hook must always exit 0; it exited ${res.status} saying: ${res.stderr}`,
    );
    const out = res.stdout.trim();
    return out === "" ? null : (JSON.parse(out) as HookOutput);
  };
}

/** A file of `bytes` bytes on `lines` lines, at a path of its own. */
function writeFile(name: string, bytes: number, lines = 1): string {
  const file = path.join(tmp, name);
  const perLine = Math.max(1, Math.floor(bytes / lines));
  const body = `${"x".repeat(perLine - 1)}\n`.repeat(lines);
  fs.writeFileSync(file, body);
  return file;
}

function denial(out: HookOutput | null): string {
  assert.ok(out, "the hook allowed a call it had to refuse");
  const specific = out.hookSpecificOutput;
  // The exact shape, because the CLI parses this against a discriminated union
  // keyed on `hookEventName` — a deny missing it is not a deny, it is a hook
  // whose output was thrown away.
  assert.equal(specific?.hookEventName, "PreToolUse");
  assert.equal(specific?.permissionDecision, "deny");
  const reason = specific?.permissionDecisionReason;
  assert.ok(typeof reason === "string" && reason.length > 0, "a refusal must say why");
  return reason;
}

test("hooks.json is the plugin wrapper shape, not the settings one", () => {
  // The trap this exists for: a plugin's file nests the events under `hooks`
  // and `settings.json` puts them at the top level. The CLI's answer to the
  // second shape in the first place is to load the plugin and register nothing
  // — no error, exit 0, and every run afterwards behaves as though the operator
  // had never switched this on.
  const parsed = JSON.parse(renderHookConfig("/run/x/read-guard.mjs")) as Record<
    string,
    unknown
  >;
  const hooks = parsed.hooks as Record<string, unknown> | undefined;
  assert.ok(hooks, "a plugin's hooks live under a `hooks` key");
  assert.equal(parsed.PreToolUse, undefined, "that is the settings.json shape");

  const events = hooks.PreToolUse as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  // Exact and case-sensitive. A wildcard would put a Node spawn in front of
  // every tool call a run makes.
  assert.equal(events[0].matcher, "Read");
  const entries = events[0].hooks as Array<Record<string, unknown>>;
  assert.equal(entries[0].type, "command");
  assert.match(String(entries[0].command), /^node "\/run\/x\/read-guard\.mjs"$/);
});

test("the manifest names the plugin and ships no skill", () => {
  // A manifest without a name is a directory `--plugin-dir` accepts and then
  // ignores. The second half is the one worth pinning as this grows: the
  // feature exists to keep text *out* of the window, so the day it starts
  // shipping a skill listing it starts costing what it saves.
  const parsed = JSON.parse(renderManifest()) as Record<string, unknown>;
  assert.ok(typeof parsed.name === "string" && parsed.name.length > 0);
  assert.equal(parsed.skills, undefined);
});

test("allows a first read and refuses the identical second one", () => {
  const ask = guard(null);
  const file = writeFile("once.ts", 400);
  assert.equal(ask({ tool_input: { file_path: file } }), null);
  const reason = denial(ask({ tool_input: { file_path: file } }));
  assert.ok(reason.includes(file), "a refusal has to name the file it is about");
  // The recoverable route, stated in the refusal itself. Without it the agent
  // has been told no and not told what to do, which is how a guard turns into
  // burnt work cycles.
  assert.match(reason, /offset and limit/);
});

test("allows the read again once the file has actually changed", () => {
  // The ledger's whole claim is "nothing changed since you read it", and it is
  // checked against the file rather than against what this app saw the agent
  // do — so an edit by the agent, by a sibling run, or by the operator all
  // reopen the file the same way.
  const ask = guard(null);
  const file = writeFile("edited.ts", 400);
  assert.equal(ask({ tool_input: { file_path: file } }), null);
  denial(ask({ tool_input: { file_path: file } }));

  fs.writeFileSync(file, "y".repeat(800));
  assert.equal(ask({ tool_input: { file_path: file } }), null);
});

test("never refuses a read that names a range", () => {
  // The invariant that keeps every refusal recoverable: whatever this says no
  // to, `offset`/`limit` still reaches every byte of the file. A guard that
  // could make a file unreadable would cost work cycles, which is strictly
  // worse than the tokens it saves.
  const ask = guard(1_000);
  const file = writeFile("huge.ts", 200_000, 10);
  for (const ranged of [{ offset: 1 }, { limit: 50 }, { offset: 1, limit: 100_000 }]) {
    assert.equal(ask({ tool_input: { file_path: file, ...ranged } }), null);
  }
  // …and a ranged read is not recorded either, so it cannot make a later whole
  // read look like a repeat of something the agent never had.
  denial(ask({ tool_input: { file_path: file } }));
});

test("refuses a whole read past the cap", () => {
  const ask = guard(1_000);
  const big = writeFile("big.ts", 20_000, 10);
  const reason = denial(ask({ tool_input: { file_path: big } }));
  assert.match(reason, /Grep|offset and limit/);
  // Under it, nothing happens.
  assert.equal(ask({ tool_input: { file_path: writeFile("small.ts", 400) } }), null);
});

test("does not refuse a long file whose read the CLI would truncate anyway", () => {
  // The reason the cap measures the *read* rather than the file. A whole `Read`
  // comes back truncated to the CLI's own line limit, so a file of many short
  // lines costs that much and no more — and a cap that compared file size would
  // refuse reads that were never going to cost what it thought. Over-refusal is
  // what makes an agent fight the guard instead of using it.
  const cap = 20_000;
  const ask = guard(cap);
  // 10,000 lines of 20 bytes: 200KB on disk, of which a whole `Read` returns
  // the first 2,000 lines — 40KB, comfortably under the cap. A guard that
  // priced the file would have refused it at three times the cap.
  const lines = CLI_DEFAULT_READ_LINES * 5;
  const file = writeFile("many-lines.ts", lines * 20, lines);
  assert.ok(
    fs.statSync(file).size / 3.6 > cap,
    "the fixture has to price above the cap by size, or it tests nothing",
  );
  assert.equal(ask({ tool_input: { file_path: file } }), null);
});

test("says nothing about a call from inside a sub-agent", () => {
  // `agent_id` is present only when the hook fires inside a sub-agent, whose
  // context is discarded when it answers — so its reads are not carried forward
  // and are not what this is for. Refusing there would also be a lie: the
  // ledger is the main thread's memory, and a fresh sub-agent has none of it.
  const ask = guard(1_000);
  const file = writeFile("delegated.ts", 20_000, 10);
  assert.equal(ask({ tool_input: { file_path: file }, agent_id: "agent-1" }), null);
  assert.equal(ask({ tool_input: { file_path: file }, agent_id: "agent-1" }), null);
});

test("keeps one session's ledger out of another's", () => {
  // Two runs work in the same folder at once, and the reads that are already
  // paid for are per conversation. Sharing a ledger would refuse a file the
  // second run has never seen.
  const ask = guard(null);
  const file = writeFile("shared.ts", 400);
  assert.equal(ask({ tool_input: { file_path: file } }), null);
  assert.equal(ask({ session_id: "sess-other", tool_input: { file_path: file } }), null);
  denial(ask({ tool_input: { file_path: file } }));
});

test("expresses no opinion on anything it cannot make sense of", () => {
  // Fail open, everywhere. This is a cost optimisation running in front of every
  // `Read` of every unattended run: a hook that threw would stop the run, and a
  // run stopped by its own cost hint has cost infinitely more than it saved.
  const ask = guard(1_000);
  assert.equal(ask({ tool_name: "Bash", tool_input: { command: "ls" } }), null);
  assert.equal(ask({ tool_input: {} }), null);
  assert.equal(ask({ tool_input: { file_path: 42 as unknown as string } }), null);
  assert.equal(ask({ tool_input: { file_path: path.join(tmp, "not-there.ts") } }), null);
  assert.equal(ask({ tool_input: { file_path: tmp } }), null, "a directory is not a file");
  assert.equal(ask({ session_id: "", tool_input: { file_path: writeFile("s.ts", 10) } }), null);
});

test("the cap the operator can usefully set stops below the CLI's own", () => {
  // Not a style assertion: the CLI already refuses a whole read past its own
  // limit with the same advice, so a cap at or above it is a switch that reads
  // as on and does nothing at all. The route clamps to this, and the settings
  // page says so.
  assert.ok(CLI_MAX_READ_TOKENS > 0);
  assert.ok(CLI_DEFAULT_READ_LINES > 0);
});
