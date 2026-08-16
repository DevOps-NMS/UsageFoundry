/**
 * One run event as the live log renders it.
 *
 * Every event used to be a single monospace string, coloured by kind and
 * prefixed with a glyph from a private alphabet (`⇢ ⌫ ⊕ ⇄ ⇥ ⌕`) that nothing on
 * the page explained. But the feed carries two different kinds of statement —
 * what the agent said, and what this app did about it — and rendering both at
 * one size in one typeface is why a reader scrolls past the prose looking for
 * it. `voice` is that split, and it is the only thing the renderer branches on.
 *
 * Pure and client-safe — no node builtins — for the reason `cycles.ts` is: it
 * runs in the browser over the replayed event stream.
 */

import type { RunEventDTO, SandboxRefusalKindDTO } from "./apiTypes";
import { fmtPct, fmtUSD } from "./format";

/**
 * What kind of statement a line is, which is what decides how it is set.
 *
 * `subagent` is prose like `agent` and is deliberately not the same voice: a
 * delegated turn is somebody else answering a question the main thread asked,
 * and a log that sets the two identically is a transcript of a conversation
 * with no speaker labels. It is what the reader has to be able to tell apart —
 * a report that silently interleaves two voices is worse than one that omits
 * the second.
 *
 * That is the turn a session **delegated**, which since the move to `--agent` is
 * a different thing from the agent a session **is**. Nothing here reads the
 * run's own agent: the split is `parent_tool_use_id` and only that, so a run
 * started as the reviewer still sets its own words as `agent` and only what it
 * hands off as `subagent`. Whether a `--agent` session delegates at all is
 * unmeasured; if it never does, this voice goes quiet rather than wrong, and it
 * still covers the ambient definitions that reach every child regardless.
 */
export type LogVoice = "agent" | "subagent" | "tool" | "cycle" | "system";

export type LogTone = "neutral" | "ok" | "warn" | "danger" | "accent";

export interface LogEntry {
  voice: LogVoice;
  tone: LogTone;
  /** The tool's name, or what a system row is about. Null for agent prose. */
  label: string | null;
  /** The body. Blank only on a tool call that carried no arguments. */
  text: string;
}

/**
 * The fields a tool call is actually about, in the order they win.
 *
 * Deliberately a list of *field* names rather than a table of tool names: the
 * CLI's tool set moves, and a tool this app has never heard of still has a
 * `command` or a `file_path` on it. Anything with none of them falls back to
 * the raw JSON, which is what every call rendered as before.
 */
const HEADLINE_FIELDS = [
  "command",
  "file_path",
  "notebook_path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "path",
] as const;

const MAX_ARG = 160;

/**
 * One line, bounded. A heredoc in a `Bash` call arrives with its newlines
 * intact and the log wraps, so an unflattened command pushed everything after
 * it off the visible region.
 */
function clip(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ARG ? `${flat.slice(0, MAX_ARG - 1)}…` : flat;
}

/**
 * What a tool call is about, in one bounded line.
 *
 * Exported because the stream parser retains the same string: a `tool_result`
 * names only the id of the call it answers, so the failure event has to carry
 * the command with it, and "which field names a call" must have one definition
 * — two would drift with nothing reporting it, and the second would be the one
 * an operator reads next to a 403.
 */
export function toolArgs(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return clip(input);
  if (typeof input !== "object") return clip(String(input));

  const fields = input as Record<string, unknown>;
  for (const key of HEADLINE_FIELDS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return clip(value);
  }
  return clip(JSON.stringify(input) ?? "");
}

/** Serialised length a stored tool input is cut to. Documented in Settings. */
export const MAX_TOOL_INPUT_CHARS = 4_000;

/**
 * Longest log line stored, before it is cut and marked.
 *
 * The other unbounded write into `run_events`: every stderr chunk an agent's
 * child produces becomes a row, so a run that builds anything writes its whole
 * build output into the database one chunk at a time. Larger than a tool input
 * because this is prose a person reads rather than a structure only
 * `toolArgs` looks at, and because the app's own sentences go through the same
 * door and must never be the thing that gets cut.
 */
export const MAX_LOG_CHARS = 8_000;

/** Longest single string value kept inside one, before it is cut. */
export const MAX_TOOL_FIELD_CHARS = 1_000;

