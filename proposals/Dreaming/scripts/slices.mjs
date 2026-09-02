#!/usr/bin/env node
/**
 * What each candidate slice of a day's sessions weighs, and what reading it costs.
 *
 *   node proposals/Dreaming/scripts/slices.mjs ~/.claude/projects
 *
 * `02-what-a-day-contains.md`'s cost table comes from here. The point of the
 * split is that "read every session" and "read what the sessions said" differ
 * by a factor of thirty, and the operator's sentence does not choose between
 * them.
 *
 * The `user` row is not the operator talking. Injected `<system-reminder>`
 * blocks, hook output and skill text all arrive as user `text` blocks, which is
 * why it outweighs the assistant side nearly three to one.
 */
import fs from "node:fs";
import path from "node:path";

const BYTES_PER_TOKEN = 3.6; // src/lib/fileCostNotice.ts:87
const OPUS_INPUT_PER_MTOK = 5; // src/lib/pricing.ts:38
const HAIKU_INPUT_PER_MTOK = 1; // src/lib/pricing.ts:56

const root = process.argv[2] ?? ".";

function* jsonlFiles(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".jsonl")) yield p;
    }
  }
}

let raw = 0;
let assistantText = 0;
let userText = 0;
let toolUse = 0;
let toolResult = 0;
let errorBytes = 0;
let errorBlocks = 0;
const days = new Set();

for (const file of jsonlFiles(root)) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const day = (record.timestamp ?? "").slice(0, 10);
    if (!day) continue;
    days.add(day);
    raw += Buffer.byteLength(line) + 1;
    const message = record.message;
    if (!message) continue;
    if (typeof message.content === "string") {
      const n = Buffer.byteLength(message.content);
      if (record.type === "user") userText += n;
      else assistantText += n;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "text") {
        const n = Buffer.byteLength(block.text ?? "");
        if (record.type === "user") userText += n;
        else assistantText += n;
      } else if (block.type === "tool_use") {
        toolUse += Buffer.byteLength(JSON.stringify(block.input ?? {}));
      } else if (block.type === "tool_result") {
        const c = block.content;
        const n = Buffer.byteLength(typeof c === "string" ? c : JSON.stringify(c ?? ""));
        toolResult += n;
        if (block.is_error) {
          errorBytes += n;
          errorBlocks++;
        }
      }
    }
  }
}

const n = days.size || 1;
const row = (label, bytes, extra = "") => {
  const perDay = bytes / n;
  const tokens = perDay / BYTES_PER_TOKEN;
  console.log(
    `${label.padEnd(22)} ${(bytes / 1048576).toFixed(2).padStart(9)} MB total` +
      ` ${(perDay / 1048576).toFixed(3).padStart(8)} MB/day` +
      ` ${(tokens / 1000).toFixed(1).padStart(8)}k tok` +
      ` opus $${((tokens * OPUS_INPUT_PER_MTOK) / 1e6).toFixed(3).padStart(7)}` +
      ` haiku $${((tokens * HAIKU_INPUT_PER_MTOK) / 1e6).toFixed(3).padStart(7)}` +
      (extra ? `  ${extra}` : ""),
  );
};

console.log(`${n} days\n`);
row("whole raw corpus", raw);
row("prose (all text)", assistantText + userText);
row("  assistant text", assistantText);
row("  user text", userText, "includes system-reminders and hook output");
row("tool_use inputs", toolUse);
row("tool_result output", toolResult);
row("  of which is_error", errorBytes, `${errorBlocks} blocks`);
