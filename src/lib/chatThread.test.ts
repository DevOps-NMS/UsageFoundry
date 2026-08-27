import { strict as assert } from "node:assert";
import { test } from "node:test";
import { threadItems } from "./chatThread";
import type { ChatMessageDTO, ChatQuestionDTO } from "./apiTypes";

/**
 * Where a question is drawn in the transcript.
 *
 * It earns a test on the grounds the other three question functions do — every
 * way of getting it wrong produces a *page* rather than an error — and the
 * worst of them is silent in the direction no other surface here can be: a
 * question that is never drawn leaves the thread waiting for an answer to
 * something the operator was never shown, with nothing on screen saying so.
 * Nothing throws, nothing fails to typecheck, and the chat reads as idle.
 *
 * The rest of the cases pin the pairing the panel is built on: an answered
 * question sits directly above the message that carried the answer, and a
 * pending one sits at the foot of the thread beside the composer.
 */

function msg(
  id: string,
  role: ChatMessageDTO["role"],
  ts: number,
): ChatMessageDTO {
  return { id, ts, role, text: id };
}

function question(id: string, createdAt: number): ChatQuestionDTO {
  return {
    id,
    createdAt,
    question: id,
    choices: [],
    allowText: true,
    status: "pending",
    answer: null,
    answeredAt: null,
  };
}

/** Ids in render order, a question item as the ids it holds. */
function order(items: ReturnType<typeof threadItems>): string[] {
  return items.map((item) =>
    item.kind === "message"
      ? item.message.id
      : `[${item.questions.map((q) => q.id).join(",")}]`,
  );
}

test("a question nobody has answered is drawn, at the foot of the thread", () => {
  const items = threadItems(
    [msg("ask", "user", 1_000), msg("reply", "assistant", 3_000)],
    [question("q1", 2_000)],
  );
  assert.deepEqual(order(items), ["ask", "reply", "[q1]"]);
});

test("a question outlives a thread with no messages at all", () => {
  // Reachable: the first turn of a chat can ask before it has replied, and a
  // turn that dies leaves the row behind. Dropped here, the chat waits for ever.
  const items = threadItems([], [question("q1", 2_000)]);
  assert.deepEqual(order(items), ["[q1]"]);
});

test("an answered question is drawn directly above the message answering it", () => {
  const items = threadItems(
    [
      msg("ask", "user", 1_000),
      msg("reply", "assistant", 3_000),
      msg("answer", "user", 9_000),
      msg("proposal", "assistant", 11_000),
    ],
    [question("q1", 2_000)],
  );
  assert.deepEqual(order(items), ["ask", "reply", "[q1]", "answer", "proposal"]);
});

test("questions asked by one turn stay one item, in the order asked", () => {
  // They share a `created_at` — `createQuestions` takes one `now` for the call
  // — so only the arrival order tells them apart, and the answer message quotes
  // them back in it.
  const items = threadItems(
    [msg("ask", "user", 1_000), msg("reply", "assistant", 3_000)],
    [question("q1", 2_000), question("q2", 2_000), question("q3", 2_000)],
  );
  assert.deepEqual(order(items), ["ask", "reply", "[q1,q2,q3]"]);
});

test("two turns' questions land at their own messages, never merged", () => {
  const items = threadItems(
    [
      msg("ask", "user", 1_000),
      msg("reply", "assistant", 3_000),
      msg("answer", "user", 9_000),
      msg("second", "assistant", 13_000),
      msg("again", "user", 19_000),
    ],
    [question("q1", 2_000), question("q2", 11_000)],
  );
  assert.deepEqual(order(items), [
    "ask",
    "reply",
    "[q1]",
    "answer",
    "second",
    "[q2]",
    "again",
  ]);
});

test("a question is never drawn above the message that provoked it", () => {
  // The strict comparison. `sendChatMessage` appends the message and only then
  // spawns the child that asks, so the two can land on one millisecond — and a
  // `<=` here would put the card above the sentence it is answering.
  const items = threadItems(
    [msg("ask", "user", 1_000), msg("reply", "assistant", 3_000)],
    [question("q1", 1_000)],
  );
  assert.deepEqual(order(items), ["ask", "reply", "[q1]"]);
});

test("an assistant or system message never separates a question from its answer", () => {
  // Only a *user* message closes the placement, because everything between the
  // question and the operator's next message is the rest of the turn that asked
  // — including the failure notice a turn that died leaves behind.
  const items = threadItems(
    [
      msg("ask", "user", 1_000),
      msg("failed", "system", 4_000),
      msg("answer", "user", 9_000),
    ],
    [question("q1", 2_000)],
  );
  assert.deepEqual(order(items), ["ask", "failed", "[q1]", "answer"]);
});

test("no questions is the transcript unchanged", () => {
  const messages = [msg("ask", "user", 1_000), msg("reply", "assistant", 3_000)];
  assert.deepEqual(order(threadItems(messages, [])), ["ask", "reply"]);
});
