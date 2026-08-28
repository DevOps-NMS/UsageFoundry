import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunHandoff } from "./RunHandoff";
import type { RunEventDTO } from "../lib/apiTypes";

/**
 * This fold hands the operator commands to paste into their own shell, and one
 * of them is withheld on purpose.
 *
 * `orchestrator` writes `payload.merge` only when the operator's checkout is
 * clean; when it is dirty it writes `payload.mergeBlocked` instead and no merge
 * line at all, because a copyable command gets copied and this one would merge
 * on top of uncommitted work. Nothing enforces that but the ternary in this
 * component: `payload` is `Record<string, unknown>`, so a branch that reached
 * for the wrong key would render `undefined` rather than fail a typecheck, and
 * a branch that rendered both would look right in every screenshot.
 *
 * The rest pins the three-way split the payload's untyped shape invites — a
 * missing array, an empty one, and a populated one are three different renders
 * and `Array.isArray` is the only thing telling them apart.
 */

function handoffEvent(payload: Record<string, unknown>): RunEventDTO {
  return {
    runId: "run-1",
    ts: Date.UTC(2026, 7, 12, 10, 0),
    kind: "handoff",
    payload,
  };
}

test("renders nothing without a handoff event", () => {
  assert.equal(renderToStaticMarkup(<RunHandoff handoff={undefined} />), "");
});

test("a clean checkout gets the merge command", () => {
  const html = renderToStaticMarkup(
    <RunHandoff
      handoff={handoffEvent({
        commits: ["a1b2c3d Fix the retry path"],
        review: ["git diff main...uf/run-1"],
        merge: "git merge --no-ff uf/run-1",
      })}
    />,
  );
  assert.match(html, /git merge --no-ff uf\/run-1/);
  assert.match(html, /a1b2c3d Fix the retry path/);
  assert.match(html, /git diff main\.\.\.uf\/run-1/);
});

test("a dirty checkout gets the reason and no merge command anywhere", () => {
  const html = renderToStaticMarkup(
    <RunHandoff
      handoff={handoffEvent({
        commits: ["a1b2c3d Fix the retry path"],
        review: ["git diff main...uf/run-1"],
        mergeBlocked: "Your checkout has uncommitted changes.",
        uncommitted: ["src/lib/orchestrator.ts"],
      })}
    />,
  );
  assert.match(html, /Your checkout has uncommitted changes\./);
  // The whole point of the branch: not merely "the merge line is absent", but
  // that no pasteable merge reached the page by any other route.
  assert.doesNotMatch(html, /git merge/);
  assert.match(html, /Uncommitted changes left in the checkout\./);
});

test("no commits reads as a statement rather than an empty box", () => {
  const withEmpty = renderToStaticMarkup(
    <RunHandoff handoff={handoffEvent({ commits: [], merge: "git merge x" })} />,
  );
  const withMissing = renderToStaticMarkup(
    <RunHandoff handoff={handoffEvent({ merge: "git merge x" })} />,
  );
  assert.match(withEmpty, /The agent made no commits on this branch\./);
  // A payload that carries no `commits` key at all must read the same way — the
  // route omits the field rather than sending `[]`.
  assert.equal(withEmpty, withMissing);
});

test("an absent uncommitted list draws no warning", () => {
  const html = renderToStaticMarkup(
    <RunHandoff handoff={handoffEvent({ merge: "git merge x", uncommitted: [] })} />,
  );
  assert.doesNotMatch(html, /Uncommitted changes left in the checkout/);
});
