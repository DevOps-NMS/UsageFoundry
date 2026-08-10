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
      className="rounded-sm border border-transparent bg-transparent p-0 px-2.5 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface hover:text-ink"
      // The visible glyph is decorative; the label is what carries the state.
      title={`Theme: ${LABEL[theme]} — switch to ${LABEL[next]}`}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}.`}
    >
      <span aria-hidden>
        {theme === "system" ? "◐" : theme === "light" ? "☀" : "☾"}
      </span>
    </button>
  );
}
