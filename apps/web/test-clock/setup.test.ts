import { afterEach, describe, expect, it, vi } from "vitest";
import rootConfig from "../../../vitest.config";
import clockConfig from "./config";

const pinned = process.env.POLARIS_CLOCK_SETUP
  ? process.env.POLARIS_TEST_NOW
  : undefined;

function realClockOffset(): number {
  return Math.abs(Date.now() - performance.timeOrigin - performance.now());
}

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
      expect(realClockOffset()).toBeLessThan(1000);
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

  it.runIf(!pinned)("sem o setup, o relógio é o real", () => {
    expect(vi.isFakeTimers()).toBe(false);
    expect(realClockOffset()).toBeLessThan(1000);
  });
});

describe("config da varredura de datas", () => {
  it("exclui e resolve alias como o projeto node da raiz", () => {
    const rootProject = rootConfig.test?.projects?.[0];
    if (typeof rootProject !== "object" || rootProject === null) {
      throw new Error("o primeiro projeto da raiz deixou de ser o node");
    }
    const rootNode = (
      rootProject as { test: { name: string; exclude: string[] } }
    ).test;
    expect(rootNode.name).toBe("node");
    expect(clockConfig.test?.exclude).toEqual(rootNode.exclude);
    expect(clockConfig.resolve).toEqual(rootConfig.resolve);
  });
});
