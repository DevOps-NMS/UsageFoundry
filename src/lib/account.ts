import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { CLAUDE_CONFIG_DIR } from "./config";

/**
 * Which Claude subscription the transcripts we are reading belong to.
 *
 * Claude Code records the signed-in account beside its own state. Nothing here
 * yields a numeric ceiling — Anthropic publishes none, and a tier name like
 * `default_claude_max_20x` maps to no published figure — so this only ever
 * *names* the plan. A dashboard that says "Claude Max 20x · no ceiling
 * set" is honest about two different unknowns, whereas one that says nothing
 * leaves the user guessing which account they are even looking at.
 *
 * Every read is best-effort. Both files are undocumented internals of another
 * program: they are created lazily (this machine had neither at 20:26 and both
 * at 20:47), they are mode 0600, macOS may keep credentials in the Keychain
 * instead, and their shape can change on any CLI release. A failure here must
 * never be visible as anything other than "plan unknown".
 */

export interface AccountProfile {
  /** e.g. "max", "pro", "team". Null when it cannot be determined. */
  subscriptionType: string | null;
  /** e.g. "default_claude_max_20x". Names a tier; implies no number. */
  rateLimitTier: string | null;
  /** Human-facing rendering, e.g. "Claude Max 20x". */
  label: string | null;
  /**
   * Short digest of the account identifier — enough to notice that the home
   * directory being scanned has changed hands, without carrying the UUID or
   * the email address across the wire.
   */
  fingerprint: string | null;
  /** Which file answered, for the settings page to report. */
  source: "credentials" | "profile" | null;
}

export const UNKNOWN_ACCOUNT: AccountProfile = {
  subscriptionType: null,
  rateLimitTier: null,
  label: null,
  fingerprint: null,
  source: null,
};

/**
 * Candidate locations, most authoritative first.
 *
 * `.credentials.json` is preferred because it carries the tier with no name,
 * email, or UUID beside it. `.claude.json` is the fallback, and exists both
 * inside the config directory and at the older `~/.claude.json`.
 *
 * That last one is consulted *only* when the config directory is still the
 * default. Once someone has redirected `CLAUDE_HOME` or `CLAUDE_CONFIG_DIR` —
 * pointing this app at a copied or another machine's transcript tree — the
 * home-directory file describes whoever is logged in here, not the account
 * that produced those transcripts. Reporting it would put a confident wrong
 * plan name on the dashboard, which is worse than reporting none.
 */
function candidates(): string[] {
  const home = os.homedir();
  const defaultDir = path.join(home, ".claude");
  const files = [
    path.join(CLAUDE_CONFIG_DIR, ".credentials.json"),
    path.join(CLAUDE_CONFIG_DIR, ".claude.json"),
  ];
  if (path.resolve(CLAUDE_CONFIG_DIR) === path.resolve(defaultDir)) {
    files.push(path.join(home, ".claude.json"));
  }
  return files;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function digest(v: unknown): string | null {
  const s = str(v);
  return s ? createHash("sha256").update(s).digest("hex").slice(0, 8) : null;
}

/**
 * "default_claude_max_20x" -> "Claude Max 20x"; "max" -> "Max".
 *
 * Deliberately keeps the digits rather than prettifying them away: "20x" is
 * the only part a user recognises from their billing page.
 */
function planLabel(tier: string | null, subscription: string | null): string | null {
  const raw = tier ?? subscription;
  if (!raw) return null;
  const words = raw
    .replace(/^default[_-]/, "")
    .split(/[_-]/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function parse(file: string, raw: unknown): AccountProfile | null {
  const root = (raw ?? {}) as Record<string, unknown>;

  // .credentials.json — { claudeAiOauth: { subscriptionType, rateLimitTier } }
  const oauth = root.claudeAiOauth as Record<string, unknown> | undefined;
  if (oauth) {
    const subscriptionType = str(oauth.subscriptionType);
    const rateLimitTier = str(oauth.rateLimitTier);
    if (!subscriptionType && !rateLimitTier) return null;
    return {
      subscriptionType,
      rateLimitTier,
      label: planLabel(rateLimitTier, subscriptionType),
      // No stable identifier lives in this file, so switch detection falls to
      // the profile file. Absence is reported rather than faked.
      fingerprint: null,
      source: "credentials",
    };
  }

  // .claude.json — { oauthAccount: { organizationType, organizationRateLimitTier, … } }
  const account = root.oauthAccount as Record<string, unknown> | undefined;
  if (account) {
    const subscriptionType = str(account.organizationType);
    const rateLimitTier =
      str(account.organizationRateLimitTier) ?? str(account.userRateLimitTier);
    if (!subscriptionType && !rateLimitTier) return null;
    return {
      subscriptionType,
      rateLimitTier,
      label: planLabel(rateLimitTier, subscriptionType),
      fingerprint: digest(account.accountUuid ?? account.organizationUuid),
      source: "profile",
    };
  }

  void file;
  return null;
}

interface CacheEntry {
  at: number;
  value: AccountProfile;
}

const cache = ((globalThis as unknown as { __ufAccount?: { v?: CacheEntry } })
  .__ufAccount ??= {});

/**
 * Cached for a minute, misses included. The files appear the first time the
 * CLI writes them, so caching "absent" for the process lifetime would leave
 * the plan permanently unknown on a machine that signs in after boot.
 */
const TTL_MS = 60_000;

export async function readAccountProfile(
  now = Date.now(),
): Promise<AccountProfile> {
  const hit = cache.v;
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let value: AccountProfile = UNKNOWN_ACCOUNT;
  for (const file of candidates()) {
    try {
      const parsed = parse(file, JSON.parse(await fs.readFile(file, "utf8")));
      if (parsed) {
        value = parsed;
        break;
      }
    } catch {
      // Missing, unreadable, mid-write, or a shape we do not recognise. Try
      // the next candidate; never surface it.
    }
  }

  cache.v = { at: now, value };
  return value;
}

/** Drop the cache — used by tests and after a settings change. */
export function invalidateAccountProfile(): void {
  cache.v = undefined;
}
