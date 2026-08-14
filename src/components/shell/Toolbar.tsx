"use client";

import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { SIDEBAR_ID } from "@/components/shell/Sidebar";
import { toolbarAction, toolbarTitle } from "@/components/shell/panes";

/**
 * The strip at the top of the content pane: what you are looking at, and the
 * one place this pane can send you next.
 *
 * Its height is a *floor*, not a height. In an installed window with Window
 * Controls Overlay the browser hands the page the whole title bar and states
 * where its own buttons are in `env(titlebar-area-*)`; the strip keeps clear
 * of them on both sides, because they are on the left on macOS and on the
 * right everywhere else. In an ordinary tab every one of those values falls
 * back to a figure that makes each `max()` pick the plain padding, so nothing
 * here branches on which case it is in — which matters, because the tab is
 * the only case that could be checked from this container.
 *
 * The empty part of the strip drags the window; every control on it says
 * `app-no-drag`, because a drag region swallows the pointer press.
 */
export function Toolbar({
  sidebarCollapsed,
  onToggleSidebar,
  onQuickOpen,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onQuickOpen: () => void;
}) {
  const pathname = usePathname();
  const action = toolbarAction(pathname);

  return (
    <header
      className="app-drag flex shrink-0 items-center gap-3 border-b border-line bg-canvas"
      style={{
        height: "var(--toolbar-actual)",
        // The traffic lights are measured from the *window's* left edge, and
        // the sidebar has already absorbed that much of it. What is left over
        // is what this strip has to keep clear — nothing on macOS with the
        // list open, 22px when it is a 56px rail.
        paddingLeft:
          "max(0.75rem, calc(env(titlebar-area-x, 0px) - var(--sidebar-w)))",
        // And the same sum from the other end, which is where Windows and
        // Linux put the window's buttons. The fallbacks are chosen so the
        // subtraction is exactly zero when the browser answers nothing.
        paddingRight:
          "max(0.75rem, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))",
      }}
    >
      <Button
        variant="ghost"
        size="compact"
        onClick={onToggleSidebar}
        aria-expanded={!sidebarCollapsed}
        aria-controls={SIDEBAR_ID}
        aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        className="app-no-drag"
      >
        <Icon name="sidebar" />
      </Button>

      {/* Not a heading: every page still carries its own <h1>, and a second one
          up here would put two titles in the document outline. */}
      <div className="min-w-0 truncate text-sm font-semibold text-ink">
        {toolbarTitle(pathname)}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* The chord is on the control, so the binding is discoverable without
            a shortcuts sheet nobody opens — and announced, so it is not only
            discoverable by sight. */}
        <Button
          variant="secondary"
          size="compact"
          onClick={onQuickOpen}
          aria-keyshortcuts="Meta+K"
          className="app-no-drag"
        >
          <Icon name="search" />
          <span>Quick open</span>
          <kbd className="mono rounded-[4px] border border-line bg-inset px-1 text-2xs text-ink-faint">
            ⌘K
          </kbd>
        </Button>

        <div className="app-no-drag">
          <ThemeToggle />
        </div>

        {action && (
          <ButtonLink
            href={action.href}
            variant="secondary"
            size="compact"
            className="app-no-drag"
          >
            {action.label}
          </ButtonLink>
        )}
      </div>
    </header>
  );
}
