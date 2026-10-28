# Resultado

Resultado (`/dashboard`) é a estimativa do período com as vendas confirmadas e as despesas (não é lucro líquido nem dinheiro recebido), em três abas: Resultado, Metas (`/dashboard?aba=metas`) e Despesas (`/dashboard?aba=despesas`).

## Sub-features

- `resultado-periodo` aba Resultado: `group "Período"` ("Este mês", "Mês passado", "Últimos 30 dias", "Período"), "Atualizar", "Esconder valores", "Qualidade dos dados" e as regiões "Resultado estimado", "Vendas em <mês>", "Ticket médio", "Margem".
- `metas` aba Metas: `region "Metas"`, "Nova meta"; vazio: "Nenhuma meta ainda".
- `despesas` aba Despesas: "Lançamentos", "Recorrentes" e "Categorias"; "Nova despesa"; vazio: "Nenhuma despesa neste período. Toque em Nova despesa para registrar a primeira."

## How to get to it (user POV)

- Desktop: link `Resultado` do menu "Principal" (grupo "Resultado").
- Celular: "Mais" e o link `Resultado`.
- Início: "Ver o resultado" (região "Resultado estimado") e "Definir meta" (`/dashboard?meta=nova`; `/dashboard?meta=lista` também abre Metas).
- Abas: `tablist "Resultado, metas e despesas"`; a primeira, `/dashboard?aba=resultado`, é o mesmo que `/dashboard`. O endereço antigo `/expenses` abre Despesas.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. `VERIFY_LOJA=vendas` para ver números; `vazia` para os vazios.

- **Abrir.** `await page.goto("/dashboard")`. `getByRole("heading", { level: 1, name: "Resultado" })`; na loja `vendas`, `region "Qualidade dos dados"` diz "Estimativa incompleta" (vendas sem taxa conhecida, nenhuma despesa).
- **Metas.** `getByRole("tab", { name: "Metas" })` ou `/dashboard?aba=metas`; `getByRole("region", { exact: true, name: "Metas" })` e o botão "Nova meta" (`apps/web/e2e/goals.e2e.ts`).
- **Despesas.** `/dashboard?aba=despesas`: `group "Mês de competência"`, "Nova despesa", `region "Despesas do período"` com o total do mês (`apps/web/e2e/expenses.e2e.ts`; a despesa no Resultado em centavos em `apps/web/e2e-real/jornadas/despesa.e2e.ts`).
- **Prova.** `$V snap "/dashboard?aba=despesas" --project desktop-claro` para o estado; uma despesa nova se prova voltando à aba Resultado.

## Gotchas

- O Free permite 1 meta em andamento: a segunda dá "Seu plano chegou ao limite de metas em andamento. Nada foi criado."
- Os nomes das regiões levam o mês corrente ("Vendas em outubro").
- Despesas é tela só do servidor: sem conexão não carrega.
