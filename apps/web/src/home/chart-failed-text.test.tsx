import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({ online: false }));

vi.mock("../lib/browser-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/browser-connection")>()),
  useConnectionOnline: () => connection.online,
}));

const { ChartFailed: HomeChartFailed } = await import("./home-chart");
const { ChartFailed: ResultChartFailed } = await import(
  "../dashboard/result-chart"
);

/**
 * What the chart says when its chunk does not open: the table of the numbers is under the chart (in "Ver os números"),
 * so the sentence says "abaixo", in the Início and in the Resultado.
 */
const WITHOUT_INTERNET =
  "O gráfico abre quando a internet voltar. Os números estão abaixo.";

describe("o gráfico que não abre, sem internet", () => {
  for (const [screen, ChartFailed] of [
    ["Início", HomeChartFailed],
    ["Resultado", ResultChartFailed],
  ] as const) {
    it(`${screen}: diz que os números estão abaixo, onde fica a tabela`, () => {
      connection.online = false;
      const text = renderToStaticMarkup(<ChartFailed />);
      expect(text).toContain(WITHOUT_INTERNET);
      expect(text).not.toContain("estão acima");
    });

    it(`${screen}: com internet, "O gráfico não abriu." e "Tentar novamente"`, () => {
      connection.online = true;
      const text = renderToStaticMarkup(<ChartFailed />);
      expect(text).toContain("O gráfico não abriu.");
      expect(text).toContain("Tentar novamente");
    });
  }
});
