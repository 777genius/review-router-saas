"use client";

import { ArrowRight, GitBranch, GitPullRequest, Plus, X } from "lucide-react";
import {
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

type ConnectSourceDialogProps = {
  readonly appInstallUrl: string | null;
  readonly workspaceId?: string | null;
  readonly triggerLabel?: string;
  readonly triggerSize?: ButtonProps["size"];
  readonly triggerVariant?: ButtonProps["variant"];
  readonly triggerClassName?: string;
};

export function ConnectSourceDialog({
  appInstallUrl,
  workspaceId,
  triggerLabel = "Connect source",
  triggerSize = "md",
  triggerVariant = "solid",
  triggerClassName = "",
}: ConnectSourceDialogProps): React.ReactElement {
  const gitLabHref = workspaceId
    ? `/setup/gitlab?workspaceId=${encodeURIComponent(workspaceId)}`
    : "/setup/gitlab";

  return (
    <DialogRoot>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant={triggerVariant}
            size={triggerSize}
            className={triggerClassName}
          />
        }
      >
        <span className="inline-flex items-center gap-2">
          <Plus aria-hidden="true" className="size-4" />
          <span>{triggerLabel}</span>
        </span>
      </DialogTrigger>
      <DialogPortal>
        <DialogBackdrop className="z-50 bg-black/80 backdrop-blur-md" />
        <DialogPopup className="z-[60] max-h-[86vh] w-[min(94vw,46rem)] overflow-y-auto border-cyan-200/20 bg-[var(--rr-surface-menu)] p-0 text-cyan-50 shadow-[0_30px_120px_rgba(0,0,0,0.62),0_0_90px_-48px_rgba(0,240,255,0.72)]">
          <div className="relative p-5 sm:p-6">
            <DialogClose
              aria-label="Close source connection dialog"
              className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-xl border border-white/10 text-slate-300 transition hover:border-cyan-200/35 hover:bg-cyan-300/[0.08] hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
            >
              <X aria-hidden="true" className="size-4" />
            </DialogClose>

            <div className="pr-10">
              <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-cyan-100">
                Connect source
              </p>
              <DialogTitle className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-cyan-50 sm:text-3xl">
                Add repositories from GitHub or GitLab
              </DialogTitle>
              <DialogDescription className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
                Source login connects identity and metadata only. Runtime tokens
                and Codex auth are written directly to your CI provider.
              </DialogDescription>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <SourceOption
                icon={<GitBranch aria-hidden="true" className="size-5" />}
                title="GitHub"
                body="Install or update the GitHub App for a personal account or organization."
                action={
                  appInstallUrl ? (
                    <LinkButton
                      href={appInstallUrl}
                      size="sm"
                      className="w-full justify-center rounded-xl"
                    >
                      <span className="inline-flex items-center gap-2">
                        <span>Continue with GitHub App</span>
                        <ArrowRight aria-hidden="true" className="size-4" />
                      </span>
                    </LinkButton>
                  ) : (
                    <span className="inline-flex min-h-9 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-300/[0.06] px-3 text-center text-xs font-semibold text-amber-100">
                      GitHub App URL is not configured
                    </span>
                  )
                }
              />
              <SourceOption
                icon={<GitPullRequest aria-hidden="true" className="size-5" />}
                title="GitLab"
                body="Paste a GitLab group or project URL, select repositories, and install CI variables without storing your token."
                action={
                  <LinkButton
                    href={gitLabHref}
                    variant="outline"
                    size="sm"
                    className="w-full justify-center rounded-xl"
                  >
                    <span className="inline-flex items-center gap-2">
                      <span>Continue with GitLab</span>
                      <ArrowRight aria-hidden="true" className="size-4" />
                    </span>
                  </LinkButton>
                }
              />
            </div>
          </div>
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}

function SourceOption({
  icon,
  title,
  body,
  action,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly body: string;
  readonly action: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="grid min-h-64 content-between gap-5 rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.045] p-4">
      <div>
        <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-200/15 bg-slate-950/60 text-cyan-100">
          {icon}
        </div>
        <h3 className="mt-4 text-lg font-semibold text-cyan-50">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-300">{body}</p>
      </div>
      {action}
    </section>
  );
}
