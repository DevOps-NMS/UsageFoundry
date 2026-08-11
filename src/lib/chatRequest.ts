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
 * It returns a transport failure rather than throwing it for the same reason.
 * `fetch` rejects on a server restarting, a dropped connection, a proxy blip;
 * the handlers called it unguarded, so the rejection escaped the `void send()`
 * that invoked them and every button on the page stayed disabled until a
 * reload, with nothing said about why. Folding it into the result is what puts
 * that failure on the same branch as a refusal the server explained — the
 * branch the caller already reports.
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
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const data = (await res.json().catch(() => ({}))) as {
    chat?: ChatDTO;
    error?: string;
  };
  if (!res.ok) return { ok: false, error: data.error ?? null };
  return { ok: true, chat: data.chat };
}
