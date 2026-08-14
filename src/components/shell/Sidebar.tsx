"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { PANES, activePane } from "@/components/shell/panes";

/** Read by the pre-paint script in layout.tsx as well — keep them in step. */
export const SIDEBAR_STORAGE_KEY = "uf.sidebar";
export const SIDEBAR_COLLAPSED = "collapsed";

/**
 * Whether the rail is showing, read off the element the pre-paint script wrote.
 *
 * The DOM attribute is the source of truth rather than a React state seeded
 * from storage, because the width has to be settled before the first paint —
 * see the note beside `[data-sidebar]` in globals.css. React mirrors it so the
 * toggle can announce `aria-expanded`, and writes both on a press.
 */
export function readCollapsed(): boolean {
  return document.documentElement.dataset.sidebar === SIDEBAR_COLLAPSED;
}

export function writeCollapsed(collapsed: boolean): void {
  const root = document.documentElement;
  if (collapsed) root.dataset.sidebar = SIDEBAR_COLLAPSED;
  else delete root.dataset.sidebar;
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_STORAGE_KEY, SIDEBAR_COLLAPSED);
    else localStorage.removeItem(SIDEBAR_STORAGE_KEY);
  } catch {
    // Disabled storage, a quota, or a private window — the same treatment the
    // canvas gives its layout. The collapse still applies to this page load;
    // it just does not survive the next one.
  }
}

type RowState = "active" | "inactive";

/**
 * Complete class strings per state — never interpolated, for `Badge`'s reason.
 *
 * `active` is the macOS source-list selection: the accent fill and the label
 * colour the OS says goes on it, which is what --tint/--tint-fg are for.
 * Neither state changes a box dimension — the fill, the hover wash and the
 * pressed step are all backgrounds, and the focus ring comes from @layer base
 * and lives outside the box model.
 */
const ROW: Record<RowState, string> = {
  active: "bg-tint text-tint-fg hover:brightness-110 active:brightness-95",
  inactive: "text-ink hover:bg-fill-hover active:bg-fill-active",
};

/**
 * The window's source list: every pane the app has, always in the same order,
 * with the one you are on filled in.
 *
 * It replaces a wrapping row of seven pills above a 1180px column. The header
 * strip at the top is deliberately *not* a link home — Dashboard is the first
 * row and ⌘1 — which is what lets the whole strip be a drag region for an
 * installed window, where the traffic lights sit on top of it.
 */
export function Sidebar() {
  const pathname = usePathname();
  const active = activePane(pathname);

  return (
    <div className="flex h-full w-[var(--sidebar-w)] shrink-0 flex-col border-r border-line bg-inset">
      <div
        className="app-drag flex shrink-0 items-center gap-2 overflow-hidden px-3"
        style={{
          height: "max(var(--toolbar-h), env(titlebar-area-height, 0px))",
          // Under Window Controls Overlay this is where the traffic lights are
          // drawn, and `titlebar-area-x` is how far in the free area starts.
          // Zero in an ordinary tab. On a collapsed rail the reservation is
          // wider than the rail, so the mark is clipped away and the strip is
          // drag space and nothing else — which is the right trade at 56px.
          paddingLeft: "max(0.75rem, env(titlebar-area-x, 0px))",
        }}
      >
        <BrandMark />
        <span className="uf-sidebar-label truncate text-sm font-semibold tracking-tight text-ink">
          UsageFoundry
        </span>
      </div>

      <nav
        aria-label="Primary"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3"
      >
        <ul className="space-y-0.5">
          {PANES.map((pane) => {
            const current = pane === active;
            return (
              <li key={pane.href}>
                <Link
                  href={pane.href}
                  // The same computation that picks the fill, said so a screen
                  // reader gets it too.
                  aria-current={current ? "page" : undefined}
                  aria-keyshortcuts={`Meta+${pane.shortcut}`}
                  className={
                    "uf-sidebar-row ui-transition flex min-h-[var(--control-h)] " +
                    "items-center gap-2.5 rounded-[6px] px-2 text-sm no-underline " +
                    `hover:no-underline ${ROW[current ? "active" : "inactive"]}`
                  }
                >
                  <Icon name={pane.icon} />
                  <span className="uf-sidebar-label truncate">{pane.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/**
 * The same three rising bars as public/icon.svg, so the tab and the page agree.
 *
 * Drawn rather than filled with a gradient: a gradient here would be the one
 * thing on the page carrying no information, and the mark has to survive being
 * 22px on a light background and 22px on a dark one, which a two-hue ramp does
 * not. The tile is --tint, which is the operator's own accent where the browser
 * exposes it, and the bars are --tint-fg for the reason that pair exists.
 */
function BrandMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[22px] w-[22px] shrink-0"
      aria-hidden
      focusable="false"
    >
      <rect width="24" height="24" rx="6" className="fill-tint" />
      <g className="fill-tint-fg">
        <rect x="6" y="13" width="3" height="5" rx="1.5" />
        <rect x="10.5" y="9.5" width="3" height="8.5" rx="1.5" />
        <rect x="15" y="6" width="3" height="12" rx="1.5" />
      </g>
    </svg>
  );
}
