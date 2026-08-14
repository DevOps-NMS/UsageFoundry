import type { MetadataRoute } from "next";

/**
 * What turns this from a tab into a window.
 *
 * Everything else in the shell — the source list, the toolbar, the keyboard
 * layer — is drawn inside whatever frame the browser gives it, and the frame a
 * tab gives it has an address bar, a tab strip and a bookmarks row above the
 * app's own title. `display: "standalone"` is what removes them.
 *
 * `display_override` puts Window Controls Overlay first: the browser then
 * hands the page the whole title bar and publishes where its own buttons are
 * in `env(titlebar-area-*)`, which is what `Toolbar` reserves. A browser that
 * does not support it falls through to plain `standalone`, and a tab has every
 * one of those env values at zero — so the strip degrades to an ordinary bar
 * with no branch anywhere deciding which case it is in.
 *
 * The colours are `--bg` from globals.css, light scheme. A manifest carries one
 * value for each and the token carries two, so this is the one place the pair
 * cannot be expressed; `viewport.themeColor` in layout.tsx states both and is
 * what the browser actually reads for chrome tinting while the app is open.
 * These two are for the install prompt and the splash, before any CSS has run.
 *
 * Note for an install behind `UF_AUTH_TOKEN`: this route is inside
 * `middleware.ts`'s matcher like every other page, so an unauthenticated fetch
 * of it is redirected to /login. Signing in first is what makes the app
 * installable. The exemption list is deliberately not widened for this — see
 * the note beside the one entry it already has.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "UsageFoundry",
    short_name: "UsageFoundry",
    description:
      "Usage-aware orchestration for Claude Code — track limits, run work against a folder, stop at a budget.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    theme_color: "#f0f0f3",
    background_color: "#f0f0f3",
    icons: [
      // The SVG first: it is the only one that stays sharp at every size, and
      // Chromium accepts `sizes: "any"` for installability.
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Separate artwork rather than the same file relabelled: a maskable icon
      // is cropped to whatever shape the platform likes, so the tile is full
      // bleed and the mark sits inside the safe zone. The rounded one declared
      // maskable would have its corners cut off twice.
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
