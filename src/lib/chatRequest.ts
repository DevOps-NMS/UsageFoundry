import type { ChatDTO } from "./apiTypes";

/**
 * One mutating request from the chat page — sending a turn, deciding proposals.
 *
 * It is a module of its own for one reason: `busy` on that page gates the
 * composer, Approve, Reject and Select-all together, nothing else on the page
 * clears it, and both handlers set it around a request. That makes how this
 * request *ends* worth a test, and `tsconfig.test.json` compiles `src/lib` —
 * a page under `src/app` imports through the `@/` alias, which nothing rewrites
 * at runtime.
 *
 * `error: null` means the response carried no message of its own. The caller
 * supplies the sentence, because that copy belongs beside the button that
 * failed.
 */
export type ChatRequestResult =
  | { ok: true; chat?: ChatDTO }
  | { ok: false; error: string | null };

export async function chatRequest(
  url: string,
  body: unknown,
): Promise<ChatRequestResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    chat?: ChatDTO;
    error?: string;
  };
  if (!res.ok) return { ok: false, error: data.error ?? null };
  return { ok: true, chat: data.chat };
}
