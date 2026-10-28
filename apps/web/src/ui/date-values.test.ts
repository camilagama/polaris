import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clampDay,
  formatDate,
  formatRange,
  isWithin,
  matchingPreset,
  nextRange,
  parseIsoDate,
  presetRange,
  todayOr,
  toIsoDate,
  validDay,
  validRange,
} from "@/ui/date-values";

describe("dias como AAAA-MM-DD", () => {
  it("lê o dia ao meio-dia e volta ao mesmo texto", () => {
    const date = parseIsoDate("2026-10-24");
    expect(date?.getHours()).toBe(12);
    expect(date && toIsoDate(date)).toBe("2026-10-24");
  });

  it("recusa o que não é um dia de verdade", () => {
    expect(parseIsoDate("2026-02-30")).toBeUndefined();
    expect(parseIsoDate("24/10/2026")).toBeUndefined();
    expect(parseIsoDate("")).toBeUndefined();
    expect(parseIsoDate(null)).toBeUndefined();
  });

  it("escreve a data como o lojista lê", () => {
    expect(formatDate("2026-10-24")).toBe("24/10/2026");
  });
});

describe("texto do intervalo", () => {
  const today = "2026-10-24";

  it("um dia só vira a data inteira", () => {
    expect(formatRange({ from: today, to: today }, today)).toBe("24/10/2026");
  });

  it("no ano de hoje, dia e mês", () => {
    expect(formatRange({ from: "2026-10-01", to: today }, today)).toBe(
      "01/10 a 24/10"
    );
  });

  it("fora do ano de hoje, com o ano", () => {
    expect(formatRange({ from: "2025-12-20", to: "2026-01-05" }, today)).toBe(
      "20/12/2025 a 05/01/2026"
    );
  });
});

describe("escolha do intervalo", () => {
  it("o primeiro toque marca o início e não fecha", () => {
    expect(nextRange(undefined, "2026-10-10")).toEqual({
      complete: false,
      draft: { from: "2026-10-10", to: undefined },
    });
  });

  it("o segundo toque fecha o intervalo", () => {
    expect(nextRange({ from: "2026-10-10" }, "2026-10-20")).toEqual({
      complete: true,
      range: { from: "2026-10-10", to: "2026-10-20" },
    });
  });

  it("o segundo toque antes do início vira o início: não há intervalo invertido", () => {
    expect(nextRange({ from: "2026-10-20" }, "2026-10-10")).toEqual({
      complete: true,
      range: { from: "2026-10-10", to: "2026-10-20" },
    });
  });

  it("o mesmo dia duas vezes é um intervalo de um dia", () => {
    expect(nextRange({ from: "2026-10-10" }, "2026-10-10")).toEqual({
      complete: true,
      range: { from: "2026-10-10", to: "2026-10-10" },
    });
  });

  it("com um intervalo completo, o toque começa outro", () => {
    expect(
      nextRange({ from: "2026-10-01", to: "2026-10-05" }, "2026-10-08")
    ).toEqual({
      complete: false,
      draft: { from: "2026-10-08", to: undefined },
    });
  });
});

describe("atalhos", () => {
  it("contam a partir do dia de hoje dado", () => {
    expect(presetRange("hoje", "2026-10-24")).toEqual({
      from: "2026-10-24",
      to: "2026-10-24",
    });
    expect(presetRange("7-dias", "2026-10-24")).toEqual({
      from: "2026-10-18",
      to: "2026-10-24",
    });
    expect(presetRange("este-mes", "2026-10-24")).toEqual({
      from: "2026-10-01",
      to: "2026-10-24",
    });
    expect(presetRange("mes-passado", "2026-10-24")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("atravessam a virada do mês e do ano", () => {
    expect(presetRange("7-dias", "2026-03-03")).toEqual({
      from: "2026-02-25",
      to: "2026-03-03",
    });
    expect(presetRange("mes-passado", "2026-01-15")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(presetRange("mes-passado", "2028-03-10")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("reconhecem o atalho do intervalo escolhido", () => {
    expect(
      matchingPreset({ from: "2026-10-01", to: "2026-10-24" }, "2026-10-24")
    ).toBe("este-mes");
    expect(
      matchingPreset({ from: "2026-10-02", to: "2026-10-24" }, "2026-10-24")
    ).toBeUndefined();
    expect(matchingPreset(null, "2026-10-24")).toBeUndefined();
  });
});

describe("dias permitidos", () => {
  it("o mês que abre fica dentro do permitido", () => {
    expect(clampDay("2026-10-24", "2026-11-01", undefined)).toBe("2026-11-01");
    expect(clampDay("2026-10-24", undefined, "2026-09-30")).toBe("2026-09-30");
    expect(clampDay("2026-10-24", "2026-10-01", "2026-10-31")).toBe(
      "2026-10-24"
    );
  });

  it("as pontas entram e a ponta ausente não limita", () => {
    expect(isWithin("2026-10-01", "2026-10-01", "2026-10-31")).toBe(true);
    expect(isWithin("2026-11-01", "2026-10-01", "2026-10-31")).toBe(false);
    expect(isWithin("2020-01-01", undefined, "2026-10-31")).toBe(true);
  });
});

describe("dia e fuso", () => {
  const original = process.env.TZ;
  afterAll(() => {
    process.env.TZ = original;
  });

  for (const zone of [
    "America/Sao_Paulo",
    "America/New_York",
    "Pacific/Auckland",
  ]) {
    describe(zone, () => {
      beforeAll(() => {
        process.env.TZ = zone;
      });

      it("o dia lido volta igual, também na troca de horário de verão", () => {
        // `08/03/2026` em Nova York e `05/04/2026` em Auckland mudam o relógio
        for (const iso of [
          "2026-03-08",
          "2026-04-05",
          "2026-10-04",
          "2026-12-31",
        ]) {
          expect(toIsoDate(parseIsoDate(iso) as Date)).toBe(iso);
        }
      });

      it("os atalhos atravessam a troca de horário sem pular dia", () => {
        expect(presetRange("7-dias", "2026-03-10")).toEqual({
          from: "2026-03-04",
          to: "2026-03-10",
        });
        expect(presetRange("7-dias", "2026-04-08")).toEqual({
          from: "2026-04-02",
          to: "2026-04-08",
        });
      });
    });
  }
});

describe("valores que a tela passa", () => {
  it("dia inválido vira vazio, e o hoje inválido vira o do aparelho", () => {
    expect(validDay("2026-13-45")).toBeUndefined();
    expect(validDay("2026-10-24")).toBe("2026-10-24");
    expect(todayOr("2026-10-24")).toBe("2026-10-24");
    expect(todayOr("ontem")).toBe(toIsoDate(new Date()));
  });

  it("intervalo com ponta inválida ou invertido vira nenhum", () => {
    expect(validRange({ from: "2026-10-01", to: "2026-10-24" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-24",
    });
    expect(validRange({ from: "2026-10-24", to: "2026-10-01" })).toBeNull();
    expect(validRange({ from: "2026-10-01", to: "x" })).toBeNull();
    expect(validRange(null)).toBeNull();
  });
});
