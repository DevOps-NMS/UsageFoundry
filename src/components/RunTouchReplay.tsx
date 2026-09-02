"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { RunTouchStepDTO } from "@/lib/apiTypes";
import { touchActor } from "@/lib/runTouches";
import type { ReplayFrame } from "@/lib/touchReplay";
// `Fact` rather than a second label row: the inspector beside the map draws the
// same Path, Tool and By about the same call, and two label columns that
// disagree about a width read as two different kinds of record.
import { Fact } from "@/components/RunTouchNotes";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Field";
import { GroupLabel } from "@/components/ui/List";

/**
 * A playhead over the order a run named files in, driving the map beside it.
 *
 * **The step is one tool call, never one file.** A file read forty times is
 * forty steps and its node accumulates forty touches — which is the whole of
 * what an operator comes here to see, and the reason the figure above the map
 * prints the call count beside the distinct-file count rather than leaving the
 * handle position to imply which of the two the track is measuring.
 *
 * **Nothing here says a call succeeded.** A mark advancing file to file reads as
 * progress, so the hedge `RunTouchNotes.tsx` states once for both surfaces
 * governs this one too: a recorded call is an *attempt*, and this replays what
 * the run tried in the order it tried it.
 *
 * **Position 0 is rest and the map is untouched there.** The replay is a mode
 * over the existing view: at 0 nothing is dimmed, nothing is marked, and the
 * canvas draws exactly what it drew before this control existed. Reset is the
 * one press back to it from anywhere.
 */

/**
 * Wall-clock seconds a whole replay aims at, and the rates that bound it.
 *
 * A fixed steps-per-second is wrong at both ends — a 40-call run finishes before
 * an eye has found the first node, and a 6,000-call one runs for a minute and a
 * half at any rate slow enough to read. So the rate is the sequence's own length
 * over a target duration, clamped: the floor keeps a short run watchable and the
 * ceiling keeps a long one from being a flicker. A sequence past the ceiling
 * runs longer than the target, deliberately — the alternative is skipping steps,
 * and a replay that skips is a replay that draws a run that did not happen.
 */
const TARGET_SECONDS = 20;
const MIN_STEPS_PER_SECOND = 2.5;
const MAX_STEPS_PER_SECOND = 120;

/**
 * Longest gap one frame may advance for.
 *
 * `requestAnimationFrame` does not fire in a hidden tab but `performance.now()`
 * keeps running, so the first frame after the operator comes back carries the
 * whole time they were away. Unclamped that is a replay that fast-forwards
 * through however long the tab was in the background and lands somewhere nobody
 * scrubbed to.
 */
const MAX_FRAME_MS = 250;

