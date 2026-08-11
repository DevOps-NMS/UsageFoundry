/**
 * Where one work cycle's output ends and the next begins.
 *
 * The run page's log is a flat stream of every turn the agent took, and the one
 * thing a reader usually wants from it — what the agent said it had done — is
 * the last assistant turn of each cycle, buried among the tool calls. Nothing
 * records that position: `orchestrator.ts` emits an `iteration` event before it
 * spawns and an `assistant` event per text block, so the boundary is derived
 * from the order they arrive in and from nothing else. Deriving it here rather
 * than adding an event keeps this readable from history that is already on
 * disk, including runs that finished before this existed.
 *
 * Pure and client-safe — no node builtins — for the same two reasons
 * `format.ts` is: it runs in the browser against the replayed event stream, and
 * `src/lib` is what `tsconfig.test.json` compiles.
 */

import type { RunEventDTO } from "./apiTypes";

export interface CycleOutput {
  /**
   * The number the orchestrator stamped on the cycle, never its position in
   * this list: a reopened run carries its earlier count forward, so its first
   * new cycle is numbered 4 and renumbering it to 1 would claim the run started
   * over.
   */
  n: number;
  /** When the reported turn arrived — not when the cycle opened. */
  ts: number;
  /** The last thing the agent said in that cycle. Never blank. */
  text: string;
  /** The cycle continued an existing conversation rather than opening one. */
  resumed: boolean;
}

/**
 * Each work cycle that said something, oldest first. A cycle that produced no
 * assistant text is omitted rather than listed empty — there is nothing to
 * render for it, and the log above already shows that it ran.
 */
export function cycleOutputs(events: readonly RunEventDTO[]): CycleOutput[] {
  const cycles: CycleOutput[] = [];

  for (const e of events) {
    if (e.kind === "iteration") {
      const n = e.payload?.n;
      cycles.push({
        n: typeof n === "number" ? n : cycles.length + 1,
        ts: e.ts,
        text: "",
        resumed: Boolean(e.payload?.resuming),
      });
      continue;
    }

    if (e.kind !== "assistant") continue;

    const open = cycles[cycles.length - 1];
    // An assistant turn with no cycle open cannot be attributed to one. The
    // orchestrator emits `iteration` before it spawns, so a complete stream
    // never gets here — but a replay the browser joined late is not worth
    // guessing at, and filing the text under the wrong cycle would be worse
    // than leaving it in the log where it already appears.
    if (!open) continue;

    const raw = e.payload?.text;
    const text = typeof raw === "string" ? raw.trim() : "";
    // Claude Code emits one event per content block and a trailing empty one is
    // routine. Letting it win would blank a cycle that did report something.
    if (!text) continue;

    open.text = text;
    open.ts = e.ts;
  }

  return cycles.filter((c) => c.text !== "");
}
