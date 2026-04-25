import type { Address } from "./types.js";

export function formatBillingAddress(address: Address | null): string {
  const presentAddress = address as Address;
  return `${presentAddress.line1}, ${presentAddress.city}, ${presentAddress.country}`;
}
