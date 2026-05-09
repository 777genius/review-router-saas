"use client";

import { useMemo, useState, type HTMLAttributes } from "react";
import { cn } from "../utils/cn";

export type CodeBlockProps = HTMLAttributes<HTMLPreElement> & {
  readonly code: string;
  readonly language?: "bash" | "shell" | "json" | "yaml" | "text";
};

export function CodeBlock({
  code,
  language = "bash",
  className,
  ...props
}: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const highlightedCode = useMemo(
    () => highlightCode(code, language),
    [code, language],
  );

  async function copyCode(): Promise<void> {
    if (!navigator.clipboard) return;

    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          void copyCode();
        }}
        className="absolute right-2 top-2 z-10 rounded-full border border-cyan-200/15 bg-slate-950/85 px-3 py-1 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-cyan-100 shadow-[0_10px_30px_-22px_rgba(0,240,255,0.9)] transition hover:-translate-y-0.5 hover:border-cyan-200/35 hover:bg-cyan-300/[0.09] hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 active:translate-y-0"
        aria-label="Copy code"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-cyan-200/15 bg-black/60 p-4 font-mono text-sm leading-6 text-cyan-50",
          className,
          "pr-28",
        )}
        {...props}
      >
        <code>{highlightedCode}</code>
      </pre>
    </div>
  );
}

function highlightCode(
  code: string,
  language: NonNullable<CodeBlockProps["language"]>,
): React.ReactNode {
  if (language !== "bash" && language !== "shell") {
    return code;
  }

  return code.split(/(\s+|\||=)/).map((token, index) => {
    if (!token) return null;
    if (/^\s+$/.test(token)) return token;

    const className = getBashTokenClassName(token);
    return className ? (
      <span key={`${token}-${index}`} className={className}>
        {token}
      </span>
    ) : (
      token
    );
  });
}

function getBashTokenClassName(token: string): string | null {
  if (token === "|") return "text-fuchsia-200";
  if (token === "=") return "text-slate-500";
  if (/^-{1,2}[\w-]+$/.test(token)) return "text-amber-100";
  if (/^https?:\/\//.test(token)) return "text-cyan-200";
  if (/^[A-Z][A-Z0-9_]+$/.test(token)) return "text-lime-200";
  if (/^(bash|cat|codex|curl|gh|git|node|npm|pnpm)$/.test(token)) {
    return "text-emerald-200";
  }
  return null;
}
