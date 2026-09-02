"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { PANES, activePane } from "@/components/shell/panes";

/** Read by the pre-paint script in layout.tsx as well — keep them in step. */
export const SIDEBAR_STORAGE_KEY = "uf.sidebar";
export const SIDEBAR_COLLAPSED = "collapsed";

/** What the toolbar's collapse button says it controls. */
export const SIDEBAR_ID = "uf-sidebar";

/** And what its mobile counterpart controls, which is a different element. */
export const SIDEBAR_DRAWER_ID = "uf-sidebar-drawer";

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
 * The two frames the same source list is drawn in.
 *
 * `docked` is a column of the window's flex row. `drawer` is the panel inside
 * the `<dialog>` below the shell's mobile breakpoint, where a 224px column of a
 * 390px window would leave the content pane 166px.
 */
export type SidebarVariant = "docked" | "drawer";

/**
 * Complete class strings per variant, for `ROW`'s reason.
 *
 * Both `display` and `width` are in here rather than split across the shared
 * string, because both differ per variant and a property set in two places
 * resolves by Tailwind's own sort order rather than by anything written down.
 *
 * The width is the load-bearing half. `docked` reads `--sidebar-w`, which
 * `[data-sidebar="collapsed"]` swaps for the 56px rail; `drawer` reads
 * `--sidebar-w-list`, which nothing swaps. The collapse is a *desktop* state,
 * settled before the first paint because the pane would otherwise jump 168px
 * into every page load — a drawer is closed on every page load and has nothing
 * to settle, so letting that attribute reach it would open a rail with its
 * labels off the screen for someone who has never seen a rail.
 */
const ROOT: Record<SidebarVariant, string> = {
  docked: "flex max-md:hidden h-full w-[var(--sidebar-w)] shrink-0",
  drawer: "flex h-full w-full",
};

/**
 * The two class names the collapse rules in globals.css key on, and the second
 * half of keeping that state out of the drawer.
 *
 * The width above is a variable the drawer can simply not read; the rail's
 * centred glyphs and its `sr-only` labels are descendant selectors from `:root`
 * and would reach anything on the page. So the drawer carries neither hook and
 * the rules have nothing to match — which is the same mechanism as a typed
 * variant prop, rather than a second selector added to undo the first.
 */
const COLLAPSE_ROW: Record<SidebarVariant, string> = {
  docked: "uf-sidebar-row",
  drawer: "",
};

