import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime.
import type { DreamingDTO } from "../../../lib/apiTypes";
import { scanDreaming } from "../../../lib/dreaming";
import {
  NIGHT_LIMIT,
  NOTE_LIMIT,
  ledgerCounts,
  listNights,
  listNotes,
  noteStillPresent,
  writtenSignatures,
} from "../../../lib/dreamingLedger";
import { dreamingRefusal, reconcileDreamingNotes } from "../../../lib/dreamingRun";
import { resolveKnowledgeRoot } from "../../../lib/knowledge";
import { getSettings } from "../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The recurrence readout, the ledger, and what a night would do right now.
 *
 * One route rather than three, because the page shows them together and they
 * are read once on mount — this pane deliberately does not poll. Its subject
 * moves once a night, and a 120-second poll against a table that changes at
 * 03:04 is 720 requests for an answer that cannot have changed.
 *
 * 200 even when nothing is configured. "No vault" and "the mount is gone" are
 * both things this endpoint is *for* saying, and the readout half needs neither
 * — it reads the transcript corpus, writes nothing, and is always available.
 * The payload carries `refusal` as a full sentence so the page can render the
 * reason rather than an error.
 */
export async function GET() {
  const settings = getSettings();
  // Before the ledger is read, so a night that finished since the last look
  // shows the files it wrote rather than a row that says it wrote nothing.
  // Cheap and idempotent — it touches only nights whose run has settled and
  // whose rows still have no path.
  reconcileDreamingNotes();
  const root = resolveKnowledgeRoot(settings);
  const readout = await scanDreaming({
    timeZone: settings.dreamingTimeZone,
    sinceDays: settings.transcriptRetentionDays,
  });
  const written = writtenSignatures();
  const counts = ledgerCounts();

  const body: DreamingDTO = {
    recurring: readout.recurring.map((r) => ({
      signature: r.signature,
      sample: r.sample,
      days: r.days,
      instances: r.instances,
      sessions: r.sessions,
      written: written.has(r.signature),
    })),
    totalSignatures: readout.totalSignatures,
    totalInstances: readout.totalInstances,
    recurringInstances: readout.recurringInstances,
    days: readout.days,
    filesWalked: readout.filesWalked,
    filesRead: readout.filesRead,
    duplicates: readout.duplicates,
    scannedInMs: readout.scannedInMs,
    scannedAt: Date.now(),

    enabled: settings.dreamingEnabled,
    refusal: dreamingRefusal(settings),
    fireAtMinutes: settings.dreamingMinutes,
    timeZone: settings.dreamingTimeZone,
    minDays: settings.dreamingMinDays,
    maxPerNight: settings.dreamingMaxPerNight,
    maxCostUSD: settings.dreamingMaxCostUSD,
    vaultLabel: root.ok ? root.mountLabel + (root.subpath ? `/${root.subpath}` : "") : null,

    notes: listNotes().map((n) => ({
      ...n,
      // Checked when somebody looks rather than when the run spoke: a file can
      // be deleted at any point after, and the row must not claim otherwise.
      present: root.ok ? noteStillPresent(root.root, n.notePath) : null,
    })),
    nights: listNights(),
    noteLimit: NOTE_LIMIT,
    notesTruncated: counts.notes > NOTE_LIMIT,
    nightLimit: NIGHT_LIMIT,
    nightsTruncated: counts.nights > NIGHT_LIMIT,
  };
  return NextResponse.json(body);
}
