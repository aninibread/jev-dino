/**
 * Estimated Jev cost for Workers AI `typesafe/jev`.
 *
 * Cloudflare’s catalog points at the dashboard for Workers AI pricing.
 * TypeSafe / OpenRouter publish $0.042 per 1M input tokens (output free).
 * We use that published rate for an on-screen estimate.
 *
 * @see https://developers.cloudflare.com/workers-ai/platform/pricing/
 * @see https://jevaiguide.com/jev-pricing/
 */

/** USD per million input tokens (output tokens are free on TypeSafe). */
export const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;

/**
 * Fallback when the model response has no usage block.
 * Typical short state+questions asks land around 300–450 tokens.
 */
export const JEV_FALLBACK_INPUT_TOKENS = 400;

export type JevUsage = {
  inputTokens: number;
  costUsd: number;
};

export function costUsdForInputTokens(inputTokens: number): number {
  const safe = Math.max(0, Number(inputTokens) || 0);
  return (safe / 1_000_000) * JEV_USD_PER_MILLION_INPUT_TOKENS;
}

export function usageFromInputTokens(inputTokens: number): JevUsage {
  const tokens = Math.max(0, Math.round(Number(inputTokens) || 0));
  return {
    inputTokens: tokens,
    costUsd: costUsdForInputTokens(tokens),
  };
}

/** Rough token estimate from serialized ask payload when usage is missing. */
export function estimateInputTokensFromPayload(payload: unknown): number {
  try {
    const chars = JSON.stringify(payload)?.length ?? 0;
    return Math.max(JEV_FALLBACK_INPUT_TOKENS, Math.ceil(chars / 4));
  } catch {
    return JEV_FALLBACK_INPUT_TOKENS;
  }
}

/** Parse Workers AI / TypeSafe usage shapes into input token count. */
export function parseInputTokensFromResult(result: unknown): number | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const root = result as Record<string, unknown>;
  const usage =
    root.usage && typeof root.usage === "object" && !Array.isArray(root.usage)
      ? (root.usage as Record<string, unknown>)
      : null;
  if (!usage) return null;

  for (const key of [
    "input_tokens",
    "prompt_tokens",
    "total_tokens",
  ] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
  }
  return null;
}

export function formatJevCostUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return "$0";
  if (costUsd < 0.0001) return `$${costUsd.toFixed(6)}`;
  if (costUsd < 0.01) return `$${costUsd.toFixed(5)}`;
  if (costUsd < 1) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}
