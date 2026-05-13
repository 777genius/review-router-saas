import type { ProviderKind } from "./provider-catalog";

export type ReviewModelOption = {
  readonly value: string;
  readonly label: string;
  readonly provider: ProviderKind;
  readonly description?: string;
  readonly badge?: "FREE RECOMMENDED" | "FREE" | "PAID" | "Unsupported";
  readonly disabled?: boolean;
};

export const codexModelOptions: readonly ReviewModelOption[] = [
  {
    value: "gpt-5.5",
    label: "gpt-5.5",
    provider: "codex",
    description: "Codex default model.",
  },
  {
    value: "gpt-5.4",
    label: "gpt-5.4",
    provider: "codex",
    description: "Codex model.",
  },
  {
    value: "gpt-5.4-mini",
    label: "gpt-5.4-mini",
    provider: "codex",
    description: "Lower-latency Codex model.",
  },
  {
    value: "gpt-5.3-codex",
    label: "gpt-5.3-codex",
    provider: "codex",
    description: "Codex-specialized model.",
  },
  {
    value: "gpt-5.3-codex-spark",
    label: "gpt-5.3-codex-spark",
    provider: "codex",
    description: "Fast Codex-specialized model.",
  },
  {
    value: "gpt-5.2",
    label: "gpt-5.2",
    provider: "codex",
    description: "Codex model.",
  },
];

export const claudeModelOptions: readonly ReviewModelOption[] = [
  {
    value: "sonnet",
    label: "sonnet",
    provider: "claude",
    description: "Claude Code default model.",
  },
  {
    value: "opus",
    label: "opus",
    provider: "claude",
    description: "Claude Code model.",
  },
  {
    value: "haiku",
    label: "haiku",
    provider: "claude",
    description: "Lower-latency Claude Code model.",
  },
];

export function listStaticReviewModelOptions(): readonly ReviewModelOption[] {
  return [...codexModelOptions, ...claudeModelOptions];
}
