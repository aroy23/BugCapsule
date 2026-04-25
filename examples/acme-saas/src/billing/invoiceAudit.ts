import { cacheClient } from "../integrations/cacheClient.js";

export type InvoiceExportAuditEvent = {
  topic: string;
  invoiceIds: readonly string[];
  exportedAt: string;
};

export function buildInvoiceExportAuditEvent(invoiceIds: readonly string[]): InvoiceExportAuditEvent {
  return {
    topic: cacheClient.topic("billing.invoice_exported"),
    invoiceIds,
    exportedAt: new Date().toISOString()
  };
}
