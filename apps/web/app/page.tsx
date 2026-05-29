import type { Metadata } from "next";
import { Database, KeyRound, ShieldCheck } from "lucide-react";
import { LoadingLinkButton } from "./loading-link-button";
import { GitHubAppInstallPermissionDialog } from "./github-app-install-permission-dialog";
import { CompareSection } from "./compare-section";
import {
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
} from "../src/server/dashboard-mutations";
import { countConnectedGitHubInstallations } from "../src/server/connected-installations";
import { getGitHubAppInstallUrl } from "../src/server/github-app-install-url";
import { reviewRouterGitHubRepoUrl, reviewRouterWebUrl } from "./public-urls";
import {
  createPublicPageMetadata,
  defaultSeoDescription,
  defaultSeoTitle,
  siteName,
} from "./seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "Free privacy-first AI code review in CI",
  description: defaultSeoDescription,
  path: "/",
});

const setupSteps = [
  {
    title: "Install GitHub App",
    body: "Choose one repository, selected repositories, or an organization. ReviewRouter syncs metadata, not source code.",
    badge: "STEP 1",
    number: "1",
    className: "setup-blueprint__step--one",
    nodeClassName: "setup-blueprint__node--one",
  },
  {
    title: "Merge setup PR",
    body: "A compact reusable workflow is added through a pull request, so your repository controls what runs in CI.",
    badge: "STEP 2",
    number: "2",
    className: "setup-blueprint__step--two",
    nodeClassName: "setup-blueprint__node--two",
  },
  {
    title: "Connect provider",
    body: "Run one local command to seed Codex OAuth, Claude Code OAuth, or API keys directly into GitHub Actions secrets.",
    badge: "STEP 3",
    number: "3",
    className: "setup-blueprint__step--three",
    nodeClassName: "setup-blueprint__node--three",
  },
] as const;

const setupSignals = [
  {
    title: "Data access",
    body: "Metadata only",
    className: "setup-blueprint__signal--data",
    icon: Database,
  },
  {
    title: "Repo owned",
    body: "You control CI",
    className: "setup-blueprint__signal--repo",
    icon: ShieldCheck,
  },
  {
    title: "Secrets synced",
    body: "Stored in GitHub Actions secrets",
    className: "setup-blueprint__signal--secrets",
    icon: KeyRound,
  },
] as const;

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${reviewRouterWebUrl}/#organization`,
      name: siteName,
      url: reviewRouterWebUrl,
      logo: `${reviewRouterWebUrl}/review-router-icon.png`,
      sameAs: [reviewRouterGitHubRepoUrl],
    },
    {
      "@type": "WebSite",
      "@id": `${reviewRouterWebUrl}/#website`,
      name: siteName,
      url: reviewRouterWebUrl,
      description: defaultSeoDescription,
      inLanguage: "en-US",
      publisher: {
        "@id": `${reviewRouterWebUrl}/#organization`,
      },
    },
    {
      "@type": "WebPage",
      "@id": `${reviewRouterWebUrl}/#webpage`,
      name: defaultSeoTitle,
      url: reviewRouterWebUrl,
      description: defaultSeoDescription,
      isPartOf: {
        "@id": `${reviewRouterWebUrl}/#website`,
      },
      about: {
        "@id": `${reviewRouterWebUrl}/#organization`,
      },
      inLanguage: "en-US",
    },
  ],
} as const;

