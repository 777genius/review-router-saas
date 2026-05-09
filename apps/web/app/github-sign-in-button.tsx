"use client";

import { useState, type ReactNode } from "react";
import { signIn, signOut } from "next-auth/react";
import { Button, type ButtonProps } from "@reviewrouter/ui";

type GitHubSignInButtonProps = Omit<
  ButtonProps,
  "children" | "onClick" | "type"
> & {
  readonly callbackUrl: string;
  readonly children: ReactNode;
  readonly pendingLabel?: string;
};

export function GitHubSignInButton({
  callbackUrl,
  children,
  pendingLabel = "Opening GitHub...",
  ...props
}: GitHubSignInButtonProps): React.ReactElement {
  const [pending, setPending] = useState(false);

  return (
    <Button
      {...props}
      type="button"
      disabled={pending || props.disabled}
      aria-busy={pending}
      onClick={() => {
        setPending(true);
        startGitHubSignIn(callbackUrl, () => {
          setPending(false);
        });
      }}
    >
      {pending ? <ButtonPendingLabel label={pendingLabel} /> : children}
    </Button>
  );
}

type GitHubSignInInlineButtonProps = {
  readonly callbackUrl: string;
  readonly children: ReactNode;
  readonly className?: string;
};

export function GitHubSignInInlineButton({
  callbackUrl,
  children,
  className = "",
}: GitHubSignInInlineButtonProps): React.ReactElement {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending}
      className={[
        "inline cursor-pointer bg-transparent p-0 text-left disabled:cursor-wait disabled:opacity-70",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => {
        setPending(true);
        startGitHubSignIn(callbackUrl, () => {
          setPending(false);
        });
      }}
    >
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
          <span>Opening GitHub...</span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}

type GitHubSignOutButtonProps = Omit<
  ButtonProps,
  "children" | "onClick" | "type"
> & {
  readonly callbackUrl?: string;
  readonly children?: ReactNode;
  readonly pendingLabel?: string;
};

export function GitHubSignOutButton({
  callbackUrl = "/",
  children = "Sign out",
  pendingLabel = "Signing out...",
  ...props
}: GitHubSignOutButtonProps): React.ReactElement {
  const [pending, setPending] = useState(false);

  return (
    <Button
      {...props}
      type="button"
      disabled={pending || props.disabled}
      onClick={() => {
        setPending(true);
        void signOut({ callbackUrl }).finally(() => {
          setPending(false);
        });
      }}
    >
      {pending ? <ButtonPendingLabel label={pendingLabel} /> : children}
    </Button>
  );
}

function ButtonPendingLabel({ label }: { readonly label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
      />
      <span>{label}</span>
    </span>
  );
}

function startGitHubSignIn(callbackUrl: string, onSettled: () => void): void {
  const start = () => {
    void signIn("github", { callbackUrl }).finally(onSettled);
  };

  if (typeof window === "undefined") {
    start();
    return;
  }

  window.requestAnimationFrame(start);
}
