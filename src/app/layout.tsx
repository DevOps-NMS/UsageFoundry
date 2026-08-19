import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/shell/AppShell";
import { authEnabled } from "@/lib/config";

/**
 * Applies to every page under this layout, and it is the banner below that
 * needs it.
 *
 * `authEnabled()` reads an environment variable, and without this every page
 * was prerendered during `next build` — which for the shipped image means
 * inside `docker build`, where `UF_AUTH_TOKEN` is not set and cannot be. So the
 * answer baked into the HTML was "authentication is off" on every install,
 * including the ones that had set a token, and no restart could change it.
 *
 * The mirror image is the reason this is a correctness fix rather than a
 * cosmetic one: a build whose shell happened to export `UF_AUTH_TOKEN`, run
 * against a deployment without one, prerenders the banner *away* and leaves
 * every route open with nothing on the page saying so.
 *
 * The cost is small here and would not have been the same trade at the top of a
 * content site: these pages are client components that fetch their own data, so
 * what the prerender was saving is a shell, not a render.
 */
export const dynamic = "force-dynamic";

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
  // auto-detects an icon in app/, so every tab showed the default globe. The
  // Apple entry is a PNG rather than the same SVG: Safari does not read an SVG
  // apple-touch-icon, and "Add to Dock" would fall back to a screenshot of the
  // page. See scripts/make-icons.py.
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
  // What makes Safari 17+ "Add to Dock" open a real window rather than a tab,
  // and what names it in the Dock. `default` for the status bar rather than
  // `black-translucent`, which puts the page *under* the iOS status bar — a
  // deliberate layout decision this app has no reason to take and no way to
  // check here.
  appleWebApp: {
    capable: true,
    title: "UsageFoundry",
    statusBarStyle: "default",
  },
  // `appleWebApp.capable` emits the *standardised* `mobile-web-app-capable`
  // and nothing else — Next made that swap because Chromium deprecated its
  // handling of the Apple-prefixed name. WebKit did not: this is the spelling
  // Safari reads, and without it "Add to Dock" opens a tab in a frame rather
  // than a window. Both are declared because each browser ignores the other's.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  // What makes every `env(safe-area-inset-*)` in the app resolve to anything
  // other than 0. The default is `auto`, which letterboxes an installed iOS app
  // inside the safe area and reports all four insets as zero — the shell then
  // has nothing to keep clear of and nothing to keep clear of it, which reads
  // as correct right up until the day something needs the space under the
  // notch. `cover` hands the page the whole screen and states the four insets,
  // and this app is in exactly the case that makes that the right trade:
  // `appleWebApp.capable` above and `display: "standalone"` in manifest.ts mean
  // an install to an iOS home screen runs full-screen, under the notch and over
  // the home indicator. AppShell pads its outer box by all four and the drawer,
  // which is a `fixed` dialog and so outside that box, pads by three; all four
  // are 0 in an ordinary desktop browser and in an installed desktop window, so
  // nothing there moves.
  viewportFit: "cover",
  // Both entries, because the app follows the OS when no theme is stored and
  // a single colour would leave the browser chrome fighting the page in one
  // of the two. The values are --bg from globals.css — they were the previous
  // palette's and had been left behind by the retune, so the title bar of an
  // installed window was a visibly different grey from the window under it.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0f0f3" },
    { media: "(prefers-color-scheme: dark)", color: "#1e1e20" },
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
            cannot be deferred.

            The collapsed sidebar rides along for the same reason and is a
            louder version of the same failure: the rail is 168px narrower than
            the list, so a state read after hydration would shove the whole
            content pane sideways one frame into every page load. Both are the
            absence of an attribute in their default state, so neither costs
            anything for someone who has never touched the control. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              `try{var t=localStorage.getItem("uf-theme");` +
              `if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;` +
              `if(localStorage.getItem("uf.sidebar")==="collapsed")` +
              `document.documentElement.dataset.sidebar="collapsed"}catch(e){}`,
          }}
        />
      </head>
      <body>
        {/* Seven source-list rows and a toolbar stand between the top of the
            document and the page itself, on every page. Invisible until it
            takes focus, which is the only time it is any use. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:border focus:border-line focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:no-underline focus:shadow-e2"
        >
          Skip to content
        </a>
        {/* Read here rather than polled: this is a server component, so the
            state is on the page from the first byte, on every page, with no
            request that can fail and leave the banner off. */}
        <AppShell authDisabled={!authEnabled()}>{children}</AppShell>
      </body>
    </html>
  );
}
