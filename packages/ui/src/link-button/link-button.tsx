import type { AnchorHTMLAttributes } from "react";
import type { VariantProps } from "tailwind-variants";
import { buttonStyles } from "../button/button-styles";
import { cn } from "../utils/cn";

type LinkButtonVariants = VariantProps<typeof buttonStyles>;
export type LinkButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> &
  LinkButtonVariants & {
    readonly href: string;
  };

export function LinkButton({
  className,
  variant,
  tone,
  size,
  ...props
}: LinkButtonProps): React.ReactElement {
  return (
    <a
      className={cn(buttonStyles({ variant, tone, size }), className)}
      {...props}
    />
  );
}
