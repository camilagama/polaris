---
status: accepted
---

# Ordem das fases, Gate Auth e Gate 2, e o plano como autoridade da sequência

## Contexto

O plano de implementação (`doc/plano-inicial.md`) foi escrito antes da execução e rege sequência, escopo e critérios dos gates. Durante a execução ele foi reescrito em cerca de 685 linhas, sem ADR nem registro de mudanças, e duas alterações de ordem mudaram o desenho original:

- **Better Auth depois do Gate Foundation.** O PR13 ficou como primeiro trabalho da Fase 2 e ganhou um Gate Auth próprio (Better Auth no runtime Worker, sessões validadas pelo servidor, revogação, nenhum plugin de organização como autoridade de tenancy) antes do login Google, da senha e dos fluxos tenant. Assim o Gate Foundation prova runtime, RLS/Hyperdrive e persistência offline sem misturar identidade.
- **Fechamento do Gate 2 antes do PR24 completo.** A auditoria do checkpoint do PR23 mostrou que sessão, onboarding, transação tenant, RLS de organizations/memberships e capabilities tinham provas isoladas, mas ainda não formavam um fluxo autenticado sobre uma entidade de negócio protegida. Uma etapa prévia e limitada (onboarding por função `SECURITY DEFINER` e RLS de Categories, [ADR 0007](0007-gate2-onboarding-and-category-rls.md)) fechou o Gate 2; o PR24 completo reutilizou o schema, sem migrations duplicadas.

Outros ajustes de escopo também ocorreram sem registro: o outbox transacional do servidor foi adiado para o PR108, e a interface de login foi adiada para antes do go-live.

## Decisão

Decidido na revisão do checkpoint Gate 4 (13/10/2026):

- O plano continua sendo a **autoridade da sequência e dos critérios dos gates**; este ADR e os demais registram o *porquê* das decisões, e o plano registra o *quê* e a *ordem*. Quando um ADR e o plano divergirem sobre sequência, vale o plano; sobre a razão de uma decisão de arquitetura, vale o ADR.
- Qualquer mudança de ordem, de escopo de gate ou inserção de etapa exige, no mesmo pull request, um ADR curto e a atualização do plano, com uma nota datada no próprio plano. Reescritas amplas do plano sem ADR deixam de ser aceitas. Este ADR cobre retroativamente as duas inserções acima.
- A ordem de fases e gates vigente é: Fase 0 e Gate 0; Fase 1 e Gate Foundation; Fase 2 com Gate Auth (PR13) e Gate 2; Fase 3 e Gate 3; Fase 4 e Gate 4; depois Fase 5 e seguintes. Os gates de cada fase só são reexecutados por completo quando a fase muda.
- A revisão do checkpoint decidiu ajustes que o responsável incorpora ao plano: Gate 3 formal (script `poc:gate3:verify` e runbook `docs/runbooks/gate-3-catalog-stock.md`, escrito pelo responsável), UI de estoque e resolução da organização pela sessão antes do Gate 5 ([ADR 0026](0026-ui-de-estoque-organizacao-pela-sessao-e-preco-de-tabela.md)), suíte PostgreSQL 18 em CI antes da Fase 5 em vez do PR122 ([ADR 0025](0025-estrategia-de-testes-de-banco.md)) e integração da cadeia de PRs por fase ([ADR 0023](0023-integracao-da-cadeia-de-prs.md)).

## Consequências

- A sequência continua auditável: quem abrir o plano encontra a ordem real e, no ADR correspondente, a razão da mudança.
- As etapas inseridas (Gate Auth, Gate 2) são parte do plano e entram no critério de "fase concluída".
- O custo é disciplina de processo: um ADR curto por mudança de ordem, mesmo quando a mudança parece óbvia.

## Alternativas consideradas

- **Tratar o plano como proposta e o status como autoridade.** Inverte a precedência já declarada em `AGENTS.md` e `docs/README.md` e dilui o critério de aceite, pois o status é um registro cronológico.
- **Congelar o plano e registrar desvios só no status.** Mantém o plano estável, mas o plano deixa de descrever o caminho real e o status vira fonte de regras.
