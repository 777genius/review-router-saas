"use client";

import { forwardRef } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import type { VariantProps } from "tailwind-variants";
import { buttonStyles } from "./button-styles";
import { cn } from "../utils/cn";

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
