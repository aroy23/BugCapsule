import fs from "node:fs/promises";
import path from "node:path";

export async function writeInvoiceFixtureRepo(repoPath: string): Promise<void> {
  await fs.rm(repoPath, { recursive: true, force: true });
  await writeFile(repoPath, "package.json", `${JSON.stringify({
    name: "invoice-fixture",
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      test: "vitest run"
    },
    dependencies: {
      redis: "^5.10.0"
    },
    devDependencies: {
      typescript: "^6.0.3",
      vitest: "^4.1.5"
    }
  }, null, 2)}\n`);
  await writeFile(repoPath, "package-lock.json", `${JSON.stringify({
    name: "invoice-fixture",
    version: "0.1.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "invoice-fixture",
        version: "0.1.0"
      }
    }
  }, null, 2)}\n`);
  await writeFile(repoPath, "tsconfig.json", `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      types: ["node", "vitest/globals"],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true
    },
    include: ["src/**/*.ts", "fixtures/**/*.ts", "tests/**/*.ts"]
  }, null, 2)}\n`);
  await writeFile(repoPath, "vitest.config.ts", `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"]
  }
});
`);

  await writeFile(repoPath, "node_modules/redis/package.json", `${JSON.stringify({
    name: "redis",
    version: "0.0.0-test",
    type: "module",
    main: "./index.js",
    types: "./index.d.ts"
  }, null, 2)}\n`);
  await writeFile(repoPath, "node_modules/redis/index.js", `export function createClient() {
  return {};
}
`);
  await writeFile(repoPath, "node_modules/redis/index.d.ts", `export function createClient(): object;
`);

  await writeFile(repoPath, "fixtures/invoiceMissingAddress.ts", `import type { Invoice } from "../src/billing/types.js";

export const invoiceMissingAddress: Invoice = {
  id: "inv_missing_address",
  customer: {
    name: "Acme Co",
    billingAddress: null
  },
  totalCents: 4200,
  currency: "USD",
  status: "open"
};
`);
  await writeFile(repoPath, "tests/export-missing-address.test.ts", `import { describe, expect, it } from "vitest";
import { invoiceMissingAddress } from "../fixtures/invoiceMissingAddress.js";
import { exportInvoices } from "../src/billing/exportInvoices.js";

describe("invoice CSV export", () => {
  it("exports invoices when billing address is missing", () => {
    expect(() => exportInvoices([invoiceMissingAddress])).not.toThrow();
  });
});
`);
  await writeFile(repoPath, "src/billing/types.ts", `export type Address = {
  line1: string;
  city: string;
  country: string;
};

export type Invoice = {
  id: string;
  customer: {
    name: string;
    billingAddress: Address | null;
  };
  totalCents: number;
  currency: string;
  status: "open" | "paid";
};
`);
  await writeFile(repoPath, "src/billing/customerAddress.ts", `import type { Address } from "./types.js";

export function formatBillingAddress(address: Address | null): string {
  const presentAddress = address as Address;
  return \`\${presentAddress.line1}, \${presentAddress.city}, \${presentAddress.country}\`;
}
`);
  await writeFile(repoPath, "src/billing/csvFormatter.ts", `export function csvRow(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(",");
}
`);
  await writeFile(repoPath, "src/integrations/cacheClient.ts", `import { createClient } from "redis";

export const cacheClient = {
  topic(name: string): string {
    void createClient;
    return name;
  }
};
`);
  await writeFile(repoPath, "src/billing/invoiceAudit.ts", `import { cacheClient } from "../integrations/cacheClient.js";

export function buildInvoiceExportAuditEvent(invoiceIds: readonly string[]): { topic: string; invoiceIds: readonly string[] } {
  return {
    topic: cacheClient.topic("billing.invoice_exported"),
    invoiceIds
  };
}
`);
  await writeFile(repoPath, "src/billing/exportInvoices.ts", `import { csvRow } from "./csvFormatter.js";
import { formatBillingAddress } from "./customerAddress.js";
import { buildInvoiceExportAuditEvent } from "./invoiceAudit.js";
import type { Invoice } from "./types.js";

export function exportInvoices(invoices: readonly Invoice[]): string {
  const header = csvRow(["invoice_id", "customer_name", "billing_address", "total", "currency", "status"]);
  const rows = invoices.map((invoice) =>
    csvRow([
      invoice.id,
      invoice.customer.name,
      formatBillingAddress(invoice.customer.billingAddress),
      String(invoice.totalCents),
      invoice.currency,
      invoice.status
    ])
  );

  void buildInvoiceExportAuditEvent(invoices.map((invoice) => invoice.id));
  return [header, ...rows].join("\\n");
}
`);
}

async function writeFile(repoPath: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(repoPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}
