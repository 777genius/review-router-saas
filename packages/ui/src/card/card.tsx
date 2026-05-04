import type { HTMLAttributes } from "react";
import { cn } from "../utils/cn";

export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 shadow-[0_16px_32px_-10px_rgba(0,0,0,0.35),0_0_50px_-28px_rgba(0,240,255,0.45)] backdrop-blur-2xl",
        className,
      )}
      {...props}
    />
  );
}
