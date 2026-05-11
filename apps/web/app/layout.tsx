import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { getServerSession } from "next-auth";
import { AppToaster } from "./app-toaster";
import { LogoMark } from "./logo-mark";
import { PrimaryNav } from "./primary-nav";
import { HeaderProfileMenu } from "./header-profile-menu";
import "./globals.css";
import {
  reviewRouterContactEmail,
  reviewRouterContactMailto,
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
                href={reviewRouterContactMailto}
              >
                {reviewRouterContactEmail}
              </a>
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
