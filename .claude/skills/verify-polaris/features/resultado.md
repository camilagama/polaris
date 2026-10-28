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
- Provado: `drives/receitas.verify.ts --grep resultado-periodo`, `--grep despesas` e `--grep metas` (loja `vendas`; 360 claro e 1280 claro).

- **Abrir.** `await page.goto("/dashboard")`. `getByRole("heading", { level: 1, name: "Resultado" })`; na loja `vendas`, `region "Qualidade dos dados"` diz "Estimativa incompleta" (vendas sem taxa conhecida, nenhuma despesa). Drive `resultado-periodo`: `getByRole("tab", { name: "Resultado", selected: true })`, `region "Resultado estimado"`, depois `getByRole("group", { name: "Período" }).getByRole("button", { name: "Últimos 30 dias" }).click()` e o mesmo botão com `pressed: true`. Só lê; roda sempre.
- **Metas.** `getByRole("tab", { name: "Metas" })` ou `/dashboard?aba=metas`; `getByRole("region", { exact: true, name: "Metas" })` e o botão "Nova meta" (`apps/web/e2e/goals.e2e.ts`). Drive `metas`: sem meta ("Nenhuma meta ainda"), `getByRole("button", { name: "Nova meta" })`, no `dialog "Nova meta"` `getByLabel("Nome")` "Meta verify" e `getByLabel("Alvo")` "50.000,00" (acima das vendas do mês: uma meta que já bateu o alvo fecha na hora, vira "Concluída" e não se edita), `getByRole("button", { name: "Criar meta" })` e o texto "Meta criada.". Depois edita: `getByRole("button", { name: /^Editar meta / })`, `getByLabel("Alvo")` com um alvo novo (de R$ 50.000 a R$ 58.999, um a cada execução), "Salvar alterações" e "Meta atualizada."; a região mostra "R$ <alvo novo>,00". Idempotente: o Free tem 1 meta em andamento, então com uma meta de execução anterior o drive só edita; sem ela, cria e edita. Segundo jeito: `$V sql "SELECT g.status, g.target::text FROM goals g JOIN organizations o ON o.id = g.organization_id WHERE o.name LIKE 'qa-verify-vendas%'"`.
- **Despesas.** `/dashboard?aba=despesas`: `group "Mês de competência"`, "Nova despesa", `region "Despesas do período"` com o total do mês (`apps/web/e2e/expenses.e2e.ts`; a despesa no Resultado em centavos em `apps/web/e2e-real/jornadas/despesa.e2e.ts`). Drive `despesas`: `getByRole("button", { exact: true, name: "Nova despesa" })`; no `dialog "Nova despesa"`, `getByLabel("Valor (R$)")` "120,00", `getByRole("combobox", { exact: true, name: "Categoria" })` e a opção "Aluguel" (as categorias padrão já vêm com a loja), `getByLabel("Descrição")` com `Aluguel verify <instante>` (único por execução), "Registrar despesa"; aparece "Despesa registrada." e a descrição na `region "Despesas do período"`; recarregar mostra a mesma linha. Cada execução soma 120,00 ao mês (e ao total do Resultado); a descrição própria evita confundir execuções. Segundo jeito: `$V sql "SELECT e.description, e.amount::text FROM expenses e JOIN organizations o ON o.id = e.organization_id WHERE o.name LIKE 'qa-verify-vendas%' ORDER BY e.created_at"`.
- **Prova.** `$V snap "/dashboard?aba=despesas" --project desktop-claro` para o estado; uma despesa nova se prova voltando à aba Resultado. Capturas do drive: `resultado-mes`, `resultado-30-dias`, `despesa-preenchida`, `despesa-registrada`, `despesa-recarregada`, `meta-preenchida`, `meta-criada`, `meta-editando`, `meta-editada`.

## Gotchas

- A aba Metas carrega depois do shell: um drive que lê "Nova meta" antes do fim do carregamento acha o botão com a lista ainda vazia e tenta criar uma segunda meta; espere "Nenhuma meta ainda" ou o botão "Editar meta …".
- O Free permite 1 meta em andamento: a segunda dá "Seu plano chegou ao limite de metas em andamento. Nada foi criado."
- Os nomes das regiões levam o mês corrente ("Vendas em outubro").
- Despesas é tela só do servidor: sem conexão não carrega.
