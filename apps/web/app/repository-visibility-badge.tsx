import { Badge } from "@reviewrouter/ui";

type RepositoryVisibilityBadgeProps = {
  readonly visibility: string;
};

export function RepositoryVisibilityBadge({
  visibility,
}: RepositoryVisibilityBadgeProps): React.ReactElement {
  const view = repositoryVisibilityView(visibility);

  return (
    <Badge tone={view.tone} className="gap-1.5 px-2.5 py-1 text-[0.62rem]">
      <VisibilityIcon kind={view.kind} />
      <span>{view.label}</span>
    </Badge>
  );
}

function repositoryVisibilityView(visibility: string): {
  readonly kind: "public" | "private" | "internal";
  readonly label: string;
  readonly tone: "success" | "warning" | "accent";
} {
  const normalized = visibility.toLowerCase();
  if (normalized === "private") {
    return { kind: "private", label: "Private", tone: "warning" };
  }
  if (normalized === "internal") {
    return { kind: "internal", label: "Internal", tone: "accent" };
  }
  return { kind: "public", label: "Public", tone: "success" };
}

function VisibilityIcon({
  kind,
}: {
  readonly kind: "public" | "private" | "internal";
}): React.ReactElement {
  if (kind === "private") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
      >
        <path
          d="M4.75 7V5.5a3.25 3.25 0 0 1 6.5 0V7"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <rect
          x="3.25"
          y="6.75"
          width="9.5"
          height="7"
          rx="1.6"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    );
  }

  if (kind === "internal") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
      >
        <path
          d="M3 13.25V4.2c0-.8.5-1.5 1.25-1.75L8 1.25l3.75 1.2C12.5 2.7 13 3.4 13 4.2v9.05"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M5.5 6h5M5.5 8.5h5M6 13.25V11h4v2.25"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
    >
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2.8 8h10.4M8 2.5c1.45 1.55 2.2 3.35 2.2 5.5s-.75 3.95-2.2 5.5C6.55 11.95 5.8 10.15 5.8 8S6.55 4.05 8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
