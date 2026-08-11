import { randomUUID } from "node:crypto";
import { db } from "./db";
import {
  ENFORCEMENT_MODES,
  normalizePolicy,
  type BudgetPolicy,
} from "./budget";
import { PERMISSION_MODES, type PermissionMode } from "./settings";
import { MAX_TEMPLATE_NAME } from "./apiTypes";

/**
 * Named run templates: a saved task prompt and the guards it should run under.
 *
 * A template is **form input, not a run**. It holds no folder claim, consumes
 * no concurrency slot, and nothing derived from `activeRuns()` can see it — the
 * only thing it ever does is pre-fill `POST /api/runs`, which stays the sole
 * authority on every value it carries. That is the whole reason a template can
 * be this cheap: it never has to be reconciled on boot, and deleting one can
 * never orphan work.
 *
 * `permissionMode` is why the narrowing below is duplicated rather than
 * deferred. It reaches `--permission-mode` on a process that edits files, and a
 * template is a *second* route to that flag — the first being the run form, and
 * `reopenRun` refuses to become a third on exactly these grounds. So it is
 * narrowed on save (here), narrowed again on read (a row outlives the build
 * that wrote it), and narrowed a third time by `POST /api/runs`. Only the last
 * is load-bearing for safety. The first is what puts the mistake where it was
 * made instead of at the first attempt to use the template; the second is what
 * stops a value this build does not recognise from ever *widening* what a saved
 * template permits.
 *
 * What a template deliberately does **not** hold:
 *
 * - **The model.** `settings.defaultModel` already sets it globally and the run
 *   form does not offer it at all. Two places to set one thing is how they
 *   drift, and the second place would be the one nobody remembers to check.
 * - **A last-used timestamp.** Ordering is by name, so the picker reads the way
 *   a person scans it. Most-recently-used would need a write on every
 *   instantiation and a `templateId` on the run wire that exists for nothing
 *   else — a lot of machinery to reorder a list of five.
 * - **Placeholders in the prompt.** The text lands in an editable textarea, so
 *   substituting a branch or a ticket number is already free.
 */

export interface RunTemplate {
  id: string;
  name: string;
  prompt: string;
  /** Null means "ask when this template is used". */
  mountId: string | null;
  /** Path within the mount. `""` is the mount root — not the same as null. */
  folder: string | null;
  isolate: boolean;
  permissionMode: PermissionMode;
  budget: BudgetPolicy;
  createdAt: number;
  updatedAt: number;
}

/** A template stripped of its identity — everything a save or an edit supplies. */
export type TemplateInput = Omit<
  RunTemplate,
  "id" | "createdAt" | "updatedAt"
>;

export type TemplateNormalization =
  | { ok: true; value: TemplateInput }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Validation — pure, and the reason this file has a test              */
/* ------------------------------------------------------------------ */

/**
 * Read a template off the wire, refusing anything that could not be run.
 *
 * Pure and total in the sense that matters: it never throws, and every refusal
 * names something the operator can change. It is deliberately stricter than
 * `normalizePolicy`, which has no error channel and must coerce — a template is
 * saved once and used many times, so the moment to reject a value is while the
 * person who typed it is still looking at it.
 */
