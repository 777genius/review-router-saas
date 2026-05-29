import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { unstable_rethrow } from "next/navigation";
import { getServerSession } from "next-auth";
import { GitBranch, LifeBuoy, Mail, ShieldCheck } from "lucide-react";
import { AppToaster } from "./app-toaster";
import { LogoMark } from "./logo-mark";
import { MobilePrimaryNav, PrimaryNav } from "./primary-nav";
import { HeaderProfileMenu } from "./header-profile-menu";
import { ThemeToggle } from "./theme-toggle";
import "./globals.css";
import {
  reviewRouterContactEmail,
  reviewRouterContactMailto,
  reviewRouterGitHubRepoUrl,
  reviewRouterWebUrl,
} from "./public-urls";
import {
  defaultSocialImage,
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
    images: [defaultSocialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: defaultSeoTitle,
    description: defaultSeoDescription,
    images: [defaultSocialImage.url],
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
  { href: "/#compare", label: "Compare" },
  { href: "/fair-use", label: "Fair use" },
] as const;

const footerLegalLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/disconnect", label: "Disconnect" },
] as const;

const themeInitScript = `
(() => {
  try {
    const preference = localStorage.getItem("reviewrouter-theme") || "dark";
    const theme = preference === "system"
      ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : preference;
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.themePreference = preference;
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themePreference = "dark";
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const profile = await loadHeaderProfile();

  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${spaceGrotesk.variable} ${jetBrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <a
          href="#content"
          className="sr-only rounded-lg border border-cyan-300/40 bg-slate-950 px-3 py-2 text-cyan-50 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-cyan-300/[0.1] bg-[var(--rr-header-bg)] shadow-[0_18px_60px_-42px_rgba(0,240,255,0.7)] backdrop-blur-xl">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-200/55 to-transparent"
          />
          <div className="mx-auto grid min-h-16 w-full min-w-0 max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:px-6 lg:min-h-20 lg:grid-cols-[minmax(240px,auto)_minmax(0,1fr)_auto] lg:py-0">
            <a
              href="/"
              className="group flex min-w-0 items-center gap-3 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
            >
              <LogoMark
                size="sm"
                className="shadow-[0_0_34px_-10px_rgba(0,240,255,0.9)]"
              />
              <span className="min-w-0">
                <span className="block truncate font-mono text-sm font-semibold tracking-[0.14em] text-cyan-50 sm:text-base sm:tracking-[0.16em]">
                  ReviewRouter
                </span>
                <span className="hidden text-xs text-slate-500 sm:block">
                  Private AI review control plane
                </span>
              </span>
            </a>
            <div className="relative hidden min-w-0 lg:block lg:justify-self-center">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-1/2 hidden h-px w-[min(38rem,52vw)] -translate-x-1/2 bg-gradient-to-r from-transparent via-cyan-300/15 to-transparent lg:block"
              />
              <PrimaryNav signedIn={profile.signedIn} />
            </div>
            <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-3 lg:justify-end">
              <ThemeToggle />
              <div className="hidden items-center gap-3 border-r border-cyan-200/10 pr-3 xl:flex">
                <span className="relative grid h-9 w-9 place-items-center rounded-xl border border-lime-300/20 bg-lime-300/[0.07] text-lime-300">
                  <ShieldCheck aria-hidden="true" className="size-4" />
                  <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-lime-300 shadow-[0_0_12px_rgba(190,242,100,0.8)]" />
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-lime-200">
                    Secure
                  </span>
                  <span className="block text-xs text-slate-500">
                    Systems operational
                  </span>
                </span>
              </div>
              <HeaderProfileMenu
                githubLogin={profile.githubLogin}
                githubAvatarUrl={profile.githubAvatarUrl}
              />
              <MobilePrimaryNav signedIn={profile.signedIn} />
            </div>
          </div>
        </header>
        <div id="content">{children}</div>
        <AppToaster />
        <footer className="site-footer relative isolate overflow-hidden border-t border-cyan-200/10 bg-[var(--rr-footer-bg)]">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/45 to-transparent"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-[linear-gradient(var(--rr-page-grid)_1px,transparent_1px),linear-gradient(90deg,var(--rr-page-grid)_1px,transparent_1px),linear-gradient(180deg,var(--rr-surface-panel-muted),var(--rr-surface-card-strong))] bg-[size:56px_56px,56px_56px,auto]"
          />
          <div className="site-footer__main mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 text-sm text-slate-400 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)] lg:items-start">
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
          <div className="site-footer__bottom mx-auto flex w-full max-w-6xl flex-col gap-3 border-t border-cyan-200/10 px-4 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
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
  } catch (error) {
    unstable_rethrow(error);
    return { signedIn: false, githubLogin: null, githubAvatarUrl: null };
  }
}
