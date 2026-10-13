---
status: accepted
---

# Integração da cadeia de PRs por fase, sem merge sem autorização

## Contexto

Até o checkpoint do Gate 4, os PRs do PR03 ao PR47 (mais o PR do fechamento do Gate 2) foram publicados como drafts **empilhados**, cada um sobre a branch do anterior, sem nenhum merge em `main`. O plano pede branches curtas e proíbe semanas de desenvolvimento numa única branch. Com mais de vinte PRs empilhados, qualquer conflito ou mudança na base se propaga pela cadeia, a revisão incremental fica difícil e `main` não contém nada do que foi construído. Além disso, os nomes das branches seguem `codex/prNN-...` em vez de `feat/…`, `fix/…` ou `chore/…` do plano.

## Decisão

Decidido na revisão do checkpoint Gate 4 (13/10/2026):

- **Nenhum merge sem autorização do responsável.** Agentes e automações não fazem merge nem ativam auto-merge; a integração é decisão explícita do responsável por PR ou por fase.
- **Estratégia recomendada: integrar por fase.** Um squash-merge sequencial por fase, na ordem Fase 0, Fase 1, Fase 2, Fase 3, Fase 4, e assim por diante. Cada merge exige CI verde e reexecução dos gates da fase no commit resultante (gates PostgreSQL em branch Neon descartável, enquanto o CI de banco do [ADR 0025](0025-estrategia-de-testes-de-banco.md) não existir). Os PRs permanecem empilhados até que sua fase seja integrada, e a base de cada PR restante é retargetada para `main` depois do merge da fase anterior.
- **Squash por fase preserva legibilidade.** O histórico de `main` fica com um commit por fase (ou por PR, se o responsável preferir squash por PR) e mensagem que lista os PRs cobertos; a rastreabilidade fina permanece nos PRs fechados e no status.
- **Nomes `codex/prNN-...` são aceitos** como desvio documentado do padrão `feat/…` do plano, porque identificam a etapa do plano, o agente e a ordem. Branches novas continuam curtas e coesas, e o prefixo não altera a regra de uma mudança conceitual por branch.
- **Antes da Fase 5.** A integração das fases 0 a 4 deve acontecer antes de iniciar a Fase 5, para que o trabalho offline parta de `main`.
- A numeração de PRs do plano (`PRnn`) e a numeração do GitHub (`#n`) são diferentes e não devem ser misturadas em prosa; o status mantém uma tabela de correspondência.

## Consequências

- `main` passa a refletir o estado real do projeto e os próximos PRs partem dele, reduzindo o risco de conflito em cascata.
- O risco do squash por fase é um revert grosseiro: reverter uma fase inteira é mais caro que reverter um PR. Mitigação: gates reexecutados por fase e correções adiante (forward-fix).
- Squash descarta a distinção de commits dentro de cada PR; quem precisar do histórico fino consulta o PR correspondente.
- Cada merge de fase é uma ação externa e só ocorre com autorização expressa.

## Alternativas consideradas

- **Merge sequencial de cada PR em `main`.** Preserva o histórico PR a PR, mas exige mais de vinte merges e reexecuções de CI, uma por vez.
- **Manter tudo empilhado até a Fase 5.** Adia o custo, mas a cadeia continua crescendo e o risco de conflito aumenta.
- **Rebase de toda a cadeia sobre `main`.** Reescreve histórico publicado e invalida CI e revisões já feitas.
