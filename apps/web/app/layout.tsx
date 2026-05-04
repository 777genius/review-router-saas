import type { Metadata, Viewport } from "next";
import "./globals.css";
import { reviewRouterApiDemoUrl } from "./public-urls";

const primaryNav = [
  { href: "/", label: "Overview" },
  { href: "/getting-started", label: "Getting started" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/status", label: "Status" },
  { href: "/security", label: "Security" },
  { href: "/support", label: "Support" },
] as const;

export const metadata: Metadata = {
  title: "ReviewRouter",
  description: "AI review control plane for GitHub pull requests.",
  icons: [{ rel: "icon", url: "/icon.svg", type: "image/svg+xml" }],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <a
          href="#content"
          className="sr-only rounded-lg border border-cyan-300/40 bg-slate-950 px-3 py-2 text-cyan-50 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-cyan-200/10 bg-slate-950/78 backdrop-blur-xl">
          <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6 md:flex-row md:items-center md:justify-between">
            <a href="/" className="group flex min-w-0 items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-2xl border border-cyan-300/30 bg-cyan-300/10 text-sm font-black text-cyan-100 shadow-[var(--rr-shadow-glow-cyan)]">
                RR
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold uppercase tracking-[0.24em] text-cyan-100">
                  ReviewRouter
                </span>
                <span className="block text-xs text-slate-400">
                  Reviews run in customer CI
                </span>
              </span>
            </a>
            <nav
              aria-label="Primary navigation"
              className="grid w-full min-w-0 grid-cols-2 gap-2 text-sm sm:flex sm:flex-wrap sm:items-center sm:gap-1 md:w-auto md:justify-end"
            >
              {primaryNav.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="min-w-0 rounded-lg px-2 py-2 text-slate-300 transition hover:bg-cyan-300/10 hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 sm:px-3"
                >
                  {item.label}
                </a>
              ))}
              <a
                href={reviewRouterApiDemoUrl}
                className="min-w-0 rounded-lg border border-lime-300/30 bg-lime-300/10 px-2 py-2 font-medium text-lime-100 transition hover:bg-lime-300/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-300 sm:px-3"
              >
                API demo
              </a>
            </nav>
          </div>
        </header>
        <div id="content">{children}</div>
        <footer className="border-t border-cyan-200/10 bg-slate-950/55">
          <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-8 text-sm text-slate-400 sm:px-6 md:grid-cols-[1fr_auto] md:items-center">
            <p>
              ReviewRouter is a metadata control plane. Code review execution,
              provider credentials, and PR diffs stay in customer GitHub Actions
              by default.
            </p>
            <div className="flex flex-wrap gap-3">
              <a className="text-cyan-100 hover:underline" href="/privacy">
                Privacy
              </a>
              <a className="text-cyan-100 hover:underline" href="/terms">
                Terms
              </a>
              <a className="text-cyan-100 hover:underline" href="/fair-use">
                Fair use
              </a>
              <a className="text-cyan-100 hover:underline" href="/disconnect">
                Disconnect
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
