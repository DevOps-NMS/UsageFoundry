"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/chat", label: "Orchestrator" },
  { href: "/runs", label: "Runs" },
  { href: "/workflows", label: "Workflows" },
  { href: "/branches", label: "Branches" },
  { href: "/account", label: "API account" },
  { href: "/settings", label: "Settings" },
];

/**
 * The same three rising bars as public/icon.svg, so the tab and the page agree.
 *
 * Drawn rather than filled with a gradient: a gradient here would be the one
 * thing on the page carrying no information, and the mark has to survive being
 * 22px on a light background and 22px on a dark one, which a two-hue ramp does
 * not. The tile is --accent, which swaps with the theme.
 */
function BrandMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[22px] w-[22px] shrink-0"
      aria-hidden
      focusable="false"
    >
      <rect width="24" height="24" rx="6" className="fill-accent" />
      <rect x="6" y="13" width="3" height="5" rx="1.5" fill="#fff" />
      <rect x="10.5" y="9.5" width="3" height="8.5" rx="1.5" fill="#fff" />
      <rect x="15" y="6" width="3" height="12" rx="1.5" fill="#fff" />
    </svg>
  );
}

export function Nav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;

  return (
    <header className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line py-4">
      <Link
        href="/"
        className="ui-transition flex min-h-[var(--control-h)] items-center gap-2 rounded-sm text-md font-semibold tracking-tight text-ink no-underline hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
        <BrandMark />
        UsageFoundry
      </Link>
      <nav aria-label="Primary" className="ml-auto flex flex-wrap items-center gap-1">
        {LINKS.map((l) => {
          const active =
            l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              // The same computation that drives the styling, expressed so a
              // screen reader gets it too. It replaces a data-active attribute
              // that said this visually and nowhere else.
              aria-current={active ? "page" : undefined}
              // Both states are the same weight and the same padding. A bolder
              // active link would change its own width, and the whole row would
              // shuffle on every navigation.
              className={`ui-transition inline-flex min-h-[var(--control-h)] items-center rounded-sm px-2.5 text-sm no-underline hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                active
                  ? "bg-accent-dim text-ink"
                  : "text-ink-muted hover:bg-surface hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      {/* Outside the <nav>: it changes how the page looks, it does not go
          anywhere. Last in the DOM, so tabbing through the header ends on it
          rather than passing it on the way to the first link. */}
      <ThemeToggle />
    </header>
  );
}
