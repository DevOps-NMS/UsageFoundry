"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, readCollapsed, writeCollapsed } from "@/components/shell/Sidebar";
import { Toolbar } from "@/components/shell/Toolbar";

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

  // Mirrors the attribute the pre-paint script in layout.tsx already set, so
  // the toggle can announce `aria-expanded`. The server and the first client
  // paint both say "expanded"; the effect corrects it a frame later, which is
  // invisible because it moves nothing — the *width* came off the attribute
  // before this component existed.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);

  function toggleSidebar() {
    const next = !readCollapsed();
    writeCollapsed(next);
    setCollapsed(next);
  }

  // The login page is the one screen with nothing to navigate to: no session,
  // no panes, and a single field. It keeps `main` so the skip link still has
  // its target.
  if (pathname === "/login") {
    return <main id="main">{children}</main>;
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar sidebarCollapsed={collapsed} onToggleSidebar={toggleSidebar} />
        {/* The pane's own scroll region. A `sticky bottom-0` bar inside a page
            now sticks to the bottom of this rather than of the document, which
            is where it was always meant to be. */}
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {/* px-4 / sm:px-5 is the gutter two pages already reach through with
              a matching negative margin — keep the pair in step. */}
          <div className="px-4 pt-5 pb-12 sm:px-5">{children}</div>
        </main>
      </div>
    </div>
  );
}
