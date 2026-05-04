"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "@reviewrouter/ui";

export type FormSubmitButtonProps = Omit<ButtonProps, "children" | "type"> & {
  readonly idleLabel: string;
  readonly pendingLabel: string;
};

export function FormSubmitButton({
  idleLabel,
  pendingLabel,
  disabled,
  ...props
}: FormSubmitButtonProps): React.ReactElement {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={disabled || pending} {...props}>
      {pending ? pendingLabel : idleLabel}
    </Button>
  );
}
