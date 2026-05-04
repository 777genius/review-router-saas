type LogoMarkProps = {
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
};

const sizeClasses = {
  sm: "h-10 w-10 rounded-xl",
  md: "h-14 w-14 rounded-2xl",
  lg: "h-16 w-16 rounded-2xl",
} as const;

export function LogoMark({
  size = "sm",
  className = "",
}: LogoMarkProps): React.ReactElement {
  return (
    <span
      className={[
        "grid shrink-0 place-items-center border border-cyan-200/15 bg-white/[0.04] p-1 shadow-[0_0_32px_rgba(0,240,255,0.16)]",
        sizeClasses[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      <img
        src="/icon.svg"
        alt=""
        className="h-full w-full rounded-[inherit]"
        draggable={false}
      />
    </span>
  );
}
