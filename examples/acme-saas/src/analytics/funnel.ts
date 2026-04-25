export type FunnelStep = {
  name: string;
  visitors: number;
};

export function conversionRate(first: FunnelStep, last: FunnelStep): number {
  if (first.visitors === 0) {
    return 0;
  }

  return last.visitors / first.visitors;
}
