import type { Metadata } from "next";
import { Badge, Card, LinkButton } from "@reviewrouter/ui";
import { GitHubSignInButton } from "../../github-sign-in-button";
import { LogoMark } from "../../logo-mark";
import { createNoIndexPageMetadata } from "../../seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = createNoIndexPageMetadata({
  title: "Sign in",
  description:
    "Sign in to connect GitHub installation metadata to the ReviewRouter dashboard.",
});

type SignInPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

type SignInIssue = {
  readonly badge: string;
  readonly title: string;
  readonly body: string;
  readonly nextStep?: string;
  readonly tone: "warning" | "success";
};

const signInIssues: Record<string, SignInIssue> = {
  OAuthCallback: {
    badge: "GitHub App installed",
    title: "Finish dashboard sign-in",
    body: "GitHub returned from the App installation before dashboard sign-in was started. Continue with GitHub below to connect the installed App to your dashboard.",
    nextStep:
      "If this repeats, disable “Request user authorization (OAuth) during installation” in the GitHub App settings and keep the setup URL pointed at /setup.",
    tone: "success",
  },
  OAuthSignin: {
    badge: "Sign-in issue",
    title: "GitHub sign-in could not start.",
    body: "Check the GitHub App client settings, then try again.",
    tone: "warning",
  },
  AccessDenied: {
    badge: "Access denied",
    title: "GitHub denied access.",
    body: "Use an account that can access the selected installation or repository.",
    tone: "warning",
  },
  Configuration: {
    badge: "Configuration issue",
    title: "ReviewRouter sign-in is not configured correctly.",
    body: "Contact support with this page URL.",
    tone: "warning",
  },
};

export default async function SignInPage({
  searchParams,
}: SignInPageProps): Promise<React.ReactElement> {
  const params = searchParams ? await searchParams : {};
  const callbackUrl = readSafeCallbackUrl(readParam(params.callbackUrl));
  const error = readParam(params.error);
  const issue = error
    ? (signInIssues[error] ?? signInIssues.Configuration)
    : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 md:py-12">
      <section className="min-w-0 rounded-[2rem] border border-cyan-300/[0.12] bg-[var(--rr-surface-card-strong)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_90px_-54px_rgba(0,240,255,0.9)] backdrop-blur-2xl sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <LogoMark size="sm" />
          <Badge tone={issue ? issue.tone : "accent"}>GitHub sign-in</Badge>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0 space-y-4">
            <h1 className="max-w-full text-3xl font-extrabold leading-[1.08] tracking-[-0.035em] text-cyan-50 [overflow-wrap:anywhere] sm:max-w-3xl sm:text-4xl sm:tracking-[-0.04em] md:text-6xl">
              Sign in to ReviewRouter
            </h1>
            <p className="max-w-full text-base leading-7 text-[var(--rr-color-text-muted)] [overflow-wrap:anywhere] sm:max-w-2xl">
              Continue with GitHub to map installed repositories to your
              dashboard. Provider credentials and PR diffs stay in GitHub
              Actions.
            </p>
          </div>
          <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap lg:justify-end">
            <GitHubSignInButton
              callbackUrl={callbackUrl}
              size="lg"
              className="w-full rounded-2xl sm:min-w-56 sm:w-auto"
            >
              Continue with GitHub
            </GitHubSignInButton>
            <LinkButton
              href="/"
              variant="outline"
              size="lg"
              className="w-full rounded-2xl sm:min-w-36 sm:w-auto"
            >
              Back to home
            </LinkButton>
          </div>
        </div>
      </section>

      {issue ? (
        <Card className="rounded-2xl border-amber-300/20 bg-amber-300/[0.05] p-5 sm:p-6">
          <Badge tone={issue.tone}>{issue.badge}</Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            {issue.title}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            {issue.body}
          </p>
          {issue.nextStep ? (
            <p className="mt-3 max-w-2xl text-xs leading-5 text-slate-400">
              {issue.nextStep}
            </p>
          ) : null}
        </Card>
      ) : (
        <Card className="rounded-2xl p-5 sm:p-6">
          <Badge tone="success">No secrets stored here</Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            Sign-in only connects metadata.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            ReviewRouter uses GitHub identity to show installations,
            repositories, setup PR status, and health. It does not ask for Codex
            OAuth files or provider API keys here.
          </p>
        </Card>
      )}
    </main>
  );
}

function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function readSafeCallbackUrl(value: string | null): string {
  if (!value) return "/dashboard";

  if (value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }

  try {
    const parsed = new URL(value);
    if (parsed.origin === process.env.NEXTAUTH_URL) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return "/dashboard";
  }

  return "/dashboard";
}
