"use client";

import type { ReactNode } from "react";
import {
  Badge,
  Button,
  type ButtonProps,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  LinkButton,
} from "@reviewrouter/ui";
import {
  Building2,
  ExternalLink,
  FileCode2,
  LockKeyhole,
  MessageSquareCheck,
  X,
} from "lucide-react";
import { githubSecretPermissionDocs } from "./github-app-permission-doc-links";

type GitHubAppInstallPermissionDialogProps = {
  readonly href: string;
  readonly children: ReactNode;
  readonly variant?: ButtonProps["variant"];
  readonly size?: ButtonProps["size"];
  readonly className?: string;
  readonly continueLabel?: string;
};

type PermissionRow = {
  readonly title: string;
  readonly badge?: string;
  readonly body: string;
  readonly docs?: readonly {
    readonly label: string;
    readonly href: string;
  }[];
  readonly icon: ReactNode;
};

const sensitivePermissionRows: readonly PermissionRow[] = [
  {
    title: "Secrets: read",
    badge: "Cannot read secret values",
    body: "GitHub returns metadata only: secret name, timestamps, visibility, and selected repository access. ReviewRouter checks that CODEX_AUTH_JSON, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, or OPENROUTER_API_KEY exists.",
    docs: [
      {
        label: "GitHub Docs: Get a repository secret",
        href: githubSecretPermissionDocs.repositorySecret,
      },
    ],
    icon: <LockKeyhole aria-hidden="true" className="h-7 w-7" />,
  },
  {
    title: "Organization secrets: read",
    badge: "Selected repo check",
    body: "Used to verify an organization secret is available to this repository. GitHub does not expose the decrypted secret value through this API.",
    docs: [
      {
        label: "GitHub Docs: Get an organization secret",
        href: githubSecretPermissionDocs.organizationSecret,
      },
      {
        label: "GitHub Docs: List selected repositories",
        href: githubSecretPermissionDocs.organizationSecretRepositories,
      },
    ],
    icon: <Building2 aria-hidden="true" className="h-7 w-7" />,
  },
  {
    title: "Organization plan: read",
    badge: "Plan name only",
    body: "Used to choose the right secret setup path for private organization repositories. ReviewRouter checks whether org-level Actions secrets are supported for the selected repository.",
    icon: <Building2 aria-hidden="true" className="h-7 w-7" />,
  },
] as const;

const setupPermissionRows: readonly PermissionRow[] = [
  {
    title: "Contents + Workflows: write",
    body: "Creates the setup PR that adds the ReviewRouter workflow. Review still runs inside GitHub Actions.",
    icon: <FileCode2 aria-hidden="true" className="h-7 w-7" />,
  },
  {
    title: "Pull requests, Checks, Commit statuses: write",
    body: "Posts ReviewRouter setup state, review comments, checks, and CI status back to the pull request.",
    icon: <MessageSquareCheck aria-hidden="true" className="h-7 w-7" />,
  },
] as const;

export function GitHubAppInstallPermissionDialog({
  href,
  children,
  variant,
  size,
  className,
  continueLabel = "Continue to GitHub install",
}: GitHubAppInstallPermissionDialogProps): React.ReactElement {
  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant={variant}
            size={size}
            className={className}
          />
        }
      >
        {children}
      </DialogTrigger>
      <DialogPortal>
        <DialogBackdrop className="z-50 bg-black/80 backdrop-blur-md" />
        <DialogPopup className="z-[60] max-h-[86vh] w-[min(94vw,52rem)] overflow-y-auto border-cyan-200/20 bg-[#061015] p-0 text-cyan-50 shadow-[0_30px_120px_rgba(0,0,0,0.62),0_0_90px_-48px_rgba(0,240,255,0.72)]">
          <div className="relative p-5 sm:p-6">
            <DialogClose
              aria-label="Close GitHub App permission dialog"
              className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full border border-transparent text-slate-300 transition hover:border-cyan-200/20 hover:bg-cyan-300/[0.06] hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200"
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </DialogClose>

            <div className="pr-11">
              <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-cyan-100">
                GITHUB APP INSTALL
              </p>
              <DialogTitle className="mt-2 text-3xl font-semibold tracking-[-0.02em] text-cyan-50 sm:text-[2rem]">
                Review GitHub permissions
              </DialogTitle>
              <DialogDescription className="mt-2 max-w-3xl text-sm leading-6 text-slate-300 sm:text-base">
                Some GitHub permission names sound broader than what the API
                actually exposes. ReviewRouter uses them for setup automation
                and metadata checks.
              </DialogDescription>
            </div>

            <PermissionSection
              title="SENSITIVE-SOUNDING PERMISSIONS"
              rows={sensitivePermissionRows}
              className="mt-7"
            />
            <PermissionSection
              title="SETUP + REVIEW PERMISSIONS"
              rows={setupPermissionRows}
              className="mt-7"
            />

            <div className="mt-6 flex items-center gap-4 rounded-xl border border-cyan-200/20 bg-cyan-300/[0.045] px-4 py-3 text-sm leading-5 text-cyan-100 sm:px-5">
              <LockKeyhole
                aria-hidden="true"
                className="h-5 w-5 shrink-0 text-cyan-200"
              />
              <p>
                Provider credentials stay in GitHub Actions secrets.
                ReviewRouter SaaS stores metadata and setup state only.
              </p>
            </div>

            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full border-slate-500/40 text-slate-100 hover:border-cyan-200/30 sm:w-auto"
                  />
                }
              >
                Cancel
              </DialogClose>
              <LinkButton
                href={href}
                variant="soft"
                className="w-full rounded-xl border-cyan-100/40 bg-cyan-200 px-5 text-slate-950 shadow-[0_14px_34px_-22px_rgba(103,232,249,0.9)] hover:bg-cyan-100 sm:w-auto"
              >
                {continueLabel}
                <ExternalLink aria-hidden="true" className="h-4 w-4" />
              </LinkButton>
            </div>
          </div>
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}

function PermissionSection({
  title,
  rows,
  className,
}: {
  readonly title: string;
  readonly rows: readonly PermissionRow[];
  readonly className?: string;
}): React.ReactElement {
  return (
    <section className={className}>
      <h2 className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-cyan-100">
        {title}
      </h2>
      <div className="mt-2 divide-y divide-cyan-200/10">
        {rows.map((row) => (
          <PermissionItem key={row.title} row={row} />
        ))}
      </div>
    </section>
  );
}

function PermissionItem({
  row,
}: {
  readonly row: PermissionRow;
}): React.ReactElement {
  return (
    <div className="grid gap-4 py-3 sm:grid-cols-[3.75rem_minmax(0,1fr)] sm:gap-4 sm:py-4">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-cyan-200/20 bg-slate-950/55 text-cyan-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        {row.icon}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold leading-7 text-cyan-50">
            {row.title}
          </h3>
          {row.badge ? (
            <Badge
              tone="accent"
              className="border-cyan-300/35 bg-cyan-300/[0.07] px-3 py-1.5 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-cyan-100"
            >
              {row.badge}
            </Badge>
          ) : null}
        </div>
        <p className="mt-2 text-sm leading-5 text-slate-300">{row.body}</p>
        {row.docs?.length ? (
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
            {row.docs.map((doc) => (
              <a
                key={doc.href}
                href={doc.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium leading-5 text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 transition hover:text-cyan-50"
              >
                {doc.label}
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
