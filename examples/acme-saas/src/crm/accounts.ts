export type Account = {
  id: string;
  name: string;
  tier: "starter" | "growth" | "enterprise";
};

export function scoreAccount(account: Account): number {
  const tierScore = account.tier === "enterprise" ? 100 : account.tier === "growth" ? 60 : 25;
  return tierScore + Math.min(account.name.length, 30);
}
