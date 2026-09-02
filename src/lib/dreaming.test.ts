import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dayKey, rollUp, selectWritable, signatureOf, type ErrorObservation } from "./dreaming";
import { buildDreamingPrompt, parseNoteLines } from "./dreamingRun";

/**
 * The four pure functions Dreaming's behaviour is decided by, and every one of
 * them fails silently.
 *
 * `signatureOf` deciding two failures are different writes a second note beside
 * a note that is already there, which the destination vault's own conventions
 * name as the failure mode they exist to prevent — and nothing throws.
 * `selectWritable` off by one writes 1,177 notes into a 1,224-note vault
 * instead of 77, and the symptom is a vault, not an error. `dayKey` on the
 * wrong zone moves every day boundary the feature is denominated in, so a
 * failure seen twice in one local evening reads as a recurrence and qualifies
 * for a note. `parseNoteLines` mis-parsing leaves a ledger row pointing at
 * nothing, which is the one column that makes a wrong note retractable.
 *
 * The numbers asserted below are the ones in `proposals/Dreaming` and they were
 * measured by `scripts/ledger.mjs` over the same corpus. A change here that
 * moves them is a change to what the proposal claims.
 */

describe("signatureOf", () => {
  it("collapses the varying parts so one failure is one signature", () => {
    // The same denial at two paths on two nights. If these differ, the second
    // night writes a duplicate note.
    const a = signatureOf("bwrap: Can't create file at /home/x/.claude/settings.json: Permission denied");
    const b = signatureOf("bwrap: Can't create file at /var/y/.claude/settings.json: Permission denied");
    assert.equal(a, b);
  });

  it("collapses digits, hex runs and 0x literals", () => {
    assert.equal(signatureOf("Exit code 1"), signatureOf("Exit code 127"));
    assert.equal(
      signatureOf("failed at commit a1b2c3d4e5f6"),
      signatureOf("failed at commit 9f8e7d6c5b4a"),
    );
    assert.equal(signatureOf("segfault at 0xdeadbeef"), signatureOf("segfault at 0xcafe"));
  });

  it("keeps genuinely different failures apart", () => {
    assert.notEqual(
      signatureOf("pdftoppm is not installed"),
      signatureOf("This command requires approval"),
    );
  });

  it("flattens whitespace, so a reflowed message is the same message", () => {
    assert.equal(signatureOf("a   b\n\tc"), signatureOf("a b c"));
  });

  it("reads only the first 400 bytes, so a long tail cannot split a signature", () => {
    const head = "the same opening line ";
    assert.equal(
      signatureOf(head + "x".repeat(500)),
      signatureOf(head + "x".repeat(500) + " and then something else entirely"),
    );
  });
});

describe("dayKey", () => {
  it("buckets on the operator's zone, not UTC", () => {
    // 22:30 UTC on the 1st is already the 2nd in Berlin (UTC+2 in July). A
    // feature whose unit is "a day" gets this wrong in a way nothing reports:
    // two sightings one local evening apart would read as two days.
    const at = Date.parse("2026-07-01T22:30:00Z");
    assert.equal(dayKey(at, "UTC"), "2026-07-01");
    assert.equal(dayKey(at, "Europe/Berlin"), "2026-07-02");
  });

  it("falls back to UTC rather than throwing on a zone the platform rejects", () => {
    // A blank page is worse than a boundary that is off by an hour.
    const at = Date.parse("2026-07-01T10:00:00Z");
    assert.equal(dayKey(at, "Not/AZone"), "2026-07-01");
  });
});

const ob = (signature: string, day: string, sessionId = "s1"): ErrorObservation => ({
  signature,
  sample: signature,
  day,
  sessionId,
});

describe("rollUp", () => {
  it("counts distinct days apart from instances", () => {
    const [row] = rollUp([
      ob("a", "2026-08-10"),
      ob("a", "2026-08-10"),
      ob("a", "2026-08-12"),
    ]);
    assert.deepEqual(row.days, ["2026-08-10", "2026-08-12"]);
    assert.equal(row.instances, 3);
  });

  it("orders by days spanned, then instances, then signature", () => {
    const rows = rollUp([
      ob("once-often", "2026-08-10"),
      ob("once-often", "2026-08-10"),
      ob("once-often", "2026-08-10"),
      ob("twice", "2026-08-10"),
      ob("twice", "2026-08-11"),
    ]);
    // Days outrank instances: a failure on two days is a standing property, a
    // failure three times in one day is one bad afternoon.
    assert.deepEqual(
      rows.map((r) => r.signature),
      ["twice", "once-often"],
    );
  });

  it("is stable for two signatures with identical counts", () => {
    const rows = rollUp([ob("b", "2026-08-10"), ob("a", "2026-08-10")]);
    assert.deepEqual(
      rows.map((r) => r.signature),
      ["a", "b"],
    );
  });

  it("caps the sessions it lists rather than holding every one", () => {
    const many = Array.from({ length: 40 }, (_, i) => ob("a", "2026-08-10", `s${i}`));
    const [row] = rollUp(many);
    assert.equal(row.instances, 40);
    assert.ok(row.sessions.length <= 12, `held ${row.sessions.length} sessions`);
  });
});

