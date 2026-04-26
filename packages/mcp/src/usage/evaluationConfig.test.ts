import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveEvaluationConfig } from "./evaluationConfig.js";

describe("evaluation config", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bugcapsule-evaluation-config-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("enables evaluation from repo pricing config without explicit prompt args", async () => {
    await writeRepoPricing({ profile: "windsurf:swe-1.6-fast" });

    const config = await resolveEvaluationConfig({ repoPath: tempRoot });

    expect(config).toEqual({
      status: "enabled",
      evaluationModel: "SWE-1.6 Fast",
      evaluationEncoding: "o200k_base",
      inputPricePerMillion: 0.3,
      outputPricePerMillion: 1.5
    });
  });

  it("does not enable evaluation by default without repo pricing config", async () => {
    await expect(resolveEvaluationConfig({ repoPath: tempRoot })).resolves.toEqual({ status: "disabled" });
  });

  it("does not auto-enable from an empty repo pricing config", async () => {
    await writeRepoPricing({});

    await expect(resolveEvaluationConfig({ repoPath: tempRoot })).resolves.toEqual({ status: "disabled" });
  });

  it("allows generateEvaluation false to opt out even when repo pricing is configured", async () => {
    await writeRepoPricing({ profile: "windsurf:swe-1.6-fast" });

    await expect(resolveEvaluationConfig({ repoPath: tempRoot, generateEvaluation: false })).resolves.toEqual({ status: "disabled" });
  });

  it("surfaces invalid auto-enabled repo pricing", async () => {
    await writeRepoPricing({ profile: "windsurf:swe-1.6" });

    const config = await resolveEvaluationConfig({ repoPath: tempRoot });

    expect(config.status).toBe("invalid");
    if (config.status === "invalid") {
      expect(config.message).toContain("requires input_per_million and output_per_million overrides");
    }
  });

  async function writeRepoPricing(value: Record<string, unknown>): Promise<void> {
    const configDir = path.join(tempRoot, ".bugcapsule");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "pricing.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
});
