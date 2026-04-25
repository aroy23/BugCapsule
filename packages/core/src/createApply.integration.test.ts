import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyCapsule } from "./applyCapsule.js";
import { createCapsule } from "./createCapsule.js";
import { writeInvoiceFixtureRepo } from "./testFixtures.js";

const tempRoot = path.resolve(".tmp-tests/core");

describe("BugCapsule create/apply integration", () => {
  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("creates a failing capsule, applies a capsule fix, and verifies the original repro", async () => {
    const repoPath = path.join(tempRoot, "invoice-fixture");
    await writeInvoiceFixtureRepo(repoPath);

    const created = await createCapsule({
      repoPath,
      command: "npm test -- export-missing-address",
      capsuleId: "bc_invoice_address_null",
      installDependencies: false,
      verifyCapsule: true
    });

    expect(created.status).toBe("created_failing");
    expect(created.manifest.files.map((file) => file.capsulePath)).toEqual(expect.arrayContaining([
      "src/billing/customerAddress.ts",
      "src/billing/exportInvoices.ts",
      "tests/export-missing-address.test.ts",
      "__mocks__/redis.ts"
    ]));
    expect(created.manifest.mocks.map((mock) => mock.moduleName)).toEqual(["redis"]);
    expect(created.manifest.originalRepro.stdoutPath).toBe(".bugcapsule/captures/bc_invoice_address_null/original.stdout.log");
    await expect(fs.access(path.join(repoPath, ".bugcapsule", "captures", created.capsuleId, "original.stderr.log"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(repoPath, ".bugcapsule", "reports", created.capsuleId, "report.md"))).rejects.toThrow();
    await expect(fs.access(path.join(repoPath, ".bugcapsule", "reports", created.capsuleId, "report.json"))).rejects.toThrow();

    const capsuleCustomerAddressPath = path.join(
      created.capsulePath,
      "src/billing/customerAddress.ts"
    );
    const originalContent = await fs.readFile(capsuleCustomerAddressPath, "utf8");
    await fs.writeFile(capsuleCustomerAddressPath, originalContent.replace(
      "  const presentAddress = address as Address;\n  return `${presentAddress.line1}, ${presentAddress.city}, ${presentAddress.country}`;",
      "  if (!address) {\n    return \"\";\n  }\n\n  return `${address.line1}, ${address.city}, ${address.country}`;"
    ));

    const applied = await applyCapsule({
      repoPath,
      capsuleId: created.capsuleId,
      verify: true,
      allowDirty: true
    });

    expect(applied.status).toBe("applied_verified");
    expect(applied.modifiedOriginalFiles).toEqual(["src/billing/customerAddress.ts"]);
    expect(await fs.readFile(path.join(repoPath, "src/billing/customerAddress.ts"), "utf8")).toContain("if (!address)");
  });
});
