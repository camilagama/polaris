# Despesas

Despesas (`/expenses`) é a tela das despesas da loja, um destino do menu no grupo "Financeiro", ao lado do Resultado: o título "Despesas", o botão "Nova despesa" na linha dele e o segmentado "Lançamentos", "Recorrentes" e "Categorias" (`?ver=recorrentes`, `?ver=categorias`; sem `ver`, Lançamentos). Só lê e grava com conexão. O endereço antigo `/dashboard?aba=despesas` abre esta tela no lugar.

## Sub-features

- `despesas` Lançamentos: "Nova despesa"; vazio: "Nenhuma despesa neste período." só a frase, sem botão (o "Nova despesa" único é o do título, sempre: lendo, vazio, com despesas, nas anuladas e nas outras partes); com uma categoria na barra "Filtrar despesas" o vazio é "Nenhuma despesa encontrada com estes filtros." com "Limpar filtros"; nas Anuladas sem categoria é "Nenhuma despesa anulada neste período.".
- `despesas-recorrentes` e `despesas-categorias` as outras duas partes do segmentado, no mesmo endereço (`?ver=`).

## How to get to it (user POV)

- Desktop: link `Despesas` do menu "Principal" (grupo "Financeiro"), 1 clique; só existe para quem tem `expense:create`.
- Celular: "Mais" e o link `Despesas` (2 toques).
- Resultado: o link "Despesas do período", na linha do título do Resultado (só com `expense:create`).
- Resultado vazio: o link "Nova despesa" (só com `expense:create`).
- Endereço: `/expenses`; `/dashboard?aba=despesas` (e `&ver=`) abre a mesma tela no próprio navegador, sem carga nova.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. `VERIFY_LOJA=vendas` para ver números; `vazia` para o vazio.
- Provado: `drives/receitas.verify.ts --grep despesas` (loja `vendas`; 360 claro e 1280 claro).

- **Abrir.** `await page.goto("/expenses")`; `getByRole("heading", { level: 1, name: "Despesas" })`, `button "Mês de competência, <Mês de AAAA>"` (um botão só, sem setas de mês; abre a grade de meses no `dialog "Mês de competência"`), "Nova despesa", `region "Despesas do período"` com o total do mês (`apps/web/e2e/expenses.e2e.ts`; a despesa no Resultado em centavos em `apps/web/e2e-real/jornadas/despesa.e2e.ts`). Drive `despesas`: `getByRole("button", { exact: true, name: "Nova despesa" })`; no `dialog "Nova despesa"`, `getByLabel("Valor (R$)")` "120,00", `getByRole("combobox", { exact: true, name: "Categoria" })` e a opção "Aluguel" (as categorias padrão já vêm com a loja), `getByLabel("Descrição")` com `Aluguel verify <instante>` (único por execução), "Registrar despesa"; aparece "Despesa registrada." e a descrição na `region "Despesas do período"`; recarregar mostra a mesma linha. Cada execução soma 120,00 ao mês (e ao total do Resultado); a descrição própria evita confundir execuções. Segundo jeito: `$V sql "SELECT e.description, e.amount::text FROM expenses e JOIN organizations o ON o.id = e.organization_id WHERE o.name LIKE 'qa-verify-vendas%' ORDER BY e.created_at"`.
- **Anular e Desfazer.** Na `region "Despesas do período"`, `getByRole("button", { name: "Anular despesa <descrição>" })` age no primeiro toque: a linha sai, e o aviso `status` "Despesa “<descrição>” anulada." (com o foco) traz o botão "Desfazer", que a devolve ao período ("Despesa reativada."); o segmentado `group "Situação"` (botões "Ativas" e "Anuladas", `aria-pressed`, na linha do mês, um toque) mostra em "Anuladas" a linha com "Reativar"; não há pílula de Situação. O "Filtrar" é só ícone abaixo de 760 px (nome "Filtrar despesas"). O filtro de Categoria é a pílula "Categoria" da mesma barra, na linha do "Mês de competência"; o "Nova despesa" está na linha do título e o "Total do período" abre o cartão da lista.
- **Endereço antigo.** `await page.goto("/dashboard?aba=despesas&ver=categorias")` termina em `/expenses?ver=categorias`, com o segmento Categorias aberto.
- **Prova.** `$V snap "/expenses" --project desktop-claro` para o estado; uma despesa nova se prova no Resultado (`/dashboard`), que lê de novo ao abrir.

## Gotchas

- Despesas é tela só do servidor: sem conexão não carrega.
- O link "Despesas do período" do Resultado é um link comum (`<a href="/expenses">`): a tela abre com a carga da página.
