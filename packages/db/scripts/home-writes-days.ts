import { type Clock, shiftDay, storeDay, storeNoon } from "./gate-clock";

/**
 * The days the home-writes gate works out, all from one clock. The seeded sales sit at noon of the store's yesterday
 * (noon of today is still ahead before 12:00 and a sale in the future is refused), and the month the Início reads is
 * the month of that day: on the 1st it would otherwise be a month with no sale. The goals take `today`, which the
 * database evaluates against its own clock. The periods mirror `homePeriods` of home-model.ts, applied to the day of the sale.
 */
export function homeWritesDays(clock: Clock) {
  const today = storeDay(clock);
  const saleDay = storeDay(clock, -1);
  const first = `${saleDay.slice(0, 7)}-01`;
  const eve = shiftDay(first, -1);
  const previousFirst = `${eve.slice(0, 7)}-01`;
  const thirty = shiftDay(saleDay, -29);
  const [year = 0, month = 1] = saleDay.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return {
    before: { from: thirty < previousFirst ? thirty : previousFirst, to: eve },
    month: { from: first, to: last },
    saleInstant: storeNoon(saleDay),
    today,
  };
}
