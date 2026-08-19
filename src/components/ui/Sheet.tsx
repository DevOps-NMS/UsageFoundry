"use client";

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { Button, ButtonRow, type ButtonVariant } from "@/components/ui/Button";

/**
 * A `<dialog>` is in the top layer, so it is outside `AppShell`'s box and owes
 * the window's own edges itself — the same distinction `SidebarDrawer` already
 * makes one component over. All four are 0px in a browser tab, on the desktop
 * and in an installed desktop window, and non-zero only under
 * `viewportFit: "cover"`, which is the iOS home-screen install: without this
 * the panel's title sits under the notch, because `inset-0` means the whole
 * screen and not the part of it the OS has left alone.
 */
const VIEWPORT_INSETS: CSSProperties = {
  paddingTop: "env(safe-area-inset-top, 0px)",
  paddingBottom: "env(safe-area-inset-bottom, 0px)",
  paddingLeft: "env(safe-area-inset-left, 0px)",
  paddingRight: "env(safe-area-inset-right, 0px)",
};

/**
 * What is left for the panel once the OS and a software keyboard have taken
 * their share.
 *
 * `dvh` rather than `vh`: on a phone `100vh` is the viewport with the browser's
 * chrome *hidden*, so a sheet capped at it is taller than the screen and its
 * one default action is below the fold — on the one element in the app whose
 * whole job is to be answered. `--keyboard-inset` is the other half and cannot
 * come from a unit at all: a software keyboard resizes the visual viewport and
 * leaves every vh unit exactly as it was. AppShell publishes it; it is 0px
 * anywhere there is no keyboard up, which is everywhere this app runs on a
 * pointer.
 */
const PANEL_MAX_H =
  "calc(100dvh - var(--keyboard-inset, 0px) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 3rem)";

/**
 * A modal that arrives from the top of the pane, the way a macOS sheet drops
 * out from under a window's title bar.
 *
 * It is a native `<dialog>` opened with `showModal()`, and that is a
 * correctness decision rather than a shortcut: the top layer, the inert
 * background, the focus trap and Esc-to-dismiss are all things the browser
 * already implements to spec. A hand-rolled overlay would be a hand-rolled
 * focus trap, which is the part that silently stops working the day someone
 * adds a control to the footer.
 *
 * The element is always rendered and never conditionally mounted — a closed
 * `<dialog>` is `display: none`, and mounting it in the same commit that calls
 * `showModal()` is a race. Nothing here sets `display`, for the same reason: a
 * `flex` utility would outrank the UA's `dialog:not([open]) { display: none }`
 * and leave a closed sheet lying across the page.
 */
export function Sheet({
  open,
  onDismiss,
  title,
  children,
  confirmLabel,
  onConfirm,
  confirmVariant = "primary",
  confirmDisabled = false,
  busy = false,
  cancelLabel = "Cancel",
}: {
  open: boolean;
  /** Esc, or Cancel. The sheet never closes itself — this flips `open`. */
  onDismiss: () => void;
  title: ReactNode;
  children: ReactNode;
  /** The one default action. A sheet with two of them has no default action. */
  confirmLabel: ReactNode;
  onConfirm: () => void;
  confirmVariant?: ButtonVariant;
  confirmDisabled?: boolean;
  busy?: boolean;
  cancelLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Esc fires `cancel` before the browser closes the dialog. Preventing it and
  // going through `onDismiss` keeps React's `open` the single source of truth —
  // otherwise the element and the state disagree until the next render, and the
  // sheet cannot be reopened without toggling the prop twice.
  function onCancel(e: React.SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    onDismiss();
  }

  // A destructive sheet opens with the safe choice focused: `showModal` would
  // otherwise land on the first focusable thing, and one Return on a Purge
  // sheet is not a confirmation.
  const destructive = confirmVariant === "danger";

  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      aria-labelledby={titleId}
      // inset-0 with the UA margin cleared makes the element the whole viewport,
      // so the panel below can sit at the top of it. The three `-none`s defeat
      // the UA's own max-width/max-height on a modal dialog.
      className="fixed inset-0 m-0 h-auto max-h-none w-auto max-w-none overflow-hidden bg-transparent p-0 [&::backdrop]:bg-black/25"
      style={VIEWPORT_INSETS}
    >
      <div
        className="sheet-enter mx-auto w-[min(34rem,calc(100%-2rem))] rounded-b-lg border border-t-0 border-line bg-surface shadow-e3"
        // The panel scrolls, not the viewport-sized dialog around it: a long
        // sheet has to stay reachable without the page behind it moving. That
        // is also what keeps Cancel and the default action reachable with a
        // keyboard up — the cap shrinks with the visible area and the footer
        // is at the end of a scroll region rather than under the keyboard.
        style={{ maxHeight: PANEL_MAX_H, overflowY: "auto" }}
      >
        <div className="p-5">
          <h2 id={titleId} className="text-sm font-semibold text-ink">
            {title}
          </h2>
          <div className="mt-2 text-sm leading-normal text-ink-muted">
            {children}
          </div>
          {/* The default action last, which is where macOS puts it. */}
          <ButtonRow className="mt-4 justify-end">
            <Button
              variant="secondary"
              onClick={onDismiss}
              disabled={busy}
              autoFocus={destructive}
            >
              {cancelLabel}
            </Button>
            <Button
              variant={confirmVariant}
              onClick={onConfirm}
              disabled={confirmDisabled}
              busy={busy}
              autoFocus={!destructive}
            >
              {confirmLabel}
            </Button>
          </ButtonRow>
        </div>
      </div>
    </dialog>
  );
}