const COLLAPSE_LABEL: Record<SidebarVariant, string> = {
  docked: "uf-sidebar-label",
  drawer: "",
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
export function Sidebar({
  variant = "docked",
  onNavigate,
}: {
  variant?: SidebarVariant;
  /**
   * Called when a destination is pressed. The drawer dismisses on it, including
   * on the row you are already standing on — a pathname effect would leave that
   * one press doing nothing at all.
   */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = activePane(pathname);

  return (
    <div
      // Only the docked list answers to the toolbar's collapse button; the
      // drawer is a different element with a different control, and two nodes
      // sharing one id is an aria-controls that points at either of them.
      id={variant === "docked" ? SIDEBAR_ID : undefined}
      className={`${ROOT[variant]} flex-col border-r border-line bg-inset`}
    >
      <div
        className="app-drag flex shrink-0 items-center gap-2 overflow-hidden px-3"
        style={{
          height: "var(--toolbar-actual)",
          // Under Window Controls Overlay this is where the traffic lights are
          // drawn, and `titlebar-area-x` is how far in the free area starts.
          // Zero in an ordinary tab. On a collapsed rail the reservation is
          // wider than the rail, so the mark is clipped away and the strip is
          // drag space and nothing else — which is the right trade at 56px.
          paddingLeft: "max(0.75rem, env(titlebar-area-x, 0px))",
        }}
      >
        <BrandMark />
        <span
          className={`${COLLAPSE_LABEL[variant]} truncate text-sm font-semibold tracking-tight text-ink`}
        >
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
                  // Absent past the ninth row: `panes.ts` has nine digits and
                  // a tenth destination. Unguarded, this announced a shortcut
                  // that does not exist — `Meta+undefined` — to a screen reader.
                  aria-keyshortcuts={pane.shortcut ? `Meta+${pane.shortcut}` : undefined}
                  onClick={onNavigate}
                  className={
                    `${COLLAPSE_ROW[variant]} ui-transition flex min-h-[var(--control-h)] ` +
                    // A row is aimed at with a finger below the breakpoint, so
                    // it takes the 44px target the doc records there; above it
                    // the pointer keeps the 32px control height every other
                    // row in the app has.
                    "max-md:min-h-11 items-center gap-2.5 rounded-[6px] px-2 text-sm no-underline " +
                    `hover:no-underline ${ROW[current ? "active" : "inactive"]}`
                  }
                >
                  <Icon name={pane.icon} />
                  <span className={`${COLLAPSE_LABEL[variant]} truncate`}>
                    {pane.label}
                  </span>
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
 * The source list below the shell's mobile breakpoint, off-canvas and closed.
 *
 * A native `<dialog>` opened with `showModal()`, which is `Sheet`'s decision
 * for `Sheet`'s reason: the top layer, the inert background, the focus trap and
 * Esc-to-dismiss are all the browser's, and a hand-rolled overlay would be a
 * hand-rolled focus trap. `Sheet` itself is not reused because it is a
 * *top-anchored panel with a title, one default action and Cancel* — a nav
 * drawer is edge-anchored and has none of the three, and threading a fabricated
 * confirm action through it to reach the machinery would be a worse lie than
 * the twenty lines below.
 *
 * The three rules that follow from using the element rather than imitating it
 * are the same ones and are why they are written out again here: it is always
 * rendered and never conditionally mounted, because mounting in the same commit
 * that calls `showModal()` is a race; nothing sets `display` on it, because a
 * `display` utility outranks the UA's `dialog:not([open]) { display: none }`
 * and would leave a closed drawer lying across the page — which is also why
 * this is not hidden above the breakpoint with a `md:hidden`, and why AppShell
 * closes it on a media query instead; and `cancel` is prevented so Esc goes
 * through `onDismiss` and React's `open` stays the single source of truth.
 */
export function SidebarDrawer({
  open,
  onDismiss,
}: {
  open: boolean;
  /** Esc, the backdrop, or a destination. The drawer never closes itself. */
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      id={SIDEBAR_DRAWER_ID}
      aria-label="Navigation"
      onCancel={(e) => {
        e.preventDefault();
        onDismiss();
      }}
      // The element is the whole viewport, so `::backdrop` is drawn behind it
      // and can never be the click target. What "dismissed on the backdrop"
      // actually means here is a press that landed on the dialog itself rather
      // than on the panel inside it.
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
      // inset-0 with the UA margin cleared makes the element the whole
      // viewport, so the panel below can sit against its left edge. The three
      // `-none`s defeat the UA's own max-width/max-height on a modal dialog.
      //
      // `cursor-pointer` is not decoration on a surface no pointer will ever
      // visit: it is what makes iOS Safari treat a tap on a non-interactive
      // element as a click at all, and the dismiss above is a click. The panel
      // takes it back, because `cursor` inherits.
      className="fixed inset-0 m-0 h-auto max-h-none w-auto max-w-none cursor-pointer overflow-hidden bg-transparent p-0 [&::backdrop]:bg-black/25"
    >
      <div
        className="drawer-enter h-full cursor-default bg-inset shadow-e3"
        style={{
          // The list keeps its full width and the inset is added to it, rather
          // than eaten out of it — all three are 0px in a browser tab and on
          // the desktop, and non-zero only where the OS has taken an edge of
          // the screen: a notch, a home indicator, or the rounded corner a
          // phone in landscape puts over this exact edge.
          width: "calc(var(--sidebar-w-list) + env(safe-area-inset-left, 0px))",
          paddingTop: "env(safe-area-inset-top, 0px)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          paddingLeft: "env(safe-area-inset-left, 0px)",
        }}
      >
        <Sidebar variant="drawer" onNavigate={onDismiss} />
      </div>
    </dialog>
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
