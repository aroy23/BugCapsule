export type Address = {
  line1: string;
  city: string;
  country: string;
};

export type Customer = {
  id: string;
  name: string;
  billingAddress: Address | null;
};

export type Invoice = {
  id: string;
  customer: Customer;
  totalCents: number;
  currency: "USD" | "EUR";
  status: "draft" | "open" | "paid";
};
