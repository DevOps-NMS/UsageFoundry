"use client";

import { useEffect, useState } from "react";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";

export type Theme = "system" | "light" | "dark";

/** Read by the pre-paint script in layout.tsx as well — keep them in step. */
export const THEME_STORAGE_KEY = "uf-theme";

/**
 * All three at once, in the order macOS lists them, rather than a button that
 * cycles. A cycling control makes the current state readable only from a
 * tooltip and the next state guessable only by pressing it — and with three
 * states, reaching the one you want costs up to two presses and a re-read.
 *
 * Glyphs rather than words: this sits in the header beside seven nav links, and
 * "Light Dark Match system" is wider than the app's name. The labels are still
 * the accessible names — see SegmentedControl's `labels`.
 */
const OPTIONS: readonly SegmentedOption<Theme>[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "Match system", icon: "display" },
];

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

  return (
    <SegmentedControl
      options={OPTIONS}
      value={theme}
      onChange={apply}
      label="Appearance"
      labels="hidden"
    />
  );
}
