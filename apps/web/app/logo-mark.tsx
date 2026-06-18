type LogoMarkProps = {
  readonly size?: "xs" | "sm" | "md" | "lg";
  readonly className?: string;
};

const sizeClasses = {
  xs: "h-9 w-9 rounded-lg",
  sm: "h-11 w-11 rounded-xl",
  md: "h-16 w-16 rounded-2xl",
  lg: "h-20 w-20 rounded-[1.35rem]",
} as const;

export function LogoMark({
  size = "sm",
  className = "",
}: LogoMarkProps): React.ReactElement {
  return (
    <span
      className={[
        "grid shrink-0 place-items-center border border-cyan-200/10 bg-white/[0.03] p-0.5 shadow-[0_0_32px_rgba(0,240,255,0.16)]",
        sizeClasses[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      <img
        src="/review-router-logo.png"
        alt=""
        className="h-full w-full object-contain drop-shadow-[0_0_18px_rgba(0,240,255,0.18)]"
        draggable={false}
      />
    </span>
  );
}
