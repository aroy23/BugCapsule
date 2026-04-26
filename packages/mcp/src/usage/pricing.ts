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

export type PricingConfig = Partial<Pricing> & {
  profile?: string;
};

export type PricingCatalogProfile = {
  id: string;
  provider: string;
  model: string;
  displayName?: string;
  currency?: string;
  input_per_million?: number;
  cached_input_per_million?: number;
  output_per_million?: number;
  evaluation_encoding?: string;
  source?: string;
  verifiedAt?: string;
  notes?: string;
  requiresManualPrice?: boolean;
  pricingStatus?: string;
};

type PricingCatalog = {
  schemaVersion?: string;
  profiles?: PricingCatalogProfile[];
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

export async function hasRepoPricingConfig(repoPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(repoPath, ".bugcapsule", "pricing.json"), "utf8");
  } catch {
    return false;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return true;
  }
}

export async function loadPricingCatalog(): Promise<PricingCatalogProfile[]> {
  for (const candidate of bundledPricingCatalogCandidates()) {
    const catalog = await tryReadPricingCatalog(candidate);
    if (catalog) {
      return catalog;
    }
  }

  return [];
}

export async function resolvePricingConfig(value: PricingConfig): Promise<Pricing> {
  const catalogProfile = value.profile ? await findPricingProfile(value.profile) : undefined;
  if (value.profile && !catalogProfile) {
    throw new Error(`Unknown pricing profile '${value.profile}'.`);
  }

  const inputPerMillion = numberValue(value.input_per_million) ?? catalogProfile?.input_per_million;
  const outputPerMillion = numberValue(value.output_per_million) ?? catalogProfile?.output_per_million;
  const displayName = stringValue(value.displayName) ?? catalogProfile?.displayName;
  const cachedInputPerMillion = numberValue(value.cached_input_per_million) ?? catalogProfile?.cached_input_per_million;
  const evaluationEncoding = stringValue(value.evaluation_encoding) ?? catalogProfile?.evaluation_encoding;
  const source = stringValue(value.source) ?? catalogProfile?.source;
  const verifiedAt = stringValue(value.verifiedAt) ?? catalogProfile?.verifiedAt;
  const notes = stringValue(value.notes) ?? catalogProfile?.notes;

  if (value.profile && (inputPerMillion === undefined || outputPerMillion === undefined)) {
    throw new Error(`Pricing profile '${value.profile}' requires input_per_million and output_per_million overrides.`);
  }

  return {
    ...(value.profile ? { profile: value.profile } : {}),
    ...(catalogProfile?.provider ? { provider: catalogProfile.provider } : {}),
    model: stringValue(value.model) ?? catalogProfile?.model ?? DEFAULT_PRICING.model,
    ...(displayName ? { displayName } : {}),
    currency: stringValue(value.currency) ?? catalogProfile?.currency ?? DEFAULT_PRICING.currency,
    input_per_million: inputPerMillion ?? DEFAULT_PRICING.input_per_million,
    ...(cachedInputPerMillion !== undefined ? { cached_input_per_million: cachedInputPerMillion } : {}),
    output_per_million: outputPerMillion ?? DEFAULT_PRICING.output_per_million,
    ...(evaluationEncoding ? { evaluation_encoding: evaluationEncoding } : {}),
    ...(source ? { source } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(notes ? { notes } : {})
  };
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
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const parsed = JSON.parse(raw) as PricingConfig;
  return resolvePricingConfig(parsed);
}

async function tryReadPricingCatalog(filePath: string): Promise<PricingCatalogProfile[] | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PricingCatalog;
    return Array.isArray(parsed.profiles) ? parsed.profiles : null;
  } catch {
    return null;
  }
}

async function findPricingProfile(profileId: string): Promise<PricingCatalogProfile | undefined> {
  const profiles = await loadPricingCatalog();
  return profiles.find((profile) => profile.id === profileId);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bundledPricingCandidates(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [
    path.resolve(here, "..", "pricing.json"),
    path.resolve(here, "..", "..", "pricing.json"),
    path.resolve(here, "..", "..", "..", "pricing.json")
  ];
}

function bundledPricingCatalogCandidates(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [
    path.resolve(here, "..", "pricing-catalog.json"),
    path.resolve(here, "..", "..", "pricing-catalog.json"),
    path.resolve(here, "..", "..", "..", "pricing-catalog.json")
  ];
}
