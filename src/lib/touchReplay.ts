import type { RunTouchStepDTO } from "./apiTypes";
import { dirOf, nodeId, parentOf, type PathNodeKind } from "./pathMap";

/**
 * A run's touches as a playhead over the map they are already drawn on.
 *
 * **This module reaches nothing** — no database, no `node:fs`, no `git` — for
 * `runTouches.ts`' reason one file over: the page that scrubs is a `"use
 * client"` file and imports this, so one server import would follow `node:fs`
 * into the browser bundle. The scan that produces its input is
 * `scanTouchSequence` in `runTouchScan.ts`, which is server-only for exactly
 * that reason. It also lives in `src/lib` because that is what
 * `tsconfig.test.json` compiles.
 *
 * **The sequence is never derived in the browser from the event array.** The
 * run page holds the newest 2,000 events inside 4 MB (`stream/route.ts`), so a
 * client-side derivation would describe the tail of a long run as the whole of
 * it — which is the failure this feature exists to make visible, arriving inside
 * the feature itself. What arrives here has already been read from the
 * database, whole.
 *
 * **Nothing here says a touch succeeded**, and that matters more on a playhead
 * than on a table: a mark moving file to file reads as progress. A recorded
 * call is an *attempt* — `orchestrator.ts` stores a result only when the tool
 * failed and the failure row carries no id joining it back — so there is no
 * outcome to draw and no join to invent.
 *
 * Every failure mode below is silent. A step placed on the wrong node draws a
 * plausible replay of something that did not happen; a step placed on nothing
 * makes the playhead disappear for a frame and reads as a gap in the run; and a
 * dim set computed at rest would replace the map rather than ride over it.
 */

/** What this module needs off a drawn node, and nothing about anybody's payload. */
export interface DrawnNode {
  id: string;
  kind: PathNodeKind;
  path: string;
}

/**
 * Where each touch lands on the plan as it is currently drawn, in order.
 *
 * **A path behind a fold resolves to the fold**, not to nothing. `planPathMap`
 * folds directories past the drawn-file budget and the surface's whole promise
 * is that no file is dropped — so a playhead that landed on nothing for those
 * touches would be the promise broken in the one place it is checkable, and it
 * would look like a run that paused rather than like a file the map has rolled
 * up. The nearest folded ancestor is the only one: a fold hides its subtree, so
 * every directory above a folded one is drawn open.
 *
 * `null` is a path the plan holds nowhere, which a well-formed plan cannot
 * produce — every touched path is in the report, every report file is in the
 * tree, and every tree file is drawn or behind exactly one fold. It is returned
 * rather than thrown because this runs inside a render: the readout below still
 * names the path, so a step that lands nowhere costs a highlight rather than
 * the whole page.
 *
 * Re-run whenever the plan changes, which is what makes opening a fold move the
 * playhead onto the file it was standing for.
 */
export function placeTouches(
  steps: readonly RunTouchStepDTO[],
  nodes: readonly DrawnNode[],
): (string | null)[] {
  const drawnFiles = new Set<string>();
  const foldedDirs = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "file") drawnFiles.add(node.path);
    else if (node.kind === "folded") foldedDirs.add(node.path);
  }

  // Memoised on the path: a file read forty times is forty steps, and the walk
  // up its directory chain is the same walk every time.
  const placed = new Map<string, string | null>();
  const resolve = (path: string): string | null => {
    if (drawnFiles.has(path)) return nodeId("file", path);
    for (let at: string | null = dirOf(path); at !== null; at = parentOf(at)) {
      if (foldedDirs.has(at)) return nodeId("folded", at);
    }
    return null;
  };

  return steps.map((step) => {
    let id = placed.get(step.path);
    if (id === undefined) {
      id = resolve(step.path);
      placed.set(step.path, id);
    }
    return id;
  });
}

/** What the map draws at one position in the sequence. */
export interface ReplayFrame {
  /**
   * How many touches have landed on each drawn node, up to and including the
   * position. A fold carries the touches on every file behind it.
   */
  reached: ReadonlyMap<string, number>;
  /** The node the touch at the playhead landed on. Null at rest. */
  currentId: string | null;
  /** The touch at the playhead. Null at rest. */
  step: RunTouchStepDTO | null;
  /**
   * File and fold nodes the replay has not reached yet, drawn washed out.
   *
   * **Null at rest**, and that is the whole of what keeps this a mode over the
   * existing view rather than a replacement for it: with nothing dimmed and no
   * playhead, the map is pixel-identical to the one an operator who never
   * touched the scrubber sees.
   *
   * Directory anchors are never in it. They are the arrangement rather than the
   * content — dimming the labels would take away the orientation the map exists
   * to give while saying nothing about the run.
   */
  dimmed: ReadonlySet<string> | null;
  /** Clamped into `0..steps.length`. 0 is rest, before the first touch. */
  position: number;
}

/**
 * The state at one position: everything up to and including touch `position`.
 *
 * **Position is 1-based over the touches and 0 is rest.** A 0-based playhead
 * would have no way to say "before anything happened" that was not also "the
 * first call", and the resting map — the one this feature must leave exactly as
 * it found it — is the state before the first call.
 *
 * A file with no event has no position in the sequence at all: `changedNotTouched`
 * is a diff entry and nothing else, so it is dimmed for the whole replay and
 * never becomes current. That is the true reading — the sequence never reaches
 * it — and its own hollow mark is what already says why.
 */
export function replayFrame(
  steps: readonly RunTouchStepDTO[],
  placed: readonly (string | null)[],
  nodes: readonly DrawnNode[],
  position: number,
): ReplayFrame {
  const through = Math.min(Math.max(Math.trunc(position), 0), steps.length);

  const reached = new Map<string, number>();
  for (let i = 0; i < through; i++) {
    const id = placed[i];
    if (id === null || id === undefined) continue;
    reached.set(id, (reached.get(id) ?? 0) + 1);
  }

  if (through === 0) {
    return { reached, currentId: null, step: null, dimmed: null, position: 0 };
  }

  const dimmed = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "dir") continue;
    if (!reached.has(node.id)) dimmed.add(node.id);
  }

  const at = through - 1;
  return {
    reached,
    currentId: placed[at] ?? null,
    step: steps[at] ?? null,
    dimmed,
    position: through,
  };
}
