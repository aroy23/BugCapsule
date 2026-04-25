import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectProject } from "./projectDetector.js";
import { writeInvoiceFixtureRepo } from "./testFixtures.js";

const tempRoot = path.resolve(".tmp-tests/project-detector");

describe("detectProject", () => {
  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("detects a TypeScript npm project", async () => {
    const repoPath = path.join(tempRoot, "invoice-fixture");
    await writeInvoiceFixtureRepo(repoPath);

    const project = await detectProject(repoPath);

    expect(project.packageManager).toBe("npm");
    expect(project.testRunner).toBe("vitest");
    expect(project.framework).toBe("node");
    expect(project.tsconfigPath).toBe(path.join(repoPath, "tsconfig.json"));
  });
});
