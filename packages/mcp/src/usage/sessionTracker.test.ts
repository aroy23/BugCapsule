import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionTracker } from "./sessionTracker.js";

describe("SessionTracker", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bugcapsule-usage-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("writes JSON + Markdown logs when a session is finalized via apply_patch", async () => {
    await seedFakeRepo(tempRoot);

    const tracker = new SessionTracker();
    const baseTimestamp = new Date("2026-04-25T21:18:00.123Z").toISOString();

    await tracker.recordCall({
      tool: "bugcapsule_create_from_command",
      repoPath: tempRoot,
      capsuleIdHint: "cap-001",
      inputTokens: 8500,
      outputTokens: 2100,
      durationMs: 1830,
      timestamp: baseTimestamp
    });

    await tracker.recordCall({
      tool: "bugcapsule_apply_patch",
      repoPath: tempRoot,
      capsuleIdHint: "cap-001",
      inputTokens: 200,
      outputTokens: 80,
      durationMs: 240,
      timestamp: new Date("2026-04-25T21:19:00.000Z").toISOString()
    });

    await tracker.finalizeSession(tempRoot, "apply_patch");

    const logsDir = path.join(tempRoot, ".bugcapsule", "logs");
    const entries = (await fs.readdir(logsDir)).sort();
    const jsonFile = entries.find((name) => name.endsWith("-session.json"));
    const mdFile = entries.find((name) => name.endsWith("-summary.md"));
    expect(jsonFile, `expected JSON log in ${entries.join(", ")}`).toBeDefined();
    expect(mdFile, `expected Markdown summary in ${entries.join(", ")}`).toBeDefined();

    const jsonRaw = await fs.readFile(path.join(logsDir, jsonFile!), "utf8");
    const log = JSON.parse(jsonRaw) as Record<string, unknown>;

    expect(log.repoPath).toBe(tempRoot);
    expect(log.totalInputTokens).toBe(8700);
    expect(log.totalOutputTokens).toBe(2180);
    expect(typeof log.totalCost).toBe("string");
    expect(Array.isArray(log.calls)).toBe(true);
    expect((log.calls as unknown[]).length).toBe(2);

    const comparison = log.comparison as Record<string, number | string>;
    expect(typeof comparison.estimatedFullRepoTokens).toBe("number");
    expect(typeof comparison.capsuleTokens).toBe("number");
    expect(comparison.estimatedFullRepoTokens).toBeGreaterThan(0);
    expect(comparison.capsuleTokens).toBeGreaterThan(0);
    expect(typeof comparison.estimatedFullRepoCost).toBe("string");
    expect(typeof comparison.actualCost).toBe("string");
    expect(typeof comparison.tokenSavingsPercent).toBe("number");
    expect(typeof comparison.costSavingsPercent).toBe("number");

    const md = await fs.readFile(path.join(logsDir, mdFile!), "utf8");
    expect(md).toContain("BugCapsule Session");
    expect(md).toContain("bugcapsule_create_from_command");
    expect(md).toContain("bugcapsule_apply_patch");
    expect(md).toMatch(/Saved ~\d+(?:\.\d+)?% on cost/);
  });

  it("uses repo-level pricing override when present", async () => {
    await seedFakeRepo(tempRoot);
    const overrideDir = path.join(tempRoot, ".bugcapsule");
    await fs.mkdir(overrideDir, { recursive: true });
    await fs.writeFile(
      path.join(overrideDir, "pricing.json"),
      JSON.stringify({ model: "test-model", currency: "USD", input_per_million: 100, output_per_million: 200 }),
      "utf8"
    );

    const tracker = new SessionTracker();
    await tracker.recordCall({
      tool: "bugcapsule_run",
      repoPath: tempRoot,
      inputTokens: 1_000_000,
      outputTokens: 0,
      durationMs: 10,
      timestamp: new Date().toISOString()
    });
    await tracker.finalizeSession(tempRoot, "shutdown");

    const logsDir = path.join(tempRoot, ".bugcapsule", "logs");
    const entries = await fs.readdir(logsDir);
    const jsonFile = entries.find((name) => name.endsWith("-session.json"));
    expect(jsonFile).toBeDefined();
    const log = JSON.parse(await fs.readFile(path.join(logsDir, jsonFile!), "utf8")) as Record<string, unknown>;
    const pricing = log.pricing as Record<string, unknown>;
    expect(pricing.model).toBe("test-model");
    expect(pricing.input_per_million).toBe(100);
    expect(log.totalCost).toBe("$100.00");
  });
});

async function seedFakeRepo(rootPath: string): Promise<void> {
  await fs.writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "demo", version: "0.0.0" }, null, 2),
    "utf8"
  );
  await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
  await fs.writeFile(
    path.join(rootPath, "src", "index.ts"),
    "export const value = 'hello world '.repeat(200);\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(rootPath, "src", "util.ts"),
    "export function add(a: number, b: number): number { return a + b; }\n".repeat(50),
    "utf8"
  );

  const capsuleDir = path.join(rootPath, ".bugcapsule", "capsules", "cap-001");
  await fs.mkdir(capsuleDir, { recursive: true });
  await fs.writeFile(path.join(capsuleDir, "capsule.json"), JSON.stringify({ id: "cap-001" }), "utf8");
  await fs.writeFile(path.join(capsuleDir, "repro.ts"), "export const repro = 1;\n", "utf8");
}
