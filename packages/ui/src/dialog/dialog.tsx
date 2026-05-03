"use client";

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { cn } from "../utils/cn";

export const DialogRoot = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;
export const DialogPortal = BaseDialog.Portal;

export function DialogBackdrop(
  props: React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop>,
): React.ReactElement {
  return (
    <BaseDialog.Backdrop
      {...props}
      className={cn(
        "fixed inset-0 bg-black/70 backdrop-blur-sm",
        props.className,
      )}
    />
  );
}

export function DialogPopup(
  props: React.ComponentPropsWithoutRef<typeof BaseDialog.Popup>,
): React.ReactElement {
  return (
    <BaseDialog.Popup
      {...props}
      className={cn(
        "fixed left-1/2 top-1/2 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-cyan-200/20 bg-slate-950 p-6 text-cyan-50 shadow-[var(--rr-shadow-glow-cyan)]",
        props.className,
      )}
    />
  );
}

export const DialogTitle = BaseDialog.Title;
export const DialogDescription = BaseDialog.Description;

export const Dialog = {
  Root: DialogRoot,
  Trigger: DialogTrigger,
  Close: DialogClose,
  Portal: DialogPortal,
  Backdrop: DialogBackdrop,
  Popup: DialogPopup,
  Title: DialogTitle,
  Description: DialogDescription,
};
