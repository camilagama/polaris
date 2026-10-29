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
 * What the chart says when its chunk does not open, by where the numbers sit: in the Início the table is under the
 * chart (in "Ver os números"); in the Resultado the totals are above the chart and the table is below it.
 */
const HOME_WITHOUT_INTERNET =
  "O gráfico abre quando a internet voltar. Os números estão abaixo.";
const RESULT_WITHOUT_INTERNET =
  "O gráfico abre quando a internet voltar. Os totais estão acima e a tabela, abaixo.";

describe("o gráfico que não abre, sem internet", () => {
  for (const [screen, ChartFailed, sentence] of [
    ["Início", HomeChartFailed, HOME_WITHOUT_INTERNET],
    ["Resultado", ResultChartFailed, RESULT_WITHOUT_INTERNET],
  ] as const) {
    it(`${screen}: diz onde ficam os números`, () => {
      connection.online = false;
      const text = renderToStaticMarkup(<ChartFailed />);
      expect(text).toContain(sentence);
    });

    it(`${screen}: com internet, "O gráfico não abriu." e "Tentar novamente"`, () => {
      connection.online = true;
      const text = renderToStaticMarkup(<ChartFailed />);
      expect(text).toContain("O gráfico não abriu.");
      expect(text).toContain("Tentar novamente");
    });
  }
});