export default async function HomePage(): Promise<React.ReactElement> {
  const appInstallUrl = getGitHubAppInstallUrl();
  const [mutationStatus, workspaceScope] = await Promise.all([
    getDashboardMutationStatus(),
    getDashboardWorkspaceScope(),
  ]);
  const connectedInstallations = mutationStatus.signedIn
    ? await countConnectedGitHubInstallations(workspaceScope)
    : 0;
  const hasConnectedApp = connectedInstallations > 0;
  const primaryHref = hasConnectedApp
    ? "/dashboard"
    : (appInstallUrl ?? "/setup");
  const primaryLabel = hasConnectedApp
    ? "Open dashboard"
    : "Install GitHub App";

  return (
    <main className="home-shell flex min-h-screen w-full flex-col gap-8 overflow-hidden pb-8 md:pb-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <section
        aria-labelledby="setup-blueprint-title"
        className="setup-blueprint mx-auto w-full"
      >
        <BlueprintLines />

        <div className="setup-blueprint__intro">
          <p className="setup-blueprint__eyebrow">ReviewRouter Setup ///</p>
          <h1 id="setup-blueprint-title">
            Free privacy-first
            <br />
            AI code review
            <br />
            that stays inside your CI
          </h1>
          <span aria-hidden="true" className="setup-blueprint__intro-rule" />
          <p>
            Connect your repository, add the workflow, and enable secure access
            for free.
          </p>
        </div>

        <div className="setup-blueprint__mobile-cta">
          {!hasConnectedApp && appInstallUrl ? (
            <GitHubAppInstallPermissionDialog
              href={appInstallUrl}
              size="lg"
              className="home-install-cta setup-blueprint__install-cta"
            >
              {primaryLabel}
            </GitHubAppInstallPermissionDialog>
          ) : (
            <LoadingLinkButton
              href={primaryHref}
              size="lg"
              className="home-install-cta setup-blueprint__install-cta"
              pendingLabel={
                hasConnectedApp ? "Opening dashboard..." : "Opening setup..."
              }
            >
              {primaryLabel}
            </LoadingLinkButton>
          )}
        </div>

        {setupSteps.map((item) => (
          <div
            className={`setup-blueprint__node ${item.nodeClassName}`}
            key={item.number}
          >
            <span>{item.number}</span>
          </div>
        ))}

        {setupSteps.map((item) => (
          <article
            className={`setup-blueprint__step ${item.className}`}
            key={item.title}
          >
            <p className="setup-blueprint__step-label">
              {item.badge}
              <span aria-hidden="true" />
            </p>
            <h2>{item.title}</h2>
            <p>{item.body}</p>
          </article>
        ))}

        <div className="setup-blueprint__mobile-steps">
          {setupSteps.map((item) => (
            <article className="setup-blueprint__mobile-step" key={item.title}>
              <div
                className={`setup-blueprint__mobile-node setup-blueprint__mobile-node--${item.number}`}
              >
                <span>{item.number}</span>
              </div>
              <div>
                <p className="setup-blueprint__step-label">
                  {item.badge}
                  <span aria-hidden="true" />
                </p>
                <h2>{item.title}</h2>
                <p>{item.body}</p>
              </div>
            </article>
          ))}
        </div>

        {setupSignals.map((signal) => {
          const Icon = signal.icon;

          return (
            <div
              className={`setup-blueprint__signal ${signal.className}`}
              key={signal.title}
            >
              <Icon aria-hidden="true" size={28} strokeWidth={1.65} />
              <span>
                <strong>{signal.title}</strong>
                <small>{signal.body}</small>
              </span>
            </div>
          );
        })}

        <div className="setup-blueprint__cta">
          {!hasConnectedApp && appInstallUrl ? (
            <GitHubAppInstallPermissionDialog
              href={appInstallUrl}
              size="lg"
              className="home-install-cta setup-blueprint__install-cta"
            >
              {primaryLabel}
            </GitHubAppInstallPermissionDialog>
          ) : (
            <LoadingLinkButton
              href={primaryHref}
              size="lg"
              className="home-install-cta setup-blueprint__install-cta"
              pendingLabel={
                hasConnectedApp ? "Opening dashboard..." : "Opening setup..."
              }
            >
              {primaryLabel}
            </LoadingLinkButton>
          )}
        </div>

        <span aria-hidden="true" className="setup-blueprint__version">
          RR
          <br />
          v1.0
        </span>
      </section>

      <CompareSection />
    </main>
  );
}

