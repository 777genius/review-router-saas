import type { HTMLAttributes } from "react";
import { cn } from "../utils/cn";

export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <section
      className={cn(
        "rounded-2xl border border-cyan-200/15 bg-slate-950/70 p-5 shadow-[var(--rr-shadow-glow-cyan)] backdrop-blur",
        className,
      )}
      {...props}
    />
  );
}
