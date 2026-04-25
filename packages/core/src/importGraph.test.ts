import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildImportGraph } from "./importGraph.js";

describe("buildImportGraph", () => {
  it("walks TypeScript imports and records external service imports", async () => {
    const graph = await buildImportGraph(path.resolve("examples/acme-saas"), [
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