describe("selectWritable", () => {
  const rows = rollUp([
    ob("one-day", "2026-08-10"),
    ob("two-days", "2026-08-10"),
    ob("two-days", "2026-08-11"),
    ob("three-days", "2026-08-10"),
    ob("three-days", "2026-08-11"),
    ob("three-days", "2026-08-12"),
  ]);

  it("writes nothing about a failure seen on one day only", () => {
    // The measurement this whole policy rests on: writing on first sight makes
    // 93.5% of the notes about something that never recurred.
    const picked = selectWritable(rows, new Set(), 2).map((r) => r.signature);
    assert.deepEqual(picked.sort(), ["three-days", "two-days"]);
  });

  it("suppresses a signature this app has already written", () => {
    const picked = selectWritable(rows, new Set(["two-days"]), 2).map((r) => r.signature);
    assert.deepEqual(picked, ["three-days"]);
  });

  it("honours a raised threshold", () => {
    const picked = selectWritable(rows, new Set(), 3).map((r) => r.signature);
    assert.deepEqual(picked, ["three-days"]);
  });

  it("treats minDays below one as one rather than selecting everything twice", () => {
    // 0 or a negative would make the filter vacuous, which is the write-every-
    // signature policy arrived at by accident.
    const picked = selectWritable(rows, new Set(), 0);
    assert.equal(picked.length, 3);
  });
});

describe("buildDreamingPrompt", () => {
  const rows = rollUp([ob("bwrap denied", "2026-08-10"), ob("bwrap denied", "2026-08-12")]);
  const prompt = buildDreamingPrompt(rows, "2026-08-12");

  /**
   * Every constraint this feature has that is not enforced by code is enforced
   * by this string. A prompt that quietly stopped saying one of these would
   * still run, still write, and still look right in the log.
   */
  it("tells the run to read the vault's conventions before writing", () => {
    assert.match(prompt, /CLAUDE\.md/);
    assert.match(prompt, /before you write anything/i);
  });

  it("separates transcription from diagnosis", () => {
    assert.match(prompt, /hypothesis/i);
    assert.match(prompt, /transcription/i);
  });

  it("says a signature is a string rather than a cause", () => {
    assert.match(prompt, /strings\*\*, not causes|not causes/i);
  });

  it("asks it to grow an existing note rather than write a second one beside it", () => {
    assert.match(prompt, /growing\s+the existing note in place|grow an existing note/i);
  });

  it("quotes the machine verbatim and names the days spanned", () => {
    assert.match(prompt, /bwrap denied/);
    assert.match(prompt, /2 days/);
    assert.match(prompt, /2026-08-10, 2026-08-12/);
  });

  it("asks for the paths back, which is what makes a note retractable", () => {
    assert.match(prompt, /NOTE <item number>/);
  });
});

describe("parseNoteLines", () => {
  it("reads the reporting line", () => {
    const got = parseNoteLines("NOTE 1 2 Areas/Tooling/Poppler.md", 2);
    assert.deepEqual([...got], [[1, "2 Areas/Tooling/Poppler.md"]]);
  });

  it("tolerates a bullet, backticks and stray spacing", () => {
    const got = parseNoteLines("- NOTE  2   `3 Resources/X.md` ", 2);
    assert.deepEqual([...got], [[2, "3 Resources/X.md"]]);
  });

  it("drops an item number nobody asked about", () => {
    // A ledger row pointing at a file for an item that was never sent is worse
    // than no row: it claims provenance the run cannot have had.
    assert.equal(parseNoteLines("NOTE 9 X.md", 2).size, 0);
    assert.equal(parseNoteLines("NOTE 0 X.md", 2).size, 0);
  });

  it("ignores prose that merely mentions the word", () => {
    assert.equal(parseNoteLines("I did not write a NOTE for item 1.", 2).size, 0);
  });

  it("takes the last line for an item when a run reports it twice", () => {
    const got = parseNoteLines("NOTE 1 first.md\nNOTE 1 second.md", 1);
    assert.deepEqual([...got], [[1, "second.md"]]);
  });
});
