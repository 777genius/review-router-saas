import type { Metadata } from "next";

export const siteName = "ReviewRouter";

export const defaultSeoTitle =
  "ReviewRouter | Free privacy-first AI code review in CI";

export const defaultSeoDescription =
  "Free privacy-first AI code review for complex GitHub codebases. Configure Codex Subscription, Claude Subscription, OpenAI, and OpenRouter reviews while code, PR diffs, and secrets stay in CI.";

export const seoKeywords = [
  "AI code review",
  "GitHub pull request review",
  "privacy-first code review",
  "GitHub App",
  "Codex code review",
  "Claude Code review",
  "OpenAI code review",
  "OpenRouter code review",
  "CI code review",
  "GitHub Actions",
  "complex codebases",
  "private codebase review",
] as const;

export const defaultSocialImageVersion = "20260514-subscription-labels";

export const defaultSocialImage = {
  url: `/opengraph-image?v=${defaultSocialImageVersion}`,
  width: 1200,
  height: 630,
  alt: "ReviewRouter privacy-first AI code review control plane",
} as const;

export function createPublicPageMetadata(input: {
  readonly title: string;
  readonly description: string;
  readonly path: `/${string}`;
}): Metadata {
  const title = `${input.title} | ${siteName}`;

  return {
    title: {
      absolute: title,
    },
    description: input.description,
    keywords: [...seoKeywords],
    category: "Developer tools",
    alternates: {
      canonical: input.path,
      languages: {
        "en-US": input.path,
        "x-default": input.path,
      },
    },
    openGraph: {
      title,
      description: input.description,
      url: input.path,
      siteName,
      locale: "en_US",
      type: "website",
      images: [defaultSocialImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: input.description,
      images: [defaultSocialImage.url],
    },
  };
}

export function createNoIndexPageMetadata(input: {
  readonly title: string;
  readonly description?: string;
}): Metadata {
  const title = `${input.title} | ${siteName}`;

  return {
    title: {
      absolute: title,
    },
    description: input.description,
    robots: {
      index: false,
      follow: true,
      googleBot: {
        index: false,
        follow: true,
      },
    },
  };
}
