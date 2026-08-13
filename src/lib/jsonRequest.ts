/**
 * One request to this app's own API, whose failures are values rather than
 * throws.
 *
 * `chatRequest` was extracted for this reason and for one page; the same defect
 * was in the branches page's three destructive controls and in the land card's
 * poll, so the mechanism lives here and `chatRequest` is a thin caller of it.
 * `fetch` rejects on a server restarting, a dropped connection, a proxy blip,
 * and a handler that calls it unguarded reports nothing at all: the rejection
 * escapes an `onClick` or a `void load()`, the `finally` re-enables the button,
 * and the page is left exactly as it was — which is what a press that did
 * nothing also looks like. Folding the failure into the result is what puts it
 * on the same branch as a refusal the server explained, the branch the caller
 * already renders.
 *
 * `status` is the split the callers need and the reason this is not just
 * `chatRequest` with a wider body type: `null` is nobody answered, a number is
 * somebody refused. A poll turns that into `pollFailureMessage(status, error)`
 * — the wording every page here already uses — and a mutating press turns it
 * into `actionFailureMessage` below.
 *
 * A 2xx whose body will not parse is reported as a failure too. The land card
 * read `await res.json()` unguarded, so such an answer threw out of a `void
 * load()` and left the previous snapshot on screen with nothing said.
 *
 * `error: null` means the response carried no message of its own. The caller
 * supplies that sentence, because that copy belongs beside the button that
 * failed.
 */
export type JsonFailure = {
  ok: false;
  /** `null` when the request never got an answer at all. */
  status: number | null;
  error: string | null;
};

export type JsonResult<T> = { ok: true; data: T } | JsonFailure;

export async function jsonRequest<T>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<JsonResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
      // Every read through here is a poll of state that moves under the page.
      cache: "no-store",
      ...(init?.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(init.body),
          }),
    });
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Parsed before the status is looked at: a 500 carries no JSON, and letting
  // that throw would report a reachable server as an unreachable one.
  const body: unknown = await res.json().then(
    (value: unknown) => value,
    () => null,
  );
  const explained =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;

  if (!res.ok) return { ok: false, status: res.status, error: explained };
  if (typeof body !== "object" || body === null) {
    return { ok: false, status: res.status, error: "the answer was not JSON" };
  }
  return { ok: true, data: body as T };
}

/**
 * What a button says when the press did not go through.
 *
 * `pollFailureMessage`'s counterpart for the other half of a page: that one
 * ends in "this page has stopped refreshing", which is the wrong thing to tell
 * someone who just pressed Purge. A request that never reached the server may
 * still have been carried out — the response is what was lost, not necessarily
 * the work — and on this app's three destructive controls that is the sentence
 * that matters, since nothing re-sends it and a second press might land a
 * second time.
 *
 * A refusal the server explained is passed through untouched: it already knows
 * why, in words written next to the check that refused.
 */
export function actionFailureMessage(failure: JsonFailure, fallback: string): string {
  if (failure.status === null) {
    return `The request did not reach the server — ${failure.error}. It may or may not have been carried out, so check before trying again.`;
  }
  if (failure.error) return failure.error;
  // The one failure the operator can clear themselves, and `middleware.ts`
  // answers `/api/*` with it rather than a redirect, so nothing else on screen
  // would say the session had lapsed.
  if (failure.status === 401) return "Signed out — sign in again, then try that again.";
  return fallback;
}
