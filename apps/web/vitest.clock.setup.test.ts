import { afterEach, describe, expect, it, vi } from "vitest";

const pinned = process.env.POLARIS_TEST_NOW;

describe("relógio fixado por POLARIS_TEST_NOW", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.runIf(pinned)("o Date do teste é o instante pedido", () => {
    expect(new Date().toISOString()).toBe(
      new Date(pinned as string).toISOString()
    );
    expect(Date.now()).toBe(Date.parse(pinned as string));
  });

  it.runIf(pinned)(
    "um teste que devolve o relógio real não leva isso ao teste seguinte",
    () => {
      vi.useRealTimers();
      expect(
        Math.abs(Date.now() - Date.parse(pinned as string))
      ).toBeGreaterThan(0);
    }
  );

  it.runIf(pinned)("o teste depois dele volta ao instante pedido", () => {
    expect(Date.now()).toBe(Date.parse(pinned as string));
  });

  it.runIf(pinned)("um teste que fixa o próprio relógio manda no dele", () => {
    vi.useFakeTimers({
      now: new Date("2020-01-02T03:04:05Z"),
      toFake: ["Date"],
    });
    expect(new Date().toISOString()).toBe("2020-01-02T03:04:05.000Z");
  });

  it.runIf(!pinned)("sem a variável, o relógio é o real", () => {
    expect(vi.isFakeTimers()).toBe(false);
    expect(
      Math.abs(Date.now() - performance.timeOrigin - performance.now())
    ).toBeLessThan(1000);
  });
});
