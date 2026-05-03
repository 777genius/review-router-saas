"use client";

import { forwardRef } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "../utils/cn";

const buttonStyles = tv({
  base: "inline-flex items-center justify-center rounded-lg border font-medium tracking-wide transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
  variants: {
    variant: {
      solid:
        "border-cyan-300/50 bg-cyan-300 text-slate-950 shadow-[var(--rr-shadow-glow-cyan)] hover:bg-cyan-200",
      soft: "border-cyan-300/25 bg-cyan-300/10 text-cyan-100 hover:bg-cyan-300/15",
      outline:
        "border-cyan-300/40 bg-transparent text-cyan-100 hover:bg-cyan-300/10",
      ghost:
        "border-transparent bg-transparent text-cyan-100 hover:bg-cyan-300/10",
    },
    tone: {
      neutral: "",
      accent: "",
      success: "border-lime-300/40 text-lime-100",
      warning: "border-amber-300/40 text-amber-100",
      danger: "border-red-300/40 text-red-100",
    },
    size: {
      sm: "h-9 px-3 text-sm",
      md: "h-10 px-4 text-sm",
      lg: "h-12 px-5 text-base",
    },
  },
  defaultVariants: {
    variant: "solid",
    tone: "accent",
    size: "md",
  },
});

type ButtonVariants = VariantProps<typeof buttonStyles>;
export type ButtonProps = React.ComponentPropsWithoutRef<typeof BaseButton> &
  ButtonVariants;

export const Button = forwardRef<
  React.ElementRef<typeof BaseButton>,
  ButtonProps
>(({ className, variant, tone, size, ...props }, ref) => (
  <BaseButton
    ref={ref}
    className={cn(buttonStyles({ variant, tone, size }), className)}
    {...props}
  />
));
Button.displayName = "Button";
