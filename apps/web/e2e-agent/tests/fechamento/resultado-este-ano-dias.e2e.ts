import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Achado da área 4 (Resultado): com "Este ano", o texto de apoio do gráfico diz "N de M dias sem custo informado"
 * com M os dias do ano até hoje, e a leitura do mês do gráfico (novembro) diz "· N de 7 dias sem custo informado".
 * O explorador esperava o mesmo período nos dois; este teste afirma isso.
 */
// o texto de "Este mês" ("1 a 30 de novembro. 1 de 7 dias…") fica na tela até o ano chegar: espera o do ano
const CHART_TEXT =
  /^1 de janeiro a .*\d+ de \d+ dias sem custo informado\. A diferença/;
const READING_TEXT = /^· \d+ de \d+ dias sem custo informado$/;
const DAYS = /(\d+) de (\d+) dias sem custo informado/;

test("dias sem custo no texto do gráfico e na leitura do mês com Este ano", {
  session: "bb-achados-2",
  tags: ["bugbash"],
}, async ({ app, screen }) => {
  await app.open("/dashboard");
  await screen.getByRole("button", { name: "Este ano" }).tap();
  await expect(
    screen.getByRole("button", { name: "Este ano" })
  ).toHaveAttribute("aria-pressed", "true");
  const chart = screen.getByText(CHART_TEXT).first();
  await expect(chart).toBeVisible();
  const total = DAYS.exec((await chart.textContent()) ?? "")?.[2];
  if (!total) {
    throw new Error("O texto do gráfico não diz o total de dias.");
  }

  const card = screen.getByText(READING_TEXT).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(`de ${total} dias`);
});
