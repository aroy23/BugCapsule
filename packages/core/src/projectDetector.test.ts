import path from "node:path";
import { describe, expect, it } from "vitest";

import { detectProject } from "./projectDetector.js";

describe("detectProject", () => {
  it("detects the Acme SaaS demo project", async () => {
    const project = await detectProject(path.resolve("examples/acme-saas"));

    expect(project.packageManager).toBe("npm");
    expect(project.testRunner).toBe("vitest");
    expect(project.framework).toBe("node");
    expect(project.tsconfigPath).toContain("examples/acme-saas/tsconfig.json");
  });
});