/**
 * A tool call's input, bounded, for storage rather than for display.
 *
 * `run_events` keeps `b.input` whole, and for a `Write` or an `Edit` that input
 * *is* the file — `old_string` and `new_string` in full — so the log grows at
 * the byte volume of everything the agents write. Nothing ever read it whole:
 * `describeEvent` renders `toolArgs(input)`, one clipped line, and always has.
 *
 * So the cut is made where the bytes are, and it is made in an order that keeps
 * the line the reader sees: the headline fields go in first, exactly the ones
 * `toolArgs` picks between and in its order, then whatever else fits. Each
 * string is cut at `MAX_TOOL_FIELD_CHARS` — well under the total — so the field
 * that names the call can never be the one the budget runs out on.
 *
 * `truncatedFrom` is the serialised length before any of that, and it is
 * returned rather than folded into the object because it belongs on the event
 * payload beside the input: a short input and a shortened one must not look
 * alike, which is the same reason `runEvents` reports `dropped` on a replay it
 * cut and `diff.ts` counts the files it left out.
 *
 * Here rather than beside the sweep for `toolArgs`' own reason — this is the
 * second reader of "which field names a call", and two lists would drift with
 * nothing reporting it.
 */
export function clipToolInput(input: unknown): {
  input: unknown;
  truncatedFrom?: number;
} {
  // A value that will not serialise is recorded as the call with no arguments,
  // which is the true statement about it. Nothing off the stream can be one —
  // it arrives from `JSON.parse` — but this is on the path of every tool call
  // of every cycle, and `emit` is on the path of every status transition, so a
  // throw here would take a run's whole log with it and then the run.
  const raw = serialise(input);
  if (raw === undefined) return { input: null };
  if (raw.length <= MAX_TOOL_INPUT_CHARS) return { input };

  if (typeof input !== "object" || input === null) {
    // A bare string or number that is somehow this long: cut the value itself,
    // since there are no fields to choose between.
    return {
      input: typeof input === "string" ? cutTo(input, MAX_TOOL_FIELD_CHARS) : input,
      truncatedFrom: raw.length,
    };
  }

  const fields = input as Record<string, unknown>;
  const rest = Object.keys(fields).filter(
    (k) => !(HEADLINE_FIELDS as readonly string[]).includes(k),
  );

  const kept: Record<string, unknown> = {};
  let spent = 2; // the braces
  for (const key of [...HEADLINE_FIELDS, ...rest]) {
    if (!(key in fields)) continue;
    const value = fields[key];
    const cut = typeof value === "string" ? cutTo(value, MAX_TOOL_FIELD_CHARS) : value;
    const serialised = serialise(cut);
    // A value that will not serialise at all (a function, undefined) is left
    // out rather than stored as the string "undefined".
    if (serialised === undefined) continue;
    const cost = key.length + serialised.length + 4;
    if (spent + cost > MAX_TOOL_INPUT_CHARS) continue;
    kept[key] = cut;
    spent += cost;
  }

  return { input: kept, truncatedFrom: raw.length };
}

