import type { Metadata } from "next";

export const siteName = "ReviewRouter";

export const defaultSeoTitle =
  "ReviewRouter | Privacy-first AI code review in CI";

export const defaultSeoDescription =
  "Privacy-first AI code review for GitHub pull requests. Configure Codex, OpenAI, and OpenRouter reviews while code, PR diffs, and secrets stay in CI.";

export const seoKeywords = [
  "AI code review",
  "GitHub pull request review",
  "privacy-first code review",
  "GitHub App",
  "Codex code review",
  "OpenAI code review",
  "OpenRouter code review",
  "CI code review",
  "GitHub Actions",
] as const;

const defaultSocialImage = {
  url: "/review-router-logo.png",
  width: 795,
  height: 713,
  alt: "ReviewRouter privacy-first AI code review control plane",
} as const;

export function createPublicPageMetadata(input: {
  readonly title: string;
  readonly description: string;
  readonly path: `/${string}`;
}): Metadata {
  const title = `${input.title} | ${siteName}`;

  return {
    title,
    description: input.description,
    keywords: [...seoKeywords],
    alternates: {
      canonical: input.path,
    },
    openGraph: {
      title,
      description: input.description,
      url: input.path,
      siteName,
      type: "website",
      images: [defaultSocialImage],
    },
    twitter: {
      card: "summary",
      title: input.title,
      description: input.description,
      images: [defaultSocialImage.url],
    },
  };
}
