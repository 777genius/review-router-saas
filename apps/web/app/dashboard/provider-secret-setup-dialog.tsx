"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import {
  Badge,
  Button,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "@reviewrouter/ui";
import { ProviderSecretSetupChooser } from "./provider-secret-setup-chooser";
import type { OrganizationSecretPolicy } from "./provider-secret-setup-chooser";
import {
  providerSetupConfirmedEventName,
  type ProviderSetupConfirmedEventDetail,
} from "./repository-setup-optimistic-events";

type ProviderSecretGuidanceSet = {
  readonly codexOAuth: ProviderSecretSetupGuidance;
  readonly codexApiKey: ProviderSecretSetupGuidance;
  readonly openRouterApiKey: ProviderSecretSetupGuidance;
};

export function ProviderSecretSetupDialog({
  workspaceId,
  repositoryId,
  repositoryFullName,
  repositoryVisibility,
  organizationLogin,
  organizationSecretPolicy,
  guidanceSet,
  triggerLabel,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
  disabled = false,
}: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly repositoryVisibility: string;
  readonly organizationLogin: string | null;
  readonly organizationSecretPolicy: OrganizationSecretPolicy | null;
  readonly guidanceSet: ProviderSecretGuidanceSet;
  readonly triggerLabel: string;
  readonly triggerVariant?: "solid" | "soft" | "outline" | "ghost";
  readonly triggerSize?: "sm" | "md" | "lg";
  readonly triggerClassName?: string | undefined;
  readonly disabled?: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const refreshAfterClose = useRef(false);

  useEffect(() => {
    function handleProviderSetupConfirmed(event: Event): void {
      const detail = (event as CustomEvent<ProviderSetupConfirmedEventDetail>)
        .detail;
      if (detail?.repositoryId === repositoryId) {
        refreshAfterClose.current = true;
      }
    }

    window.addEventListener(
      providerSetupConfirmedEventName,
      handleProviderSetupConfirmed,
    );
    return () => {
      window.removeEventListener(
        providerSetupConfirmedEventName,
        handleProviderSetupConfirmed,
      );
    };
  }, [repositoryId]);

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (!nextOpen && refreshAfterClose.current) {
      refreshAfterClose.current = false;
      router.refresh();
    }
  }

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant={triggerVariant}
            size={triggerSize}
            className={triggerClassName}
            disabled={disabled}
          />
        }
      >
        {triggerLabel}
      </DialogTrigger>
      <DialogPortal>
        <DialogBackdrop className="z-50" />
        <DialogPopup className="z-[60] max-h-[86vh] w-[min(96vw,58rem)] overflow-y-auto border-emerald-300/20 bg-[#061015] p-0 shadow-[0_30px_120px_rgba(0,0,0,0.62),0_0_90px_-48px_rgba(190,255,61,0.7)]">
          <DialogClose
            render={
              <button
                type="button"
                className="absolute right-4 top-4 z-10 inline-grid h-10 w-10 place-items-center rounded-full border border-cyan-200/15 bg-slate-950/75 text-cyan-100 shadow-[0_12px_40px_-30px_rgba(0,240,255,0.95)] transition hover:-translate-y-0.5 hover:border-cyan-200/35 hover:bg-cyan-300/[0.08] hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 active:translate-y-0"
              />
            }
            aria-label="Close provider secrets dialog"
          >
            <span className="sr-only">Close</span>
            <span aria-hidden="true" className="relative h-4 w-4">
              <span className="absolute left-1/2 top-1/2 h-0.5 w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-current" />
              <span className="absolute left-1/2 top-1/2 h-0.5 w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-current" />
            </span>
          </DialogClose>
          <div className="border-b border-emerald-300/15 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4 pr-12">
              <div className="min-w-0">
                <Badge tone="success">Provider secrets</Badge>
                <DialogTitle className="mt-3 text-xl font-semibold text-emerald-50">
                  Connect model credentials for {repositoryFullName}
                </DialogTitle>
                <DialogDescription className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
                  Merge the setup PR first, then run one command from your own
                  computer. The command connects your AI provider to{" "}
                  {repositoryFullName}; secrets are written directly to GitHub
                  Actions, while ReviewRouter SaaS stores only metadata and
                  model settings. Run it in a terminal from the{" "}
                  {repositoryFullName} repository directory.
                </DialogDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={organizationLogin ? "accent" : "neutral"}>
                  {organizationLogin
                    ? "repository or org secret"
                    : "repository secret"}
                </Badge>
              </div>
            </div>
          </div>
          <div className="p-5 sm:p-6">
            <ProviderSecretSetupChooser
              workspaceId={workspaceId}
              repositoryId={repositoryId}
              repositoryFullName={repositoryFullName}
              repositoryVisibility={repositoryVisibility}
              organizationLogin={organizationLogin}
              organizationSecretPolicy={organizationSecretPolicy}
              codexOAuthGuidance={guidanceSet.codexOAuth}
              codexApiKeyGuidance={guidanceSet.codexApiKey}
              openRouterApiKeyGuidance={guidanceSet.openRouterApiKey}
            />
          </div>
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}
