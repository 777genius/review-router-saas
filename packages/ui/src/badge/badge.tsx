import type { HTMLAttributes } from "react";
import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "../utils/cn";

const badgeStyles = tv({
  base: "inline-flex w-fit shrink-0 items-center rounded-full border px-4 py-2 text-[0.68rem] font-semibold uppercase leading-none tracking-[0.2em] shadow-[0_0_20px_rgba(0,240,255,0.08)]",
  variants: {
    tone: {
      neutral: "border-white/10 bg-white/[0.04] text-slate-200",
      accent: "border-cyan-300/20 bg-cyan-300/[0.08] text-cyan-100",
      success: "border-lime-300/20 bg-lime-300/[0.08] text-lime-100",
      warning: "border-amber-300/25 bg-amber-300/[0.08] text-amber-100",
      danger: "border-red-300/25 bg-red-300/[0.08] text-red-100",
    },
  },
  defaultVariants: { tone: "neutral" },
});

type BadgeVariants = VariantProps<typeof badgeStyles>;
export type BadgeProps = HTMLAttributes<HTMLSpanElement> & BadgeVariants;

export function Badge({
  className,
  tone,
  ...props
}: BadgeProps): React.ReactElement {
  return <span className={cn(badgeStyles({ tone }), className)} {...props} />;
}
