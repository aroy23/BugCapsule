import type { Ticket } from "./tickets.js";

export function responseWindowHours(ticket: Ticket): number {
  if (ticket.priority === "high") {
    return 4;
  }

  return ticket.priority === "medium" ? 12 : 24;
}
