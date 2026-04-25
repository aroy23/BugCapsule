export function activeSeatRatio(activeSeats: number, purchasedSeats: number): number {
  if (purchasedSeats === 0) {
    return 0;
  }

  return activeSeats / purchasedSeats;
}
