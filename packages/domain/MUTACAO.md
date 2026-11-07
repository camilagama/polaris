# Testes de mutação do domínio (Stryker)

O Stryker muda o código de `src/money/`, `src/sales/`, `src/inventory/` e `src/economics/` (um operador, uma condição, uma constante por vez) e roda os testes dessas quatro pastas. Mutante que nenhum teste derruba **sobreviveu**: aponta uma regra sem prova. Só relata; não reprova por pontuação (`break` desligado).

## Rodar

```sh
bun run --filter @polaris/domain test:mutation            # as quatro pastas, uma de cada vez
bun run --filter @polaris/domain test:mutation money      # só uma (money, sales, inventory, economics)
```

Precisa de `node` no PATH (o Stryker abre processos filhos). Em `packages/domain/reports/` ficam os arquivos incrementais (`stryker-incremental-<pasta>.json`) e, em `reports/mutation/`, o relatório HTML e o JSON de cada pasta. O resumo (pontuação por pasta e sobreviventes por arquivo e linha) sai no console e, no Actions, no `GITHUB_STEP_SUMMARY`.

- `MUTATION_DEADLINE_MINUTES` encerra a execução no prazo; o Stryker guarda o que já testou e a próxima continua dali.
- Com o arquivo incremental, só os mutantes dos arquivos que mudaram (ou cujos testes mudaram) são testados de novo. Apague `reports/` para recomeçar.

## Por que é assim

- `inPlace: true`: o Stryker copia o projeto para uma pasta temporária e reescreve o `tsconfig.json` com a API do TypeScript, que o TypeScript 7 não tem; no lugar, ele troca os arquivos e os restaura ao sair.
- Se o processo for morto sem restaurar (SIGKILL, queda da máquina), arquivos de `src/` ficam mutados: rode `git status` e `git checkout -- packages/domain/src` antes de commitar.
- No fim de uma execução que o script conclui (também depois de um corte por `MUTATION_DEADLINE_MINUTES`), ele compara o `git diff` de `src/` com o do início e, se mudou, avisa no erro padrão e sai com código 3 (que vale mais que o 1 de uma pasta que falhou): é o `src/` mutado que o Stryker não restaurou; restaure com `git checkout -- packages/domain/src`. Se o `git diff` não puder ser lido, o aviso também sai. Edição sua não commitada, que já estava lá no início, não dispara o aviso.
- Depois de interromper com Ctrl+C, ou se o script for morto de outra forma, não há aviso garantido (o Bun morre junto com o grupo de processos no SIGINT): confira `git diff packages/domain/src` e restaure com `git checkout -- packages/domain/src`.
- Numa execução parcial (`test:mutation money`), as pastas não pedidas aparecem no resumo como "not run": o JSON que uma rodada anterior deixou em `reports/mutation/` não é lido.
- `vitest.mutation.config.ts` limita os testes às quatro pastas; com `coverageAnalysis: perTest`, cada mutante roda só os testes que passam pela linha mutada.
- `@stryker-mutator/vitest-runner` precisa da 10.1.1 ou mais nova para o Vitest 5 (o filtro por nome de teste usa ` > ` entre as suítes).
- O workflow agendado não roda no PR: ele é entregue como patch de texto (`mutation-nightly.yml`) e aplicado por quem cuida de `.github/workflows`, depois do merge.
