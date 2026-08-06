export type InvestigationTokenUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}>;

export function isValidInvestigationTokenUsage(
  usage: InvestigationTokenUsage,
): boolean {
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.cachedInputTokens) &&
    usage.cachedInputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0 &&
    Number.isSafeInteger(usage.reasoningOutputTokens) &&
    usage.reasoningOutputTokens >= 0 &&
    Number.isSafeInteger(usage.totalTokens) &&
    usage.totalTokens >= 0 &&
    usage.cachedInputTokens <= usage.inputTokens &&
    usage.reasoningOutputTokens <= usage.outputTokens &&
    usage.totalTokens === usage.inputTokens + usage.outputTokens
  );
}
