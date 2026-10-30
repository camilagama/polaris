---
status: accepted
---

# Separação das roles de banco de auth e de tenant e remoção das superfícies PoC

## Contexto

Os [ADRs 0002](0002-neon-postgresql18-hyperdrive-rls.md) e [0006](0006-audit-events-tenant.md) já registram que os GUCs transaction-local (`app.user_id`, `app.organization_id`) são contexto definido pelo runtime, não prova de identidade contra SQL arbitrário. A mesma role de runtime, `polaris_pr11_runtime` (nome herdado da prova PR11), serve hoje a duas finalidades: a autenticação Better Auth, com DML sem RLS nas tabelas `user`, `account`, `session` e `verification`, e as operações de tenant. Consequência concreta: qualquer SQL arbitrário na role de tenant lê todos os usuários, forja os dois GUCs e passa pelas policies. O padrão de separação já existe para o onboarding (`polaris_onboarding_runtime`, função `SECURITY DEFINER`) e para o cleanup de mídia (`polaris_media_cleanup_runtime`, [ADR 0014](0014-private-media-derivatives-and-reconciliation.md)).

Também continuam no repositório e no bundle superfícies de prova: a tabela `db_poc_operations`, a rota `/api/poc/database`, a rota de RLS (`rls-poc`), as configurações `wrangler.pr11.jsonc` e `wrangler.pr12.jsonc`, o laboratório offline, e o Hyperdrive real do PR11 referenciado em arquivo de configuração. Não há registro de que os Workers e o Hyperdrive PoC remotos tenham sido removidos, nem de que a credencial owner do PR11 tenha sido rotacionada.

## Decisão

Decidido na revisão do checkpoint Gate 4 (13/10/2026):

- **Duas roles de runtime, dois Hyperdrives.** Uma role de **auth** (`polaris_auth_runtime`) com DML nas quatro tabelas de autenticação e nenhum acesso às tabelas de domínio; e uma role de **tenant** sem nenhum acesso a essas quatro tabelas. Cada uma conecta por seu próprio binding Hyperdrive, com query caching desabilitado. As duas são roles sem `BYPASSRLS` e sem ownership dos objetos. O Better Auth usa o binding de auth; as operações de tenant usam o binding de tenant, depois de a sessão ter sido resolvida.
- **Este ADR supera parcialmente o ADR 0002**, no ponto em que ele tratava a role runtime única e o onboarding como adiado; o onboarding já havia sido alterado pelo [ADR 0007](0007-gate2-onboarding-and-category-rls.md). Os demais pontos do ADR 0002 (PostgreSQL 18, Hyperdrive sem cache, contexto transacional, RLS como defesa em profundidade) permanecem em vigor.
- **Superfícies PoC saem do build de produção.** O laboratório offline e as rotas de PoC não entram no bundle nem no Worker de produção; a tabela `db_poc_operations` e as rotas associadas são removidas (a tabela por migration), e os arquivos `wrangler.pr11/pr12` deixam de ser configuração de produção. Os recursos remotos de PoC (Workers e Hyperdrive) são removidos e a credencial owner do PR11 é rotacionada pelo responsável, registrados no checklist de go-live dos [runbooks](../runbooks/README.md) — nada disso foi executado por esta documentação.
- **Outras decisões de endurecimento da mesma rodada**, implementadas por outros agentes: defesa CSRF por `Origin` no `/rpc` e atributos de cookie fixados; arquivo `_headers` com CSP, `frame-ancestors`, HSTS e demais headers para a SPA servida pelos Static Assets; rate limits e timeouts de banco (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`); limites de tamanho de texto, de percentual e de parcelas no domínio, no contrato e como `CHECK`; tetos de upload e de transformação de mídia; reconciliação entre o ledger e o saldo (por trigger deferido) e sequência por variante no ledger; CI com PostgreSQL 18 ([ADR 0025](0025-estrategia-de-testes-de-banco.md)).

## Consequências

- Um SQL arbitrário na role de tenant deixa de ler credenciais e sessões; a separação reduz o raio de explosão de uma injeção na camada tenant.
- Aumenta o custo operacional: duas credenciais, dois bindings Hyperdrive e uma role a mais para provisionar e rotacionar. O gate de RLS e os runbooks precisam provar a negação cruzada entre as duas roles.
- Remover as superfícies PoC elimina rotas e tabelas que ninguém deveria alcançar em produção, ao custo de perder os laboratórios como atalho de demonstração (eles continuam acessíveis em desenvolvimento e na build de PoC).
- O nome `polaris_pr11_runtime` é herança do PoC; renomeá-lo é uma mudança opcional e separada, não decidida aqui.
- Até as mudanças serem implementadas e verificadas, o estado do código segue o ADR 0002 e as pendências aparecem no checklist de go-live.

## Alternativas consideradas

- **Manter uma única role e confiar na aplicação.** É o estado atual; a exploração é concreta e o ganho de simplicidade não justifica a superfície.
- **Esconder as tabelas de auth com RLS por `user_id`.** Better Auth precisa ler e escrever essas tabelas antes de existir contexto de usuário, o que inviabiliza a policy.
- **Funções `SECURITY DEFINER` para todo acesso de auth.** Fecha a superfície, mas reimplementa o adaptador do Better Auth em SQL e dificulta atualizações da biblioteca.

## Emenda (30/10/2026): as superfícies de prova saíram do banco e da configuração

A parte de banco e configuração da decisão "Superfícies PoC saem do build de produção" foi feita:

- A migration 0108 apaga `db_poc_operations` e `rls_poc_operations`, com a política `rls_poc_operations_organization_isolation` (`FOR ALL TO PUBLIC`) e os grants do papel de tenant sobre ela. As duas tabelas saíram do schema do Drizzle e das listas da exportação e do purge.
- A rota `/api/poc/database` e o `DB_POC_ENABLED` já não existiam no código; o script `poc` de `packages/db`, que usava a definição da tabela, saiu.
- `DB_RLS_POC_ENABLED` saiu da rota de RLS e do `wrangler.pr11.jsonc`. A rota continua só no Worker de prova do PR11 (`apps/web/poc/pr11.ts`, configuração própria) e no servidor local do gate `rls` do CI; o Worker do app nunca a importa.
- Os gates que provam RLS nessa tabela (`tenant-context` e `rls`, da suíte `ci`) não perderam asserção: cada um cria a tabela na base descartável já confirmada, a partir da migration 0001 (as mesmas instruções que o bootstrap do PR11 roda num projeto Neon vazio), e a apaga ao terminar (`packages/db/scripts/rls-gate-fixture.ts`). A prova remota pelo Worker e pelo Hyperdrive (`poc:rls:bootstrap` e `poc:rls:verify`) não mudou: ela já criava a tabela num projeto vazio.
- O `verify:staging-isolation` recusa `DB_POC_ENABLED` e `DB_RLS_POC_ENABLED` em qualquer bloco do `wrangler.jsonc` (nível de cima, staging, produção) e no `wrangler.json` da build, com qualquer valor.

Continua fora do repositório e do código: remover os Workers e o Hyperdrive de PoC no Cloudflare e rotacionar a credencial owner do PR11 (checklist de go-live dos [runbooks](../runbooks/README.md#superfícies-e-credenciais-de-prova)). O laboratório offline é outra etapa.
