import { describe, expect, it } from "vitest";
import { invoiceMissingAddress } from "../fixtures/invoiceMissingAddress.js";
import { exportInvoices } from "../src/billing/exportInvoices.js";

describe("invoice CSV export", () => {
  it("exports invoices when billing address is missing", () => {
    expect(() => exportInvoices([invoiceMissingAddress])).not.toThrow();
  });
});
