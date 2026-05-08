import { Badge, Card, LinkButton } from "@reviewrouter/ui";
import { GitHubSignInButton } from "../../github-sign-in-button";
import { LogoMark } from "../../logo-mark";

export const dynamic = "force-dynamic";

type SignInPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

const errorCopy: Record<string, string> = {
  OAuthCallback:
    "GitHub returned an OAuth callback error. Check that the GitHub App callback URL matches this site, then try again.",
  OAuthSignin:
    "GitHub sign-in could not start. Check the GitHub App client settings, then try again.",
  AccessDenied:
    "GitHub denied access. Use an account that can access the selected installation or repository.",
  Configuration:
    "ReviewRouter sign-in is not configured correctly. Contact support with this page URL.",
};

export default async function SignInPage({
  searchParams,
}: SignInPageProps): Promise<React.ReactElement> {
  const params = searchParams ? await searchParams : {};
  const callbackUrl = readSafeCallbackUrl(readParam(params.callbackUrl));
  const error = readParam(params.error);
  const message = error ? (errorCopy[error] ?? errorCopy.Configuration) : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 md:py-12">
      <section className="min-w-0 rounded-[2rem] border border-cyan-300/[0.12] bg-[#0a0a0f]/80 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_90px_-54px_rgba(0,240,255,0.9)] backdrop-blur-2xl sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <LogoMark size="sm" />
          <Badge tone={message ? "warning" : "accent"}>GitHub sign-in</Badge>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0 space-y-4">
            <h1 className="max-w-full text-3xl font-extrabold leading-[1.08] tracking-[-0.035em] text-cyan-50 [overflow-wrap:anywhere] sm:max-w-3xl sm:text-4xl sm:tracking-[-0.04em] md:text-6xl">
              Sign in to ReviewRouter.
            </h1>
            <p className="max-w-full text-base leading-7 text-[#a0a8c0] [overflow-wrap:anywhere] sm:max-w-2xl">
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

      {message ? (
        <Card className="rounded-2xl border-amber-300/20 bg-amber-300/[0.05] p-5 sm:p-6">
          <Badge tone="warning">Sign-in issue</Badge>
          <h2 className="mt-4 text-2xl font-semibold text-cyan-50">
            GitHub did not complete sign-in.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            {message}
          </p>
        </Card>
      ) : (
        <Card className="rounded-2xl p-5 sm:p-6">
          <Badge tone="success">No secret custody</Badge>
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
