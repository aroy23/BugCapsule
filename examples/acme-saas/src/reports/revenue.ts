export function summarizeRevenue(cents: readonly number[]): string {
  const total = cents.reduce((sum, value) => sum + value, 0);
  return `$${(total / 100).toFixed(2)}`;
}
