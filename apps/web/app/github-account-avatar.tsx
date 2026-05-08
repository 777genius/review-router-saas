type GitHubAccountAvatarProps = {
  readonly avatarUrl?: string | null | undefined;
  readonly login: string;
  readonly size?: "sm" | "md" | "profile";
  readonly className?: string;
};

const sizeClasses = {
  sm: "h-7 w-7 rounded-xl",
  md: "h-10 w-10 rounded-2xl",
  profile: "h-8 w-8 rounded-2xl",
} as const;

export function GitHubAccountAvatar({
  avatarUrl,
  login,
  size = "sm",
  className = "",
}: GitHubAccountAvatarProps): React.ReactElement | null {
  if (!avatarUrl) return null;

  return (
    <span
      className={[
        "grid shrink-0 place-items-center overflow-hidden border border-cyan-200/15 bg-white/[0.04] p-0.5 shadow-[0_0_24px_rgba(0,240,255,0.12)]",
        sizeClasses[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <img
        src={avatarUrl}
        alt={`${login} GitHub avatar`}
        className="h-full w-full rounded-[inherit] object-cover"
        draggable={false}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    </span>
  );
}
