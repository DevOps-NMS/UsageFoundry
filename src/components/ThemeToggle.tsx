"use client";

import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

/** Read by the pre-paint script in layout.tsx as well — keep them in step. */
export const THEME_STORAGE_KEY = "uf-theme";

const ORDER: Theme[] = ["system", "light", "dark"];

const LABEL: Record<Theme, string> = {
  system: "Match system",
  light: "Light",
  dark: "Dark",
};

/**
 * Drawn rather than typed. The three states used to be the characters ◐ ☀ ☾,
 * which are at the mercy of whichever font on the machine happens to carry
 * them — they arrive at different sizes, on different baselines, and on some
 * systems as an emoji in full colour. These are 16px, aligned, and take the
 * button's own text colour through every one of its states.
 */
const ICON: Record<Theme, React.ReactElement> = {
  system: (
    <>
      <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2.75a5.25 5.25 0 0 0 0 10.5Z" fill="currentColor" />
    </>
  ),
  light: (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" />
    </g>
  ),
  dark: <path d="M13.3 10.1A5.7 5.7 0 0 1 5.9 2.7a5.7 5.7 0 1 0 7.4 7.4Z" fill="currentColor" />,
};

/**
 * Three states, not two. "System" is the default and has to stay reachable:
 * the token layer expresses it as the *absence* of a data-theme attribute, so
 * a two-way toggle would make it unreachable once the user touched the
 * control even once.
 */
export function ThemeToggle() {
  // Always renders "system" on the server and on the first client paint. The
  // pre-paint script has already set the attribute by then, so the DOM is
  // correct; this only catches the state up so the label matches.
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    if (next === "system") {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  }

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];

  return (
    <button
      type="button"
      onClick={() => apply(next)}
      // A border, because the glyph alone was the entire affordance: nothing on
      // screen said this was a control until it was clicked. It is the same
      // resting outline a secondary button wears, at icon-button size.
      className="ui-transition inline-flex h-[var(--control-h)] w-[var(--control-h)] cursor-pointer items-center justify-center rounded-sm border border-line bg-transparent text-ink-muted hover:border-line-strong hover:bg-surface hover:text-ink active:shadow-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      // The visible glyph is decorative; the label is what carries the state.
      title={`Theme: ${LABEL[theme]} — switch to ${LABEL[next]}`}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}.`}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden focusable="false">
        {ICON[theme]}
      </svg>
    </button>
  );
}