function BlueprintLines(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="setup-blueprint__lines"
      fill="none"
      preserveAspectRatio="none"
      viewBox="0 0 2058 764"
    >
      <defs>
        <pattern
          id="setup-blueprint-dots"
          width="24"
          height="24"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="2" cy="2" fill="rgba(103, 232, 249, 0.34)" r="1.15" />
        </pattern>
        <linearGradient
          id="setup-blueprint-cyan"
          x1="30"
          x2="1450"
          y1="500"
          y2="180"
        >
          <stop stopColor="#63dfff" stopOpacity="0.56" />
          <stop offset="0.52" stopColor="#6bdfff" stopOpacity="0.98" />
          <stop offset="1" stopColor="#9cebff" stopOpacity="0.78" />
        </linearGradient>
        <linearGradient
          id="setup-blueprint-lime"
          x1="1465"
          x2="1955"
          y1="190"
          y2="92"
        >
          <stop stopColor="#6bdfff" stopOpacity="0.78" />
          <stop offset="1" stopColor="#9cebff" stopOpacity="0.9" />
        </linearGradient>
        <filter
          id="setup-blueprint-glow"
          x="-20%"
          y="-80%"
          width="140%"
          height="260%"
        >
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
        <marker
          id="setup-blueprint-arrow"
          markerHeight="12"
          markerWidth="14"
          orient="auto"
          refX="11"
          refY="6"
        >
          <path d="M0 0 12 6 0 12 3 6Z" fill="#73ddff" />
        </marker>
        <marker
          id="setup-blueprint-arrow-lime"
          markerHeight="12"
          markerWidth="14"
          orient="auto"
          refX="11"
          refY="6"
        >
          <path d="M0 0 12 6 0 12 3 6Z" fill="#73ddff" />
        </marker>
      </defs>

      <rect
        fill="url(#setup-blueprint-dots)"
        height="78"
        opacity="0.22"
        width="660"
        x="698"
        y="62"
      />
      <rect
        fill="url(#setup-blueprint-dots)"
        height="320"
        opacity="0.14"
        width="452"
        x="1434"
        y="58"
      />
      <rect
        fill="url(#setup-blueprint-dots)"
        height="88"
        opacity="0.12"
        width="1020"
        x="816"
        y="574"
      />

      <path
        d="M35 25V684L91 660H545L584 635"
        stroke="rgba(148, 163, 184, 0.34)"
        strokeWidth="2"
      />
      <path
        d="M1998 49V742"
        stroke="rgba(148, 163, 184, 0.35)"
        strokeWidth="2"
      />
      <path
        d="M23 37H58M35 25V50"
        stroke="rgba(203, 213, 225, 0.72)"
        strokeWidth="2"
      />
      <path
        d="M1987 470H2012M1999 457V483"
        stroke="rgba(203, 213, 225, 0.48)"
        strokeWidth="2"
      />
      <circle
        cx="35"
        cy="37"
        r="4"
        stroke="rgba(203, 213, 225, 0.75)"
        strokeWidth="2"
      />
      <circle cx="35" cy="428" r="3" fill="rgba(203, 213, 225, 0.7)" />

      <path
        className="setup-blueprint__trace-glow"
        d="M32 497 199 450 329 376H652L710 354 840 324 969 248H1244L1338 210 1465 191"
        stroke="#dfff67"
        strokeOpacity="0.35"
        strokeWidth="6"
        filter="url(#setup-blueprint-glow)"
      />
      <path
        className="setup-blueprint__trace setup-blueprint__trace--cyan"
        d="M32 497 199 450 329 376H652L710 354 840 324 969 248H1244L1338 210 1465 191"
        markerEnd="url(#setup-blueprint-arrow)"
        stroke="url(#setup-blueprint-cyan)"
        strokeWidth="2.4"
      />
      <path
        className="setup-blueprint__trace setup-blueprint__trace--lime"
        d="M1338 210 1465 191 1658 92H1934"
        markerEnd="url(#setup-blueprint-arrow-lime)"
        stroke="url(#setup-blueprint-lime)"
        strokeWidth="2.4"
      />
      <path
        d="M199 490V660M840 365V532M1465 235V402"
        stroke="#66dfff"
        strokeOpacity="0.9"
        strokeWidth="2.2"
      />
      <path
        d="M1465 235V402"
        stroke="#66dfff"
        strokeOpacity="0.55"
        strokeWidth="2.2"
      />

      <path
        d="M91 660H545L869 532H1154L1465 402H1860"
        stroke="rgba(226, 232, 240, 0.78)"
        strokeWidth="2"
      />
      <path
        d="M228 635H584L632 660H545M743 533H1195L1204 503M1492 374H1860L1849 398H1465"
        stroke="rgba(103, 232, 249, 0.18)"
        strokeWidth="1.5"
      />
      <path
        d="M710 354 772 287H1007M1272 531 1465 134 1840 135 1998 92 1860 402"
        stroke="rgba(103, 232, 249, 0.11)"
        strokeWidth="1.5"
      />
      <path
        d="M1418 430H1856M1489 374H1860M1148 139H1330M1468 82H1710M1710 82 1732 60H1934"
        stroke="rgba(148, 163, 184, 0.16)"
        strokeWidth="1.5"
      />
      <path
        className="setup-blueprint__scan-lines"
        d="M28 710H119M530 310H696M1004 552H1168M1465 458H1834"
        stroke="rgba(103, 232, 249, 0.13)"
        strokeDasharray="4 10"
        strokeWidth="1.4"
      />

      <circle
        className="setup-blueprint__anchor"
        cx="199"
        cy="660"
        r="8"
        stroke="#61ddff"
        strokeWidth="3"
      />
      <circle
        className="setup-blueprint__anchor"
        cx="840"
        cy="532"
        r="8"
        stroke="#61ddff"
        strokeWidth="3"
      />
      <circle
        className="setup-blueprint__anchor setup-blueprint__anchor--lime"
        cx="1465"
        cy="402"
        r="8"
        stroke="#61ddff"
        strokeWidth="3"
      />
      <path
        d="M201 660H223M842 532H865M1467 402H1490"
        stroke="rgba(226, 232, 240, 0.56)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
