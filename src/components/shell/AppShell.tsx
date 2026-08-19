"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { QuickOpen } from "@/components/shell/QuickOpen";
import { PANES } from "@/components/shell/panes";
import { ReadOnlyNotice } from "@/components/shell/ReadOnlyNotice";
import {
  Sidebar,
  SidebarDrawer,
  readCollapsed,
  writeCollapsed,
} from "@/components/shell/Sidebar";
import { Toolbar } from "@/components/shell/Toolbar";
import {
  isCommitChord,
  isPlainCommandChord,
  isTextEntry,
} from "@/components/shell/shortcuts";

/**
 * The shell's mobile boundary, written out because a media query is the one
 * thing a Tailwind class cannot be read back from.
 *
 * 48rem is Tailwind's own `md`, and it is the same line every `max-md:` and
 * `md:` in `AppShell`, `Sidebar` and `Toolbar` draws: at or above it the source
 * list is a docked column, below it a drawer. `md` rather than `lg` so a tablet
 * in portrait — 768px, exactly this — keeps the list rather than losing it to a
 * drawer it has the room for, and rather than `sm`, where a 640px window would
 * still be handing 224px of 640 to a list. The two panes that already collapse
 * to one column keep their own `lg:`; this is about the window, not the page.
 *
 * See docs/agent/conventions.md, "The mobile boundary".
 */
const SIDEBAR_DOCKED = "(min-width: 48rem)";

/**
 * What the OS has taken off the edges of the window, and the whole of what this
 * app does about it.
 *
 * All four are 0px in a browser tab, on the desktop and in an installed desktop
 * window; they are non-zero only under `viewportFit: "cover"`, which layout.tsx
 * sets because `display: "standalone"` and `appleWebApp.capable` mean an
 * install to an iOS home screen runs full-screen — under the notch and over the
 * home indicator.
 *
 * All four rather than the two that state that case: `cover` also applies to an
 * ordinary iOS *tab*, where in landscape the notch and the rounded corners take
 * ~47px off one side against the pane's own 16px gutter. Setting `cover` and
 * padding only the vertical pair would put a line of body text under the camera
 * on every phone held sideways — a defect introduced by the fix rather than
 * found by it.
 *
 * Applied to the shell's *outer* box rather than to the strip and the pane
 * separately, for two reasons. The source list and the toolbar beside it are
 * padded by the same amount and so stay in step. And `<main>`'s own box then
 * ends above the home indicator, which is what a `sticky bottom-0` bar inside a
 * page needs: it sticks to the bottom of its scroll container, and padding *on*
 * that container would not have moved it. `--pane-h` in globals.css subtracts
 * the vertical pair. The drawer is a `fixed` dialog, so it is outside this box
 * and pads itself.
 */
const SAFE_AREA: CSSProperties = {
  paddingTop: "env(safe-area-inset-top, 0px)",
  paddingBottom: "env(safe-area-inset-bottom, 0px)",
  paddingLeft: "env(safe-area-inset-left, 0px)",
  paddingRight: "env(safe-area-inset-right, 0px)",
};

/**
 * The window, less whatever a software keyboard is standing in front of.
 *
 * `calc(100dvh - var(--keyboard-inset))` rather than `h-dvh`, and the two are
 * the same declaration everywhere `--keyboard-inset` is 0px — which is the
 * desktop, an installed window, the server's first paint, and a phone with
 * nothing focused. It is additive on exactly the grounds the insets above are.
 */
const SHELL_BOX: CSSProperties = {
  ...SAFE_AREA,
  // The fallback is not decoration: a var() that resolves to nothing makes the
  // whole calc() invalid at computed-value time, and the shell's height would
  // silently become `auto`.
  height: "calc(100dvh - var(--keyboard-inset, 0px))",
};

/**
 * Below this, a difference between the two viewports is not a keyboard.
 *
 * A horizontal scrollbar is counted in `innerHeight` and not in
 * `visualViewport.height`, and engines disagree about sub-pixel rounding, so
 * the difference is not reliably 0 for reasons that have nothing to do with a
 * keyboard. The shortest software keyboard on any phone is several times this,
 * so the floor costs nothing there and is what keeps a desktop window provably
 * untouched: under it the property is never written at all.
 *
 * What it does cost, knowingly: an iPad with a hardware keyboard attached, where
 * iPadOS leaves a ~55px accessory bar over the page. That is above the mobile
 * breakpoint, and a floor low enough to catch it would be low enough for a
 * scrollbar to trip — which trades a partly covered bar on one device for a
 * shell that is quietly short on every desktop.
 */
const KEYBOARD_FLOOR_PX = 96;

/**
 * The window: a source list on the left, a toolbar and a scrolling content
 * pane on the right.
 *
 * It replaces a 1180px column centred in the viewport, which is what a page in
 * a browser looks like. A Mac app fills the window it was given, and the two
 * halves scroll independently — the sidebar stays put while a run log runs off
 * the bottom of the pane beside it.
 *
 * `authDisabled` is the one fact the shell carries that is not about the shell.
 * It is a prop from `layout.tsx` rather than something polled, because the
 * point of it is that it cannot be missed: a server component reads the
 * environment once and every page render says it, with no request to fail and
 * no state to get stale. There is deliberately no dismiss control — the state
 * it reports is that anyone who can reach this port can start a billed agent.
 */
