import type { HTMLAttributes } from "react";
import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "../utils/cn";

const badgeStyles = tv({
  base: "inline-flex w-fit shrink-0 items-center whitespace-nowrap border font-semibold uppercase leading-none",
  variants: {
    tone: {
      neutral: "border-white/10 bg-white/[0.04] text-slate-200",
      accent: "border-cyan-300/20 bg-cyan-300/[0.08] text-cyan-100",
      success: "border-lime-300/20 bg-lime-300/[0.08] text-lime-100",
      warning: "border-amber-300/25 bg-amber-300/[0.08] text-amber-100",
      danger: "border-red-300/25 bg-red-300/[0.08] text-red-100",
    },
    size: {
      md: "rounded-full px-4 py-2 text-[0.68rem] tracking-[0.2em] shadow-[0_0_20px_rgba(0,240,255,0.08)]",
      xs: "rounded-md px-1.5 py-0.5 text-[0.56rem] tracking-[0.12em] shadow-none",
    },
  },
  defaultVariants: { tone: "neutral", size: "md" },
});

type BadgeVariants = VariantProps<typeof badgeStyles>;
export type BadgeProps = HTMLAttributes<HTMLSpanElement> & BadgeVariants;

export function Badge({
  className,
  size,
  tone,
  ...props
}: BadgeProps): React.ReactElement {
  return (
    <span className={cn(badgeStyles({ tone, size }), className)} {...props} />
  );
}
