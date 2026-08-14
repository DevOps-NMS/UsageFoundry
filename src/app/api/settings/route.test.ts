import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../../../lib/settings";

/**
 * Every key of `Settings` survives a round trip through `PUT /api/settings`.
 *
 * The route builds its patch from an explicit `if ("<key>" in body)` branch per
 * setting, and that shape is deliberate — it is where `defaultPermissionMode`,
 * `landStrategy`, `chatDefaultGuards` and `sessionResetOverrideAt` are narrowed
 * before they reach storage, so it must not become a `{ ...body }` merge. What
 * it costs is that a *missing* branch fails in silence: the settings page sends
 * the whole object, the route answers 200 with the value it already had, and
 * the page writes that answer back over the form — so the textarea reverts
 * under a "Saved" confirmation and the setting can never be changed at all.
 * That is what happened to `continuedWorkPrompt`, for as long as it existed.
 *
 * So the test is about the class rather than that key: the table below is typed
 * against `keyof Settings`, which makes a field added to the interface a
 * compile error here until it is probed, and every probe then proves the route
 * both answers with the value and stores it. One key, one named test, so a
 * dropped branch names itself.
 *
 * A field that is deliberately not settable through this route would fail here
 * too, and that is the intended cost: `Settings` is what the settings page
 * edits, so a key it cannot save is a decision to write down rather than a
 * probe to delete.
 *
 * It opens a database for the reason the chat route's test does — the defect is
 * in a payload, so only something that reads the payload can see it. The
 * database is a throwaway directory and the run is a few milliseconds.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-settings-route-"));

// Config is fixed at boot, so the throwaway database has to be named before the
// first import of anything that reads it — hence the dynamic imports below.
process.env.DATA_DIR = DATA_DIR;

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

/**
 * What to send for one key, and what should be stored for it.
 *
 * `stored` is only spelled out where the route normalizes on the way in; where
 * it is absent the value goes in as it stands. Every value has to differ from
 * the default, or a key the route drops would still read as accepted.
 */
type Probe = { send: unknown; stored?: unknown };

// The route refuses a reset instant more than five hours ahead, so this one is
// in the past — a value it will accept rather than answer 400 for.
const RESET_AT = Date.now() - 60 * 60 * 1000;

const PROBES: Record<keyof Settings, Probe> = {
  sessionCostLimit: { send: 42.5 },
  weeklyCostLimit: { send: 300 },
  sessionTokenLimit: { send: 1_000_000 },
  weeklyTokenLimit: { send: 9_000_000 },
  weeklyAnchor: { send: { weekday: 3, hourUTC: 9 } },
  sessionResetOverrideAt: { send: RESET_AT },
  reservedHeadroomFraction: { send: 0.2 },
  planUsageFromApi: { send: false },
  defaultPermissionMode: { send: "plan" },
  defaultModel: { send: "claude-sonnet-5" },
  // Filled in by the hook below: the route refuses an id that names no usable
  // agent, so this is the one probe whose value has to exist in the database
  // before it can be sent.
  defaultAgentId: { send: null },
  continuationPrompt: { send: "CHANGED continuation" },
  includeSidechains: { send: false },
  forwardSubAgentText: { send: false },
  maxConcurrentRuns: { send: 3 },
  isolationCopyGlobs: { send: [".env.local"] },
  isolationPreamble: { send: "CHANGED preamble" },
  continuedWorkPrompt: { send: "CHANGED continued work" },
  telemetryForRuns: { send: true },
  donePushbackPrompt: { send: "CHANGED pushback" },
  liveGuardIntervalSeconds: { send: 90 },
  resumeGraceHours: { send: 12 },
  landStrategy: { send: "squash" },
  killProcessGroup: { send: false },
  chatTurnBudgetUSD: { send: 7 },
  eventRetentionDays: { send: 14 },
  checkoutRetentionDays: { send: 3 },
  transcriptRetentionDays: { send: 45 },
  chatDefaultGuards: {
    send: {
      permissionMode: "plan",
      isolate: false,
      budget: { maxIterations: 3, maxDurationMinutes: 45 },
    },
    // `normalizePolicy` fills the policy out, so what comes back is the whole
    // shape rather than the two fields that were sent.
    stored: {
      permissionMode: "plan",
      isolate: false,
      budget: {
        maxWeeklyFraction: null,
        maxSessionFraction: null,
        maxRunCostUSD: null,
        maxRunTokens: null,
        maxIterations: 3,
        maxDurationMinutes: 45,
        enforcement: "between-cycles",
        continueAfterDone: false,
      },
    },
  },
};

