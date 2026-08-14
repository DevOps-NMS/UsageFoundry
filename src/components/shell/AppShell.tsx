"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { QuickOpen } from "@/components/shell/QuickOpen";
import { PANES } from "@/components/shell/panes";
import { Sidebar, readCollapsed, writeCollapsed } from "@/components/shell/Sidebar";
import { Toolbar } from "@/components/shell/Toolbar";
import {
  isCommitChord,
  isPlainCommandChord,
  isTextEntry,
} from "@/components/shell/shortcuts";

/**
 * The window: a source list on the left, a toolbar and a scrolling content
 * pane on the right.
 *
 * It replaces a 1180px column centred in the viewport, which is what a page in
 * a browser looks like. A Mac app fills the window it was given, and the two
 * halves scroll independently — the sidebar stays put while a run log runs off
 * the bottom of the pane beside it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  // Mirrors the attribute the pre-paint script in layout.tsx already set, so
  // the toggle can announce `aria-expanded`. The server and the first client
  // paint both say "expanded"; the effect corrects it a frame later, which is
  // invisible because it moves nothing — the *width* came off the attribute
  // before this component existed.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);

  const [quickOpen, setQuickOpen] = useState(false);

  // There is nowhere to go from the login screen: every pane bounces straight
  // back to it, and the quick-open sheet is not rendered there at all.
  const chromeless = pathname === "/login";

  /**
   * The app's one keyboard listener.
   *
   * ⌘1…⌘8 for the panes and ⌘K for quick open, and nothing else — every chord
   * here is either the app's or the browser's, never both. ⌘R, ⌘L, ⌘T and ⌘W
   * are the browser's and are never looked at; the modifier test in
   * `isPlainCommandChord` is what keeps ⌘⇧K and Ctrl+1 out of range as well.
   *
   * Esc is not bound. The quick-open sheet is a native `<dialog>`, so the
   * browser already closes it on Esc and routes that through `onDismiss` —
   * a second handler for the same key would be two things racing to close one
   * sheet.
   */
  useEffect(() => {
    if (chromeless) return;
    function onKeyDown(e: KeyboardEvent) {
      // Nothing is intercepted while someone is typing. ⌘↩ is the documented
      // exception and this layer binds it to nothing, which is the point: a
      // page's own commit chord can never be swallowed here.
      if (isTextEntry(e.target) && !isCommitChord(e)) return;
      if (!isPlainCommandChord(e)) return;

      if (e.key === "k") {
        e.preventDefault();
        setQuickOpen(true);
        return;
      }
      const pane = PANES.find((p) => p.shortcut === e.key);
      if (pane) {
        e.preventDefault();
        // The sheet is modal, so it would otherwise stay lying over whichever
        // pane just arrived underneath it.
        setQuickOpen(false);
        router.push(pane.href);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, chromeless]);

  function toggleSidebar() {
    const next = !readCollapsed();
    writeCollapsed(next);
    setCollapsed(next);
  }

  // The login page keeps `main` so the skip link still has its target, and
  // nothing else — there is no session behind it to navigate with.
  if (chromeless) {
    return <main id="main">{children}</main>;
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          sidebarCollapsed={collapsed}
          onToggleSidebar={toggleSidebar}
          onQuickOpen={() => setQuickOpen(true)}
        />
        {/* The pane's own scroll region. A `sticky bottom-0` bar inside a page
            now sticks to the bottom of this rather than of the document, which
            is where it was always meant to be. */}
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {/* px-4 / sm:px-5 is the gutter two pages already reach through with
              a matching negative margin — keep the pair in step.

              A flex column of at least the pane's own height, which is how a
              page says "fill what is left" without naming a number. A `vh`
              figure cannot: the pane is the window less the toolbar less this
              padding less whatever heading stands above the box, so every
              62vh/68vh box here hung past the bottom edge and gave the pane a
              scrollbar whose whole travel was empty. `min-h-full` rather than
              `h-full` is what keeps a page longer than the pane growing
              exactly as before — free space is never negative, so nothing
              shrinks either. */}
          <div className="flex min-h-full flex-col px-4 pt-5 pb-12 sm:px-5">
            {children}
          </div>
        </main>
      </div>
      <QuickOpen open={quickOpen} onDismiss={() => setQuickOpen(false)} />
    </div>
  );
}
