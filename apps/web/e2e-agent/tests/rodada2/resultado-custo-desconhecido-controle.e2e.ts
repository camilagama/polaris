import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Controle dos testes de "dias sem custo informado": na loja semeada com o Chaveiro sem custo e uma venda dele, o aviso
 * do dia aparece e a cadeia diz "Não inclui N item sem custo conhecido". Os testes do Pix e do dinheiro, com custo
 * conhecido, afirmam que essa segunda frase não aparece e que o aviso do dia continua lá: o que falta é a taxa.
 */
const DAILY_CHART = /^Vendas líquidas e custos por dia/;
const DAYS_WITHOUT_COST = /dias? sem custo informado/;
const ITEM_WITHOUT_COST = /(item|itens) sem custo conhecido/;
test("o Resultado de uma loja com venda de item sem custo diz 'dias sem custo informado'", {
  session: "bb-r2-estoque-semcusto",
  tags: ["rodada2"],
}, async ({ app, screen }) => {
  await app.open("/dashboard");
  await expect(screen.getByRole("img", { name: DAILY_CHART })).toBeVisible();
  await expect(screen.getByText(DAYS_WITHOUT_COST).first()).toBeVisible();
  await expect(screen.getByText(ITEM_WITHOUT_COST)).toBeVisible();
});
