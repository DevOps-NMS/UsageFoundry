import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * When the nightly pass may fire, which is the half of this feature that had
 * never run when it shipped.
 *
 * Everything about Dreaming that was verified by hand went through the press
 * (`origin: "form"`). The clock was reasoned about and unit-tested nowhere, and
 * it carried two faults that a press can never expose — both silent, and both
 * of which stop the feature dead while every surface still reads correctly.
 *
 * **The cursor was a day key, and the boot reconciler set it to today.** The
 * intent was `reconcileSchedulesOnBoot`'s: a server coming back up must not
 * start an unattended agent because of something that should have happened
 * hours ago. But `schedules.ts` moves its cursor to an *instant*, so a fire time
 * later that same day is still ahead of it and still fires. A day key is
 * coarser than the thing it guards: once set to today, the tick's
 * `cursor === today` test returned for the rest of the calendar day. So
 * **Dreaming could never fire on a day the server had booted** — and this server
 * reboots on every `docker compose up --build` and on every host restart, so on
 * a machine that is rebuilt most days it would have fired approximately never,
 * with the pane showing an empty Nights tab and no error anywhere.
 *
 * **And enabling the setting did not start the timer.** `startDreaming` was
 * called from boot alone, so an operator who switched Dreaming on in Settings
 * got nothing until the next restart — and, because of the fault above, nothing
 * on the day of that restart either.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-dreaming-clock-"));
process.env.DATA_DIR = DATA_DIR;

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

type Clock = typeof import("./dreamingRun");
type Settings = typeof import("./settings");
let clock: Clock;
let settings: Settings;

before(async () => {
  clock = await import("./dreamingRun");
  settings = await import("./settings");
});

/** 03:04 UTC on the given day. */
const at = (iso: string) => Date.parse(iso);

beforeEach(() => {
  settings.saveSettings({
    dreamingEnabled: true,
    dreamingMinutes: 3 * 60 + 4,
    dreamingTimeZone: "UTC",
  });
  clock.clearDreamingCursor();
});

describe("the nightly cursor", () => {
  it("fires a window that is still ahead on the day the server booted", () => {
    // The fault this file exists for. Boot at 01:00, fire time 03:04 the same
    // morning: the window has not passed, so the boot reconciler must not close
    // it. A day-keyed cursor closed the whole day.
    clock.reconcileDreamingOnBoot(at("2026-09-02T01:00:00Z"));
    assert.equal(
      clock.dreamingDue(at("2026-09-02T03:05:00Z")).due,
      true,
      "a boot before the fire time must leave that night open",
    );
  });

  it("does not catch up a window that passed while the server was down", () => {
    // The rule the boot reconciler is actually for, and it still holds: a
    // server coming back at 10:00 must not start an agent because of an 03:04
    // it missed.
    clock.reconcileDreamingOnBoot(at("2026-09-02T10:00:00Z"));
    assert.equal(clock.dreamingDue(at("2026-09-02T10:01:00Z")).due, false);
  });

  it("still fires the next night after a boot that skipped one", () => {
    clock.reconcileDreamingOnBoot(at("2026-09-02T10:00:00Z"));
    assert.equal(clock.dreamingDue(at("2026-09-02T23:59:00Z")).due, false);
    assert.equal(clock.dreamingDue(at("2026-09-03T03:05:00Z")).due, true);
  });

  it("fires once and not again for the same window", () => {
    clock.reconcileDreamingOnBoot(at("2026-09-02T01:00:00Z"));
    const first = clock.dreamingDue(at("2026-09-02T03:05:00Z"));
    assert.equal(first.due, true);
    clock.markDreamingFired(first.dueAt);
    assert.equal(clock.dreamingDue(at("2026-09-02T03:06:00Z")).due, false);
    assert.equal(clock.dreamingDue(at("2026-09-02T20:00:00Z")).due, false);
    // …and the following night is a different window.
    assert.equal(clock.dreamingDue(at("2026-09-03T03:05:00Z")).due, true);
  });

  it("does not fire before the time of day it was set to", () => {
    clock.reconcileDreamingOnBoot(at("2026-09-01T23:00:00Z"));
    assert.equal(clock.dreamingDue(at("2026-09-02T02:00:00Z")).due, false);
    assert.equal(clock.dreamingDue(at("2026-09-02T03:04:00Z")).due, true);
  });

  it("reads the fire time in the operator's zone, not UTC", () => {
    settings.saveSettings({ dreamingTimeZone: "Europe/Berlin" });
    clock.reconcileDreamingOnBoot(at("2026-09-01T23:00:00Z"));
    // 03:04 Berlin is 01:04 UTC in September.
    assert.equal(clock.dreamingDue(at("2026-09-02T00:30:00Z")).due, false);
    assert.equal(clock.dreamingDue(at("2026-09-02T01:05:00Z")).due, true);
  });

  it("never fires from a cursor that was never set", () => {
    // A fresh install, or a database restored without the key. Firing here
    // would be an unattended agent started by nothing an operator did.
    clock.clearDreamingCursor();
    assert.equal(clock.dreamingDue(at("2026-09-02T12:00:00Z")).due, false);
    // …and the reading itself arms it, so the next window is honoured.
    assert.equal(clock.dreamingDue(at("2026-09-03T03:05:00Z")).due, true);
  });
});

describe("arming", () => {
  it("switching it on does not immediately spend on a window already past", () => {
    // The operator flips it on at 10:00. Today's 03:04 has gone. Turning a
    // setting on is not a press of Run, and `review.ts:34`'s rule is that spend
    // nobody asked for is spend nobody authorised — the page has an explicit
    // "Run tonight's pass now" for the case where they do want it.
    clock.clearDreamingCursor();
    clock.armDreaming(at("2026-09-02T10:00:00Z"));
    assert.equal(clock.dreamingDue(at("2026-09-02T10:01:00Z")).due, false);
    assert.equal(clock.dreamingDue(at("2026-09-03T03:05:00Z")).due, true);
  });

  it("leaves an existing cursor alone rather than re-arming a running clock", () => {
    // Saving the settings page re-sends every field, so `dreamingEnabled: true`
    // arrives on every save. Re-arming on each one would push the cursor
    // forward past a window that was about to fire, and a nightly job that
    // never runs on days the operator visits Settings is the kind of fault
    // nobody would think to look for.
    clock.reconcileDreamingOnBoot(at("2026-09-02T01:00:00Z"));
    clock.armDreaming(at("2026-09-02T02:00:00Z"));
    assert.equal(clock.dreamingDue(at("2026-09-02T03:05:00Z")).due, true);
  });
});
