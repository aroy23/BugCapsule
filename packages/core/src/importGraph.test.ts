import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildImportGraph } from "./importGraph.js";
import { writeInvoiceFixtureRepo } from "./testFixtures.js";

const tempRoot = path.resolve(".tmp-tests/import-graph");

describe("buildImportGraph", () => {
  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("walks TypeScript imports and records external service imports", async () => {
    const repoPath = path.join(tempRoot, "invoice-fixture");
    await writeInvoiceFixtureRepo(repoPath);

    const graph = await buildImportGraph(repoPath, [
      "tests/export-missing-address.test.ts"
    ]);

    expect([...graph.nodes.keys()]).toEqual(expect.arrayContaining([
      "tests/export-missing-address.test.ts",
      "fixtures/invoiceMissingAddress.ts",
      "src/billing/exportInvoices.ts",
      "src/billing/customerAddress.ts",
      "src/integrations/cacheClient.ts"
    ]));
    expect(graph.nodes.get("src/integrations/cacheClient.ts")?.externalImports).toEqual([
      {
        moduleName: "redis",
        namedImports: ["createClient"]
      }
    ]);
  });
});
