import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const PERCENT_LIMIT = /100\s?%/;

/**
 * Achado da sessão (a) Vender: um desconto percentual de 150% cai no teto de percentual do domínio
 * (InvalidPercentageError → InvalidSaleAdjustmentError), e a tela responde com a mensagem genérica dos ajustes
 * ("os valores devem ser positivos e percentual só vale para desconto e acréscimo"), que não vale para 150% de
 * desconto: o valor é positivo e o tipo é desconto. Esperado: a mensagem diz o limite (100%).
 */
test("venda com desconto percentual de 150%", {
  session: "bb-achados-1",
  tags: ["bugbash"],
}, async ({ agent, app, screen }) => {
  await app.open("/sales");
  await agent.act("Adicione o produto Camiseta básica à venda, quantidade 1");
  await expect(screen.getByText("Camiseta básica").first()).toBeVisible();
  await agent.act(
    "Adicione um ajuste de Desconto informado como Percentual (%) e digite {percentual} no campo do percentual. Só preencha: não avalie nem corrija mensagens de validação que aparecerem.",
    { params: { percentual: "150" } }
  );
  // o passo do agente chegou ao campo (verificação que grava o cache, válida com ou sem a correção)
  await expect(screen.getByLabel("Percentual (%)").first()).toHaveValue("150");
  // o achado: a mensagem do ajuste deveria dizer o limite do percentual
  await expect(
    screen.getByText(PERCENT_LIMIT, { exact: false }).first()
  ).toBeVisible();
});
