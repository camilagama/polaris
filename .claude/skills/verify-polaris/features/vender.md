# Vender (Nova venda)

A tela Vender (`/sales`) é o formulário "Nova venda": itens buscados no catálogo com quantidade e preço, ajustes (desconto), o pagamento e a confirmação. Confirmada, a venda vira um registro que não se edita (corrige-se por devolução ou cancelamento, no [Histórico](historico.md)).

## Sub-features

- `venda-abrir` abre a tela com o `h1` "Nova venda" e o `form "Nova venda"`.
- `venda-buscar` busca um produto em "Produto ou variante" e escolhe a variante na lista "Variantes encontradas".
- `venda-itens` quantidade, preço cobrado e preço de tabela de cada item; "Adicionar item".
- `venda-ajuste` "Adicionar ajuste": desconto em percentual ou valor.
- `venda-pagamento` o método ("Pix", "Dinheiro", "Crédito", "Débito", "Transferência", "Outro") e o perfil de pagamento.
- `venda-confirmar` "Confirmar venda" mostra a região "Venda confirmada"; o estoque baixa.
- `venda-em-andamento` a venda montada e não confirmada fica na aba (`sessionStorage`, `polaris.sale.draft.v1:<loja>`): sair de Vender, recarregar ou trocar de build e voltar a devolve, com o `status` "Venda em andamento" e o botão "Limpar venda" sob o título.
- `venda-sem-estoque` o item com saldo 0 diz "Sem estoque: saldo 0. Para vender, dê entrada no estoque." (sem a permissão de estoque, "Peça a quem cuida do estoque para dar entrada.") com o link "Dar entrada no estoque"; a recusa do servidor ao confirmar diz "A venda não foi registrada: falta estoque de <item> (pediu N, saldo S)." com o mesmo link; o link leva ao [Estoque](estoque.md).
- `venda-primeira-linha` só na 1ª venda da loja que o servidor confirma, e só se esta aba soube pelo Início que a loja nunca vendeu (abra `/` antes de vender): o painel "Venda confirmada" termina com "1ª venda registrada. Veja o Hoje no Início e o resultado estimado em Resultado." e os links "Ver o Início" e "Ver o Resultado"; a 2ª venda não a mostra (e2e-real `primeira-venda.e2e.ts`).
- `venda-sem-produto` loja sem produto: "Cadastre um produto para vender." e o botão "Cadastrar produto".

## How to get to it (user POV)

- Desktop: link `Vender` do menu "Principal".
- Celular: link `Vender`, no meio da barra "Destinos".
- Início: link "Nova venda".
- Endereço `/sales`.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK, `$V seed vendas`, `VERIFY_LOJA=vendas` (a busca precisa de produto com saldo).
- Provado: `drives/receitas.verify.ts --grep venda-confirmar` (360 claro e 1280 escuro). A venda guardada sem conexão, na loja `pro` com `launch --runtime`: `drives/offline-pro.verify.ts` (ver o Gotcha).

