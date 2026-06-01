export type SourceProvider = "github" | "gitlab";

const sourceProviderMeta: Record<
  SourceProvider,
  { readonly name: string; readonly iconSrc: string }
> = {
  github: {
    name: "GitHub",
    iconSrc: "/service-icons/github.svg",
  },
  gitlab: {
    name: "GitLab",
    iconSrc: "/service-icons/gitlab.svg",
  },
};

export function sourceProviderName(provider: SourceProvider): string {
  return sourceProviderMeta[provider].name;
}

export function SourceProviderLogo({
  provider,
  className = "h-4 w-4",
}: {
  readonly provider: SourceProvider;
  readonly className?: string;
}): React.ReactElement {
  const meta = sourceProviderMeta[provider];

  return (
    <img aria-hidden="true" alt="" className={className} src={meta.iconSrc} />
  );
}

export function SourceProviderLabel({
  provider,
  label,
  className = "inline-flex items-center gap-2",
  logoClassName = "h-4 w-4",
}: {
  readonly provider: SourceProvider;
  readonly label?: string;
  readonly className?: string;
  readonly logoClassName?: string;
}): React.ReactElement {
  return (
    <span className={className}>
      <SourceProviderLogo provider={provider} className={logoClassName} />
      <span>{label ?? sourceProviderName(provider)}</span>
    </span>
  );
}
