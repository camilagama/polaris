import { test } from "@e2e-dev/web";
import { expect, unique } from "e2e";

/**
 * Achado da sessão (c) Despesas e Resultado: em /dashboard, o Resultado lê o período uma vez ao montar a tela
 * (`usePeriodSummary`) e nada o lê de novo quando uma despesa é registrada na aba Despesas da mesma tela. Ao voltar
 * para a aba Resultado, "(−) Despesas do período (sem venda)" mostra o valor de antes até o toque em "Atualizar".
 * Esperado: ao voltar, o Resultado inclui a despesa nova (valor anterior + R$ 100,00).
 */

const NON_DIGITS = /\D/g;
const EXPENSES_ROW = "Despesas do período (sem venda)";

function cents(text: string | null): number {
  const digits = (text ?? "").replace(NON_DIGITS, "");
  return digits === "" ? Number.NaN : Number(digits);
}

function brl(value: number): string {
  const reais = Math.floor(value / 100).toLocaleString("pt-BR");
  return `${reais},${String(value % 100).padStart(2, "0")}`;
}

test("despesa avulsa de R$ 100,00 pela aba Despesas do Resultado", {
  session: "bb-achados-2",
  tags: ["bugbash"],
}, async ({ agent, app, screen }) => {
  await app.open("/dashboard");
  const chain = screen.getByRole("region", {
    name: "Como chegamos a este resultado",
  });
  const expensesCell = chain
    .getByRole("row")
    .filter({ hasText: EXPENSES_ROW })
    .getByRole("cell")
    .first();
  await expect(expensesCell).toBeVisible();
  const before = cents(await expensesCell.textContent());

  await screen.getByRole("tab", { name: "Despesas" }).tap();
  const description = `Despesa QA ${Date.now()}`;
  await agent.act(
    "Na aba Lançamentos, registre uma despesa avulsa de R$ 100,00 com competência neste mês e descrição {descricao}. Se não houver categoria de despesa, crie uma chamada Aluguel e use-a. Depois de registrar, fique na aba Despesas.",
    { params: { descricao: unique(description) } }
  );
  await expect(screen.getByText(description).first()).toBeVisible();

  await screen.getByRole("tab", { name: "Resultado" }).tap();
  await expect(expensesCell).toContainText(brl(before + 10_000), {
    timeout: 10_000,
  });
});
