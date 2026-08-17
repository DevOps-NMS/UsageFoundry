import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  extractLoginUrl,
  normalizeCode,
  parseAuthStatus,
} from "./claudeAuth";

/**
 * Three parsers reading another program's console output, captured from the
 * pinned CLI rather than read from any spec — the same footing as the
 * `stream-json` parser and the OTLP shapes, and the same reason for tests:
 * every way each one can go wrong is silent, and two of them point the wrong
 * way.
 *
 * A URL this fails to find is a Sign in button that opens nothing, and the
 * operator's only evidence is that pressing it did not work. A status shape
 * that stops parsing renders as *signed out* unless the parser insists on the
 * field it keys off, which would put a Sign in button in front of somebody who
 * is already signed in and a Sign out button nowhere. And a code carrying a
 * newline answers the CLI's prompt with its first half and whatever the CLI
 * asks next with its second — the one place a pasted value reaches a child
 * process, so the one place a paste can mean two things.
 */

/** `claude auth login`, stdout, pipes — what the server actually reads. */
const LOGIN_PIPED = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=v51p27kLpQ0P2RkpczX5ORwN68Yxf9jhMMFVeLSijdc&code_challenge_method=S256&state=HwKeHYwuw3Ntm5XUxqw30mAh5oP2OEzUYNu2F9cRfD4",
  "Paste code here if prompted > ",
].join("\n");

const AUTHORIZE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=v51p27kLpQ0P2RkpczX5ORwN68Yxf9jhMMFVeLSijdc&code_challenge_method=S256&state=HwKeHYwuw3Ntm5XUxqw30mAh5oP2OEzUYNu2F9cRfD4";

/**
 * The same line under a tty, where the CLI wraps the URL in an OSC 8 hyperlink
 * and so prints it twice — once as the escape's payload, once as the visible
 * label. We spawn with pipes, so this is defence against a CLI that decides
 * otherwise rather than a shape seen in production; it is here because the
 * payload copy ends at a control character, and a stripper that missed the
 * escape would hand the browser a URL truncated at `ESC`.
 */
const LOGIN_HYPERLINKED =
  "If the browser didn't open, visit: " +
  `\u001B]8;;${AUTHORIZE_URL}\u001B\\${AUTHORIZE_URL}\u001B]8;;\u001B\\`;

describe("extractLoginUrl", () => {
  it("finds the authorize URL in what the CLI prints down a pipe", () => {
    assert.equal(extractLoginUrl(LOGIN_PIPED), AUTHORIZE_URL);
  });

  it("takes the label rather than the escape's payload under a tty", () => {
    assert.equal(extractLoginUrl(LOGIN_HYPERLINKED), AUTHORIZE_URL);
  });

  it("has nothing to report before the URL is printed", () => {
    assert.equal(extractLoginUrl("Opening browser to sign in…\n"), null);
    assert.equal(extractLoginUrl(""), null);
  });

  /**
   * The one case worth a check rather than a comment: this string is rendered
   * as the link an operator is asked to enter Anthropic credentials on, so a
   * URL from anywhere else is refused outright and the caller reports the raw
   * line instead of presenting it.
   */
  it("refuses a URL that is not Anthropic's", () => {
    assert.equal(
      extractLoginUrl("visit: https://claude.com.evil.test/oauth/authorize"),
      null,
    );
    assert.equal(extractLoginUrl("visit: http://claude.com/oauth"), null);
  });

  it("skips a foreign URL to reach the real one", () => {
    const url = extractLoginUrl(
      `docs: https://example.test/help\nvisit: ${AUTHORIZE_URL}`,
    );
    assert.equal(url, AUTHORIZE_URL);
  });
});

describe("parseAuthStatus", () => {
  it("reads a signed-in subscription", () => {
    const res = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "someone@example.test",
        orgId: "8e6be016-61f3-4138-b979-eb6ff8efa2ef",
        orgName: "NMS",
        subscriptionType: "team",
      }),
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok && res.value, {
      loggedIn: true,
      method: "claude.ai",
      email: "someone@example.test",
      organization: "NMS",
      plan: "team",
      apiKeySource: null,
    });
  });

  it("reads a signed-out container", () => {
    const res = parseAuthStatus(
      '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value.loggedIn, false);
    assert.equal(res.ok && res.value.email, null);
  });

  /**
   * An `ANTHROPIC_API_KEY` in the environment reaches every work cycle, and the
   * CLI reports it as logged in with no identity at all. Carrying
   * `apiKeySource` through is what lets the page say which credential runs will
   * actually bill against, rather than showing a subscription nothing uses.
   */
  it("carries the API key source that outranks the login", () => {
    const res = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        apiKeySource: "ANTHROPIC_API_KEY",
        email: null,
        orgId: null,
        orgName: null,
        subscriptionType: null,
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value.apiKeySource, "ANTHROPIC_API_KEY");
    assert.equal(res.ok && res.value.email, null);
  });

  it("parses past a warning line printed before the object", () => {
    const res = parseAuthStatus(
      'npm warn deprecated something\n{"loggedIn":false,"authMethod":"none"}',
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value.loggedIn, false);
  });

  /**
   * The silent-and-wrong-way case. A CLI that renames `loggedIn` must not read
   * as signed out — that is a Sign in button in front of somebody already
   * signed in, and a Sign out button they can no longer reach.
   */
  it("refuses a shape it does not recognise rather than reading it as signed out", () => {
    for (const raw of [
      '{"authenticated":true}',
      "{}",
      "null",
      "[]",
      "command not found: claude",
      "",
    ]) {
      const res = parseAuthStatus(raw);
      assert.equal(res.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
    }
  });
});

describe("normalizeCode", () => {
  it("accepts a pasted code with the whitespace a paste picks up", () => {
    const res = normalizeCode("  abc123#state-value\n");
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value, "abc123#state-value");
  });

  /**
   * The CLI reads one line from stdin. A value with an interior newline would
   * answer this prompt and the next one, so it is refused rather than trimmed
   * to its first line — a paste that captured surrounding text is a mistake to
   * report, not one to silently reinterpret.
   */
  it("refuses a value carrying an interior newline", () => {
    assert.equal(normalizeCode("abc123\nyes").ok, false);
    assert.equal(normalizeCode("abc 123").ok, false);
  });

  it("refuses nothing, and refuses what cannot be a code", () => {
    assert.equal(normalizeCode("").ok, false);
    assert.equal(normalizeCode("   ").ok, false);
    assert.equal(normalizeCode(undefined).ok, false);
    assert.equal(normalizeCode(42).ok, false);
    assert.equal(normalizeCode("x".repeat(513)).ok, false);
  });
});
