"use client";

import { useState, type MouseEvent } from "react";
import { LinkButton, type LinkButtonProps } from "@reviewrouter/ui";

type LoadingLinkButtonProps = LinkButtonProps & {
  readonly pendingLabel?: string;
};

export function LoadingLinkButton({
  children,
  pendingLabel = "Opening...",
  onClick,
  ...props
}: LoadingLinkButtonProps): React.ReactElement {
  const [pending, setPending] = useState(false);

  return (
    <LinkButton
      {...props}
      aria-busy={pending}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          setPending(true);
        }
      }}
    >
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
          <span>{pendingLabel}</span>
        </span>
      ) : (
        children
      )}
    </LinkButton>
  );
}
