# Resultado

Resultado (`/dashboard`) é a estimativa do período com as vendas confirmadas e as despesas (não é lucro líquido nem dinheiro recebido), em duas abas: Resultado e Metas (`/dashboard?aba=metas`). As despesas são o destino [Despesas](despesas.md); o Resultado leva a elas pelo link "Despesas do período".

## Sub-features

- `resultado-periodo` aba Resultado: `button "Período: 01/10 a 31/10, editar"` (o seletor do projeto, igual no celular e no desktop; o botão abre um painel `dialog "Período"` com o `group "Atalhos do período"` ("Este mês", "Mês passado", "Últimos 30 dias", "Este ano"), o calendário e, sob ele, o botão do intervalo escolhido (`button "Digitar as datas: 01/11 a 30/11"`, abre os campos Início e Fim) para o intervalo livre, até 366 dias; um atalho aplica e fecha o painel; acima de 62 dias o gráfico e "Ver os números" agrupam por mês), "Atualizar", "Esconder valores", "Qualidade dos dados" e as regiões "Resultado estimado", "Vendas em <mês>", "Ticket médio", "Margem". A partir de 900 px as quatro regiões são colunas de uma faixa só (`[data-kpi-row]`); abaixo, cartões.
- `resultado-vazio` período sem venda nem despesa: "Sem vendas nem despesas em <período>" com os links "Nova venda" (leva a `/sales`) e, só com `expense:create`, "Nova despesa" (leva a `/expenses`); loja `vazia`.
- `resultado-link-despesas` o link "Despesas do período", na linha do título, leva a `/expenses`.
- `metas` aba Metas: `region "Metas"`, "Nova meta"; vazio: "Nenhuma meta ainda" com a linha de apoio, sem botão (o "Nova meta" único é o do cabeçalho, sempre).

## How to get to it (user POV)

- Desktop: link `Resultado` do menu "Principal" (grupo "Financeiro", com Despesas).
- Celular: "Mais" e o link `Resultado`.
- Início: o cartão "Resultado estimado" inteiro (o link dentro da região) e "Definir meta" (`/dashboard?meta=nova`; `/dashboard?meta=lista` também abre Metas).
- Abas: `tablist "Resultado e metas"`; a primeira, `/dashboard?aba=resultado`, é o mesmo que `/dashboard`. `/dashboard?aba=despesas` não é aba: abre a tela [Despesas](despesas.md).

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. `VERIFY_LOJA=vendas` para ver números; `vazia` para os vazios.
- Provado: `drives/receitas.verify.ts --grep resultado-periodo` e `--grep metas` (loja `vendas`; 360 claro e 1280 claro).

- **Abrir.** `await page.goto("/dashboard")`. `getByRole("heading", { level: 1, name: "Resultado" })`; na loja `vendas`, `region "Qualidade dos dados"` diz "Estimativa incompleta" (vendas sem taxa conhecida, nenhuma despesa). Drive `resultado-periodo`: `getByRole("tab", { name: "Resultado", selected: true })`, `region "Resultado estimado"`, depois `getByRole("button", { name: /^Período: .+, editar$/ }).click()` e, no `dialog "Período"`, `getByRole("group", { name: "Atalhos do período" }).getByRole("button", { exact: true, name: "Últimos 30 dias" }).click()` (igual no celular e no desktop). O cartão "Vendas em outubro" dá lugar à `region "Vendas líquidas"`, que é o sinal de que o período novo foi lido. Só lê; roda sempre.
- **Metas.** `getByRole("tab", { name: "Metas" })` ou `/dashboard?aba=metas`; `getByRole("region", { exact: true, name: "Metas" })` e o botão "Nova meta" (`apps/web/e2e/goals.e2e.ts`). Drive `metas`: sem meta ("Nenhuma meta ainda"), `getByRole("button", { name: "Nova meta" })`, no `dialog "Nova meta"` `getByLabel("Nome")` "Meta verify" e `getByLabel("Alvo")` "50.000,00" (acima das vendas do mês: uma meta que já bateu o alvo fecha na hora, vira "Concluída" e não se edita), `getByRole("button", { name: "Criar meta" })` e o texto "Meta criada.". Depois edita: `getByRole("button", { name: /^Editar meta / })`, `getByLabel("Alvo")` com um alvo novo (de R$ 50.000 a R$ 58.999, um a cada execução), "Salvar alterações" e "Meta atualizada."; a região mostra "R$ <alvo novo>,00". Idempotente: o Free tem 1 meta em andamento, então com uma meta de execução anterior o drive só edita; sem ela, cria e edita. Segundo jeito: `$V sql "SELECT g.status, g.target::text FROM goals g JOIN organizations o ON o.id = g.organization_id WHERE o.name LIKE 'qa-verify-vendas%'"`.
- **Aviso de estimativa.** Na aba Resultado, a `region "Qualidade dos dados"` vem logo abaixo dos cartões: uma frase ("Estimativa incompleta: N itens sem custo e M vendas sem taxa.") e o botão "Ver o que falta", que abre a lista. Os chips dizem a base à vista ("vs. setembro", ou "vs. 27/10 a 30/10" num período que não é mês).
- **Prova.** `$V snap "/dashboard" --project desktop-claro` para o estado; uma despesa nova (tela [Despesas](despesas.md)) se prova abrindo o Resultado de novo. Capturas do drive: `resultado-mes`, `resultado-30-dias`, `meta-preenchida`, `meta-criada`, `meta-editando`, `meta-editada`.

## Gotchas

- A aba Metas carrega depois do shell: um drive que lê "Nova meta" antes do fim do carregamento acha o botão com a lista ainda vazia e tenta criar uma segunda meta; espere "Nenhuma meta ainda" ou o botão "Editar meta …".
- O Free permite 1 meta em andamento: a segunda dá "Seu plano chegou ao limite de metas em andamento. Nada foi criado."
- Os nomes das regiões levam o mês corrente ("Vendas em outubro").
