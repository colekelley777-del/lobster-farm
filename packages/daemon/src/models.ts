import type { ModelName, ModelTier, ThinkLevel } from "@lobster-farm/shared";

/** Map abstract model names to Claude CLI model identifiers. */
const MODEL_IDS: Record<ModelName, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/**
 * Map think levels to Claude CLI effort flags.
 * "none" maps to "low" (not null) because Claude CLI's --effort low is the
 * correct way to suppress extended thinking. Omitting --effort entirely would
 * leave it at the model's default (which may include thinking).
 */
const EFFORT_MAP: Record<ThinkLevel, string | null> = {
  none: "low",
  standard: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Resolve a ModelTier to a Claude CLI model ID string. */
export function resolve_model_id(tier: ModelTier): string {
  return MODEL_IDS[tier.model];
}

/** Resolve a ThinkLevel to a Claude CLI effort flag value, or null if not applicable. */
export function resolve_effort(think: ThinkLevel): string | null {
  return EFFORT_MAP[think];
}

/** Build the model-related CLI flags for a given ModelTier. */
export function build_model_flags(tier: ModelTier): string[] {
  const flags = ["--model", resolve_model_id(tier)];
  const effort = resolve_effort(tier.think);
  if (effort) {
    flags.push("--effort", effort);
  }
  return flags;
}
