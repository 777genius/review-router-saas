import type { HTMLAttributes } from "react";
import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "../utils/cn";

const badgeStyles = tv({
  base: "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
  variants: {
    tone: {
      neutral: "border-slate-300/20 bg-slate-300/10 text-slate-100",
      accent: "border-cyan-300/30 bg-cyan-300/10 text-cyan-100",
      success: "border-lime-300/30 bg-lime-300/10 text-lime-100",
      warning: "border-amber-300/30 bg-amber-300/10 text-amber-100",
      danger: "border-red-300/30 bg-red-300/10 text-red-100",
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
