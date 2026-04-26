import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { estimateCapsuleTokens, estimateRepoTokens } from "./repoTokens.js";
import { estimateTokens } from "./tokenizer.js";

describe("repo token estimates", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bugcapsule-repo-tokens-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("excludes lockfiles and generated runtime lineage artifacts", async () => {
    const repoPackage = "{\"name\":\"demo\"}\n";
    const repoSource = "export const value = 'repo';\n";
    const capsulePackage = "{\"scripts\":{\"repro\":\"tsx .bugcapsule/repros/cap-001.ts\"}}\n";
    const capsuleSource = "export const value = 'capsule';\n";
    const reproSource = "export const repro = 1;\n";
    const largeGeneratedContent = "generated runtime lineage artifact\n".repeat(200);

    await fs.writeFile(path.join(tempRoot, "package.json"), repoPackage, "utf8");
    await fs.writeFile(path.join(tempRoot, "package-lock.json"), "lockfile\n".repeat(200), "utf8");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "index.ts"), repoSource, "utf8");

    const capsuleRoot = path.join(tempRoot, ".bugcapsule", "capsules", "cap-001");
    await fs.mkdir(path.join(capsuleRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(capsuleRoot, "package.json"), capsulePackage, "utf8");
    await fs.writeFile(path.join(capsuleRoot, "package-lock.json"), "capsule lockfile\n".repeat(200), "utf8");
    await fs.writeFile(path.join(capsuleRoot, "src", "index.ts"), capsuleSource, "utf8");
    await fs.mkdir(path.join(capsuleRoot, ".bugcapsule", "repros", "cap-001.lineage", "modules", "src"), { recursive: true });
    await fs.writeFile(path.join(capsuleRoot, ".bugcapsule", "repros", "cap-001.ts"), reproSource, "utf8");
    await fs.writeFile(path.join(capsuleRoot, ".bugcapsule", "repros", "cap-001.lineage.json"), largeGeneratedContent, "utf8");
    await fs.writeFile(
      path.join(capsuleRoot, ".bugcapsule", "repros", "cap-001.lineage", "modules", "src", "index.ts"),
      largeGeneratedContent,
      "utf8"
    );

    expect(await estimateRepoTokens(tempRoot)).toBe(
      estimateTokens(repoPackage) + estimateTokens(repoSource)
    );
    expect(await estimateCapsuleTokens(tempRoot, "cap-001")).toBe(
      estimateTokens(capsulePackage) + estimateTokens(capsuleSource) + estimateTokens(reproSource)
    );
  });
});