export function normalizeTemplateInput(raw: unknown): TemplateNormalization {
  const o = (raw ?? {}) as Record<string, unknown>;

  const name = String(o.name ?? "").trim();
  if (!name) return { ok: false, error: "A template needs a name." };
  if (name.length > MAX_TEMPLATE_NAME) {
    return {
      ok: false,
      error: `A template name is at most ${MAX_TEMPLATE_NAME} characters.`,
    };
  }

  const prompt = String(o.prompt ?? "").trim();
  if (!prompt) {
    return {
      ok: false,
      error:
        "A template needs a task. The prompt is the part worth saving — the " +
        "guards take seconds to re-set, a prompt that took three attempts to " +
        "get right does not.",
    };
  }

  // Narrowed against the same four literals `POST /api/runs` uses, and for the
  // same reason: this value reaches `--permission-mode` on a process that edits
  // files. Refused here as well so it lands where the mistake was made.
  const permissionMode = String(o.permissionMode ?? "acceptEdits");
  if (!(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return { ok: false, error: `Unknown permission mode: ${permissionMode}` };
  }

  const rawBudget = (o.budget ?? {}) as Record<string, unknown>;

  // Same narrowing as the run route: this decides whether a running agent is
  // killed part-way through a work cycle, so an unrecognised mode is reported
  // rather than quietly downgraded to the safe default.
  if (rawBudget.enforcement !== undefined && rawBudget.enforcement !== null) {
    const candidate = String(rawBudget.enforcement);
    if (!(ENFORCEMENT_MODES as readonly string[]).includes(candidate)) {
      return { ok: false, error: `Unknown enforcement mode: ${candidate}` };
    }
  }

  const budget = normalizePolicy(rawBudget);

  // The pair `POST /api/runs` refuses, refused again at the door. Validating
  // only at POST would let a template be saved that can never be instantiated,
  // and the failure would surface weeks later against a form the operator has
  // no memory of filling in.
  if (budget.maxIterations === null && budget.maxDurationMinutes === null) {
    return {
      ok: false,
      error:
        "A template with no work-cycle limit needs a time limit. Wall-clock " +
        "time is the only limit that keeps advancing whether or not the agent " +
        "reports what it spent, so it is the only thing that would end a run " +
        "started from this template.",
    };
  }

  // A folder is a path *within* a mount, so the two are stored together or not
  // at all — a folder with no mount names nothing. Null is "ask when used"; the
  // empty string is a real answer (the mount root), and collapsing the two
  // would silently turn "no folder recorded" into "the whole workspace", which
  // is the one selection that blocks every other run in the tree.
  const mountId =
    o.mountId === null || o.mountId === undefined || String(o.mountId) === ""
      ? null
      : String(o.mountId);
  const folder = mountId === null ? null : String(o.folder ?? "");

  return {
    ok: true,
    value: {
      name,
      prompt,
      mountId,
      folder,
      // Matches `POST /api/runs`: anything but an explicit false asks for the
      // isolated checkout, which is the choice that cannot damage the
      // operator's own working tree.
      isolate: o.isolate !== false,
      permissionMode: permissionMode as PermissionMode,
      budget,
    },
  };
}

interface TemplateRow {
  id: string;
  name: string;
  prompt: string;
  mount_id: string | null;
  folder: string | null;
  isolate: number;
  permission_mode: string;
  budget: string;
  created_at: number;
  updated_at: number;
}

/**
 * A stored row as the rest of the app sees it.
 *
 * Pure — it takes the row rather than reading one — so the narrowing it does is
 * testable without a database.
 */
export function rowToTemplate(row: TemplateRow): RunTemplate {
  // Read-time narrowing must never *widen* what a saved template permits, so an
  // unrecognised mode degrades to `plan`, the only one of the four that cannot
  // write. Symmetric with `normalizePolicy` degrading an unknown enforcement
  // mode to `between-cycles` instead of throwing: a row can outlive the build
  // that wrote it, and the safe reading of a value this build does not
  // understand is the least it could have meant, never the most.
  const permissionMode = (PERMISSION_MODES as readonly string[]).includes(
    row.permission_mode,
  )
    ? (row.permission_mode as PermissionMode)
    : "plan";

  let rawBudget: unknown = {};
  try {
    rawBudget = JSON.parse(row.budget);
  } catch {
    // An unreadable blob normalises to a single work cycle and no other guard,
    // which is the smallest thing this app knows how to run.
  }

  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    mountId: row.mount_id,
    folder: row.folder,
    isolate: row.isolate !== 0,
    permissionMode,
    budget: normalizePolicy(rawBudget),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

const COLUMNS = `id, name, prompt, mount_id, folder, isolate, permission_mode,
                 budget, created_at, updated_at`;

/**
 * Turn SQLite's unique-index violation into the sentence the form should show.
 *
 * The constraint is the check — see the index comment in `db.ts` — so this is
 * where "already exists" becomes readable, rather than a check-then-insert
 * upstream that would say the same thing less reliably.
 */
function withNameConflict<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = String((err as { code?: unknown } | null)?.code ?? "");
    if (code.startsWith("SQLITE_CONSTRAINT")) {
      throw new Error(
        `A template called “${name}” already exists. Rename this one, or ` +
          `pick that template and update it.`,
      );
    }
    throw err;
  }
}

export function listTemplates(): RunTemplate[] {
  // By name, case-insensitively: the picker is a list a person scans, and the
  // order they scan it in should not depend on which one they last touched.
  const rows = db()
    .prepare(
      `SELECT ${COLUMNS} FROM run_templates ORDER BY name COLLATE NOCASE`,
    )
    .all() as TemplateRow[];
  return rows.map(rowToTemplate);
}

export function getTemplate(id: string): RunTemplate | null {
  const row = db()
    .prepare(`SELECT ${COLUMNS} FROM run_templates WHERE id = ?`)
    .get(id) as TemplateRow | undefined;
  return row ? rowToTemplate(row) : null;
}

export function createTemplate(input: TemplateInput): RunTemplate {
  const id = randomUUID();
  const now = Date.now();
  withNameConflict(input.name, () =>
    db()
      .prepare(
        `INSERT INTO run_templates
           (id, name, prompt, mount_id, folder, isolate, permission_mode,
            budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.prompt,
        input.mountId,
        input.folder,
        input.isolate ? 1 : 0,
        input.permissionMode,
        JSON.stringify(input.budget),
        now,
        now,
      ),
  );
  return getTemplate(id)!;
}

/** Null when there is no such template — the caller answers 404. */
export function updateTemplate(
  id: string,
  input: TemplateInput,
): RunTemplate | null {
  if (!getTemplate(id)) return null;
  withNameConflict(input.name, () =>
    db()
      .prepare(
        `UPDATE run_templates
            SET name = ?, prompt = ?, mount_id = ?, folder = ?, isolate = ?,
                permission_mode = ?, budget = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.name,
        input.prompt,
        input.mountId,
        input.folder,
        input.isolate ? 1 : 0,
        input.permissionMode,
        JSON.stringify(input.budget),
        Date.now(),
        id,
      ),
  );
  return getTemplate(id);
}

/**
 * Deleting a template touches nothing else. Runs started from one carry their
 * own copy of every value, so there is no cascade to think about and no run
 * that becomes unreadable afterwards.
 */
export function deleteTemplate(id: string): boolean {
  const res = db().prepare("DELETE FROM run_templates WHERE id = ?").run(id);
  return res.changes > 0;
}
