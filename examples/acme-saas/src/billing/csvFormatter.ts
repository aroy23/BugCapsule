export function formatCsvRow(values: readonly unknown[]): string {
  return values.map(formatCsvCell).join(",");
}

function formatCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);

  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}
