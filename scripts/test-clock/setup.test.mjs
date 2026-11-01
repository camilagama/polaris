import { afterEach, describe, expect, it, vi } from "vitest";
import datasConfig from "../../vitest.datas.config";
import rootConfig from "../../vitest.config";
import { FUSOS, INSTANTES, parseNow } from "./instants.mjs";
import { freezeClock } from "./setup.mjs";

const pinned = process.env.POLARIS_TEST_NOW;

function realClockOffset() {
  return Math.abs(Date.now() - performance.timeOrigin - performance.now());
}

function saoPaulo(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

describe("relógio congelado por POLARIS_TEST_NOW", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.runIf(pinned)("o Date do teste é o instante pedido", () => {
    expect(new Date().toISOString()).toBe(parseNow(pinned).toISOString());
    expect(Date.now()).toBe(Date.parse(pinned));
  });

  it.runIf(pinned)("o relógio não anda com o tempo real", async () => {
    const before = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(performance.now() - before).toBeGreaterThanOrEqual(25);
    expect(Date.now()).toBe(Date.parse(pinned));
  });

  it.runIf(pinned)(
    "um teste que devolve o relógio real não leva isso ao teste seguinte",
    () => {
      vi.useRealTimers();
      expect(realClockOffset()).toBeLessThan(1000);
    }
  );

  it.runIf(pinned)("o teste depois dele volta ao instante pedido", () => {
    expect(Date.now()).toBe(Date.parse(pinned));
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

describe("freezeClock", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("congela só o Date: o tempo real passa e o Date fica", async () => {
    const instant = parseNow("2026-12-01T02:50:00Z");
    vi.useRealTimers();
    freezeClock(instant);
    const before = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(performance.now() - before).toBeGreaterThanOrEqual(25);
    expect(Date.now()).toBe(instant.getTime());
    expect(new Date().toISOString()).toBe("2026-12-01T02:50:00.000Z");
  });

  it("deixa em paz o relógio que o teste já fixou", () => {
    vi.useFakeTimers({
      now: new Date("2020-01-02T03:04:05Z"),
      toFake: ["Date"],
    });
    freezeClock(parseNow("2026-12-01T02:50:00Z"));
    expect(new Date().toISOString()).toBe("2020-01-02T03:04:05.000Z");
  });

  it("o setup recusa POLARIS_TEST_NOW sem fuso ao carregar", async () => {
    vi.stubEnv("POLARIS_TEST_NOW", "2026-11-01T03:30:00");
    vi.resetModules();
    await expect(import("./setup.mjs")).rejects.toThrow(
      "POLARIS_TEST_NOW inválido"
    );
  });
});

describe("POLARIS_TEST_NOW", () => {
  it.each([
    "2026-11-01T03:30:00Z",
    "2026-11-01T00:30:00-03:00",
    "2026-11-01T00:30Z",
    "2026-11-01T03:30:00.250+00:00",
  ])("aceita %s", (raw) => {
    expect(parseNow(raw).getTime()).not.toBeNaN();
  });

  it.each([
    "2026-11-01T03:30:00",
    "2026-11-01",
    "2026-11-01 03:30:00Z",
    "2026-13-01T03:30:00Z",
    "2026-02-30T00:00:00Z",
    "2026-11-31T00:00:00Z",
    "2026-11-01T24:00:00Z",
    "2026-11-01T03:60:00Z",
    "ontem",
  ])("recusa %s", (raw) => {
    expect(() => parseNow(raw)).toThrow("POLARIS_TEST_NOW inválido");
  });
});

describe("instantes da varredura", () => {
  it("são os quatro combinados, em dois fusos", () => {
    expect(INSTANTES.map((item) => item.chave)).toEqual([
      "dia-1-0030",
      "ultimo-dia-2350",
      "virada-do-ano",
      "bissexto-1200",
    ]);
    expect(FUSOS).toEqual(["America/Sao_Paulo", "UTC"]);
  });

  it.each(INSTANTES.map((item) => [item.chave, item]))(
    "%s cai na hora de São Paulo declarada",
    (_chave, item) => {
      expect(saoPaulo(parseNow(item.now))).toBe(item.saoPaulo);
    }
  );
});

describe("config da varredura de datas", () => {
  it("exclui (mais packages/db) e resolve alias como o projeto node da raiz", () => {
    const rootProject = rootConfig.test?.projects?.[0];
    if (typeof rootProject !== "object" || rootProject === null) {
      throw new Error("o primeiro projeto da raiz deixou de ser o node");
    }
    const rootNode = rootProject.test;
    expect(rootNode.name).toBe("node");
    expect(datasConfig.test?.exclude).toEqual([
      ...rootNode.exclude,
      "packages/db/**",
    ]);
    expect(datasConfig.resolve).toEqual(rootConfig.resolve);
  });

  it("inclui o que o projeto node da raiz inclui em apps e packages, mais o próprio helper", () => {
    const rootNode = rootConfig.test?.projects?.[0].test;
    expect(datasConfig.test?.include).toEqual([
      "scripts/test-clock/*.test.mjs",
      ...rootNode.include.filter((glob) => !glob.startsWith("scripts/")),
    ]);
  });
});
