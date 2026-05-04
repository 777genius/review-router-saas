import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { LogoMark } from "./logo-mark";
import "./globals.css";
import { reviewRouterApiDemoUrl, reviewRouterWebUrl } from "./public-urls";

const primaryNav = [
  { href: "/", label: "Overview" },
  { href: "/getting-started", label: "Getting started" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/status", label: "Status" },
  { href: "/security", label: "Security" },
  { href: "/support", label: "Support" },
] as const;

export const metadata: Metadata = {
  metadataBase: new URL(reviewRouterWebUrl),
  title: "ReviewRouter",
  description: "AI review control plane for GitHub pull requests.",
  icons: {
    icon: [
      { url: "/review-router-icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [
      { url: "/review-router-icon.png", type: "image/png", sizes: "512x512" },
    ],
  },
  openGraph: {
    title: "ReviewRouter",
    description: "AI review control plane for GitHub pull requests.",
    images: [{ url: "/review-router-logo.png", alt: "ReviewRouter logo" }],
  },
  twitter: {
    card: "summary",
    title: "ReviewRouter",
    description: "AI review control plane for GitHub pull requests.",
    images: ["/review-router-logo.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--font-inter",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en" className={`${inter.variable} ${jetBrainsMono.variable}`}>
      <body>
        <a
          href="#content"
          className="sr-only rounded-lg border border-cyan-300/40 bg-slate-950 px-3 py-2 text-cyan-50 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-cyan-300/[0.08] bg-[#0a0a0f]/90 backdrop-blur-xl">
          <div className="mx-auto flex min-h-16 w-full min-w-0 max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6 md:flex-row md:items-center md:justify-between md:py-0">
            <a href="/" className="group flex min-w-0 items-center gap-3">
              <LogoMark size="sm" />
              <span className="min-w-0">
                <span className="block font-mono text-sm font-semibold tracking-[0.18em] text-cyan-100">
                  ReviewRouter
                </span>
                <span className="block text-xs text-[#8892b0]">
                  Reviews run in customer CI
                </span>
              </span>
            </a>
            <nav
              aria-label="Primary navigation"
              className="grid w-full min-w-0 grid-cols-2 gap-2 font-mono text-xs uppercase tracking-[0.16em] sm:flex sm:flex-wrap sm:items-center sm:gap-1 md:w-auto md:justify-end"
            >
              {primaryNav.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="min-w-0 rounded-lg px-2 py-2 text-slate-200 transition hover:bg-cyan-300/[0.06] hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 sm:px-3"
                >
                  {item.label}
                </a>
              ))}
              <a
                href={reviewRouterApiDemoUrl}
                className="min-w-0 rounded-lg border border-cyan-300/25 bg-cyan-300/[0.03] px-2 py-2 font-semibold text-cyan-100 transition hover:border-cyan-300/50 hover:bg-cyan-300/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 sm:px-3"
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
