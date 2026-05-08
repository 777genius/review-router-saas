"use client";

import { useEffect, useRef, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!githubLogin) {
    return (
      <GitHubSignInButton
        callbackUrl="/dashboard"
        variant="ghost"
        size="sm"
        className="rounded-xl border border-cyan-200/20 px-3 font-mono text-[0.68rem] uppercase tracking-[0.14em] text-cyan-100"
      >
        Sign in
      </GitHubSignInButton>
    );
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Open profile menu for ${githubLogin}`}
        className="group inline-flex min-h-11 items-center gap-2 rounded-2xl border border-cyan-200/15 bg-white/[0.035] px-2.5 py-2 text-left transition hover:border-cyan-200/40 hover:bg-cyan-300/[0.08] hover:shadow-[0_0_28px_-18px_rgba(0,240,255,0.95)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className="hidden max-w-32 truncate font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-cyan-100 sm:inline">
          {githubLogin}
        </span>
        <ProfileAvatar githubLogin={githubLogin} avatarUrl={githubAvatarUrl} />
        <span className="text-cyan-100/70 transition group-hover:text-cyan-50">
          {open ? "⌃" : "⌄"}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Profile menu"
          className="absolute right-0 top-full z-50 mt-3 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-cyan-200/15 bg-[#090d17]/95 p-3 shadow-[0_24px_70px_rgba(0,0,0,0.55),0_0_60px_-42px_rgba(0,240,255,0.9)] backdrop-blur-2xl"
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
          <GitHubSignOutButton
            variant="ghost"
            size="sm"
            className="mt-2 w-full justify-center rounded-xl border border-white/10 text-cyan-100 hover:border-cyan-200/30 hover:bg-cyan-300/[0.08]"
          />
        </div>
      ) : null}
    </div>
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
