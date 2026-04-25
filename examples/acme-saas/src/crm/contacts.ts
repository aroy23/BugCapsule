export type Contact = {
  id: string;
  accountId: string;
  email: string;
};

export function primaryDomain(contact: Contact): string {
  return contact.email.split("@").at(1) ?? "unknown.local";
}
