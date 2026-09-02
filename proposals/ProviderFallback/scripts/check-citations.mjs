#!/usr/bin/env node
// Resolve every citation in proposals/ProviderFallback/ mechanically.
//
//   `path/file.ts:N`        full citation; N must exist in that file
//   `path/file.ts:N`–`:M`   a range on the SAME file
//   `:N` otherwise          chains to the last named repo path in the same
//                           markdown file — the form ContextControl's
//                           validation pass found fifty violations of
//
// Names that are not repo paths (Codex sources, `config.toml`, `AGENTS.md`,
// absolute host paths) suppress the anchor instead of erroring, so a bare `:N`
// after one is reported rather than silently chained to something older.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Derived from this file's own location, so the script runs from anywhere.
const DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(dirname(DIR));
const files = readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
const problems = [];
let links = 0, paths = 0, named = 0, bare = 0, foreign = 0;

const counts = new Map();
const lines = (p) => {
  if (!counts.has(p)) counts.set(p, readFileSync(join(ROOT, p), "utf8").split("\n").length);
  return counts.get(p);
};
const resolve = (p) => {
  if (existsSync(join(ROOT, p))) return p;
  for (const d of ["src/lib/", "src/app/"]) if (existsSync(join(ROOT, d + p))) return d + p;
  return null;
};
// Anything matching these is not this repository's and is not an error.
const FOREIGN =
  /^(codex-rs\/|\/|~|config\.toml$|AGENTS\.md$|\.credentials\.json$|cli\.rs$|exec_events\.rs$|exec_lib\.rs$|shared_options\.rs$|sandbox_mode_cli_arg\.rs$|approval_mode_cli_arg\.rs$|config_override\.rs$|token_data\.rs$|auth_env_telemetry\.rs$|shell_environment_policy\.rs$|lib\.rs$|hook_config\.rs$|mcp_types\.rs$|filter\.jsonl$)/;

const TOKEN =
  /(–|-)?`(?:(Dockerfile|docker-compose\.yml|[A-Za-z0-9_.\/~-]+\.(?:ts|tsx|mjs|sh|rs|md|json|jsonl|yml|toml))(?::(\d+))?|:(\d+))`/g;

for (const f of files) {
  const text = readFileSync(join(DIR, f), "utf8");

  for (const m of text.matchAll(/\]\((?!https?:)([^)\s#]+)\)/g)) {
    links++;
    if (!existsSync(join(DIR, m[1]))) problems.push(`${f}: dead link → ${m[1]}`);
  }

  let anchor = null;
  for (const m of text.matchAll(TOKEN)) {
    const [, dash, path, pathLine, bareLine] = m;
    if (path) {
      if (existsSync(join(DIR, path))) { anchor = null; continue; }   // sibling doc
      if (FOREIGN.test(path)) { foreign++; anchor = null; continue; }
      const p = resolve(path);
      if (!p) { problems.push(`${f}: no such path → ${path}`); anchor = null; continue; }
      paths++;
      anchor = p;
      if (pathLine) {
        named++;
        if (Number(pathLine) > lines(p))
          problems.push(`${f}: ${p}:${pathLine} past EOF (${lines(p)})`);
      }
      continue;
    }
    const n = Number(bareLine);
    bare++;
    if (!anchor) { problems.push(`${f}: ${dash ? "range end" : "bare"} \`:${n}\` with no anchor`); continue; }
    if (n > lines(anchor))
      problems.push(
        `${f}: ${dash ? "range end" : "bare"} \`:${n}\` → ${anchor} (${lines(anchor)} lines) WRONG ANCHOR`,
      );
  }
}

console.log(
  `files ${files.length}  links ${links}  repo paths ${paths}  foreign names ${foreign}  named lines ${named}  bare :N ${bare}`,
);
console.log(problems.length ? `\nPROBLEMS (${problems.length}):` : "\nno problems");
for (const p of problems) console.log("  " + p);
