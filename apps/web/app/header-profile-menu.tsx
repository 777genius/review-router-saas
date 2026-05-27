"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { GitHubAccountAvatar } from "./github-account-avatar";
import {
  GitHubSignInButton,
  GitHubSignOutButton,
} from "./github-sign-in-button";

type HeaderProfileMenuProps = {
  readonly githubLogin: string | null;
  readonly githubAvatarUrl: string | null;
};

export function HeaderProfileMenu({
  githubLogin,
  githubAvatarUrl,
}: HeaderProfileMenuProps): React.ReactElement {
  if (!githubLogin) {
    return (
      <GitHubSignInButton
        callbackUrl="/dashboard"
        variant="ghost"
        size="sm"
        className="rounded-xl border border-cyan-200/20 bg-white/[0.035] px-3 font-mono text-[0.68rem] uppercase tracking-[0.14em] text-cyan-100"
      >
        Sign in
      </GitHubSignInButton>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Open profile menu for ${githubLogin}`}
          className="group inline-flex min-h-11 shrink-0 items-center gap-2 rounded-2xl border border-cyan-200/15 bg-white/[0.035] px-2.5 py-2 text-left transition hover:border-cyan-200/40 hover:bg-cyan-300/[0.08] hover:shadow-[0_0_28px_-18px_rgba(0,240,255,0.95)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 data-[state=open]:border-cyan-200/40 data-[state=open]:bg-cyan-300/[0.08]"
        >
          <span className="hidden max-w-32 truncate font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-cyan-100 sm:inline">
            {githubLogin}
          </span>
          <ProfileAvatar
            githubLogin={githubLogin}
            avatarUrl={githubAvatarUrl}
          />
          <ProfileMenuChevron />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Profile menu"
          align="end"
          sideOffset={12}
          className="z-50 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-cyan-200/15 bg-[var(--rr-surface-menu)] p-3 shadow-[var(--rr-shadow-elevated),0_0_60px_-42px_rgba(0,240,255,0.9)] backdrop-blur-2xl"
        >
          <div className="flex items-center gap-3 rounded-xl bg-cyan-300/[0.055] p-3">
            <ProfileAvatar
              githubLogin={githubLogin}
              avatarUrl={githubAvatarUrl}
            />
            <div className="min-w-0">
              <p className="font-mono text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Signed in as
              </p>
              <p className="truncate text-sm font-semibold text-cyan-50">
                {githubLogin}
              </p>
            </div>
          </div>
          <DropdownMenu.Item asChild>
            <GitHubSignOutButton
              variant="ghost"
              size="sm"
              className="mt-2 w-full justify-center rounded-xl border border-white/10 text-cyan-100 hover:border-cyan-200/30 hover:bg-cyan-300/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
            />
          </DropdownMenu.Item>
          <DropdownMenu.Arrow className="fill-[var(--rr-surface-menu)]" />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ProfileMenuChevron(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="h-4 w-4 shrink-0 text-cyan-100/70 transition duration-150 group-hover:text-cyan-50 group-data-[state=open]:rotate-180"
    >
      <path
        d="M5 7.5 10 12.5 15 7.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
    </svg>
  );
}

function ProfileAvatar({
  githubLogin,
  avatarUrl,
}: {
  readonly githubLogin: string;
  readonly avatarUrl: string | null;
}): React.ReactElement {
  if (avatarUrl) {
    return (
      <GitHubAccountAvatar
        avatarUrl={avatarUrl}
        login={githubLogin}
        size="profile"
      />
    );
  }

  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-2xl border border-cyan-200/15 bg-cyan-300/[0.08] font-mono text-xs font-bold uppercase text-cyan-100 shadow-[0_0_24px_rgba(0,240,255,0.12)]">
      {githubLogin.slice(0, 1)}
    </span>
  );
}
