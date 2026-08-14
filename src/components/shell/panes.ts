import type { IconName } from "@/components/ui/Icon";

/**
 * The app's destinations, once.
 *
 * The source list draws them, the toolbar titles itself from them, ⌘1…⌘7
 * navigates to them and quick open searches them. Four readers is why this is
 * a module rather than an array inside the sidebar: a pane added in one of
 * them and missed in the others is a pane you can reach and cannot get back
 * from, or a shortcut that lands somewhere the list does not highlight.
 */
export interface Pane {
  href: string;
  label: string;
  icon: IconName;
  /** The digit after ⌘. Announced with `aria-keyshortcuts` on the row. */
  shortcut: string;
}

export const PANES: readonly Pane[] = [
  { href: "/", label: "Dashboard", icon: "dashboard", shortcut: "1" },
  { href: "/chat", label: "Orchestrator", icon: "chat", shortcut: "2" },
  { href: "/runs", label: "Runs", icon: "runs", shortcut: "3" },
  { href: "/workflows", label: "Workflows", icon: "workflows", shortcut: "4" },
  { href: "/branches", label: "Branches", icon: "branches", shortcut: "5" },
  { href: "/account", label: "API account", icon: "account", shortcut: "6" },
  { href: "/settings", label: "Settings", icon: "settings", shortcut: "7" },
];

/**
 * Which pane a path belongs to, or null for one that belongs to none.
 *
 * The boundary is a path segment, not a prefix. `startsWith("/runs")` — which
 * is what the top nav did — also matches a future `/runsheet`, and the failure
 * is a highlighted row that is not where you are.
 */
export function activePane(pathname: string): Pane | null {
  return (
    PANES.find((pane) =>
      pane.href === "/"
        ? pathname === "/"
        : pathname === pane.href || pathname.startsWith(`${pane.href}/`),
    ) ?? null
  );
}

/**
 * What the toolbar calls the page.
 *
 * Derived from the route rather than published by the page, because the pages
 * still carry their own `<h1>` and nothing in the shell may reach into them.
 * A dynamic route gets the name of the *kind* of thing it shows — the row's
 * own identity is the heading in the body, where there is room for it.
 */
export function toolbarTitle(pathname: string): string {
  if (pathname === "/runs/new") return "New run";
  if (pathname.startsWith("/runs/")) return "Run";
  if (pathname === "/workflows/new") return "New workflow";
  if (pathname.endsWith("/edit") && pathname.startsWith("/workflows/")) {
    return "Edit workflow";
  }
  if (pathname.includes("/instances/")) return "Workflow run";
  if (pathname.startsWith("/workflows/")) return "Workflow";
  return activePane(pathname)?.label ?? "UsageFoundry";
}

/**
 * The one action the toolbar offers, where that action is a *destination*.
 *
 * Only navigation appears here. Everything else a page can do — Start, Run,
 * Approve, Land — needs that page's own state, and a toolbar button wired to
 * it would be the shell reaching into a body it is not allowed to touch. So a
 * page whose primary action is not a link simply has none up here, and keeps
 * the button it already has.
 */
export interface ToolbarAction {
  href: string;
  label: string;
}

export function toolbarAction(pathname: string): ToolbarAction | null {
  if (pathname === "/" || pathname === "/runs") {
    return { href: "/runs/new", label: "New run" };
  }
  if (pathname === "/workflows") {
    return { href: "/workflows/new", label: "New workflow" };
  }
  return null;
}
