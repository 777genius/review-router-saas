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
    <Button
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending}
      {...props}
    >
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
          <span>{pendingLabel}</span>
        </span>
      ) : (
        idleLabel
      )}
    </Button>
  );
}
