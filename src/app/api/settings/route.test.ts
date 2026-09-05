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
const MOUNT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-settings-mount-"));

// Config is fixed at boot, so the throwaway database has to be named before the
// first import of anything that reads it — hence the dynamic imports below.
process.env.DATA_DIR = DATA_DIR;
// And the mounts too: `knowledgeBaseMountId` is refused unless it names one, so
// the probe below would otherwise pass or fail on whatever this machine happens
// to have bind-mounted.
process.env.WORKSPACE_ROOTS = `Probe Vault=${MOUNT_DIR}`;

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(MOUNT_DIR, { recursive: true, force: true });
});

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
  // Trimmed on the way in, so what comes back is not what was sent.
  landVerifyCommand: { send: "  npm test  ", stored: "npm test" },
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
  readGuard: { send: true },
  contextPruning: { send: true },
  contextPruningStrictness: { send: "aggressive" },
  contextPruningEngine: { send: "winnow" },
  contextPruningForkMinColdAge: { send: 30 },
  // Sent above the CLI's own 25,000-token refusal and stored just under it: a
  // cap at or past that is a number nothing would ever act on, so the route
  // clamps rather than storing what was typed.
  readGuardMaxTokens: { send: 40_000, stored: 24_999 },
  freshStartContextTokens: { send: 150_000 },
  maxConcurrentRuns: { send: 3 },
  maxConcurrentAssists: { send: 5 },
  resolveVerifyTools: { send: ["Bash(npm run typecheck:*)"] },
  isolationCopyGlobs: { send: [".env.local"] },
  isolationCopyGlobsByRepo: { send: { "acme/web": ["apps/web/.env"] } },
  isolationPreamble: { send: "CHANGED preamble" },
  continuedWorkPrompt: { send: "CHANGED continued work" },
  telemetryForRuns: { send: true },
  donePushbackPrompt: { send: "CHANGED pushback" },
  liveGuardIntervalSeconds: { send: 90 },
  maxCycleSilenceMinutes: { send: 45 },
  resumeGraceHours: { send: 12 },
  landStrategy: { send: "squash" },
  killProcessGroup: { send: false },
  chatTurnBudgetUSD: { send: 7 },
  eventRetentionDays: { send: 14 },
  checkoutRetentionDays: { send: 3 },
  transcriptRetentionDays: { send: 45 },
  installDailyCostLimitUSD: { send: 250 },
  // `Probe Vault` above slugs to this id. The route refuses one that names no
  // configured mount, which is the same shape as `defaultAgentId`'s refusal.
  knowledgeBaseMountId: { send: "probe-vault" },
  // Sent in the form a person types and stored normalized, so the round trip
  // proves the two ends agree on the spelling rather than only on the value.
  knowledgeBaseSubpath: { send: "/Vault/Notes/", stored: "Vault/Notes" },
  dreamingEnabled: { send: true },
  dreamingMinutes: { send: 4 * 60 + 30 },
  dreamingTimeZone: { send: "Europe/Berlin" },
  dreamingMinDays: { send: 3 },
  dreamingMaxCostUSD: { send: 5 },
  dreamingMaxPerNight: { send: 8 },
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
        maxRunCostFactor: null,
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

type Answer = { settings: Settings; nonDefaultKeys: string[] };

async function readAll(): Promise<Answer> {
  const { GET } = await import("./route");
  return (await (await GET(new Request("http://localhost/api/settings"))).json()) as Answer;
}

async function read(): Promise<Settings> {
  return (await readAll()).settings;
}

async function writeAll(key: string, value: unknown): Promise<Answer> {
  const { PUT } = await import("./route");
  const res = await PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    }),
  );
  const body = (await res.json()) as {
    settings?: Settings;
    nonDefaultKeys?: string[];
    error?: string;
  };
  assert.equal(
    res.status,
    200,
    `PUT /api/settings refused ${key}: ${body.error ?? "(no message)"}`,
  );
  assert.ok(body.settings, `PUT /api/settings answered without settings`);
  const moved = body.nonDefaultKeys;
  assert.ok(
    Array.isArray(moved),
    `PUT /api/settings answered without nonDefaultKeys — the settings page ` +
      `sets its state from this response, so every fold's count would be ` +
      `stale from the moment the operator pressed Save`,
  );
  return { settings: body.settings, nonDefaultKeys: moved };
}