/**
 * A real saved agent for the one probe that has to name one.
 *
 * The route refuses a `defaultAgentId` that names nothing or that names a row
 * Claude Code would drop, which is the whole point of that branch — so the probe
 * cannot be a made-up string. The value is patched in rather than written above
 * because `createAgent` mints the id, and the loop reads `PROBES[key]` inside
 * each test callback, after this has run.
 */
before(async () => {
  const { createAgent } = await import("../../../lib/agents");
  const agent = createAgent({
    name: "probe-reviewer",
    description: "reads diffs",
    prompt: "You review.",
    model: null,
  });
  PROBES.defaultAgentId.send = agent.id;
});

function expected(probe: Probe): unknown {
  return "stored" in probe ? probe.stored : probe.send;
}

async function read(): Promise<Settings> {
  const { GET } = await import("./route");
  const body = (await (await GET()).json()) as { settings: Settings };
  return body.settings;
}

async function write(key: string, value: unknown): Promise<Settings> {
  const { PUT } = await import("./route");
  const res = await PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    }),
  );
  const body = (await res.json()) as { settings?: Settings; error?: string };
  assert.equal(
    res.status,
    200,
    `PUT /api/settings refused ${key}: ${body.error ?? "(no message)"}`,
  );
  assert.ok(body.settings, `PUT /api/settings answered without settings`);
  return body.settings;
}

test("the probe table covers exactly the keys Settings has", async () => {
  const { SETTINGS_KEYS } = await import("../../../lib/settings");
  assert.deepEqual(
    Object.keys(PROBES).sort(),
    [...SETTINGS_KEYS].sort(),
    "every key of Settings needs a probe below, and nothing else belongs there",
  );
});

for (const key of Object.keys(PROBES) as (keyof Settings)[]) {
  test(`PUT /api/settings accepts ${key}`, async () => {
    const probe = PROBES[key];
    const want = expected(probe);

    const before = await read();
    assert.notDeepEqual(
      before[key],
      want,
      `the probe for ${key} must differ from what is already stored, or a ` +
        `key the route drops would still look accepted`,
    );

    const answered = await write(key, probe.send);
    assert.deepEqual(
      answered[key],
      want,
      `PUT /api/settings answered with the old ${key}, so the route has no ` +
        `branch for it — the settings page writes this answer back over the ` +
        `form, which is what makes the edit vanish under a "Saved" message`,
    );

    assert.deepEqual(
      (await read())[key],
      want,
      `GET /api/settings does not report the ${key} that was just stored`,
    );
  });
}

test("a blank prompt keeps whatever is stored", async () => {
  // The rule `continuationPrompt`, `isolationPreamble`, `donePushbackPrompt`
  // and `continuedWorkPrompt` share: emptying one would silently remove
  // instructions an agent depends on, so the stored text stands until it is
  // replaced by other text.
  const prompts = [
    "continuationPrompt",
    "isolationPreamble",
    "donePushbackPrompt",
    "continuedWorkPrompt",
  ] as const;

  for (const key of prompts) {
    const kept = (await read())[key];
    const answered = await write(key, "   ");
    assert.equal(answered[key], kept, `a blank ${key} was answered as empty`);
    assert.equal((await read())[key], kept, `a blank ${key} was stored`);
  }
});
