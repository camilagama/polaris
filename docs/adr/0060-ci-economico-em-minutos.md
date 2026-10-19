---
status: accepted
---

# CI econômico em minutos do GitHub Actions

## Contexto

O repositório é privado, então cada job do CI consome minutos da conta dona e o GitHub cobra cada job **arredondado para cima ao minuto**. Em 6 a 15/10/2026 foram 201 execuções e 1.295 jobs: 1.146 minutos de tempo real, mas cerca de 1.890 minutos cobrados (perda de ~39% só com arredondamento, porque os checks leves duram de 20 a 90 segundos). O gate de navegador sozinho foi 30% (576 minutos, ~9 por execução: 468 s só no `test:offline-poc`, que roda dois projetos em série) e cada merge repetia na `main` tudo o que o pull request já tinha provado. Em 15/10 o Actions parou de iniciar jobs ("pagamentos recentes falharam ou o limite de gastos precisa aumentar"): a economia de minutos virou requisito, não otimização.

## Decisão

- **Os checks leves viram um job só** ("Checks"): lint, formato, fronteiras, drift de migration, tipos, knip, build e testes unitários compartilham checkout, instalação e cache. Cada passo roda mesmo se um anterior falhar (`!cancelled()` e instalação concluída), então uma execução continua mostrando todos os problemas, e o job falha se qualquer um falhar. Nenhum check foi removido nem afrouxado.
- **O gate de navegador só roda quando algo que ele exercita mudou.** Um job curto (`changes`, cerca de um minuto) compara o commit testado com seu primeiro pai (a base do merge do pull request) e classifica os arquivos em `scripts/ci-changed.mjs`, com testes: só prosa (`docs/`, `doc/`, `*.md`), só o pacote de banco (`packages/db/`) ou só o servidor, o Worker e os scripts de gate do app web (`apps/web/src/server/`, `apps/web/worker/`, `apps/web/scripts/`) ou só o app Admin (`apps/admin/`) não aciona o gate: ele serve o bundle estático do cliente e responde às chamadas `/rpc` com `page.route`, então nada disso roda nele e o cliente nunca os importa (para o Admin, `scripts/ci-changed.test.mjs` lê o grafo de imports e falha se `apps/web`, `apps/catalog` ou `packages/` passarem a importá-lo); qualquer outra coisa, inclusive o próprio workflow e o script, aciona. Se a classificação falhar, o gate roda mesmo assim.
- **O gate de navegador não se repete na `main`.** O pull request já o provou sobre o resultado do merge; a `main` roda os checks leves e os gates de banco. Uma execução completa sob demanda existe (`workflow_dispatch`, que também liga a auditoria).
- **A auditoria de dependências só roda quando um manifesto ou o lockfile mudou** (qualquer `package.json`, `bun.lock`, `.bun-version`, `.node-version`) e continua consultiva.
- **Um cache só por lockfile.** A chave do cache de instalação deixa de incluir o nome do job (eram 55 caches somando 10,8 GB, acima do limite de 10 GB do repositório, que despejava caches o tempo todo), com `restore-keys` para aproveitar o do lockfile anterior.
- **Os gates de banco (PostgreSQL 18) continuam rodando em todo pull request**: são baratos (cerca de 1,5 minuto) e provam o que mais importa.

## Consequências

- Estimativa sobre o histórico real (classificando cada pull request pelos arquivos que mudou): ~18% menos minutos cobrados (cerca de 340 de 1.890). Quase todo pull request toca o app web, então o gate de navegador continua rodando na maioria deles e é o grosso do custo. Pull requests só de documentação ou só de banco custam cerca de 7 a 8 minutos em vez de 17.
- A execução fica mais longa no relógio (os checks leves deixam de rodar em paralelo: de ~1,5 para ~4 a 5 minutos), em troca de menos minutos.
- Uma mudança de banco que quebre o app web só seria vista pelo gate de navegador depois de acionada por outra mudança ou sob demanda. Aceito: o cliente web não importa o pacote de banco, e os gates de banco e os testes unitários continuam rodando.
- O que mais reduziria o consumo sem enfraquecer nada é acelerar o gate de navegador (hoje serial por causa do SQLite WASM) ou rodar menos execuções (agrupar commits antes do push); isso é decisão à parte.

## Alternativas rejeitadas

- **Pular o CI inteiro em pull requests de documentação:** o formato e as fronteiras também valem para arquivos Markdown e de configuração.
- **Rodar o gate de navegador só em um projeto (desktop):** reduziria o tempo pela metade, mas enfraquece a prova em tela de celular, que importa para um app offline-first.
- **Usar uma ação de terceiros para detectar caminhos:** mais uma dependência com pin de commit a manter, para algo que cabe em 70 linhas testadas.
- **Rodar tudo em `main` por segurança:** repete o que o pull request já provou sobre o mesmo código.