- **Abrir.** `await page.goto("/sales")`. `getByRole("heading", { level: 1, name: "Nova venda" })`; o primeiro item é `getByRole("group", { exact: true, name: "Item 1" })`.
- **Buscar.** `item.getByLabel("Produto ou variante").fill("Caneca")`. Aparece `item.getByRole("list", { name: "Variantes encontradas" })` com botões "Caneca esmaltada Saldo 20 · custo médio R$ 12,00"; clique com `getByRole("button", { name: /Caneca esmaltada/ })`.
- **Quantidade e preço.** `item.getByLabel("Quantidade").fill("2")` (há também "Menos uma unidade" e "Mais uma unidade"); `item.getByLabel("Preço cobrado").fill("35,00")`. "Preço de tabela" vem do produto quando ele tem um.
- **Desconto.** `getByRole("button", { name: "Adicionar ajuste" })`, depois no `group "Ajuste 1"`: combobox "Tipo de ajuste" → opção "Desconto", combobox "Como informar" → "Percentual (%)", e `getByLabel("Percentual (%)")` (receita de `apps/web/e2e-real/pages/venda.ts`, `fillSale`).
- **Pagamento.** `getByRole("radiogroup", { name: "Método de pagamento" }).getByRole("radio", { name: "Dinheiro" }).check()`; `getByRole("combobox", { exact: true, name: "Perfil de pagamento" }).click()` e `getByRole("option", { exact: true, name: "Sem perfil de pagamento" }).click()`.
- **Confirmar.** `getByRole("button", { name: "Confirmar venda" }).click()`. Aparece `getByRole("region", { name: /Venda confirmada|já estava confirmada/ })` com "Subtotal" e "Total devido".
- **Venda em andamento.** Montada a venda, `getByRole("status").filter({ hasText: "Venda em andamento" })` e `getByRole("button", { exact: true, name: "Limpar venda" })` aparecem sob o título. Vá ao Início pelo menu e volte por "Vender" ou "Nova venda": os mesmos itens. "Limpar venda" com itens abre `getByRole("dialog", { name: "Limpar venda?" })` com "Isso tira os N itens da venda." (um item: "Isso tira o item da venda."); sem item escolhido, limpa sem perguntar. Ao voltar, a linha cuja variante saiu do catálogo (ou cujo produto foi arquivado) sai com o aviso que a nomeia ("O item <nome> saiu do catálogo e foi tirado da venda."; no plural, "Os itens A e B saíram…"), e o preço de tabela novo entra com "<nome>: preço de tabela atualizado para R$ X; o preço cobrado acompanhou." (ou "…continua R$ Y." quando era negociado); com uma venda enviada sem resposta, o carrinho volta igual, sem aviso; um rascunho de outro dia da loja some com "A venda em andamento era de outro dia e foi descartada.".
- **Sem estoque.** Escolha uma variante de saldo 0: sob o nome aparece o aviso e, no estilo de "Trocar variante", `getByRole("link", { name: /Dar entrada no estoque de/ })`. Com quantidade acima do saldo, "Confirmar venda" é recusada pelo servidor: o `Alert` recebe o foco, diz que a venda não foi registrada e nomeia o item, e traz o link e o botão "Atualizar dados e revisar a venda". O link vai na mesma aba; a venda em andamento volta ao tocar "Vender" no menu. Nada é gravado na recusa.
- **Efeito colateral.** O Estoque mostra o saldo da Caneca 2 a menos, e o Histórico, uma venda a mais; ou `$V sql "SELECT count(*) FROM sales s JOIN organizations o ON o.id = s.organization_id WHERE o.name LIKE 'qa-verify-vendas%'"`.
- **Prova.** `evidence.shot("venda-preenchida", …)` antes de confirmar e `evidence.shot("venda-confirmada", …)` depois.

## Gotchas

- Sem perfil de pagamento ativo, o formulário avisa "Nenhum perfil de pagamento ativo…" e a venda sai com taxa e prazo desconhecidos: escolha "Sem perfil de pagamento", senão "Confirmar venda" recusa.
- O duplo toque em "Confirmar venda" gera uma venda só (o e2e-real prova com `dblclick`); a região pode dizer "já estava confirmada".
- O placeholder de "Preço cobrado" ("49,90") não é valor: preencha.
- A venda guardada no aparelho sem conexão ("Guardar venda neste aparelho", "Vendas guardadas neste aparelho") não acontece com loja Free: o plano não escreve offline. Na pilha real ela se prova com a loja `pro` (`$V seed pro`, o plano Pro gravado no banco) numa instância `launch --runtime`: `VERIFY_LOJA=pro $V drive .claude/skills/verify-polaris/drives/offline-pro.verify.ts --grep venda-offline`. O drive abre `/` com rede, espera o service worker e recarrega (a aba passa a ser controlada), espera o `status` "Tudo sincronizado", corta a rede (`context.setOffline(true)`, `status` "Sem conexão"), vai a Vender pelo menu, monta a venda (1 Camiseta básica, a um preço novo a cada execução, de R$ 40,10 a R$ 79,98), clica "Guardar venda neste aparelho" e vê `region "Vendas guardadas neste aparelho"` com o valor e "Aguardando envio". Com a rede de volta, o cartão some, o `status` volta a "Tudo sincronizado" e a venda é a primeira do Histórico. Segundo jeito: `$V sql "SELECT i.charged_unit_price::text FROM sale_items i JOIN organizations o ON o.id = i.organization_id WHERE o.name LIKE 'qa-verify-pro%'"` lista os preços enviados; cada execução (um projeto) soma uma venda e tira 1 do saldo da Camiseta. Sem `--runtime` a loja `pro` também diz "Offline indisponível neste aparelho". Os laboratórios (`/offline-screens-lab?screen=sale`, `apps/web/e2e/offline-screens.e2e.ts` e `apps/web/e2e/sale-screen.e2e.ts`, com a caixa "Rede disponível") seguem sendo a prova dos estados que a pilha real não produz (rede que cai no meio do envio, venda travada).
- Cada venda confirmada muda o Início, o Histórico, o Estoque e o Resultado da loja `vendas`: uma receita depois desta não parte mais do estado semeado.
