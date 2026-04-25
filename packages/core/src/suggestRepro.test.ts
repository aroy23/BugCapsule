import path from "node:path";
import { describe, expect, it } from "vitest";

import { suggestRepro } from "./suggestRepro.js";

describe("suggestRepro", () => {
  it("ranks matching tests and runtime repro scripts from a vague bug description", async () => {
    const result = await suggestRepro({
      repoPath: path.resolve("examples/acme-saas"),
      bugDescription: "invoice export crashes when billing address is missing"
    });

    expect(result.status).toBe("ready");
    expect(result.candidates[0]?.command).toBe("npm test -- export-missing-address");
    expect(result.candidates.some((candidate) => candidate.canCreateCapsule)).toBe(true);
    expect(result.relatedFiles.map((file) => file.path)).toEqual(expect.arrayContaining([
      "src/billing/exportInvoices.ts",
      "src/billing/customerAddress.ts"
    ]));
    expect(result.agentWorkflow.map((step) => step.action)).toEqual([
      "try_candidate_command",
      "confirm_failure",
      "create_capsule",
      "fix_capsule"
    ]);
  });
});
