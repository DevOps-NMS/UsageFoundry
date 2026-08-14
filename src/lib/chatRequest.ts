import type { ChatDTO } from "./apiTypes";
import { jsonRequest } from "./jsonRequest";

/**
 * One mutating request from the chat page — sending a turn, deciding proposals,
 * stopping a turn that is not going to finish. The body is optional because the
 * cancel route reads none; the method stays POST either way, since `jsonRequest`
 * would otherwise infer GET from the absent body and that route answers 405.
 *
 * It is a module of its own for one reason: `busy` on that page gates the
 * composer, Approve, Reject and Select-all together, nothing else on the page
 * clears it, and both handlers set it around a request. That makes how this
 * request *ends* worth a test, and `tsconfig.test.json` compiles `src/lib` —
 * a page under `src/app` imports through the `@/` alias, which nothing rewrites
 * at runtime.
 *
 * How it ends is now `jsonRequest`'s job, because the same unguarded `fetch`
 * was in the branches page's three destructive controls and in the land card's
 * poll: a transport failure comes back as a value rather than a rejection, so
 * it lands on the same branch as a refusal the server explained — the branch
 * the caller already reports. What stays here is the chat's own shape, since
 * the page reads the thread straight off the answer.
 */
export type ChatRequestResult =
  | { ok: true; chat?: ChatDTO }
  | { ok: false; error: string | null };

export async function chatRequest(
  url: string,
  body?: unknown,
): Promise<ChatRequestResult> {
  const result = await jsonRequest<{ chat?: ChatDTO }>(url, {
    method: "POST",
    body,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, chat: result.data.chat };
}
