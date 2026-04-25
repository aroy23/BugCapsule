import { formatBillingAddress } from "./customerAddress.js";
import { formatCsvRow } from "./csvFormatter.js";
import { buildInvoiceExportAuditEvent } from "./invoiceAudit.js";
import type { Invoice } from "./types.js";

export function exportInvoices(invoices: readonly Invoice[]): string {
  const header = formatCsvRow([
    "invoice_id",
    "customer_name",
    "billing_address",
    "total",
    "currency",
    "status"
  ]);

  const rows = invoices.map((invoice) =>
    formatCsvRow([
      invoice.id,
      invoice.customer.name,
      formatBillingAddress(invoice.customer.billingAddress),
      formatCurrency(invoice.totalCents),
      invoice.currency,
      invoice.status
    ])
  );

  void buildInvoiceExportAuditEvent(invoices.map((invoice) => invoice.id));

  return [header, ...rows].join("\n");
}

function formatCurrency(totalCents: number): string {
  return (totalCents / 100).toFixed(2);
}
