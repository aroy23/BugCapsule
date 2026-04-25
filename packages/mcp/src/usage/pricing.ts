import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Pricing } from "./types.js";

const DEFAULT_PRICING: Pricing = {
  model: "claude-sonnet",
  currency: "USD",
  input_per_million: 3,
  output_per_million: 15
};

export async function loadPricing(repoPath: string): Promise<Pricing> {
  const override = await tryReadPricing(path.join(repoPath, ".bugcapsule", "pricing.json"));
  if (override) {
    return override;
  }

  for (const candidate of bundledPricingCandidates()) {
    const bundled = await tryReadPricing(candidate);
    if (bundled) {
      return bundled;
    }
  }

  return { ...DEFAULT_PRICING };
}

export function costForTokens(pricing: Pricing, inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.input_per_million;
  const outputCost = (outputTokens / 1_000_000) * pricing.output_per_million;
  return inputCost + outputCost;
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) {
    return "$0.00";
  }

  const absolute = Math.abs(amount);
  const decimals = absolute >= 1 ? 2 : absolute >= 0.01 ? 4 : 6;
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${absolute.toFixed(decimals)}`;
}

async function tryReadPricing(filePath: string): Promise<Pricing | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<Pricing>;
    return normalizePricing(parsed);
  } catch {
    return null;
  }
}

function normalizePricing(value: Partial<Pricing>): Pricing {
  const inputPerMillion = Number(value.input_per_million);
  const outputPerMillion = Number(value.output_per_million);

  return {
    model: typeof value.model === "string" && value.model.length > 0 ? value.model : DEFAULT_PRICING.model,
    currency: typeof value.currency === "string" && value.currency.length > 0 ? value.currency : DEFAULT_PRICING.currency,
    input_per_million: Number.isFinite(inputPerMillion) ? inputPerMillion : DEFAULT_PRICING.input_per_million,
    output_per_million: Number.isFinite(outputPerMillion) ? outputPerMillion : DEFAULT_PRICING.output_per_million
  };
}

function bundledPricingCandidates(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [
    path.resolve(here, "..", "pricing.json"),
    path.resolve(here, "..", "..", "pricing.json"),
    path.resolve(here, "..", "..", "..", "pricing.json")
  ];
}
