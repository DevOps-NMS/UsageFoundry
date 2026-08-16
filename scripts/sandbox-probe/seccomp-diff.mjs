#!/usr/bin/env node
// Prove that `uf-seccomp.json` is your Docker's default profile plus four named
// blocks, and nothing else.
//
// The profile beside this was derived from moby v28.5.2's copy of the default,
// which is a version and not a guarantee: the default moves between engine
// releases (28.2 added three `lsm_*` names, 28.4 moved the file into its own
// module), and a profile derived from the wrong one either denies something
// your containers rely on or permits something you did not read. Nobody diffs
// two 13 KB JSON files by eye, so this does it: it strips every block whose
// `comment` starts with `UF-PROBE:`, drops the non-schema `_comment` key, and
// asserts what is left is byte-for-byte the upstream you hand it.
//
// It is a check and not a generator. If it reports drift, the fix is to
// re-derive against your own engine's default rather than to edit this — the
// four added blocks are printed so you can see exactly what to re-apply.
//
// Usage, on the machine that will run the probe:
//
//   docker version --format '{{.Server.Version}}'          # e.g. 28.5.2
//   # engines up to 28.3.x:
//   curl -fsSL -o /tmp/upstream.json \
//     https://raw.githubusercontent.com/moby/moby/v28.3.3/profiles/seccomp/default.json
//   # engines from 28.4.0 on, where the profile lives in its own module:
//   curl -fsSL -o /tmp/upstream.json \
//     https://raw.githubusercontent.com/moby/moby/v28.5.2/vendor/github.com/moby/profiles/seccomp/default.json
//
//   node scripts/sandbox-probe/seccomp-diff.mjs /tmp/upstream.json
//
// With no node on the host, the probe image carries one:
//
//   docker run --rm -v "$PWD/scripts/sandbox-probe:/p" -v /tmp/upstream.json:/u.json \
//     usagefoundry:probe node /p/seccomp-diff.mjs /u.json /p/uf-seccomp.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "UF-PROBE:";

const [upstreamPath, derivedPath = path.join(HERE, "uf-seccomp.json")] = process.argv.slice(2);

if (!upstreamPath) {
  console.error("usage: seccomp-diff.mjs <upstream-default.json> [<derived.json>]");
  console.error("See the header of this file for where to fetch the upstream default.");
  process.exit(2);
}

/** Reading these is the whole job, so a parse failure names the file. */
function readProfile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`${file} is not JSON: ${err.message}`);
    process.exit(2);
  }
}

const upstream = readProfile(upstreamPath);
const derived = readProfile(derivedPath);

const addedBlocks = (derived.syscalls ?? []).filter((s) => (s.comment ?? "").startsWith(MARKER));
const baseBlocks = (derived.syscalls ?? []).filter((s) => !(s.comment ?? "").startsWith(MARKER));

// Compared as canonical JSON rather than field by field: an added key anywhere
// in a rule is exactly the kind of drift this exists to catch, and a structural
// walk would have to know the schema to know what it may ignore. Key order is
// normalised because it carries no meaning in JSON and every editor changes it.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

// The allow-everything block is 361 syscall names long, so printing two of them
// side by side hides the one name that moved. Report the set difference.
function describeBlockDrift(upstreamBlock, block) {
  const lines = [];
  const before = new Set(upstreamBlock?.names ?? []);
  const after = new Set(block?.names ?? []);
  const gained = [...after].filter((n) => !before.has(n));
  const lost = [...before].filter((n) => !after.has(n));
  if (gained.length > 0) lines.push(`    names here and not upstream: ${gained.join(", ")}`);
  if (lost.length > 0) lines.push(`    names upstream and not here: ${lost.join(", ")}`);
  for (const key of new Set([...Object.keys(upstreamBlock ?? {}), ...Object.keys(block ?? {})])) {
    if (key === "names") continue;
    if (canonical(upstreamBlock?.[key]) !== canonical(block?.[key])) {
      lines.push(`    "${key}": upstream ${canonical(upstreamBlock?.[key])} / here ${canonical(block?.[key])}`);
    }
  }
  return lines.join("\n");
}

const problems = [];

// `_comment` is not in the profile schema. Docker's loader is a plain
// `json.Unmarshal`, which ignores unknown keys, so it costs nothing — but it is
// ours and must not be counted as upstream drift.
const strippedDerived = { ...derived, syscalls: baseBlocks };
delete strippedDerived._comment;

for (const key of new Set([...Object.keys(upstream), ...Object.keys(strippedDerived)])) {
  if (key === "syscalls") continue;
  if (canonical(upstream[key]) !== canonical(strippedDerived[key])) {
    problems.push(`top-level "${key}" differs from upstream`);
  }
}

if (baseBlocks.length !== (upstream.syscalls ?? []).length) {
  problems.push(
    `upstream has ${(upstream.syscalls ?? []).length} rule blocks, this profile has ` +
      `${baseBlocks.length} that are not marked ${MARKER}`,
  );
} else {
  baseBlocks.forEach((block, i) => {
    if (canonical(block) !== canonical(upstream.syscalls[i])) {
      problems.push(`rule block ${i} differs from upstream:\n${describeBlockDrift(upstream.syscalls[i], block)}`);
    }
  });
}

console.log(`upstream: ${upstreamPath} (${(upstream.syscalls ?? []).length} rule blocks)`);
console.log(`derived:  ${derivedPath} (${(derived.syscalls ?? []).length} rule blocks)`);
console.log("");
console.log(`added by this repository (${addedBlocks.length}):`);
for (const block of addedBlocks) {
  const args = (block.args ?? [])
    .map((a) => `arg${a.index} ${a.op} value=0x${(a.value ?? 0).toString(16)} valueTwo=0x${(a.valueTwo ?? 0).toString(16)}`)
    .join("; ");
  console.log(`  ${block.action.padEnd(15)} ${block.names.join(", ")}${args ? `  [${args}]` : ""}`);
}
console.log("");

if (problems.length > 0) {
  console.error(`DRIFT: this profile is not ${upstreamPath} plus those ${addedBlocks.length} blocks.`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  console.error("Re-derive against your own engine's default before using it. Do not widen");
  console.error("anything else while you are in there.");
  process.exit(1);
}

console.log(`OK: everything outside those ${addedBlocks.length} blocks is ${upstreamPath} verbatim.`);
