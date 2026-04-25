export type Ticket = {
  id: string;
  priority: "low" | "medium" | "high";
  status: "open" | "closed";
};

export function shouldEscalate(ticket: Ticket): boolean {
  return ticket.priority === "high" && ticket.status === "open";
}
