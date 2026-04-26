import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { costForTokens, loadPricing, loadPricingCatalog, resolvePricingConfig } from "./pricing.js";

describe("pricing profiles", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bugcapsule-pricing-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("loads the SWE-1.6 Fast catalog profile from repo pricing config", async () => {
    await writeRepoPricing({ profile: "windsurf:swe-1.6-fast" });

    const pricing = await loadPricing(tempRoot);

    expect(pricing.profile).toBe("windsurf:swe-1.6-fast");
    expect(pricing.provider).toBe("Windsurf");
    expect(pricing.model).toBe("SWE-1.6 Fast");
    expect(pricing.input_per_million).toBe(0.3);
    expect(pricing.cached_input_per_million).toBe(0.03);
    expect(pricing.output_per_million).toBe(1.5);
    expect(pricing.evaluation_encoding).toBe("o200k_base");
  });

  it("preserves cached input price while normal cost uses standard input and output prices", async () => {
    const catalog = await loadPricingCatalog();
    const profile = catalog.find((entry) => entry.id === "windsurf:swe-1.6-fast");

    expect(profile?.cached_input_per_million).toBe(0.03);

    const pricing = await resolvePricingConfig({ profile: "windsurf:swe-1.6-fast" });
    expect(costForTokens(pricing, 1_000_000, 1_000_000)).toBeCloseTo(1.8);
  });

  it("allows manual overrides on top of a catalog profile", async () => {
    await writeRepoPricing({
      profile: "windsurf:swe-1.6-fast",
      input_per_million: 0.4,
      output_per_million: 2
    });

    const pricing = await loadPricing(tempRoot);

    expect(pricing.model).toBe("SWE-1.6 Fast");
    expect(pricing.input_per_million).toBe(0.4);
    expect(pricing.cached_input_per_million).toBe(0.03);
    expect(pricing.output_per_million).toBe(2);
  });

  it("requires manual prices for profiles without public bundled pricing", async () => {
    await expect(resolvePricingConfig({ profile: "windsurf:swe-1.6" })).rejects.toThrow(
      "requires input_per_million and output_per_million overrides"
    );
  });

  async function writeRepoPricing(value: Record<string, unknown>): Promise<void> {
    const configDir = path.join(tempRoot, ".bugcapsule");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "pricing.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
});
