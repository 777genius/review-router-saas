import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { getServerSession } from "next-auth";
import { GitBranch, LifeBuoy, Mail, ShieldCheck } from "lucide-react";
import { AppToaster } from "./app-toaster";
import { LogoMark } from "./logo-mark";
import { PrimaryNav } from "./primary-nav";
import { HeaderProfileMenu } from "./header-profile-menu";
import "./globals.css";
import {
  reviewRouterContactEmail,
  reviewRouterContactMailto,
  reviewRouterGitHubRepoUrl,
  reviewRouterWebUrl,
} from "./public-urls";
import {
  defaultSeoDescription,
  defaultSeoTitle,
  seoKeywords,
  siteName,
} from "./seo";
import { authOptions } from "../src/auth/auth-options";

export const metadata: Metadata = {
  metadataBase: new URL(reviewRouterWebUrl),
  applicationName: siteName,
  title: {
    default: defaultSeoTitle,
    template: `%s | ${siteName}`,
  },
  description: defaultSeoDescription,
  keywords: [...seoKeywords],
  authors: [{ name: siteName }],
  creator: siteName,
  publisher: siteName,
  manifest: "/manifest.webmanifest",
  category: "Developer tools",
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
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    title: defaultSeoTitle,
    description: defaultSeoDescription,
    url: "/",
    siteName,
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "ReviewRouter privacy-first AI code review control plane",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: defaultSeoTitle,
    description: defaultSeoDescription,
    images: ["/opengraph-image"],
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

const footerResourceLinks = [
  { href: "/support", label: "Support" },
  { href: "/compare", label: "Compare" },
  { href: "/fair-use", label: "Fair use" },
] as const;

const footerLegalLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/disconnect", label: "Disconnect" },
] as const;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const profile = await loadHeaderProfile();

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
            <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:justify-end">
              <PrimaryNav signedIn={profile.signedIn} />
              <HeaderProfileMenu
                githubLogin={profile.githubLogin}
                githubAvatarUrl={profile.githubAvatarUrl}
              />
            </div>
          </div>
        </header>
        <div id="content">{children}</div>
        <AppToaster />
        <footer className="relative isolate overflow-hidden border-t border-cyan-200/10 bg-[#05070d]">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/45 to-transparent"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-[linear-gradient(rgba(103,232,249,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(103,232,249,0.018)_1px,transparent_1px),linear-gradient(180deg,rgba(8,47,73,0.22),rgba(2,6,23,0.78))] bg-[size:56px_56px,56px_56px,auto]"
          />
          <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 text-sm text-slate-400 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)] lg:items-start">
            <div className="max-w-2xl">
              <a href="/" className="inline-flex min-w-0 items-center gap-3">
                <LogoMark size="sm" />
                <span className="min-w-0">
                  <span className="block font-mono text-sm font-semibold tracking-[0.18em] text-cyan-100">
                    ReviewRouter
                  </span>
                  <span className="block text-xs text-slate-500">
                    Metadata control plane for CI-native AI review
                  </span>
                </span>
              </a>
              <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
                Open-source setup, routing, health, and audit for AI code
                review. Source code, provider credentials, and PR diffs stay in
                customer GitHub Actions by default.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <a
                  className="group inline-flex min-h-12 min-w-0 items-center gap-3 rounded-lg border border-cyan-200/10 bg-white/[0.03] px-4 text-cyan-50 transition hover:border-cyan-200/30 hover:bg-cyan-200/[0.07]"
                  href={reviewRouterGitHubRepoUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  <GitBranch
                    aria-hidden="true"
                    className="size-4 shrink-0 text-cyan-200"
                  />
                  <span className="truncate">GitHub repository</span>
                </a>
                <a
                  className="group inline-flex min-h-12 min-w-0 items-center gap-3 rounded-lg border border-cyan-200/10 bg-white/[0.03] px-4 text-cyan-50 transition hover:border-cyan-200/30 hover:bg-cyan-200/[0.07]"
                  href={reviewRouterContactMailto}
                >
                  <Mail
                    aria-hidden="true"
                    className="size-4 shrink-0 text-cyan-200"
                  />
                  <span className="truncate">{reviewRouterContactEmail}</span>
                </a>
              </div>
            </div>
            <div className="grid gap-6 sm:grid-cols-2 lg:justify-self-end">
              <nav aria-label="Footer resources">
                <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Product
                </h2>
                <ul className="mt-3 grid gap-1">
                  {footerResourceLinks.map((link) => (
                    <li key={link.href}>
                      <a
                        className="inline-flex min-h-11 items-center rounded-lg px-2 text-cyan-100 transition hover:bg-cyan-300/[0.07] hover:text-white"
                        href={link.href}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <nav aria-label="Footer legal">
                <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Trust
                </h2>
                <ul className="mt-3 grid gap-1">
                  {footerLegalLinks.map((link) => (
                    <li key={link.href}>
                      <a
                        className="inline-flex min-h-11 items-center rounded-lg px-2 text-cyan-100 transition hover:bg-cyan-300/[0.07] hover:text-white"
                        href={link.href}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="border-t border-cyan-200/10 pt-5 sm:col-span-2">
                <div className="inline-flex min-w-0 items-start gap-3 rounded-lg bg-cyan-300/[0.05] px-4 py-3 text-slate-300">
                  <ShieldCheck
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-lime-300"
                  />
                  <p className="min-w-0 leading-6">
                    <span className="font-medium text-cyan-50">
                      No code custody by default.
                    </span>{" "}
                    Review execution remains in your GitHub Actions boundary.
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 border-t border-cyan-200/10 px-4 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>© 2026 ReviewRouter. Built for repository-owned CI.</p>
            <a
              className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-cyan-100 transition hover:bg-cyan-300/[0.07] hover:text-white"
              href="/support"
            >
              <LifeBuoy aria-hidden="true" className="size-4" />
              Need help with setup?
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}

async function loadHeaderProfile(): Promise<{
  readonly signedIn: boolean;
  readonly githubLogin: string | null;
  readonly githubAvatarUrl: string | null;
}> {
  try {
    const session = await getServerSession(authOptions);
    return {
      signedIn: Boolean(session?.user),
      githubLogin: session?.user?.githubLogin ?? null,
      githubAvatarUrl: session?.user?.githubAvatarUrl ?? null,
    };
  } catch {
    return { signedIn: false, githubLogin: null, githubAvatarUrl: null };
  }
}
