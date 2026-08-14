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

import type { RunEventDTO } from "./apiTypes";
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
            // The specialist's own name when the `Task` call that opened it was
            // seen this cycle, and the bare word otherwise — a stream the
            // browser joined late, or a call whose input named no type. Never a
            // tool-use id: that is an identifier for this app, not a speaker.
            label: String(p.name ?? "sub-agent"),
            text,
          };
    }

    case "tool": {
      const tool = String(p.name ?? "tool");
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
        text: toolArgs(p.input),
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
      return message === "" || message.startsWith("system:")
        ? null
        : { voice: "system", tone: "neutral", label: null, text: message };
    }

    // Consumed by the stream reader as a marker; never a line.
    case "replay-complete":
      return null;
  }
}
