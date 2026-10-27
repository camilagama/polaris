import { describe, expect, it } from "vitest";
import {
  type Clock,
  runClock,
  shiftDay,
  storeDay,
  storeNoon,
} from "./gate-clock";

const at =
  (iso: string): Clock =>
  () =>
    new Date(iso);

describe("the store day on a fixed clock", () => {
  // São Paulo is UTC-3: 02:59:59Z is 23:59:59 of the day before, 03:00:00Z is the next midnight
  it("changes at midnight in São Paulo, not in UTC", () => {
    expect(storeDay(at("2026-10-27T02:59:59.999Z"))).toBe("2026-10-26");
    expect(storeDay(at("2026-10-27T03:00:00.000Z"))).toBe("2026-10-27");
    expect(storeDay(at("2026-10-27T00:30:00.000Z"))).toBe("2026-10-26");
    expect(storeDay(at("2026-10-27T23:59:59.999Z"))).toBe("2026-10-27");
  });

  it("shifts by calendar days across the end of a month and of a year", () => {
    expect(storeDay(at("2026-11-01T02:30:00.000Z"), 0)).toBe("2026-10-31");
    expect(storeDay(at("2026-11-01T02:30:00.000Z"), 1)).toBe("2026-11-01");
    expect(storeDay(at("2027-01-01T02:59:00.000Z"), 1)).toBe("2027-01-01");
    expect(storeDay(at("2027-01-01T03:00:00.000Z"), -2)).toBe("2026-12-30");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("gives the same answer for every time of day, so a gate near midnight and one at noon agree", () => {
    const hours = Array.from({ length: 24 }, (_, hour) =>
      storeDay(at(`2026-10-27T${String(hour).padStart(2, "0")}:00:00.000Z`), -3)
    );
    // 00:00Z to 02:00Z is still the 26th in São Paulo; from 03:00Z the 27th
    expect(new Set(hours)).toEqual(new Set(["2026-10-23", "2026-10-24"]));
    expect(hours.slice(0, 3)).toEqual([
      "2026-10-23",
      "2026-10-23",
      "2026-10-23",
    ]);
    expect(hours.slice(3).every((day) => day === "2026-10-24")).toBe(true);
  });

  it("takes another time zone when the gate asks for one", () => {
    // Tokyo is UTC+9: 15:00Z on the 26th is already the 27th there, and still the 26th in São Paulo
    const clock = at("2026-10-26T15:00:00.000Z");
    expect(storeDay(clock)).toBe("2026-10-26");
    expect(storeDay(clock, 0, "Asia/Tokyo")).toBe("2026-10-27");
  });
});

describe("noon of a store day", () => {
  it("is the same day in the store calendar and in UTC, whatever the time of day the gate runs", () => {
    for (const hour of ["00", "02", "03", "12", "23"]) {
      const day = storeDay(at(`2026-10-27T${hour}:30:00.000Z`), -1);
      const noon = storeNoon(day);
      expect(noon.slice(0, 10)).toBe(day);
      expect(storeDay(() => new Date(noon))).toBe(day);
    }
  });
});

describe("the run clock", () => {
  it("never moves: two reads are the same instant, and a read cannot change it", () => {
    const first = runClock();
    const second = runClock();
    expect(second.getTime()).toBe(first.getTime());
    first.setUTCFullYear(1999);
    expect(runClock().getTime()).toBe(second.getTime());
  });
});
