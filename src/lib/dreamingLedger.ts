import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import type { SignatureRollup } from "./dreaming";

/**
 * What Dreaming has written, and what a night decided.
 *
 * Two tables and no model. `dreaming_notes` is the deduplication key *and* the
 * retraction list — the vault has no `.git`, no author field and nothing in a
 * note that says this app produced it, so "what did Dreaming write" is a
 * question only this side can answer. `dreaming_nights` is the other half: a
 * night that selected nothing wrote no notes, and a pane reading only the first
 * table cannot tell that from a night that never ran.
 *
 * Everything here is synchronous, like every other reader of this database.
 */

export interface DreamingNote {
  signature: string;
  sample: string;
  writtenAt: number;
  night: string;
  runId: string | null;
  /** Vault-relative, or null when the run wrote nothing for this signature. */
  notePath: string | null;
  daysSeen: number;
  instances: number;
}

export type NightOutcome = "selected" | "quiet" | "refused" | "failed";

export interface DreamingNight {
  night: string;
  startedAt: number;
  outcome: NightOutcome;
  reason: string | null;
  runId: string | null;
  selected: number;
}

/** Every signature this app has already written a note for. */
export function writtenSignatures(): Set<string> {
  const rows = db().prepare("SELECT signature FROM dreaming_notes").all() as {
    signature: string;
  }[];
  return new Set(rows.map((r) => r.signature));
}

