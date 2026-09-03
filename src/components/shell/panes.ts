import type { IconName } from "@/components/ui/Icon";

/**
 * The app's destinations, once.
 *
 * The source list draws them, the toolbar titles itself from them, ⌘1…⌘9
 * navigates to them and quick open searches them. Four readers is why this is
 * a module rather than an array inside the sidebar: a pane added in one of
 * them and missed in the others is a pane you can reach and cannot get back
 * from, or a shortcut that lands somewhere the list does not highlight.
 *
 * The digit follows the row's position rather than the pane's age: a shortcut
 * that names the fifth row and lands on the sixth is worse than one somebody
 * has to relearn, so inserting a pane renumbers the ones under it. **Nine is
 * the ceiling** — ⌘1…⌘9 is nine digits and the list is ten rows — so the tenth
 * row has no digit at all, and *which* row that is falls out of the order
 * rather than being chosen: today it is Settings, because Dreaming moved up to
 * eighth and pushed the two configuration panes down one each.
 *
 * That used to be a warning rather than a mechanism, and it named the wrong row
 * (Knowledge, which has been the seventh since it moved above the two
 * configuration panes, and is still seventh with Dreaming under it). It is now
 * a type: `shortcut` is optional, and the two readers that put the digit into a
 * string guard it. Both were unguarded, and both failed silently rather than
 * loudly — a screen reader announcing `Meta+undefined` and a palette printing
 * `⌘undefined`, neither a type error and neither a throw.
 */
export interface Pane {
  href: string;
  label: string;
  icon: IconName;
  /**
   * The digit after ⌘, or absent past the ninth row — Settings, as the list
   * below stands.
   *
   * Announced with `aria-keyshortcuts` on the row and shown in quick open, and
   * **every reader of it must handle its absence** — see the note above.
   */
  shortcut?: string;
}

export const PANES: readonly Pane[] = [
  { href: "/", label: "Dashboard", icon: "dashboard", shortcut: "1" },
  { href: "/chat", label: "Orchestrator", icon: "chat", shortcut: "2" },
  { href: "/runs", label: "Runs", icon: "runs", shortcut: "3" },
  { href: "/workflows", label: "Workflows", icon: "workflows", shortcut: "4" },
  { href: "/agents", label: "Agents", icon: "agents", shortcut: "5" },
  { href: "/branches", label: "Branches", icon: "branches", shortcut: "6" },
  // Above the two configuration panes rather than after them: those two are the
  // install's own settings and keep the bottom, where Knowledge is a place the
  // operator reads — and so is the row now directly under it. The renumbering
  // below both is what the rule above asks for.
  { href: "/knowledge", label: "Knowledge", icon: "knowledge", shortcut: "7" },
  // Directly under Knowledge, which is the pane it is nearest in kind — both
  // are places the operator reads, and this one is a readout of what the
  // install did to itself. It sat below the configuration pair until the
  // operator asked for this order, and the digits are what that cost: the rule
  // above renumbers everything under an inserted row, so the two config panes
  // each drop one and the list runs out of digits one row early.
  { href: "/dreaming", label: "Dreaming", icon: "dreaming", shortcut: "8" },
  { href: "/account", label: "API account", icon: "account", shortcut: "9" },
  // The tenth row, and the first row in this app with no shortcut. Losing ⌘9
  // is the price of the order above, and the loss falls on the pane somebody
  // opens when something is wrong — which is the argument the old arrangement
  // made for keeping the digit here, and which was overruled, not forgotten.
  // Settings stays one press away in quick open. What may never be done is the
  // compromise: leaving the digits alone while Dreaming sits eighth would give
  // ⌘8 a name in the list and a landing one row down, which is the failure the
  // position rule at the top of this file exists to prevent.
  { href: "/settings", label: "Settings", icon: "settings" },
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
  // Before the line under it, which would otherwise title a sub-route with the
  // name of the page it hangs off — and a toolbar saying "Run" over a screen
  // that is not the run page is the one breadcrumb an operator has.
  if (pathname.endsWith("/touched") && pathname.startsWith("/runs/")) {
    return "What it touched";
  }
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
 *
 * The second half of that sentence is also the rule for a page whose action
 * *is* a link: `/runs` and `/workflows` both head themselves with the same
 * primary button this would draw, and both were rendering it twice, 62px
 * apart, the toolbar's secondary copy stuttering directly above the page's own
 * accent one. Whichever surface offers an action, only one of them does. The
 * dashboard keeps this because the dashboard has no such button of its own,
 * which is exactly the case this exists for.
 */
export interface ToolbarAction {
  href: string;
  label: string;
}

export function toolbarAction(pathname: string): ToolbarAction | null {
  if (pathname === "/") return { href: "/runs/new", label: "New run" };
  return null;
}