/** Cut a string to `max` characters, marking that something followed. */
function cutTo(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** JSON, or undefined for a value that cannot be one. Never throws. */
function serialise(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * One clause per sandbox condition, and none of them says "denied".
 *
 * Every marker `sandbox.ts` recognises is a sandbox that is *not working*
 * rather than a policy that refused a path, and a row that said the second
 * about the first would send an operator to edit an allowlist that was never
 * consulted. The wording is deliberately as narrow as the evidence.
 */
const SANDBOX_REASON: Record<SandboxRefusalKindDTO, string> = {
  "seccomp-unavailable":
    "the seccomp applier is missing, so unix socket access is not restricted",
  "sandbox-unavailable": "a sandbox was required here and could not start",
  "dependency-missing": "the sandbox's own dependencies are not installed",
  "sandbox-message": "the CLI's Linux sandbox reported this",
};

/** How loudly a hand-driven transition should read. */
function statusTone(status: unknown): LogTone {
  if (status === "failed") return "danger";
  if (status === "paused" || status === "blocked" || status === "stopped") {
    return "warn";
  }
  return "neutral";
}

/**
 * Null for an event with nothing to show — a blank content block, or the CLI's
 * own `system:` chatter, which is noise once a run is underway.
 *
 * The switch has no `default`, on purpose: every kind is handled by name, so
 * adding one to `RunEventDTO` is a compile error here rather than a line that
 * silently renders as nothing.
 */
export function describeEvent(e: RunEventDTO): LogEntry | null {
  const p = e.payload ?? {};

  switch (e.kind) {
    case "iteration":
      return {
        voice: "cycle",
        tone: "neutral",
        label: `Work cycle ${p.n}`,
        text: p.resuming ? "continuing the same conversation" : "",
      };

    case "assistant": {
      // Claude Code emits one event per content block and a trailing empty one
      // is routine; as a line it was a gap in the feed with a timestamp on it.
      const text = String(p.text ?? "").trim();
      return text === ""
        ? null
        : { voice: "agent", tone: "neutral", label: null, text };
    }

    case "subagent": {
      const text = String(p.text ?? "").trim();
      return text === ""
        ? null
        : {
            voice: "subagent",
            tone: "neutral",
            // The sub-agent's own name when the `Task` call that opened it was
            // seen this cycle, and the bare word otherwise — a stream the
            // browser joined late, or a call whose input named no type. Never a
            // tool-use id: that is an identifier for this app, not a speaker.
            label: String(p.name ?? "sub-agent"),
            text,
          };
    }

    case "tool": {
      const tool = String(p.name ?? "tool");
      // What was stored is bounded (see `clipToolInput`), so the line says when
      // it is looking at a shortened input. A short call and a shortened one
      // reading alike is the failure `runEvents` already avoids on a replay it
      // had to cut.
      const args = toolArgs(p.input);
      const shortened = typeof p.truncatedFrom === "number";
      return {
        voice: "tool",
        tone: "neutral",
        // A call a sub-agent made is still a tool call and is set as one — but
        // it is attributed, because a `Grep` sitting between two of the main
        // thread's lines otherwise reads as the main thread's. The name comes
        // from the `Task` call that opened it; a delegation whose call was not
        // seen falls back to the bare word rather than to nothing, since "some
        // sub-agent" is the true statement and "the main thread" is not.
        label: p.parentToolUseId
          ? `${String(p.subagent ?? "sub-agent")} › ${tool}`
          : tool,
        text: shortened
          ? [args, "input shortened for storage"].filter(Boolean).join(" · ")
          : args,
      };
    }

    case "tool_error": {
      const tool = String(p.name ?? "tool");
      // Attributed the way a delegated call is, and for that reason: a failed
      // `Bash` sitting between two of the main thread's lines otherwise reads
      // as the main thread's.
      const who = p.parentToolUseId
        ? `${String(p.subagent ?? "sub-agent")} › ${tool}`
        : tool;
      const command = String(p.command ?? "").trim();
      // A system row rather than a tool one: the tool voice is a chip and a
      // muted line with no tone on it, which is what every call that worked
      // looks like. This is the line the reader came for.
      return {
        voice: "system",
        tone: "danger",
        label: "tool failed",
        text: [command ? `${who}: ${command}` : who, String(p.text ?? "").trim()]
          .filter(Boolean)
          .join(" — "),
      };
    }

    case "sandbox": {
      const tool = String(p.name ?? "tool");
      const command = String(p.command ?? "").trim();
      // This row sits directly under the `tool_error` for the same call, which
      // already carries the tool's own words in full. So it says the one thing
      // that row cannot — which sandbox condition those words were recognised
      // as — and says it first, or the two lines are the same sentence twice.
      // The raw reason is still on the event for anyone reading the table.
      //
      // `warn` rather than `danger`, the call the guard row already makes: a
      // boundary doing its job is not a fault, and the failure is set as one
      // above.
      const kind = String(p.kind ?? "");
      return {
        voice: "system",
        tone: "warn",
        label: "sandbox",
        text: [
          // A kind this build does not know is a row written by another one.
          // Naming it beats a blank line, and beats claiming which it was.
          SANDBOX_REASON[kind as SandboxRefusalKindDTO] ??
            `an unrecognised sandbox condition (${kind || "unnamed"})`,
          command ? `${tool}: ${command}` : tool,
        ]
          .filter(Boolean)
          .join(" — "),
      };
    }

    case "budget":
      // A guard is not a fault and must not be dressed as one, so a stop is
      // `warn` rather than `danger` — the same call the run state card makes.
      return p.allowed
        ? {
            voice: "system",
            tone: "neutral",
            label: "budget",
            text: `clear · weekly ${fmtPct(
              typeof p.weeklyFraction === "number" ? p.weeklyFraction : null,
            )}`,
          }
        : {
            voice: "system",
            tone: "warn",
            label: "budget",
            // `scope` says whose limit this was. Without it a workflow-wide
            // stop reads as this run's own guard, which sends the operator to
            // the wrong form to change it.
            text: `${p.disposition === "pause" ? "pause" : "stop"}${
              p.live ? ", mid-cycle" : ""
            }${p.scope === "workflow" ? ", workflow-wide" : ""} — ${p.reason}`,
          };

    case "result":
      return {
        voice: "system",
        tone: "ok",
        label: "cycle done",
        text: `${fmtUSD(Number(p.costUSD ?? 0))} · ${p.numTurns ?? "?"} turns`,
      };

    case "error":
      return {
        voice: "system",
        tone: "danger",
        label: "error",
        text: String(p.message ?? ""),
      };

    case "handoff": {
      const commits = Array.isArray(p.commits) ? p.commits.length : 0;
      return {
        voice: "system",
        tone: "accent",
        label: "handoff",
        text: `${commits} commit${commits === 1 ? "" : "s"} on ${p.branch}`,
      };
    }

    case "land": {
      // Before `deleted`, and it is deliberately not one: the retention sweep
      // removes the *directory* and leaves the branch and every commit on it
      // exactly where they were. A row that read as a deletion would say this
      // app destroyed work it did not touch.
      if (p.reclaimed) {
        return {
          voice: "system",
          tone: "neutral",
          label: "checkout reclaimed",
          text: `${p.worktreeRemoved} — ${p.branch ?? "the branch"} is untouched`,
        };
      }
      if (p.purged) {
        return {
          voice: "system",
          tone: "warn",
          label: "purged",
          text: `${p.branch} — ${p.commits} commit${
            p.commits === 1 ? "" : "s"
          } and ${p.discarded} uncommitted path${
            p.discarded === 1 ? "" : "s"
          } gone`,
        };
      }
      if (p.deleted) {
        return {
          voice: "system",
          tone: "warn",
          label: "deleted",
          text: String(p.branch ?? ""),
        };
      }
      if (p.commit) {
        return {
          voice: "system",
          tone: "neutral",
          label: "committed",
          text: `${p.files} path${p.files === 1 ? "" : "s"} to ${
            p.branch
          } as ${p.commit}`,
        };
      }
      const resolved = Array.isArray(p.resolved) ? p.resolved.length : null;
      return resolved !== null
        ? {
            voice: "system",
            tone: "accent",
            label: "resolved",
            text: `merged ${p.target} into ${p.branch}, resolving ${resolved} file${
              resolved === 1 ? "" : "s"
            }`,
          }
        : {
            voice: "system",
            tone: "ok",
            label: "landed",
            text: `${p.branch} into ${p.target} (${p.strategy})`,
          };
    }

    case "review": {
      // The same event kind carries both — a read-only review and a conflict
      // resolution — because they are the same billed, out-of-cycle spawn.
      const label = p.assist === "resolve" ? "resolve" : "review";
      if (p.status === "running") {
        return {
          voice: "system",
          tone: "accent",
          label,
          text: `started — ${p.shown}/${p.files} files`,
        };
      }
      if (p.status === "failed") {
        return {
          voice: "system",
          tone: "danger",
          label,
          text: `failed: ${p.error}`,
        };
      }
      return {
        voice: "system",
        tone: "ok",
        label,
        text: `done — ${fmtUSD(Number(p.costUSD ?? 0))}`,
      };
    }

    case "status": {
      // `message` is what a hand-driven transition says about itself — a
      // pick-up, a park, a resume. Without it the log shows the status flipping
      // and nothing about why.
      const why = p.stop_reason ?? p.message;
      return {
        voice: "system",
        tone: statusTone(p.status),
        label: "status",
        text: `${p.status}${why ? ` — ${why}` : ""}`,
      };
    }

    case "log": {
      const message = String(p.message ?? "");
      if (message === "" || message.startsWith("system:")) return null;
      // Same mark as a tool input, for the same reason: an agent's build output
      // arrives here one stderr chunk per row and is cut at `MAX_LOG_CHARS`.
      return {
        voice: "system",
        tone: "neutral",
        label: null,
        text:
          typeof p.truncatedFrom === "number"
            ? `${message} · line shortened for storage`
            : message,
      };
    }

    // Consumed by the stream reader as a marker; never a line.
    case "replay-complete":
      return null;
  }
}
