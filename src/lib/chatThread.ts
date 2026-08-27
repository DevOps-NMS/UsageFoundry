import type { ChatMessageDTO, ChatQuestionDTO } from "./apiTypes";

/**
 * One thing the chat page draws in the transcript.
 *
 * A questions item holds every question asked by one turn, in the order the
 * model wrote them, because that is how they are asked and how they are
 * settled — `answerChatQuestions` sends one message for the set and supersedes
 * whatever it did not name.
 */
export type ThreadItem =
  | { kind: "message"; message: ChatMessageDTO }
  | { kind: "questions"; questions: ChatQuestionDTO[] };

/**
 * The transcript with the chat's questions put back where they were asked.
 *
 * Pure and unit-tested, and the failure it exists against is silent in the
 * worst direction there is: a question the page never draws is a thread that
 * sits waiting for an operator who was never shown anything to answer, on a
 * page that looks entirely normal — no error, no empty state, nothing in the
 * console. The tail append is what makes that unreachable, and it is what the
 * test pins first.
 *
 * **A question is drawn before the operator's next message, not at its own
 * timestamp.** `ask_operator` records the row *during* the turn, so the
 * question's `createdAt` is minutes earlier than the reply that turn ends with
 * — placed by timestamp alone the card would sit above the sentence explaining
 * why it was being asked. Everything between the question and the operator's
 * next message is the rest of that turn, so the operator's next message is the
 * boundary: a pending question lands at the foot of the thread where the
 * composer is, and an answered one lands directly above the message that
 * carried the answer, which is what makes the pair read as asked-and-answered
 * rather than as a card that vanished.
 *
 * The comparison is **strict**, and that is the one part of this worth stating.
 * A question created in the same millisecond as a user message is the one that
 * message provoked — `sendChatMessage` appends the message and only then spawns
 * the child that asks — so `<=` would draw a question above the message that
 * caused it every time the two landed on one tick.
 *
 * `questions` must arrive oldest first, which is what `listQuestions` orders by
 * and what the DTO carries; nothing here re-sorts, because a page that sorted
 * would be a second opinion about an order the database already decides.
 */
export function threadItems(
  messages: readonly ChatMessageDTO[],
  questions: readonly ChatQuestionDTO[],
): ThreadItem[] {
  const items: ThreadItem[] = [];
  let next = 0;

  for (const message of messages) {
    if (message.role === "user") {
      const asked: ChatQuestionDTO[] = [];
      while (next < questions.length && questions[next].createdAt < message.ts) {
        asked.push(questions[next]);
        next += 1;
      }
      if (asked.length > 0) items.push({ kind: "questions", questions: asked });
    }
    items.push({ kind: "message", message });
  }

  // Everything still open, and everything a turn asked after the last message
  // the operator sent. Never dropped: this is the branch that runs on the only
  // shape that matters, a question nobody has answered yet.
  if (next < questions.length) {
    items.push({ kind: "questions", questions: questions.slice(next) });
  }
  return items;
}
