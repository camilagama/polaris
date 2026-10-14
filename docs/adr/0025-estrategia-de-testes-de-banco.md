---
status: accepted
---

# Estratégia de testes de banco: gates em Neon descartável e CI com PostgreSQL 18

## Contexto

Quase toda a garantia do Polaris vive no banco: RLS com `FORCE`, triggers deferidos, ledger append-only, grants mínimos e funções `SECURITY DEFINER`. Até o checkpoint do Gate 4, nada disso rodava em CI: o pipeline executa lint com boundaries, typecheck, testes unitários, Knip, build e o gate de navegador do offline, mas **não sobe PostgreSQL**, não reaplica as migrations, não confere drift do `db:generate` e nem sequer roda `format:check`. Cerca de dezenove gates e trinta e nove migrations só foram verificados à mão, em branches Neon descartáveis, com travas de host e de nome de branch nos scripts que impedem rodá-los contra um PostgreSQL de serviço. O plano prevê a suíte PostgreSQL em CI no PR122, muito depois do ponto em que as garantias já importam.

## Decisão

Decidido na revisão do checkpoint Gate 4 (13/10/2026):

- **Dois ambientes de prova, com papéis diferentes.**
  - **Neon descartável** (branch schema-only, de curta duração, banco novo por gate): continua sendo o ambiente de prova de aceite de cada fase, porque reproduz o provedor real. Procedimento em [gate-4-sales-core.md](../runbooks/gate-4-sales-core.md) e, para o Gate 3, no runbook `docs/runbooks/gate-3-catalog-stock.md` (escrito pelo responsável).
  - **CI com PostgreSQL 18** como serviço: roda a cada pull request, reaplica todas as migrations do zero, executa `db:generate` com checagem de diff (drift), `format:check` e os gates de banco, com as travas de host e de branch parametrizadas para aceitar o serviço de CI. O CI reduz o custo de reexecutar e impede regressão silenciosa; não substitui a prova no provedor. Enquanto o job `database` não tiver um histórico verde no GitHub Actions, ele roda como **consultivo** (não bloqueia o merge); a promoção a check obrigatório fica registrada como decisão do responsável. O job `audit` (`bun audit`) também é consultivo.
- **Gates sequenciais por banco.** Dois gates nunca rodam em paralelo no mesmo banco, porque os de falha injetada criam triggers em tabelas compartilhadas e contaminam a execução do outro. No CI, a sequência roda em um job com um banco por execução; paralelismo só entre bancos distintos.
- **Roles realistas.** Os gates devem exercitar as roles reais de aplicação (sem `BYPASSRLS` e sem ownership), uma sessão com fuso diferente de UTC e, quando houver, papéis além de `owner`.
- **Lacunas explícitas.** O CI não prova o caminho Worker, Hyperdrive e Neon (pooling, `set_config` e triggers deferidos através do pooler): essa prova com código tenant real roda em staging e está no checklist de go-live dos [runbooks](../runbooks/README.md).
- **Oráculos independentes.** Cenários de dinheiro usam um oráculo que exercite o arredondamento half-up (não apenas casos exatos), e as asserções de contagem de migrations não ficam fixas em números obsoletos.

## Consequências

- Regressões de RLS, triggers e migrations passam a quebrar o CI em vez de esperar um gate manual.
- O CI de banco tem custo de tempo e de manutenção dos scripts de gate (suporte comum para ambiente, SQLSTATE esperado e fixtures de tenant, hoje duplicado entre scripts).
- Branches Neon continuam limitadas por plano; apagar a própria branch depois do gate segue obrigatório.
- A promessa do plano (PR122) é antecipada para antes da Fase 5; o PR122 passa a cobrir apenas o que sobrar (harness do Worker, suíte de concorrência).

## Alternativas consideradas

- **Só gates manuais em Neon.** Mantém a fidelidade ao provedor, mas depende de memória e de tempo humano a cada mudança.
- **Mocks de banco em testes unitários.** Rápidos, mas não provam RLS, triggers nem grants, que são a razão dos gates.
- **Esperar o PR122.** Deixa dezenas de PRs de banco sem prova repetível.
