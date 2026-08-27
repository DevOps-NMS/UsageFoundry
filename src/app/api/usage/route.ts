import v8 from "node:v8";
import { NextResponse } from "next/server";
import { scanUsage, transcriptCacheStats } from "@/lib/transcripts";
import {
  agentOriginIndex,
  buildPeriods,
  buildSnapshot,
  resolveTimeZone,
} from "@/lib/windows";
import { listAgents, listAmbientAgents } from "@/lib/agents";
import { getSettings, limitConfig, newWorkPaused } from "@/lib/settings";
import { readAccountProfile } from "@/lib/account";
import { planUsage } from "@/lib/planUsage";
import { telemetryWindow } from "@/lib/otlp";
import { retentionCutoff } from "@/lib/retention";
import { installSpendReport } from "@/lib/installBudget";
import {
  pricedCuts,
  sumPruneSavings,
} from "../../../lib/contextPruning";
import { readFilterSavings } from "@/lib/intakeFilter";
import { PROJECTS_DIR } from "@/lib/config";
import { configProblems } from "@/lib/configCheck";
import { jsonMaybeGzipped } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The model the `byAgent` counterfactual is priced at.
 *
 * Named here rather than inside `windows.ts` because what makes a target right
 * is what an operator could plausibly point an agent at, which is a product
 * decision and not a metering one — the rollup takes it as an argument for the
 * same reason `agentNames` is an argument. Sonnet 5 is the one that earns it:
 * it is the next tier down from the `claude-opus-5` every recorded run here
 * used, `pricing.ts` has real rates for it, and an agent carrying
 * `"model": "sonnet"` selected with `--agent` is the whole of the mechanism —
 * no schema change, and deliberately no model column on `run_templates`, which
 * `templates.ts` refuses by name.
 *
 * A constant rather than a setting: nothing acts on this figure, one target is
 * enough to answer "is this worth trying", and a picker would be a control that
 * changes a number nobody is billed for.
 */
const COUNTERFACTUAL_MODEL = "claude-sonnet-5";

