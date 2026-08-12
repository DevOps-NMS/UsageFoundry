import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: {
    default: "UsageFoundry",
    // Pages that set a title get it in front of the app's name, so a row of
    // pinned tabs is readable and browser history is searchable by page.
    template: "%s · UsageFoundry",
  },
  applicationName: "UsageFoundry",
  description:
    "Usage-aware orchestration for Claude Code — track limits, run work against a folder, stop at a budget.",
  // public/icon.svg was in the repository and referenced by nothing: Next only
  // auto-detects an icon in app/, so every tab showed the default globe.
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  // Both entries, because the app follows the OS when no theme is stored and
  // a single colour would leave the browser chrome fighting the page in one
  // of the two. The values are --bg from globals.css.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1013" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning because the script below mutates this very
    // element before React hydrates it. Without it React treats the attribute
    // it did not render as a mismatch and can discard the tree.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline and render-blocking on purpose: an explicitly chosen theme
            has to be on the element before first paint, or the page paints in
            the OS theme and then snaps. Someone on the default "system"
            setting can never flash, because that state *is* the absence of
            this attribute. Kept as raw text rather than next/script so it
            cannot be deferred. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              `try{var t=localStorage.getItem("uf-theme");` +
              `if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body>
        {/* Seven nav links stand between the top of the document and the page
            itself, on every page. Invisible until it takes focus, which is the
            only time it is any use. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:border focus:border-line focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:no-underline focus:shadow-e2"
        >
          Skip to content
        </a>
        {/* Narrower gutter on phones — the old shell kept a flat 20px at every
            width, which is most of a small screen spent on margin. */}
        <div className="mx-auto max-w-shell px-4 pb-16 sm:px-5">
          <Nav />
          <main id="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
