"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/runs", label: "Runs" },
  { href: "/branches", label: "Branches" },
  { href: "/account", label: "API account" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;

  return (
    <header className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line py-4">
      <Link
        href="/"
        className="flex items-center gap-2 text-md font-semibold tracking-tight text-ink no-underline hover:no-underline"
      >
        <span
          className="inline-block h-[22px] w-[22px] rounded-md bg-gradient-to-br from-accent to-[#7a5cff]"
          aria-hidden
        />
        UsageFoundry
      </Link>
      <nav className="ml-auto flex flex-wrap items-center gap-1">
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
              className={`rounded-sm px-2.5 py-1.5 text-sm no-underline hover:no-underline ${
                active
                  ? "bg-accent-dim text-ink"
                  : "text-ink-muted hover:bg-surface hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
        <ThemeToggle />
      </nav>
    </header>
  );
}