export function AppShell({
  children,
  authDisabled = false,
}: {
  children: ReactNode;
  authDisabled?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();

  // Mirrors the attribute the pre-paint script in layout.tsx already set, so
  // the toggle can announce `aria-expanded`. The server and the first client
  // paint both say "expanded"; the effect corrects it a frame later, which is
  // invisible because it moves nothing — the *width* came off the attribute
  // before this component existed.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);

  const [quickOpen, setQuickOpen] = useState(false);

  // Closed on every page load, and React state rather than the pre-paint
  // attribute the collapse uses: a drawer has nothing to settle before the
  // first paint, because there is no stored state it could be arriving in.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // There is nowhere to go from the login screen: every pane bounces straight
  // back to it, and the quick-open sheet is not rendered there at all.
  const chromeless = pathname === "/login";

  /**
   * How much of the window a software keyboard is covering, published as
   * `--keyboard-inset` for the shell's height above and for `--pane-h`.
   *
   * This cannot be a CSS unit. A software keyboard resizes the **visual**
   * viewport and leaves the layout viewport alone, so `dvh` — which tracks the
   * browser's own chrome and nothing else — reports the same figure with the
   * keyboard up as with it down. Everything anchored to the foot of the pane
   * therefore sits behind it: the three `sticky bottom-0` footers, the chat
   * composer, a `Sheet`'s default action. On a phone that is the box being
   * typed into and the button that commits it, both off screen at once.
   *
   * `innerHeight` minus `visualViewport.height` is the whole measurement.
   * Deliberately *not* `offsetTop`: that is how far the browser has scrolled
   * the visible area within the layout viewport, which changes the moment the
   * shell shrinks — reading it back would be a loop between this and the
   * height it sets. `scale` is the one other thing that shrinks the visual
   * viewport, and a pinch-zoomed page must not be mistaken for a keyboard and
   * have the shell folded in half under it.
   *
   * It runs on the login screen too. That page has no pinned bar to rescue,
   * but it does have the app's first text field, and a property left unwritten
   * there is one more state to reason about than one that is simply 0px.
   */
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    // An arrow rather than a `function`: TypeScript carries a narrowed `const`
    // into a function *expression* and not into a hoisted declaration, which
    // one could be called from above the guard. Written as a declaration this
    // is two `'viewport' is possibly 'null'` errors and nothing else.
    const publish = () => {
      const covered =
        viewport.scale > 1 ? 0 : window.innerHeight - viewport.height;
      const inset = covered < KEYBOARD_FLOOR_PX ? 0 : Math.round(covered);
      root.style.setProperty("--keyboard-inset", `${inset}px`);
    };
    publish();
    viewport.addEventListener("resize", publish);
    return () => {
      viewport.removeEventListener("resize", publish);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);

  /**
   * The drawer belongs to the window it was opened in.
   *
   * Turning a phone to landscape crosses 768px in one frame and docks the
   * source list again, which would otherwise leave a modal drawer — the top
   * layer, the inert page behind it — lying over a shell that already has a
   * source list. A `md:hidden` on the dialog is the wrong fix: `display: none`
   * on an element in the top layer hides it without taking it out of the top
   * layer, which is an inert page and nothing on screen explaining why.
   */
  useEffect(() => {
    if (chromeless) return;
    const docked = window.matchMedia(SIDEBAR_DOCKED);
    function onChange(e: MediaQueryListEvent) {
      if (e.matches) setDrawerOpen(false);
    }
    docked.addEventListener("change", onChange);
    return () => docked.removeEventListener("change", onChange);
  }, [chromeless]);

  /**
   * The app's one keyboard listener.
   *
   * ⌘1…⌘8 for the panes and ⌘K for quick open, and nothing else — every chord
   * here is either the app's or the browser's, never both. ⌘R, ⌘L, ⌘T and ⌘W
   * are the browser's and are never looked at; the modifier test in
   * `isPlainCommandChord` is what keeps ⌘⇧K and Ctrl+1 out of range as well.
   *
   * Esc is not bound. The quick-open sheet and the mobile drawer are both
   * native `<dialog>`s, so the browser already closes whichever is open on Esc
   * and routes that through its `onDismiss` — a second handler for the same key
   * would be two things racing to close one of them, and with two dialogs in
   * play it would be two things racing to close the wrong one.
   */
  useEffect(() => {
    if (chromeless) return;
    function onKeyDown(e: KeyboardEvent) {
      // Nothing is intercepted while someone is typing. ⌘↩ is the documented
      // exception and this layer binds it to nothing, which is the point: a
      // page's own commit chord can never be swallowed here.
      if (isTextEntry(e.target) && !isCommitChord(e)) return;
      if (!isPlainCommandChord(e)) return;

      if (e.key === "k") {
        e.preventDefault();
        // Both are modal, and an iPad Mini in portrait is 744px — below the
        // breakpoint, with a keyboard available. Stacking one `showModal()` on
        // top of another leaves two dialogs in the top layer and one Esc
        // closing the wrong one.
        setDrawerOpen(false);
        setQuickOpen(true);
        return;
      }
      const pane = PANES.find((p) => p.shortcut === e.key);
      if (pane) {
        e.preventDefault();
        // Both are modal, so either would otherwise stay lying over whichever
        // pane just arrived underneath it.
        setQuickOpen(false);
        setDrawerOpen(false);
        router.push(pane.href);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, chromeless]);

  function toggleSidebar() {
    const next = !readCollapsed();
    writeCollapsed(next);
    setCollapsed(next);
  }

  // The login page keeps `main` so the skip link still has its target, and
  // nothing else — there is no session behind it to navigate with. The banner
  // rides along: /login is reachable by hand even with auth off, and it is the
  // one page whose whole subject is the credential that is not being asked for.
  if (chromeless) {
    return (
      <>
        {authDisabled && <AuthDisabledBanner />}
        {/* The one page with no shell around it still owes the insets: behind
            `UF_AUTH_TOKEN` this is the first screen an installed app shows, and
            it would otherwise be the only one drawing under the notch. */}
        <main id="main" style={SAFE_AREA}>
          {children}
        </main>
      </>
    );
  }

  return (
    <div className="flex overflow-hidden" style={SHELL_BOX}>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Above the toolbar and inside the flex column, so the pane shrinks by
            its height rather than being pushed off the bottom of `h-dvh`. */}
        {authDisabled && <AuthDisabledBanner />}
        <Toolbar
          sidebarCollapsed={collapsed}
          onToggleSidebar={toggleSidebar}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((wasOpen) => !wasOpen)}
          onQuickOpen={() => setQuickOpen(true)}
        />
        {/* The pane's own scroll region. A `sticky bottom-0` bar inside a page
            now sticks to the bottom of this rather than of the document, which
            is where it was always meant to be.

            `relative` is what keeps that true for anything *absolutely*
            positioned inside a page, and it is load-bearing rather than
            decorative: an absolute box whose containing block is the initial
            one is not clipped by this scroller at all, so it extends the
            *document's* scrollable overflow to wherever it was laid out. Every
            `sr-only` element does exactly that — Tailwind's is `position:
            absolute` with no offsets — so a `<caption className="sr-only">` on
            a table 1200px down a page gave the document a second scrollbar
            beside this one, and dragging it slid the whole window, sidebar
            included, off the top of the viewport into the page background.
            Making this the containing block puts them back inside the pane. */}
        <main id="main" className="relative min-h-0 flex-1 overflow-y-auto">
          {/* px-4 / sm:px-5 is the gutter two pages already reach through with
              a matching negative margin — keep the pair in step.

              A flex column of at least the pane's own height, which is how a
              page says "fill what is left" without naming a number. A `vh`
              figure cannot: the pane is the window less the toolbar less this
              padding less whatever heading stands above the box, so every
              62vh/68vh box here hung past the bottom edge and gave the pane a
              scrollbar whose whole travel was empty. `min-h-full` rather than
              `h-full` is what keeps a page longer than the pane growing
              exactly as before — free space is never negative, so nothing
              shrinks either. */}
          <div className="flex min-h-full flex-col px-4 pt-5 pb-12 sm:px-5">
            {/* Above every page rather than on one of them: a server that
                cannot write refuses Start, Run, Approve and Land alike, and
                finding that out one button at a time is what this replaces. */}
            <ReadOnlyNotice />
            {children}
          </div>
        </main>
      </div>
      {/* Both are always rendered and never conditionally mounted, which is the
          first of the three rules a native <dialog> comes with. */}
      <SidebarDrawer open={drawerOpen} onDismiss={() => setDrawerOpen(false)} />
      <QuickOpen open={quickOpen} onDismiss={() => setQuickOpen(false)} />
    </div>
  );
}

/**
 * The one banner in this app with no way to close it.
 *
 * Standing context normally gets `Notice`'s quiet treatment, precisely so a
 * permanent bar does not train the eye past the conditional warnings. This is
 * the exception and it earns it by not being permanent: it appears only while
 * the server is answering every route without a credential, which is a state an
 * operator either fixes or accepts deliberately. `role="alert"` rather than a
 * polite region, because on the page it arrives with, it is the news.
 */
function AuthDisabledBanner() {
  return (
    <div
      role="alert"
      className="shrink-0 border-b border-danger-line bg-inset px-4 py-1.5 text-xs leading-normal text-ink-muted sm:px-5"
    >
      {/* The bar is full-bleed and the sentence is not, for `Notice`'s reason:
          the rule under it is what makes this read as a bar, and the words are
          prose. Uncapped they ran the width of the monitor. */}
      <div className="max-w-[110ch]">
        <span className="font-semibold text-danger">Authentication is off.</span>{" "}
        Anyone who can reach this port can start billed agents and write to
        every mounted repository. Set{" "}
        <span className="mono">UF_AUTH_TOKEN</span> in{" "}
        <span className="mono">.env</span> and restart.
      </div>
    </div>
  );
}
