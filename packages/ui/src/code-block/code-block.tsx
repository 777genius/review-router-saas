import type { HTMLAttributes } from "react";
import { cn } from "../utils/cn";

export type CodeBlockProps = HTMLAttributes<HTMLPreElement> & {
  readonly code: string;
};

export function CodeBlock({
  code,
  className,
  ...props
}: CodeBlockProps): React.ReactElement {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-xl border border-cyan-200/15 bg-black/60 p-4 font-mono text-sm text-cyan-50",
        className,
      )}
      {...props}
    >
      <code>{code}</code>
    </pre>
  );
}