export async function GET(req: Request) {
  try {
    const settings = getSettings();
    const [scan, account, plan] = await Promise.all([
      scanUsage(),
      readAccountProfile(),
      settings.planUsageFromApi ? planUsage() : Promise.resolve(null),
    ]);
    const entries = settings.includeSidechains
      ? scan.entries
      : scan.entries.filter((e) => !e.isSidechain);
    // The composition reading obeys the same setting the meters do. It is a
    // different array of a different type over the same files, so nothing here
    // sums the two — but a card saying `Read` is a third of the context while
    // the card above it has excluded every sub-agent turn would be two
    // statements about two different corpora under one heading.
    const toolCalls = settings.includeSidechains
      ? scan.toolCalls
      : scan.toolCalls.filter((c) => !c.isSidechain);

    const now = Date.now();
    const limits = limitConfig(settings);
    // Read here rather than inside `buildSnapshot`, which is the function the
    // orchestrator calls before every work cycle: this is a SQLite read and a
    // directory walk, and it decides nothing — it only annotates a column with
    // where each agent name's definition lives. Only the user scope of the
    // ambient set is available, for the reason `GET /api/agents` gives: the
    // project scope depends on a cwd, and this column covers every transcript
    // on the machine rather than one checkout. A repository's own agent
    // therefore reads as `unknown`, and the card says what unmarked means.
    const agentNames = agentOriginIndex(
      listAgents().map((a) => a.name),
      listAmbientAgents().map((a) => a.name),
    );
    const snapshot = buildSnapshot(
      entries,
      limits,
      now,
      settings.sessionResetOverrideAt,
      plan,
      agentNames,
      toolCalls,
      COUNTERFACTUAL_MODEL,
    );

    // Calendar buckets are wrong at every edge if they are cut in the wrong
    // zone, and the container runs in UTC — so the browser names the zone it is
    // displaying in and `resolveTimeZone` refuses anything that is not one.
    // All three granularities on every poll: the client toggle then costs no
    // request, and the whole set is a tenth of what the snapshot already is.
    const timeZone = resolveTimeZone(
      new URL(req.url).searchParams.get("tz"),
    );
    // The transcript horizon, carried onto the card rather than enforced
    // against it. This offers twelve months and the shipped horizon is thirty
    // days, so a longer history than the retention would need the retention to
    // be a year — which would defeat it. `buildPeriods` already drops buckets
    // that closed before the first entry, so pruning makes the history
    // *shorter* rather than wrong; this is the sentence for the one bucket the
    // cutoff falls inside. Read from the same setting `sweepTranscripts` reads.
    const completeFrom = retentionCutoff(settings.transcriptRetentionDays, now);
    const periods = {
      day: buildPeriods(entries, "day", limits, now, timeZone, completeFrom),
      week: buildPeriods(entries, "week", limits, now, timeZone, completeFrom),
      month: buildPeriods(entries, "month", limits, now, timeZone, completeFrom),
    };

    // Bounded by the snapshot's own window so the card describes the same five
    // hours as the session meter — and read only when the setting is on, so a
    // stock install carries no telemetry key on the wire at all. It is never
    // folded into `snapshot`: see the DTO comment on `UsageResponse.telemetry`.
    const telemetry = settings.telemetryForRuns
      ? telemetryWindow(snapshot.session.startsAt)
      : null;

    // Pruning's value over three spans that nest, read and priced **once**:
    // pricing counts the turns after each receipt out of the transcript scan,
    // and asking for the three separately re-counted the same tail three times
    // on a ten-second poll.
    //
    // The span is bounded rather than run over the whole table, and at the
    // transcript horizon specifically — the same one `completeFrom` carries
    // above. A receipt whose transcript has been swept cannot be priced, and it
    // does not merely fall silent: its saving reads zero while an early end's
    // invalidation is still charged, so an unbounded total would sink towards
    // negative as it aged. Dropping those receipts whole makes the total a
    // floor, which is the direction every other figure here errs in. Clamped to
    // the weekly window's own start as well, so the total can never span less
    // than a figure printed beside it on an install with a short retention.
    const pruneFrom = Math.min(completeFrom ?? 0, snapshot.weekly.startsAt);
    // `pricedCuts` and not `priceReceipts(readReceipts(...))`: that pair reads
    // the legacy table alone, so every cut the fork engine made was missing
    // from this card while showing correctly on its own run's page — which goes
    // through `pruneSavings`, which knows there are two tables. The run page and
    // the dashboard were describing the same events and disagreeing.
    const pricedReceipts = await pricedCuts({ from: pruneFrom, to: now });
    const prunedWithin = (from: number, to: number) =>
      sumPruneSavings(
        pricedReceipts.filter((p) => p.row.ts >= from && p.row.ts <= to),
      );

    // Bounded at the same horizon the prune total is, and for the same reason:
    // a filtered request whose transcript has been swept can be neither dated
    // nor priced. The same two window starts the meters and the prune figures
    // use, so the card's "of which the filter" line describes the same span as
    // the figure it is a share of — the ledger carries no clock of its own, so
    // every instant comes from the transcript join and a result that joined to
    // nothing is left out of both windows rather than guessed into one. Read
    // behind its own minute-long TTL: this route is the dashboard's ten-second
    // heartbeat and the ledger grows with every request every agent in the
    // fleet makes.
    const intakeFilter = await readFilterSavings(
      {
        from: pruneFrom > 0 ? pruneFrom : null,
        sessionFrom: snapshot.session.startsAt,
        weeklyFrom: snapshot.weekly.startsAt,
      },
      now,
    );

    // Gzipped: 51,984 bytes to 9,785, measured — three granularities of
    // calendar bucket over the same entries repeat their keys on every one, and
    // this is the dashboard's ten-second heartbeat. The error branch below is
    // one sentence and stays plain.
    return jsonMaybeGzipped(req, {
      snapshot,
      periods,
      telemetry,
      // Unconditional, unlike `telemetry`: the ceiling is what the operator
      // typed and the reading is money this app recorded spending, so there is
      // no setting to gate it on and nothing to leak by reporting it. Its own
      // key rather than a field on `snapshot`, because it is a fourth reading
      // over a different span and must never be summed with the meters.
      install: installSpendReport(now),
      // What context pruning has been worth: the two windows the meters above
      // already draw — so a reader comparing them is comparing the same span,
      // not this app's idea of "recently" — and the whole of what can still be
      // priced, which is what the tile leads with. Whether to leave pruning on
      // is not a question about this week.
      //
      // Its own key and never folded into `snapshot`, on `install`'s rule and
      // one more: these are not a *third cost source*, they are the netted value
      // of an intervention, and a figure that could be added to a window total
      // would be added to one eventually. Nothing here is spend.
      // Beside `pruning` rather than inside it. They are the two halves of
      // context control and the card adds them, but their figures overlap —
      // the filter takes C1/C3/B2 mass off the wire first, and a prune that
      // later removes the same result from the transcript prices tokens the
      // API never held. The sum belongs where the overlap is printed beside
      // it; pre-adding it here would send the overstatement on with nothing
      // left saying so.
      intakeFilter,
      pruning: {
        session: prunedWithin(
          snapshot.session.startsAt,
          snapshot.session.endsAt,
        ),
        weekly: prunedWithin(snapshot.weekly.startsAt, snapshot.weekly.endsAt),
        total: sumPruneSavings(pricedReceipts),
        // Null is "nothing bounded it", which is a real state — an install with
        // transcript retention off keeps every receipt priceable. The client
        // must not print a date it invented for that case.
        totalFrom: pruneFrom > 0 ? pruneFrom : null,
      },
      meta: {
        transcriptDir: PROJECTS_DIR,
        fileCount: scan.fileCount,
        entryCount: entries.length,
        unpricedModels: scan.unpricedModels,
        scannedAt: scan.scannedAt,
        // Capped for the reason a shortened diff is, and the count is the whole
        // set so the page can say how much it is not showing. Every figure on
        // this response is a floor while this is non-empty.
        readFailures: scan.readFailures.slice(0, 5),
        readFailureCount: scan.readFailures.length,
        // What this process is holding, and what V8 will let it hold. The
        // transcript cache is the largest thing on this heap by a wide margin
        // and used to grow with every turn ever written, so the two are read
        // together: a rising `heapUsedBytes` beside a flat `entries` at
        // `maxEntries` is the cache doing its job, and beside a climbing
        // `entries` it is something else.
        memory: {
          cache: transcriptCacheStats(),
          heapUsedBytes: process.memoryUsage().heapUsed,
          heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
        },
        // "Can this window show a percentage at all", which the provider's own
        // reading answers without anything being configured — the whole point
        // of it. Reading the snapshot rather than the settings is what keeps
        // the "no ceilings" banner off a dashboard that is showing real
        // percentages.
        hasSessionCeiling:
          snapshot.session.fraction !== null ||
          settings.sessionCostLimit !== null ||
          settings.sessionTokenLimit !== null,
        hasWeeklyCeiling:
          snapshot.weekly.fraction !== null ||
          settings.weeklyCostLimit !== null ||
          settings.weeklyTokenLimit !== null,
        // Whether the setting is on, so the UI can tell "switched off" apart
        // from "on, but the provider did not answer" — the second is worth a
        // sentence and the first is not.
        planUsageFromApi: settings.planUsageFromApi,
        // On the dashboard because a held fleet and a quiet one are identical
        // here otherwise: the meters read the same, and the only difference is
        // that nothing new ever starts. One boolean off a settings row rather
        // than a second poll — this route is already the page's heartbeat.
        newWorkPaused: newWorkPaused(),
        reservedHeadroomFraction: settings.reservedHeadroomFraction ?? 0,
        // What the user typed, so the meters can name it alongside the reduced
        // ceiling they are actually measured against.
        configuredCeilings: {
          sessionCost: settings.sessionCostLimit,
          weeklyCost: settings.weeklyCostLimit,
          sessionTokens: settings.sessionTokenLimit,
          weeklyTokens: settings.weeklyTokenLimit,
        },
        sessionResetOverrideAt: settings.sessionResetOverrideAt,
        includeSidechains: settings.includeSidechains,
        account,
        entrypoints: [
          ...new Set(entries.map((e) => e.entrypoint).filter(Boolean)),
        ] as string[],
        // Cached from the boot probe, so this costs a property read rather than
        // a stat per mount on a ten-second poll. On this page because a wrongly
        // pointed mount and a wrongly pointed CLAUDE_HOME both present as the
        // zeros above it, which is also what a quiet week looks like.
        configProblems: configProblems(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
