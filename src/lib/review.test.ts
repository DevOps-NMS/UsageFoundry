import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseReviewOutput, settleOnExit } from "./review";

/**
 * Covers reading the CLI's own result object and `settleOnExit`, and only those.
 *
 * `parseReviewOutput`'s failure mode is the same one `spent_usd` guards against
 * elsewhere: a review that was billed and recorded at $0. Cost is read from
 * `total_cost_usd` — the CLI's own figure — and never re-derived from tokens,
 * so a shape this parser does not recognise is spend that silently vanishes.
 *
 * `settleOnExit` decides whether an assist ever ends, and it is the one thing
 * here that earns a *real* subprocess: the fault it guards against cannot be
 * reproduced without one, because pipes a grandchild holds open are the whole
 * mechanism. Wired to `close` alone — which is what this was — a review or a
 * conflict resolution whose answer is already sitting in the buffer never
 * lands: the row stays `running`, `assistRunning` refuses every further assist
 * for that run, and a resolution's throwaway checkout is left registered
 * mid-merge because `after` never runs.
 */

const ok = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "## What changed\nIt renamed a file.",
  total_cost_usd: 0.0421,
  usage: {
    input_tokens: 120,
    output_tokens: 80,
    cache_read_input_tokens: 9_000,
    cache_creation_input_tokens: 10,
  },
});

describe("parseReviewOutput", () => {
  it("takes the cost from the CLI and sums every token bucket", () => {
    const r = parseReviewOutput(ok, "", 0);
    assert.equal(r.status, "completed");
    assert.equal(r.costUSD, 0.0421);
    // Cache reads are the bulk of any Claude Code invocation; dropping them
    // would understate the review by two orders of magnitude.
    assert.equal(r.tokens, 9_210);
  });

  it("still records what a failed review cost", () => {
    // It was billed whether or not it produced anything readable.
    const failed = JSON.stringify({
      subtype: "error_during_execution",
      result: "the model refused",
      total_cost_usd: 0.01,
      usage: { input_tokens: 5 },
    });
    const r = parseReviewOutput(failed, "", 1);
    assert.equal(r.status, "failed");
    assert.equal(r.costUSD, 0.01);
    assert.match(r.error ?? "", /refused/);
  });

  it("falls back to stderr when there is no JSON at all", () => {
    const r = parseReviewOutput("", "command not found: claude\n", 127);
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /command not found/);
  });

  it("does not report an empty result as a review", () => {
    const empty = JSON.stringify({ subtype: "success", result: "", total_cost_usd: 0.5 });
    const r = parseReviewOutput(empty, "", 0);
    assert.equal(r.status, "failed");
    assert.equal(r.costUSD, 0.5);
  });
});

/**
 * A `claude` that prints its answer, leaves a background child holding the
 * inherited stdout, and exits. That is what the real CLI does when a tool call
 * it made started something that outlived it — the pipe stays open, so `close`
 * never comes.
 */
const FAKE_CLAUDE = `#!/bin/sh
printf '{"type":"result","subtype":"success","is_error":false,"result":"It is fine.","total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":5}}\\n'
sleep 30 &
exit 0
`;

describe("settleOnExit", () => {
  it(
    "settles once the child exits, with a grandchild still holding stdout",
    {
      // POSIX shell and process groups; nothing here is meaningful on Windows.
      skip: process.platform === "win32" ? "no process groups on Windows" : false,
      // Without this the pre-fix wiring does not fail, it hangs: `node --test`
      // waits for ever on a promise nothing is going to resolve.
      timeout: 20_000,
    },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-review-settle-"));
      const bin = path.join(dir, "fake-claude");
      fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });

      // Detached so the cleanup below can reach the grandchild through the
      // group: a test that leaks a process holding this pipe open leaves the
      // runner unable to exit. `spawnAssist` spawns detached for real whenever
      // `killProcessGroup` is on, which is the default.
      const child = spawn(bin, [], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      try {
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c: string) => (stdout += c));

        // Recorded rather than awaited. If `close` fires, the wiring this
        // replaces would have landed the assist too and the test proves nothing.
        let closed = false;
        child.on("close", () => {
          closed = true;
        });

        const startedAt = Date.now();
        const code = await new Promise<number | null>((resolve) =>
          settleOnExit(child, resolve),
        );
        const elapsed = Date.now() - startedAt;

        assert.equal(closed, false, "the grandchild should still hold stdout open");
        assert.ok(elapsed < 10_000, `settled after ${elapsed}ms`);
        assert.equal(code, 0);

        // The answer was in the buffer the whole time: parsed and recorded as a
        // review, not discarded as a timeout — and its cost recorded with it.
        const result = parseReviewOutput(stdout, "", code);
        assert.equal(result.status, "completed");
        assert.match(result.text ?? "", /It is fine\./);
        assert.equal(result.costUSD, 0.02);
      } finally {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        child.stdout.destroy();
        child.stderr.destroy();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
