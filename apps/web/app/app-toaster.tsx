"use client";

import { Toaster } from "sonner";

const TOAST_DURATION_MS = 10000;

export function AppToaster(): React.ReactElement {
  return (
    <Toaster
      position="top-right"
      duration={TOAST_DURATION_MS}
      expand
      gap={12}
      visibleToasts={5}
      offset={{ top: "6rem", right: "1rem" }}
      mobileOffset={{ top: "5rem", right: "1rem", left: "1rem" }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "pointer-events-auto w-[calc(100vw-2rem)] max-w-md sm:w-[28rem]",
        },
      }}
    />
  );
}
