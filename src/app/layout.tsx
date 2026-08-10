import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "UsageFoundry",
  description:
    "Usage-aware orchestration for Claude Code — track limits, run work against a folder, stop at a budget.",
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
        <div className="shell">
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
