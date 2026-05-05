import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { LogoMark } from "./logo-mark";
import { PrimaryNav } from "./primary-nav";
import "./globals.css";
import { reviewRouterApiDemoUrl, reviewRouterWebUrl } from "./public-urls";

export const metadata: Metadata = {
  metadataBase: new URL(reviewRouterWebUrl),
  title: "ReviewRouter",
  description: "AI review control plane for GitHub pull requests.",
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon" },
      { url: "/review-router-icon.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: [{ url: "/favicon.ico", type: "image/x-icon" }],
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

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
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
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetBrainsMono.variable}`}
    >
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
            <PrimaryNav apiDemoUrl={reviewRouterApiDemoUrl} />
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
            <div className="flex flex-wrap gap-2">
              <a
                className="inline-flex min-h-11 items-center rounded-lg px-2 text-cyan-100 hover:bg-cyan-300/[0.06] hover:underline"
                href="/support"
              >
                Support
              </a>
              <a
                className="inline-flex min-h-11 items-center rounded-lg px-2 text-cyan-100 hover:bg-cyan-300/[0.06] hover:underline"
                href="/privacy"
              >
                Privacy
              </a>
              <a
                className="inline-flex min-h-11 items-center rounded-lg px-2 text-cyan-100 hover:bg-cyan-300/[0.06] hover:underline"
                href="/terms"
              >
                Terms
              </a>
              <a
                className="inline-flex min-h-11 items-center rounded-lg px-2 text-cyan-100 hover:bg-cyan-300/[0.06] hover:underline"
                href="/fair-use"
              >
                Fair use
              </a>
              <a
                className="inline-flex min-h-11 items-center rounded-lg px-2 text-cyan-100 hover:bg-cyan-300/[0.06] hover:underline"
                href="/disconnect"
              >
                Disconnect
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
