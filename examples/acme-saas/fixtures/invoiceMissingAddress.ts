import type { Invoice } from "../src/billing/types.js";

export const invoiceMissingAddress: Invoice = {
  id: "inv_123",
  customer: {
    id: "cus_456",
    name: "Acme Corp",
    billingAddress: null
  },
  totalCents: 12000,
  currency: "USD",
  status: "open"
};