export function listNotes(limit = 500): DreamingNote[] {
  const rows = db()
    .prepare(
      `SELECT signature, sample, written_at, night, run_id, note_path, days_seen, instances
         FROM dreaming_notes
        ORDER BY written_at DESC, signature
        LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    signature: String(r.signature),
    sample: String(r.sample),
    writtenAt: Number(r.written_at),
    night: String(r.night),
    runId: (r.run_id as string | null) ?? null,
    notePath: (r.note_path as string | null) ?? null,
    daysSeen: Number(r.days_seen),
    instances: Number(r.instances),
  }));
}

/**
 * Claim a set of signatures for one night, before the run that writes them
 * exists.
 *
 * Claimed up front rather than recorded on the way out, and the ordering is the
 * whole point: a run that crashes halfway through has still written some of the
 * files, and a ledger written only on success would hand the same signatures to
 * the next night — which is the duplicate the vault's own conventions name as
 * the failure mode they exist to prevent. Over-claiming loses a note; under-
 * claiming writes a second one beside a note that is already there, and only
 * the second is a mess in somebody's document store.
 *
 * `note_path` stays null until `recordNotePath` hears otherwise, so a claimed
 * signature reads on the pane as "attempted, no file recorded" rather than as a
 * note that exists.
 */
export function claimSignatures(
  night: string,
  runId: string | null,
  rollups: readonly SignatureRollup[],
  now = Date.now(),
): number {
  const insert = db().prepare(
    `INSERT OR IGNORE INTO dreaming_notes
       (signature, sample, written_at, night, run_id, note_path, days_seen, instances)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  return db().transaction(() => {
    let claimed = 0;
    for (const r of rollups) {
      const res = insert.run(
        r.signature,
        r.sample,
        now,
        night,
        runId,
        r.days.length,
        r.instances,
      );
      claimed += res.changes;
    }
    return claimed;
  })();
}

/**
 * Attach the file a run says it wrote.
 *
 * Best-effort by design. The run reports its own paths and nothing verifies
 * that it wrote what it claims — `noteStillPresent` below is the check, and it
 * runs when a person looks rather than when the run speaks, because a file can
 * be deleted at any point after and the row must not claim otherwise.
 */
export function recordNotePath(signature: string, notePath: string | null): void {
  db()
    .prepare("UPDATE dreaming_notes SET note_path = ? WHERE signature = ?")
    .run(notePath, signature);
}

/**
 * Forget a note this app wrote.
 *
 * Deletes the *row*, never the file. Retraction in the vault is a person moving
 * a file in Obsidian — `_to_delete/` is what that store's own conventions use —
 * and an app that deleted from a mount it does not own would be a heavier thing
 * than anything else this app does. What this buys is that the signature stops
 * being suppressed: forget a row and the next qualifying night writes it again.
 */
export function forgetNote(signature: string): boolean {
  return (
    db().prepare("DELETE FROM dreaming_notes WHERE signature = ?").run(signature).changes > 0
  );
}

/**
 * Record what a night decided, without letting a later pass erase an earlier
 * one that wrote.
 *
 * A night can be decided more than once — a press at noon and the timer at
 * 03:04 share a calendar night — and the naive upsert overwrote. So a night
 * that had already selected three signatures and started a run read back as
 * `quiet`, which the pane draws as "nothing recurred": a night that wrote into
 * somebody's vault, reported on the one surface that shows it as a night that
 * did nothing. Nothing else would have contradicted it, because the notes
 * carry a run rather than an outcome.
 *
 * So `selected` is sticky. Later passes still refresh the row — a second press
 * that also selects moves it to the newer run, which is the one whose report
 * the reconciler will read — but a `quiet`, `refused` or `failed` result never
 * downgrades a night that has already written. What is lost is only that the
 * later pass found nothing, which is the uninteresting half; `dreaming_notes`
 * keeps the authoritative record of what each run claimed.
 */
export function recordNight(night: DreamingNight): void {
  db()
    .prepare(
      `INSERT INTO dreaming_nights (night, started_at, outcome, reason, run_id, selected)
       VALUES (@night, @startedAt, @outcome, @reason, @runId, @selected)
       ON CONFLICT(night) DO UPDATE SET
         started_at = excluded.started_at,
         outcome    = CASE WHEN dreaming_nights.outcome = 'selected'
                             AND excluded.outcome <> 'selected'
                           THEN dreaming_nights.outcome ELSE excluded.outcome END,
         reason     = CASE WHEN dreaming_nights.outcome = 'selected'
                             AND excluded.outcome <> 'selected'
                           THEN dreaming_nights.reason ELSE excluded.reason END,
         run_id     = COALESCE(excluded.run_id, dreaming_nights.run_id),
         selected   = CASE WHEN dreaming_nights.outcome = 'selected'
                             AND excluded.outcome <> 'selected'
                           THEN dreaming_nights.selected
                           ELSE dreaming_nights.selected + excluded.selected END`,
    )
    .run(night);
}

export function listNights(limit = 60): DreamingNight[] {
  const rows = db()
    .prepare(
      `SELECT night, started_at, outcome, reason, run_id, selected
         FROM dreaming_nights ORDER BY night DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    night: String(r.night),
    startedAt: Number(r.started_at),
    outcome: String(r.outcome) as NightOutcome,
    reason: (r.reason as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    selected: Number(r.selected),
  }));
}

export function lastNight(): DreamingNight | null {
  return listNights(1)[0] ?? null;
}

/**
 * Whether the file a row points at is still on disk.
 *
 * The one column in this feature that reports on the operator's store rather
 * than on this app's record of it, and the only way a deleted note becomes
 * visible: there is no `.git` behind the vault, so a note removed in Obsidian
 * leaves no trace anywhere except its absence.
 *
 * Containment is proved here rather than trusted from the row, on the rule that
 * a stored path is not evidence about the filesystem it is read back into. The
 * check is lexical, then again after `realpathSync` — a symlink inside the
 * vault can still point out of it — and mirrors `containedIn` in `knowledge.ts`
 * rather than importing it, for the reason that one gives about not reaching
 * into a stranger's internals.
 */
export function noteStillPresent(vaultRoot: string, notePath: string | null): boolean | null {
  if (!notePath) return null;
  let root: string;
  try {
    root = fs.realpathSync(vaultRoot);
  } catch {
    return null;
  }
  const contained = (p: string) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const candidate = path.resolve(root, notePath);
  if (!contained(candidate)) return false;
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return false;
  }
  if (!contained(real)) return false;
  try {
    return fs.statSync(real).isFile();
  } catch {
    return false;
  }
}
