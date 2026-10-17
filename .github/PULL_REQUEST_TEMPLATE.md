<!--
Cada pull request cobre uma mudança conceitual coesa (plano, seção 1).
Preencha todas as seções; escreva "não se aplica" quando for o caso.
Não cole segredos, connection strings, tokens nem dados reais de clientes.
-->

## Problema

<!-- O que não funciona ou não existe hoje, e por que isso importa. -->

## Resultado esperado

<!-- O comportamento observável depois deste PR. -->

## Arquivos alterados

<!-- Áreas e arquivos principais, e o que mudou em cada um. -->

## Risco

<!-- Classificação do plano (Low, Medium, High), o que pode dar errado e como reverter ou corrigir adiante. -->

## Testes

<!-- Testes necessários e adicionados: unitários, de propriedade, de roteador, gates PostgreSQL, navegador. -->

## Critério de aceite

<!-- A condição objetiva para considerar o PR pronto, conforme a seção do plano. -->

## Documentação afetada

<!-- Fonte canônica atualizada neste PR: PRODUCT, CONTEXT, DESIGN, AGENTS, docs/architecture, docs/business-rules, ADR, runbook, plano ou status. -->

## Verificação executada

<!-- Comandos realmente executados e o resultado. Exemplos: `bun run check`, `bun run build`, `bun run boundaries`, `bun run knip`, gates `poc:*:verify`. Não afirme que um check não executado passou. Gates em Neon: liste os que rodaram e os objetos tocados que os justificam; o restante fica com o job de CI (ADR 0025). -->

## Limites

<!-- O que este PR não prova ou não cobre, decisões que dependem do responsável e itens adiados. -->

## Checklist

- [ ] A mudança é coesa e segue a sequência e os gates do plano.
- [ ] Mudança de produto, termo, design, arquitetura ou invariante atualiza a fonte canônica no mesmo PR.
- [ ] Decisão estrutural nova que contradiz o plano tem um ADR.
- [ ] Nenhum segredo, connection string ou dado real foi incluído.
- [ ] Migrations são revisadas e reproduzíveis; `db:generate` não mostra drift.