async function write(key: string, value: unknown): Promise<Settings> {
  return (await writeAll(key, value)).settings;
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

/**
 * The one key here whose `0` and blank are opposites rather than synonyms.
 *
 * Everywhere else on this route a number is a limit, and `optionalNumber`'s
 * closing `n > 0 ? n : null` is right for all of them: a cost ceiling of zero
 * and no cost ceiling are the same request. This key is a threshold, not a
 * limit. `0` is the shipped default and the only value that ever forks; blank
 * defers to winnow's own hour, and an hour at a cycle boundary refuses every
 * time. Sharing that helper meant typing 0 returned 200, redrew the form as
 * blank, and left the engine off.
 *
 * The probe loop above cannot catch this, and did not: its probe sends 30, and
 * 30 is on the surviving side of the fold. Only 0 distinguishes the two.
 */
test("PUT /api/settings stores a fork quiet period of 0 as 0, not as blank", async () => {
  const answered = await write("contextPruningForkMinColdAge", 0);
  assert.equal(
    answered.contextPruningForkMinColdAge,
    0,
    `0 came back as ${JSON.stringify(answered.contextPruningForkMinColdAge)} — ` +
      `blank here means "use winnow's hour", which never forks, so an operator ` +
      `asking for 0 would be answered with the opposite of what they asked for`,
  );
  assert.equal((await read()).contextPruningForkMinColdAge, 0);
});

test("PUT /api/settings still reads a blank fork quiet period as blank", async () => {
  await write("contextPruningForkMinColdAge", 45);
  const answered = await write("contextPruningForkMinColdAge", "");
  assert.equal(answered.contextPruningForkMinColdAge, null);
  assert.equal((await read()).contextPruningForkMinColdAge, null);
});

test("PUT /api/settings refuses a negative fork quiet period instead of blanking it", async () => {
  // Unreachable while the key went through `optionalNumber`: -5 was folded to
  // null and stored as "defer to winnow", so a typo turned the engine off and
  // answered 200. The route always carried this message; nothing could reach it.
  const { PUT } = await import("./route");
  const res = await PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextPruningForkMinColdAge: -5 }),
    }),
  );
  assert.equal(res.status, 400);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /non-negative/,
  );
});

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

/**
 * A knowledge base naming a mount that is not configured is refused here.
 *
 * `defaultAgentId`'s rule — refuse where the person is — and the same silence
 * if it were not: the mounts are fixed at boot, so a stored id that names none
 * can never start working, and the only symptom is a Knowledge base section
 * that stays empty on a page that gives no reason why. The refusal has to be a
 * 400 rather than a quiet drop for the reason the whole file exists: a dropped
 * value is answered as the old one and written back over the form.
 */
test("PUT /api/settings refuses a knowledge base mount that is not configured", async () => {
  const { PUT } = await import("./route");
  const before = (await read()).knowledgeBaseMountId;

  const res = await PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledgeBaseMountId: "no-such-mount" }),
    }),
  );
  assert.equal(res.status, 400, "an unconfigured mount id was accepted");
  const body = (await res.json()) as { error?: string };
  assert.match(String(body.error), /no-such-mount/, "the refusal does not name the id");

  assert.equal(
    (await read()).knowledgeBaseMountId,
    before,
    "a refused mount id was stored anyway",
  );
});

/**
 * What the settings page folds on.
 *
 * A fold whose contents differ from their defaults opens by default, and that
 * rule is the whole reason folding a once-per-install control is safe rather
 * than a way to hide a surprise. The page cannot compute it — `DEFAULTS` is
 * server-side — so it reads this field, and every failure mode here is silent:
 * a key missing from the list is a setting left behind a summary at a value
 * nobody expects, and a key reported too coarsely opens a fold that holds
 * nothing the operator changed.
 *
 * The spelling is the other half of it. The page marks its fields by the dotted
 * path that reaches one control, so the guard set has to arrive split into its
 * leaves; reported whole it would say a fold holding one guard row holds a
 * change when what moved was one of the other six.
 */
test("the answer names which settings this install has moved, per control", async () => {
  const { DEFAULTS } = await import("../../../lib/settings");

  // One leaf of the guard set moved and the rest of it left at the shipped
  // value, so the dotted spelling is proved rather than incidental.
  await write("chatDefaultGuards", {
    ...DEFAULTS.chatDefaultGuards,
    budget: { ...DEFAULTS.chatDefaultGuards.budget, maxIterations: 9 },
  });
  await write("continuationPrompt", "CHANGED continuation, again");

  const moved = new Set((await readAll()).nonDefaultKeys);
  assert.ok(
    moved.has("chatDefaultGuards.budget.maxIterations"),
    "a guard field this install moved is not on the list",
  );
  assert.ok(
    !moved.has("chatDefaultGuards.budget.maxDurationMinutes"),
    "a guard field still at the shipped value is reported as moved",
  );
  assert.ok(
    !moved.has("chatDefaultGuards"),
    "the guard set is reported whole, which opens a fold holding one of its " +
      "rows for a change to any of the other six",
  );
  assert.ok(moved.has("continuationPrompt"), "a moved prompt is not on the list");

  // And it drops off again. This is the case the page's badge has to follow:
  // a prompt saved back to the shipped text is no longer a reason to fold it
  // open, and the count beside its summary says so.
  const restored = await writeAll("continuationPrompt", DEFAULTS.continuationPrompt);
  assert.ok(
    !restored.nonDefaultKeys.includes("continuationPrompt"),
    "a prompt restored to the shipped default is still reported as moved",
  );
});