export function RunTouchReplay({
  steps,
  frame,
  onPosition,
  className = "",
}: {
  steps: readonly RunTouchStepDTO[];
  frame: ReplayFrame;
  onPosition: (next: number) => void;
  className?: string;
}) {
  const total = steps.length;
  const [playing, setPlaying] = useState(false);

  // What the loop reads instead of closing over the props: a frame that depended
  // on `position` would restart the whole effect on every step, and one that
  // depended on `onPosition` would restart it whenever the page re-rendered.
  const positionRef = useRef(frame.position);
  const emitRef = useRef(onPosition);
  positionRef.current = frame.position;
  emitRef.current = onPosition;

  /**
   * The loop, on `requestAnimationFrame` and deliberately not on an interval.
   *
   * This is the same terms the force simulation one component over runs on, and
   * the reason is the same: rAF stops being called in a hidden tab, so a replay
   * left playing on a tab nobody is looking at costs nothing and resumes where
   * it was — where `setInterval` goes on firing, throttled to a second, and
   * advances a playhead over a canvas that is not being painted. The teardown
   * cancels the pending frame, so unmounting mid-play leaves nothing behind;
   * a loop that outlives its component is silent, and this is the only place
   * here that could grow one.
   */
  useEffect(() => {
    if (!playing || total === 0) return;

    const rate = Math.min(
      MAX_STEPS_PER_SECOND,
      Math.max(MIN_STEPS_PER_SECOND, total / TARGET_SECONDS),
    );
    let handle = 0;
    let last = performance.now();
    let carry = 0;

    const tick = (now: number) => {
      const elapsed = Math.min(now - last, MAX_FRAME_MS);
      last = now;
      carry += (elapsed / 1000) * rate;
      const advance = Math.floor(carry);
      if (advance >= 1) {
        carry -= advance;
        const next = Math.min(positionRef.current + advance, total);
        // Written back here as well as by the render, or a second frame
        // arriving before React has committed would advance from the same
        // position twice and drop a step.
        positionRef.current = next;
        emitRef.current(next);
        if (next >= total) {
          setPlaying(false);
          return;
        }
      }
      handle = requestAnimationFrame(tick);
    };

    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, total]);

  /** Any hand on the control takes it: a scrub fighting the loop is neither. */
  const seek = (next: number) => {
    setPlaying(false);
    onPosition(Math.min(Math.max(next, 0), total));
  };

  /**
   * Space toggles play, and only from the scrubber.
   *
   * Space on a `<button>` is the browser's own activation, so claiming it here
   * unconditionally would toggle twice on one press of Play — once through the
   * button and once through this. Narrowing it to the range input is also what
   * "when the control has focus" means: left and right already step by one
   * there, natively, because the track's step is one touch.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== " " && event.key !== "Spacebar") return;
    if (!(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    setPlaying((on) => !on);
  };

  const step = frame.step;

  return (
    // The handler is on the group rather than on the input so it catches the
    // key from whichever control has focus, and refuses everything but the
    // scrubber itself once it has.
    <div className={className} onKeyDown={onKeyDown}>
      <GroupLabel>Replay, one tool call at a time</GroupLabel>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="compact"
          onClick={() => seek(frame.position - 1)}
          disabled={frame.position === 0}
          aria-label="Step back one touch"
        >
          ‹
        </Button>
        <Button
          variant={playing ? "secondary" : "primary"}
          size="compact"
          onClick={() => setPlaying((on) => !on)}
          aria-label={playing ? "Pause the replay" : "Play the replay"}
        >
          {playing ? "Pause" : "Play"}
        </Button>
        <Button
          variant="secondary"
          size="compact"
          onClick={() => seek(frame.position + 1)}
          disabled={frame.position === total}
          aria-label="Step forward one touch"
        >
          ›
        </Button>
        <Slider
          value={frame.position}
          onChange={seek}
          min={0}
          max={total}
          step={1}
          label="Position in the sequence of tool calls"
          className="min-w-0 flex-1"
        />
        <Button
          variant="ghost"
          size="compact"
          onClick={() => seek(0)}
          disabled={frame.position === 0}
        >
          Reset
        </Button>
      </div>

      {/* The readout is the inspector's four rows about one call, in the
          inspector's own words. It is not conditional on there being a step:
          a control whose text disappears at rest is a control that has moved,
          and the resting sentence is what says what the track measures. */}
      <dl className="mt-2 space-y-1 text-xs">
        <Fact label="Touch">
          {step === null ? (
            <>
              At rest — <span className="tabular-nums">{total}</span> tool call
              {total === 1 ? "" : "s"} named a file, in this order. The map above stands at
              the end of the run.
            </>
          ) : (
            <>
              <span className="tabular-nums">{frame.position}</span> of{" "}
              <span className="tabular-nums">{total}</span>
            </>
          )}
        </Fact>
        {step !== null && (
          <>
            <Fact label="Path">
              <span className="mono break-all">{step.path}</span>
              {step.outside ? " — outside the checkout" : ""}
            </Fact>
            <Fact label="Tool">{step.tool}</Fact>
            <Fact label="By">{touchActor(step)}</Fact>
          </>
        )}
      </dl>
    </div>
  );
}
