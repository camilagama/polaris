# Polaris ERP vNext

## Plano de implementação detalhado e cauteloso



**Status:** plano de execução derivado da arquitetura canônica  

**Objetivo:** construir o novo Polaris do zero sem transportar acidentalmente as limitações arquiteturais do sistema legado.  

**Estratégia:** fundação comprovada primeiro; funcionalidades depois.  

**Regra principal:** nenhum módulo posterior pode contornar ou duplicar uma decisão já consolidada na fundação.

**Autoridade:** este arquivo rege a sequência e os critérios de implementação. Objetivos, terminologia, design, arquitetura e invariantes de negócio têm seus homes canônicos nos arquivos de raiz e em docs/. Detalhes antigos ainda não migrados são propostas e não autorizam implementação sem validação.



---



# 1. Como usar este plano



O desenvolvimento deve acontecer em PRs pequenos e semanticamente coesos.



Um PR não deve tentar simultaneamente:



- criar infraestrutura;

- mudar arquitetura;

- implementar feature;

- redesenhar UI;

- alterar billing;

- alterar segurança.



Cada PR precisa possuir:



1. problema;

2. resultado esperado;

3. arquivos alterados;

4. risco;

5. testes necessários;

6. critério de aceite;

7. documentação afetada.



Sempre que um PR introduzir uma decisão estrutural nova que contradiga este documento, ele deve parar e gerar uma decisão arquitetural explícita antes de prosseguir.



---



# 2. Regras para todos os PRs



## 2.1 Branches



Usar branches curtas:



```text

feat/foundation-...

feat/auth-...

feat/catalog-...

fix/...

chore/...

```



Não desenvolver semanas inteiras numa branch.



---



## 2.2 Tamanho



Preferência:



```text

1 PR = 1 mudança conceitual

```



Não usar número de arquivos como métrica de tamanho.



Uma migration + domínio + testes necessários para uma regra pode ser um único PR.



Três features independentes não devem estar juntas apenas porque cada uma altera poucos arquivos.



---



## 2.3 Verificação mínima



Todo PR deverá passar, quando aplicável:



```text

bun install --frozen-lockfile

bun run check

bun run typecheck

bun run test

bun run knip

bun run build

```



O conjunto real será criado durante a Fase 0.



PRs de banco deverão também executar a suíte PostgreSQL.



PRs de UI crítica deverão executar E2E relevante.



---



# 3. Classificação de risco



## Low



Exemplos:



- copy;

- documentação;

- componente puramente visual;

- refactor sem comportamento.



Verificação mínima.



## Medium



Exemplos:



- API;

- formulário;

- query;

- entitlement não financeiro;

- mudança de fluxo.



Exige testes focados e integração.



## High



Exemplos:



- autenticação;

- billing;

- RLS;

- estoque;

- venda;

- offline;

- migration destrutiva;

- privacy;

- Admin;

- restore.



Exige testes de comportamento reais, documentação e avaliação explícita de rollback.



---



# 4. Gate global

Não começar a multiplicar features enquanto estas quatro provas de infraestrutura não existirem:

- React/Vite no Worker;
- Hono + oRPC funcionando;
- Hyperdrive + PostgreSQL 18 + RLS comprovados remotamente;
- offline persistence POC aprovado ou alternativa escolhida.

Isso é o Gate Foundation. Better Auth fica depois desse gate, como primeira prova da Fase 2, e precisa passar pelo Gate Auth antes dos fluxos de login e tenant.

# FASE 0 — REPOSITÓRIO E GOVERNANÇA



Objetivo: criar um repositório saudável antes de criar qualquer regra de negócio.



---



# PR 01 — Scaffold do monorepo



## Objetivo



Criar a estrutura inicial:



```text

apps/web

apps/admin

apps/catalog



packages/domain

packages/contracts

packages/db

packages/billing

packages/ui

```



## Incluir



- Bun workspaces;

- Turborepo;

- TypeScript 7;

- Node 24 pinado;

- `.gitignore`;

- `.editorconfig`;

- package scripts;

- tsconfigs compartilhados.



## Ainda não incluir



- autenticação;

- banco;

- billing;

- feature real.



## Aceite



- `bun install` funciona;

- todos os workspaces são detectados;

- Turbo executa comandos;

- todos os packages compilam vazios;

- zero dependência circular.



---



# PR 02 — Biome, Ultracite e convenções



## Objetivo



Adicionar padrão de qualidade desde o primeiro código.



## Implementar



- Biome;

- Ultracite;

- regras TypeScript strict;

- import sorting;

- formatting;

- regras anti-`any`;

- tratamento consistente de unused imports.



## Aceite



```text

bun run lint

bun run format:check

bun run typecheck

```



passam.



Não adicionar ESLint ou Prettier em paralelo.



---



# PR 03 — Knip e boundaries



## Objetivo



Evitar dependências e imports arquiteturalmente inválidos.



## Regras principais



`packages/domain` não pode importar:



```text

react

hono

orpc

drizzle

cloudflare

better-auth

billing providers

```



`packages/contracts` não pode importar DB.



Aplicações podem consumir domain/contracts.



## Aceite



Um teste/fixture deve provar que um import proibido faz o gate falhar.



---



# PR 04 — Documentação canônica inicial



Criar:



```text

PRODUCT.md

CONTEXT.md

DESIGN.md

AGENTS.md

docs/architecture/

docs/adr/

docs/business-rules/

docs/runbooks/

```



Colocar a arquitetura consolidada como fonte inicial.



## Não fazer



Duplicar a mesma regra em cinco documentos.



Cada documento precisa declarar sua autoridade.



---



# PR 05 — CI baseline



Criar GitHub Actions.



Jobs iniciais:



```text

lint

typecheck

unit

knip

build

```



Configurar:



- Bun pinado;

- Node pinado;

- cache adequado;

- permissões mínimas;

- actions pinadas;

- concurrency.



Nenhum deploy ainda.



---



# PR 06 — Renovate e dependency policy



Adicionar Renovate.



Agrupar:



```text

TanStack

Cloudflare

Biome/Ultracite

Vitest

Playwright

```



Major updates:



```text

manual review

```



Nada de auto-merge de major.



---



# GATE 0



Antes da Fase 1:



- repo limpo;

- CI verde;

- boundaries funcionando;

- documentação presente;

- builds vazios funcionando.



---



# FASE 1 — PROVAS DE ARQUITETURA



Nenhuma feature comercial deve ser construída nesta fase.



---



# PR 07 — React + Vite + Cloudflare Worker



## Objetivo



Provar `apps/web`.



Criar:



```text

React

Vite

Cloudflare Vite Plugin

Worker

Static Assets

```



## Endpoint mínimo



```text

GET /health

```



retorna informações não sensíveis:



```json

{

  "status": "ok"

}

```



## Aceite



- dev local funciona;

- build Worker funciona;

- React é servido;

- `/health` passa.



---



# PR 08 — Hono shell



Adicionar Hono.



Estruturar aproximadamente:



```text

src/server/

  app.ts

  middleware/

  routes/

```



Criar:



```text

GET /health

GET /ready

```



Adicionar:



- request id;

- error boundary;

- headers básicos.



Não adicionar domínio ainda.



---



# PR 09 — oRPC POC



Adicionar major estável do oRPC.



Criar procedure simples:



```text

system.ping

```



Fluxo completo:



```text

React

→ oRPC client

→ Hono

→ oRPC handler

→ result

```



## Proibição



Procedure não acessa banco diretamente.



Criar use case mínimo intermediário mesmo no POC.



---



# PR 10 — PostgreSQL + Drizzle + Hyperdrive POC



Adicionar:



- Drizzle;

- `pg`;

- Hyperdrive binding;

- DB package.



Criar tabela descartável de POC ou schema mínimo.



Testar:



- query;

- transaction;

- rollback;

- connection reuse.



Não construir entidades reais ainda.



---



# PR 11 — Gate RLS/Hyperdrive

**Risco: crítico.**

Este é um dos PRs mais importantes do projeto.

## Criar

Duas organizações artificiais, org_a e org_b, com dados independentes.

Implementar withTenantTransaction() para abrir uma transação, definir o contexto local com set_config('app.organization_id', ..., true) e executar nela todas as queries tenant-scoped da operação.

## Testar localmente e com PostgreSQL 18

- tenant A vê A e tenant A não vê B;
- tentativa cross-tenant retorna zero/erro;
- todos os statements de uma operação compartilham a mesma transação contextualizada;
- leituras sem contexto são negadas ou retornam zero linhas;
- rollback limpa o contexto;
- uma nova transação não herda o contexto anterior;
- tenant A e B concorrentes não cruzam dados quando conexões são reutilizadas;
- falha em um statement faz rollback da operação inteira;
- interrupção da conexão exige retry integral da operação em uma nova transação, reaplicando o contexto;
- FORCE RLS;
- runtime role não é owner e não tem BYPASSRLS;
- query caching desabilitado sem perder connection pooling.

## Obrigatório

Executar o POC pelo caminho real Worker → Hyperdrive → Neon, na região Neon pretendida para o projeto. Guardar resultados e configuração usados para que o gate seja reproduzível.

## Stop condition

Qualquer vazamento, contexto ausente aceito ou resultado não reproduzível bloqueia a implementação tenant. Corrigir a causa antes de continuar.

# PR 12 — Offline persistence POC



Criar aplicação isolada/Página de laboratório.



Testar TanStack DB:



- criar dados offline;

- reload;

- fechar browser;

- abrir novamente;

- duas abas;

- alteração concorrente;

- schema migration;

- kill abrupto.



Testar:



- Chrome;

- Edge;

- Android Chrome;

- Safari/iPhone.



## Critério



Se os requisitos não forem confiáveis:



```text

TanStack persistence → rejeitada

Dexie/IndexedDB → fallback

```



O protocolo futuro não deve depender dessa escolha.



---



# GATE FOUNDATION



Só continuar se:



- RLS aprovado;

- Hyperdrive aprovado;

- oRPC aprovado;

- Worker aprovado;

- offline persistence aprovada ou fallback escolhido.



---



# FASE 2 — IDENTIDADE E TENANCY



---



# PR 13 — Better Auth base

Adicionar Better Auth como primeiro trabalho da Fase 2, depois do Gate Foundation.

Configurar somente:

- users;
- accounts;
- sessions;
- verifications.

Não adicionar Organization plugin como source of truth.

Este PR é também a prova base de Better Auth no Worker: verificar inicialização, persistência necessária e criação/leitura/revogação de sessão por fixture controlada, sem depender de um provider OAuth real.

## GATE AUTH

Não iniciar PR14 Google, PR15 senha ou fluxos tenant até:

- Better Auth operar no runtime Worker;
- as sessões persistirem e serem validadas pelo servidor;
- logout/revogação invalidar a sessão;
- migrations e cookies/headers necessários funcionarem no ambiente de teste;
- não haver dependência do plugin Organization como autoridade de tenancy.

Se falhar, corrigir a integração antes dos fluxos de login.

# PR 14 — Login Google



Implementar OAuth Google.



Testar:



- login;

- logout;

- sessão;

- callback inválido;

- provider error.



Adicionar audit events de segurança apropriados.



Não registrar OAuth payload.



---



# PR 15 — Email/password



Adicionar:



- signup;

- email verification;

- password login;

- password reset.



Aplicar [docs/business-rules/authentication.md](../docs/business-rules/authentication.md): 15–128 pontos de código Unicode após NFC, espaços permitidos, sem composição arbitrária nem expiração periódica; verificar HIBP antes de estabelecer/alterar credencial e falhar fechado se a consulta não estiver disponível. Reset revoga todas as sessões.

Usar Resend com templates React Email minimalistas, idempotency key por token e secrets `RESEND_API_KEY` + `AUTH_EMAIL_FROM` de domínio verificado. Os fluxos ficam indisponíveis sem sender configurado e só são expostos após PR16 (rate limiting e Turnstile). O outbox/Queue e webhooks de delivery da proposta inicial ficam adiados para hardening pré-go-live; PR15 usa callback síncrono idempotente. `EMAIL_PASSWORD_AUTH_ENABLED` permanece `false` por padrão e só deve ser ligado após o PR16.



---



# PR 16 — Turnstile e auth abuse



Adicionar verificação Turnstile server-side e rate limiting para as operações públicas de email/senha:



- signup e envio de verificação;

- password login;

- solicitação e conclusão do reset de senha.



O Worker deve validar o token pelo Siteverify, conferir `action` e o hostname configurado do Better Auth, limitar tentativas antes de chamar o provider e falhar fechado se a configuração ou a verificação estiver indisponível. O token chega no header `x-turnstile-token`; token ausente/inválido não deve chegar ao Better Auth.

Usar bindings nativos de rate limiting do Workers para um limite geral por IP e um limite menor para operações que enviam email. As chaves não devem conter IP em claro. Os contadores desses bindings são locais por região Cloudflare, então não representam uma quota global; registrar a limitação e reavaliar uma proteção distribuída antes de lançar caso o risco exija.

A interface de autenticação ainda não existe. Este PR fecha os endpoints; a tela futura deve renderizar o widget com a site key pública, enviar o token no header acima e usar a ação correspondente ao endpoint. Manter os fluxos de senha desligados até secret, hostnames, bindings e widget estarem configurados.



Testar:



- token ausente;

- token inválido e ação/hostname divergentes;

- replay de token;

- limite de IP e limite de envio de email excedidos;
- timeout/erro do Siteverify e ausência de configuração.

Registrar configuração, limites, contrato do header, privacidade e passos de ativação em runbook.



---



# PR 17 — Account linking



Implementar vínculo explícito entre uma conta Better Auth de senha e a identidade Google. Não vincular automaticamente durante login social. O endpoint `link-social` exige sessão com email verificado, rejeita `idToken` enviado pelo cliente e inicia o fluxo OAuth com redirect/PKCE. Manter `disableImplicitLinking: true`, `trustedProviders: []`, `allowDifferentEmails: false` e não substituir o perfil local pelos dados do Google ao vincular.



Casos obrigatórios:



```text

verified same email → eligible

unverified email → reject

different email → reject

```



O email local e a afirmação de email do Google precisam estar verificados e ser iguais sem distinção de caixa. Uma sessão Google verificada pode adicionar senha pelo método server-only `auth.api.setPassword`, desde que siga a política de senha do PR15; sessão com email não verificado é rejeitada. O fluxo permanece atrás da configuração de email/senha.

Testar:

- vínculo explícito com sessão e mesmo email verificado;
- email local não verificado;
- email Google não verificado;
- email diferente;
- sessão ausente;
- tentativa de vincular por `idToken` enviado pelo cliente;
- login Google sem vínculo implícito de uma conta de senha existente;
- adicionar senha a uma sessão Google verificada e confirmar que ambos os métodos usam o mesmo user ID;
- chamadas de `set-password` rejeitadas quando email/senha está desligado.



---



# PR 18 — Sessões

Implementar:

- TTL idle de 7 dias (`expiresIn`) com renovação no máximo a cada 24 horas (`updateAge`) durante uso autenticado; desativar cookie cache para validar revogação no servidor.
- Limite absoluto de 30 dias desde a criação. O Worker revoga sessões vencidas antes de encaminhar qualquer rota Better Auth; a migration PostgreSQL limita `expires_at` no INSERT/UPDATE, preserva `created_at` e ajusta linhas existentes.
- Permitir múltiplas sessões e usar os endpoints Better Auth de listagem, revogação individual e logout, verificando isolamento por usuário. A listagem exige sessão fresca de até 24 horas.
- Reset de senha revoga todas as sessões.
- Testar idle e absolute expiry, refresh perto do limite, múltiplas sessões, listagem/revogação do próprio usuário, logout, token cru e reset em duas sessões.
- Aplicar a migration e verificar o limite absoluto em PostgreSQL 18.

---

# PR 19 — Organizations e memberships

Criar schema e migration PostgreSQL para `organizations` e `memberships`.

Campos mínimos de organização:

```text
id
name
timezone
currency
status
```

Membership é identificado pela chave composta `(organization_id, user_id)` e inicia com `role = owner` e `status = active`; checks no banco limitam o vocabulário desta etapa a esses dois valores até que novos roles ou estados sejam definidos por migration. Não adicionar unicidade global a `user_id`: permitir múltiplas organizações no modelo preserva a evolução futura; a regra V1 de uma organização por usuário será imposta no domínio durante o PR20.

A V1 opera em BRL. A organização mantém timezone IANA; o PR20 valida o identificador no servidor durante o onboarding. A criação exige email verificado e essa condição é conferida no servidor, conforme `docs/business-rules/organization-and-access.md`.

Estados de organização: `active`, `suspended` e `closed`; não misturar estado operacional com estado de billing. A FK de membership para usuário usa `ON DELETE RESTRICT`; portanto, a exclusão física de um usuário com vínculo fica bloqueada. Fluxo de transferência/encerramento antes da exclusão ainda precisa ser definido.

Não impor acoplamento estrutural irreversível. Este PR cria somente schema: sem grant para role de runtime, políticas RLS ou rotas tenant. Grants/RLS entram junto da autorização e do contexto tenant, antes de operações tenant serem expostas.

Gate: gerar e reaplicar a migration em branch Neon descartável PostgreSQL 18; provar checks de status/moeda e de role/status do membership, chave composta e FKs; confirmar que `polaris_pr11_runtime` continua sem `SELECT` nas novas tabelas e que a branch production não foi alterada.

---



# PR 20 — Onboarding idempotente

Implementar o use case interno:

```text
createInitialOrganization()
```

O use case recebe o `userId` obtido de uma sessão autenticada no servidor e valida `user.email_verified` diretamente no banco. Não aceitar identidade ou estado de verificação enviados pelo cliente. Validar e normalizar nome e timezone IANA antes de iniciar a transação.

Dentro de uma transação PostgreSQL `READ COMMITTED`:

1. obter advisory lock transaction-scoped em namespace próprio e chave derivada do usuário;
2. bloquear a linha de usuário para leitura enquanto confere email verificado;
3. procurar memberships existentes;
4. se houver exatamente um, retornar a organização existente sem alterar nome/timezone (retry idempotente); se houver mais de um, falhar fechado;
5. se não houver, inserir organization e membership owner/active na mesma transação.

A regra V1 de uma organização por usuário é a fronteira de idempotência; não criar tabela de idempotency keys nem constraint global em `memberships.user_id`. O use case não persiste uma chave por request: retry para o mesmo `userId` retorna a organização existente sem alterá-la; payloads concorrentes diferentes para o mesmo usuário também retornam o primeiro resultado. O lock é liberado automaticamente no commit/rollback.

“Defaults essenciais” neste PR são os defaults já definidos no schema: currency BRL, organization status active, membership role owner e status active. Não há regra de produto para semear categorias, produtos ou outros registros; não inventar seed data.

Este PR entrega o use case interno e seu gate, sem rota HTTP ou grants para `polaris_pr11_runtime`. Expor onboarding só depois de capabilities, contexto de autorização e RLS conforme PR21/22.

Testar: repetir o mesmo comando retorna o mesmo ID sem alterar campos; requests concorrentes para o mesmo usuário, com payloads distintos, criam exatamente uma organização e um membership owner; usuário não verificado/ausente, timezone inválido e memberships preexistentes múltiplos são rejeitados. Executar gate em PostgreSQL 18 de branch Neon descartável; a branch production permanece intacta.
---



# PR 21 — Capabilities tenant

Criar em `packages/domain` um mapa único de role→capability. No V1, `owner` recebe somente o conjunto nomeado abaixo:

```text
catalog:read
product:create
product:update
inventory:adjust
sale:create
customer:update
expense:create
organization:manage
```

Centralizar a consulta em `capabilitiesForRole()`/`hasCapabilityForRole()`; não espalhar comparações de role pela aplicação. Role desconhecido ou capability desconhecida falha fechado, sem permissão.

Este mapa puro não autentica usuário, não verifica membership/status e não escolhe organização. Essas etapas pertencem ao contexto de request do PR22. Não adicionar rota tenant neste PR.

Testar o conjunto exato de capabilities de `owner`, allow para cada capability declarada, deny para role/capability desconhecidos e imutabilidade do mapa exportado.
---



# PR 22 — Tenant request context



Implementar middleware/use-case context:



```text

authenticate

→ resolve org

→ membership

→ capability

→ tenant transaction

```



Toda query tenant passa por ele.



Criar testes cross-tenant.



---



# PR 23 — Audit events tenant

Criar a tabela tenant-specific `tenant_audit_event`, separada da auditoria global de autenticação `auth_security_audit_event`.

O evento registra apenas organization ID, actor user ID interno, códigos event/entity type limitados, entity ID opaco em formato UUID e request ID UUID opcional. O writer e os checks do banco rejeitam campos fora desse contrato. Não armazenar payloads, snapshots before/after, email, IP, user-agent, tokens ou outros segredos.

`recordTenantAuditEvent(transaction, identity, event)` escreve na transação já aberta e usa a identidade validada do contexto tenant. Não iniciar uma segunda transação no writer. Eventos de mutação crítica devem comitar ou sofrer rollback junto com a mutação.

A primeira mutação auditada é `organization.created`, escrita junto com organização e membership no onboarding interno. Retry idempotente não cria outro evento. Mutações de catálogo, estoque e vendas ainda não existem e serão auditadas nos PRs de cada domínio.

A tabela usa `ENABLE` e `FORCE ROW LEVEL SECURITY`. O runtime recebe somente `INSERT`; não recebe `SELECT`, `UPDATE` ou `DELETE`. A policy exige o contexto de user/organization, membership ativa e organização ativa. GUCs são alteráveis pelo runtime: RLS ajuda contra contexto incorreto, mas não protege contra SQL arbitrário. Esta etapa não expõe histórico de auditoria à aplicação.

O gate PostgreSQL 18 em branch Neon descartável deve provar o evento de onboarding no mesmo commit, INSERT autorizado pelo contexto, negação cross-tenant, ausência de leitura/alteração pelo runtime, rollback do evento junto com a mutação e purge dos eventos ao remover a organização. A exclusão da organização remove seus eventos por cascade. Não há expiração automática; retenção legal e eventual legal hold devem ser definidos antes do go-live.

# GATE 2

Antes do catálogo:

- sessão autenticada integrada ao runtime;
- onboarding inicial da organização validado;
- tenancy comprovada em uma operação real;
- RLS aplicado a uma entidade de negócio;
- capability checks centralizados e usados nas operações.

## Fechamento do Gate 2 — concluído antes do PR24 completo

A auditoria do checkpoint PR23 confirmou que Better Auth, onboarding idempotente, transação tenant, RLS de organizations/memberships e o mapa de capabilities tinham provas isoladas, mas ainda não formavam um fluxo autenticado com uma entidade de negócio protegida. Foi criada uma etapa prévia e limitada para fechar essas lacunas antes do PR24 completo.

O slice pré-gate foi implementado e seus gates passaram na branch Neon descartável `gate2-runtime-proof`, PostgreSQL 18.6, AWS South America East 1 (São Paulo):

- onboarding `organization.createInitial` exige sessão Better Auth com email verificado; o ator vem da sessão, e a escrita passa pela função SECURITY DEFINER em `ONBOARDING_HYPERDRIVE` com a role dedicada `polaris_onboarding_runtime`;
- a migration 0012 cria `categories` com ENABLE/FORCE RLS e grants mínimos de SELECT/INSERT; `category.list/create` usam o compositor tenant e as capabilities centralizadas;
- o gate PostgreSQL confirmou idempotência, auditoria transacional, negação de DML direto, separação de roles, isolamento RLS, rollback e cascade; o Worker local confirmou autenticação, onboarding, leitura/criação, negação cross-tenant e auditoria;
- UI, archive/delete, produto, estoque e sync ficaram fora deste slice. O PR24 completo reutiliza o schema e as operações já criadas, sem migrations duplicadas.

Com as duas provas verdes, o Gate 2 está aprovado tecnicamente para este escopo. O draft PR [#22](https://github.com/camilagama/polaris/pull/22) foi publicado sobre PR23 e o CI passou 6/6 no commit de implementação `a1de720`; aguarda revisão do responsável e não foi mesclado. A implementação completa do PR24 começa depois da revisão deste checkpoint. Credenciais reais dos providers e configurações persistentes de produção continuam pré-go-live. A função SECURITY DEFINER usa search_path fixo e confiável, objetos qualificados, sem SQL dinâmico, EXECUTE revogado de PUBLIC e concedido somente à role `polaris_onboarding_runtime` conectada por `ONBOARDING_HYPERDRIVE`; a role tenant comum não tem esse privilégio. A função não valida sessão e só pode ser chamada depois da autorização no Worker. Ver [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/18/sql-createfunction.html).

---
# FASE 3 — CATÁLOGO, VARIANTES E ESTOQUE



---



# PR 24 — Categories



Completar o módulo usando a tabela `categories`, o RPC de criação/listagem e o Gate 2 do PR22. Por autorização explícita do responsável (“prossiga”), o PR24 começou empilhado sobre `codex/gate2-runtime-proof` antes da revisão humana do PR22. PR22 permanece draft; este PR também deve permanecer sem merge até revisão.

### Invariantes

- Categoria de catálogo é distinta de categoria de despesas, pertence a uma organização e é opcional para produto.
- Nome tem no máximo 100 code points, é aparado nas extremidades, preserva a caixa e é único por organização sem distinção de caixa ou espaços externos. A unicidade inclui registros arquivados e tombstones.
- Lifecycle: `active` → `archived` → `active`; `active`/`archived` → `deleted` (tombstone). Remoção não faz hard-delete; tombstone é terminal e preserva o nome.
- O tombstone só é permitido quando o domínio não tem referências dependentes. Ainda não existe tabela products nesta etapa; PR25 deverá bloquear a remoção quando adicionar um vínculo opcional de produto.
- `catalog:read` protege leitura, `category:create` criação e `category:manage` renomear/arquivar/restaurar/remover. RLS continua habilitado e forçado; a role tenant não recebe DELETE.
- `category.created`, `category.renamed`, `category.archived`, `category.restored` e `category.deleted` são auditados na mesma transação. Repetições idempotentes não duplicam eventos.
- O read contract contém ID estável, organização, nome, lifecycle e timestamps serializados para futura leitura offline. PR24 não implementa cache local, comandos offline ou sync.
- UI mínima de gestão cobre organização autenticada, criação, listagem e lifecycle com estados vazio, carregando, sucesso e erro. UI de login/providers reais permanece pré-go-live.

### Verificação e sequência

- Gerar migration 0013 via Drizzle e aplicá-la somente a uma branch Neon descartável PostgreSQL 18; provar unicidade concorrente, grants/policy UPDATE, negação de cross-tenant, lifecycle, auditoria, rollback e cascade.
- Executar o Worker local com sessão fixture para provar RPCs, capabilities e fluxo completo; confirmar cleanup de fixtures e roles.
- `bun run check`, `bun run build` e revisão independente antes de publicar draft PR empilhado sobre PR22. Nenhum merge ou recurso de produção faz parte desta etapa.



---



# PR 25 — Products

Introduzir o catálogo de produtos como uma fatia vertical tenant, com criação,
consulta, edição, arquivamento e restauração.

Criar as tabelas products e a estrutura mínima product_variants necessária
para tornar verdadeira desde esta etapa a regra canônica de que todo produto tem
ao menos uma variante. A variante padrão nasce na mesma transação do produto.
PR26 amplia essa estrutura com opções e variantes configuráveis.

Campos de produto:

- id UUIDv7, com default PostgreSQL 18 uuidv7();
- organização;
- nome obrigatório, aparado e não vazio; duplicatas são permitidas;
- descrição opcional;
- categoria de catálogo opcional, pertencente à mesma organização;
- estado derivado: active ou archived;
- timestamps técnicos e versão positiva iniciada em 1.

Sem limite de nome neste PR: as fontes não definem um e não devemos inventá-lo.
A versão é incrementada em alterações reais; update exige expectedVersion e
rejeita concorrência obsoleta. Repetir archive/restore já aplicado é idempotente.

A categoria só pode ser atribuída em criação ou troca para categoria ativa da
mesma organização. Arquivar a categoria preserva referências existentes; a
remoção terminal (tombstone) é recusada enquanto houver produtos vinculados.
A proteção deve existir no domínio e no banco, incluindo concorrência entre
atribuição e tombstone.

Cada criação grava produto, variante padrão e audit event na mesma transação.
RLS é habilitado e forçado nas duas tabelas, com policies e grants para a role
tenant limitados a SELECT/INSERT/UPDATE necessários. A role não recebe DELETE.
O banco deve rejeitar commit de produto sem variante.

Não incluir estoque, saldo, custo, preço, SKU, código de barras, mídia, opções,
combinações, escrita offline nem hard-delete de produto. SKU continua planejado
para PR27. Exclusão/tombstone de produto fica adiada até as regras de estoque e
histórico permitirem definir quando ela é segura.

UI mínima cobre organização existente, criação, listagem, edição, archive e
restore, com estados carregando, vazio, sucesso e erro. Produto sem opções usa a
variante padrão invisível na UI.

Gate: aplicar migrations 0014 e 0015 em branch Neon descartável PostgreSQL 18;
a 0015 inclui o índice composto `(organization_id, category_id)` usado pelo guard de
tombstone. Provar UUIDv7, criação atômica e variante obrigatória, FK de organização,
bloqueio de categoria tombstone, lifecycle/version, audit, grants/RLS e negação
cross-tenant. Executar bun run check, bun run build e CI. Publicar draft PR
empilhado sobre PR24; não fazer merge nem alterar recursos de produção.
draft PR empilhado sobre PR24; não fazer merge nem alterar recursos de produção.

---


# PR 26 — Variants

Expandir product_variants, introduzida com a variante padrão mínima no PR25, e
criar:

- product_options;
- product_option_values;
- variant_option_values.

Opções fixas de UX:

- Modelo;
- Cor;
- Tamanho.

Cada produto escolhe qualquer subconjunto dessas opções. Valores são aparados,
não vazios, preservam a grafia exibida e são únicos dentro da opção sem
distinção de caixa. Cada variante informa exatamente um valor por opção
selecionada; combinações duplicadas são rejeitadas. Criar combinações somente
de forma explícita, sem gerar o produto cartesiano.

Cada produto aceita no máximo 50 variantes. Criar combinações explicitamente;
o teto considera o estado persistido no fim da transação, permitindo substituir
a variante padrão por até 50 variantes configuráveis. Produto sem opções mantém
sua variante padrão. Ao configurar combinações, inserir opções, valores,
variantes e suas associações e remover a variante padrão na mesma transação; o
produto nunca pode ficar sem variante em um commit.

PR26 permite somente a configuração inicial. Reconfigurar ou remover variantes
fica adiado até definir como preservar os IDs que SKU e estoque poderão
referenciar.

Não incluir SKU (PR27), preço, estoque, mídia ou escrita offline.

Testar unicidade e limites por produto, combinações inválidas, isolamento de
organização, lifecycle, RLS e a substituição atômica da variante padrão.
Executar bun run check, bun run build e o gate PostgreSQL 18 em branch Neon
descartável.

---


# PR 27 — SKU



Adicionar SKU opcional na variante.



Regra confirmada pelo responsável: aparar espaços externos; valor vazio equivale a SKU não informado; preservar a grafia; comparar sem distinção de maiúsculas/minúsculas dentro da organização; permitir o mesmo SKU em organizações diferentes. Não inventar limite de comprimento ou formato.



SKU pode ser atribuído, trocado ou limpo em uma variante existente. Cada mudança real exige `expectedVersion` do produto, incrementa a versão e grava auditoria na mesma transação; variantes não são criadas, removidas ou reconfiguradas neste PR.



Se a variante padrão oculta tiver SKU, bloquear a configuração inicial de opções até esse SKU ser limpo. Não transferir automaticamente o código para uma combinação.



Unique tenant-scoped.



Testar:



- mesmo SKU em organizations diferentes → permitido;

- mesmo SKU na mesma organização → rejeitado.



---



# PR 28 — Inventory ledger



Criar:



```text

inventory_balances

stock_movements

```



Movimento append-only.



Saldo materializado.



Mutation do saldo e ledger na mesma transaction.



Escopo V1 confirmado: uma organização tem um único saldo por variante, sem local/depósito; se não houver linha em `inventory_balances`, a leitura representa quantidade zero e o primeiro movimento materializa a projeção. O movimento preserva o UUID estável da variante. Se a variante padrão oculta já tiver qualquer movimento, a configuração inicial de opções é recusada; não presumir uma combinação para receber sua história ou quantidade.



PR28 cria a persistência e um primitivo interno, transacional e tenant-scoped para registrar movimento e atualizar o saldo; não expõe `updateStock` genérico nem UI/RPC de estoque. Os comandos públicos continuam nomeados e chegam em PR29–31. A quantidade é inteira, o delta do ledger é assinado e nenhum commit pode deixar saldo negativo. O runtime lê movimentos e só os insere; UPDATE/DELETE são revogados e o histórico impede hard-delete da variante. O custo médio fica em PostgreSQL `numeric` exato; PR28 não calcula nem arredonda custos. PR29 deve definir precisão/arredondamento antes de implementar o custo médio, conforme `docs/business-rules/money.md`. A deduplicação fica nos commands nomeados, cuja chave identifica uma operação completa e suas linhas.

Limitação registrada: a referência RESTRICT e o ledger append-only também bloqueiam purge físico de uma organização com histórico de estoque. PR107 precisa definir e validar um caminho privilegiado de purge compatível com a retenção e o deletion ledger antes do go-live.



---



# PR 29 — Receive stock



Implementar:



```text

receiveStock

```



Inputs:



- variant;

- quantity integer > 0;

- unit cost;

- occurred date.



Atualizar moving weighted average.



Criar testes matemáticos/property-based.



Política PR29 V1: custo unitário não negativo em string decimal BRL, até 18 dígitos inteiros e 6 casas; custo médio em numeric exato com 6 casas. Recalcular após cada recebimento e arredondar half-up para 6 casas usando aritmética decimal/inteira, sem IEEE-754. A faixa é política interna, não escala exigida pelo CPC 16(R1). Custo zero é válido. Saldo positivo com média nula representa custo desconhecido e bloqueia recebimento até regra de valoração ser definida; PR31 deve definir como uma contagem inicial com quantidade positiva recebe valor.



O command recebe commandId UUID e versão 1. A primeira aplicação grava o movimento; replay idêntico não altera saldo nem ledger; payload diferente para o mesmo commandId conflita. occurredOn é uma data de calendário da organização, registrada para histórico; a média muda na ordem de confirmação do servidor e recebimentos retroativos não reprecificam vendas já confirmadas.



---



# PR 30 — Write-off stock



Implementar:



```text

writeOffStock

```



Nunca permitir saldo negativo.



Adicionar reason estruturado.



---



# PR 31 — Inventory count



Implementar:



```text

inventoryCount

```



Usuário informa:



```text

physical quantity = X

```



Servidor calcula diferença e cria movimento.

O command exige `commandId`, `commandVersion`, `occurredOn` e `expectedVersion` obtida de `inventory.getBalance`; o servidor compara a versão novamente dentro do lock da variante e rejeita contagem baseada em saldo antigo. A linha do ledger guarda a quantidade física absoluta e a versão lida para replay idempotente. Delta zero continua sendo evento de contagem auditável e avança a versão.

O custo médio conhecido é preservado. Se ainda é desconhecido, a quantidade pode ser corrigida mantendo `NULL`; opcionalmente, `valuationUnitCost` explícito pode iniciar a média quando a contagem física é positiva. Não inferir custo zero. A decisão de valoração está registrada como proposta em [ADR 0011](../docs/adr/0011-inventory-count.md); sem custo conhecido, recebimentos seguem bloqueados até valoração explícita.



Não permitir mutation direta do balance.



---



# PR 32 — Archive/delete catalog

O lifecycle de produto active/archived, com archive e restore reversíveis, já foi implementado no PR25. Este PR acrescenta o tombstone terminal do produto; não duplica as operações existentes.

### Regras de domínio

- Produto active ou archived pode transicionar para deleted; repetir delete é idempotente. Tombstone é terminal: archive, restore, edição, SKU, configuração de variante e novos movimentos de estoque são rejeitados depois dele.
- O tombstone só é permitido quando o saldo agregado atual de todas as variantes é zero. Variante sem linha materializada de saldo conta como zero; saldo positivo em qualquer variante bloqueia a operação.
- Histórico de movimentos não bloqueia o tombstone quando o saldo é zero. Produto, variantes, UUIDs, SKUs, saldos materializados, movimentos, vínculos de categoria e auditoria permanecem; nenhuma operação normal faz hard-delete. SKUs continuam reservados pela unicidade existente.
- Leituras do produto removido e do saldo/histórico permanecem disponíveis; listagem normal o omite e status "deleted" o encontra.
- product.delete exige expectedVersion, bloqueia a linha do produto, atualiza deleted_at e version e grava product.deleted na mesma transação. Repetições não duplicam auditoria.
- Tombstone e comandos de estoque usam o mesmo lock de produto. Triggers de banco repetem a proteção contra saldo positivo e bloqueiam writes diretos de saldo/movimento depois do tombstone.
- Categoria tombstone continua bloqueado enquanto qualquer produto a referencia; tombstonar o produto preserva o vínculo e não apaga a referência histórica.
- A UI de exclusão não está especificada neste PR. A operação é exposta pelo RPC; confirmação e affordance visual ficam adiadas até haver critério de interação.

### Gate e sequência

- Aplicar migration 0023 em branch Neon descartável PostgreSQL 18. Provar tombstone permitido com saldo zero e histórico/SKU preservados; bloqueio com saldo positivo tanto pelo repositório quanto pelo banco; lifecycle terminal, idempotência, auditoria, RLS, ausência de hard-delete e writes recusados após o tombstone.
- Correr em paralelo recebimento e tombstone na mesma variante: um único resultado deve confirmar; nunca pode existir produto tombstoned com saldo positivo.
- Provar replay de command de estoque existente depois do tombstone e rejeição de um command novo. A branch Neon de produção permanece intacta.
- Executar bun run check, bun run build, CI e revisão independente. Publicar PR draft empilhado sobre codex/pr31-inventory-count; não fazer merge nem alterar recursos de produção.

# PR 33 — Media schema

### Decisões confirmadas

- Asset pertence a uma organização e se associa a no máximo um produto por `product_media`.
- `variant_media` reutiliza o asset de `product_media` desse mesmo produto; uma imagem pode servir várias variantes sem duplicação.
- `position` é não negativa e única por produto ou variante. Ordena imagens e não cria regra especial de capa.
- Tombstone preserva vínculos de mídia e bloqueia mudanças posteriores nas associações. Hard-delete e purge permanecem fora do fluxo normal.
- Esta etapa persiste identidade UUIDv7, organização, timestamps e associações. Upload, locator/provider e metadados do arquivo ficam para PR34.
- Limites de imagens Free/Pro seguem como hipóteses em `PRODUCT.md`; PR33 não os impõe no banco.

### Escopo

Criar `media_assets`, `product_media` e `variant_media`, com FKs compostas que garantem mesmo tenant, vínculo de variante ao produto proprietário do asset, RLS forçada e leitura tenant-scoped. Sem upload, URLs públicas ou rotas de mídia.

### Gate

- Provar no PostgreSQL 18 criação das três tabelas, FKs, unicidade do asset por produto, associação do asset a várias variantes do mesmo produto, posições e rejeição de valores/associações inválidos.
- Provar isolamento RLS, privilégio runtime somente leitura nesta etapa e preservação de associações no tombstone; owner SQL não pode criar, reordenar nem remover vínculos após o tombstone.
- Executar `bun run check`, `bun run build`, CI e revisão independente; publicar draft empilhado sobre `codex/pr32-archive-catalog`. Não fazer merge nem alterar recursos de produção.

# PR 34 — Upload/crop pipeline



Implementar:



```text

upload

→ crop coords

→ Cloudflare Images

→ WebP 1200

→ R2

```



Testar:



- arquivo inválido;

- tamanho excessivo;

- orientation;

- crop;

- no-upscale;

- metadata stripped.



---



# PR 35 — Derivatives e media cleanup



Gerar/cachear:



- 320;

- 640.



Staging lifecycle.



Orphan reconciler.



Sem bucket público.



---



# GATE 3



Catalog e estoque devem provar:



- nenhum negative stock;

- ledger consistente;

- custo médio correto;

- variants corretas;

- media privada.



---



# FASE 4 — CLIENTES E VENDAS ONLINE



Primeiro implementar tudo online.



Offline entra depois.



---



# PR 36 — Customers



Criar:



```text

customers

```



Campos mínimos:



- name;

- phone;

- email;

- notes;

- archived.



Regra:



pelo menos um identificador útil.



Não unique rígido em email/telefone.



---



# PR 37 — Possible duplicates



Criar consulta de possíveis duplicados.



UI informa:



```text

Encontramos um possível cliente existente

```



Usuário escolhe:



- usar existente;

- criar mesmo assim.



Não merge automático.



---



# PR 38 — Sale aggregate



Criar:



```text

sales

sale_items

```



Venda confirmada imutável.



Snapshot:



- variant;

- product label;

- quantity;

- listed price;

- charged price;

- unit cost.



---



# PR 39 — Money library



Antes de cálculo completo, criar primitives:



```text

Money

Percentage

DecimalAmount

```



Usar decimal exato.



Adicionar property tests:



- soma;

- desconto;

- arredondamento;

- percentuais;

- multiplicação por quantity.



---



# PR 40 — Sale adjustments



Criar:



```text

sale_adjustments

```



Tipos:



- discount;

- surcharge;

- freight;

- payment surcharge.



Permitir também negociação por item.



---



# PR 41 — Sale payments



Criar:



```text

sale_payments

```



Métodos:



- pix;

- cash;

- credit_card;

- debit_card;

- bank_transfer;

- other.



Um pagamento por venda na V1.



---



# PR 42 — Payment profiles



Criar configurações de taxa.



Permitir regras por:



- método;

- parcelas;

- processing fee;

- anticipation.



Snapshots na venda.



---



# PR 43 — Sale transaction



Implementar criação da venda completa.



Uma transaction deve:



1. validar stock;

2. calcular valores;

3. criar sale;

4. criar items;

5. criar payment;

6. criar adjustments;

7. criar stock movements;

8. atualizar balance;

9. criar audit event;

10. criar outbox intents quando necessário.



Se qualquer passo falhar:



```text

rollback total

```



---



# PR 44 — Customer attribution



Criar:



```text

sale_customer_links

```



Implementar:



```text

assign

reassign

unassign

```



Economia da venda não muda.



Tudo auditado/versionado.



---



# PR 45 — Sale cancellation



Criar operação compensatória.



Nunca editar itens antigos.



Gerar inverse inventory movements.



---



# PR 46 — Partial returns



Criar:



```text

sale_returns

sale_return_items

```



Validar:



```text

returned <= available_to_return

restocked <= returned

```



Property tests obrigatórios.



---



# PR 47 — Sale dates



Implementar:



- occurred_at;

- recorded_at;

- confirmed_at.



Timezone organization-aware.



Validar limite retroativo.



---



# GATE 4



Provar:



- venda atômica;

- stock correto;

- money correto;

- cancellation correto;

- returns corretos;

- customer reconciliation não altera economia.



---



# FASE 5 — OFFLINE



Esta fase não deve redesenhar o domínio.



Ela deve transportar commands do domínio já existente.



---



# PR 48 — Device model



Criar:



```text

devices

offline_grants

```



Sem fingerprint.



Adicionar revoke.



---



# PR 49 — Offline authorization



Criar lease de 72h.



Assinar/validar de forma segura.



Regras:



- user;

- org;

- device;

- epoch;

- expiry;

- capability snapshot.



Servidor continua revalidando tudo no sync.



---



# PR 50 — Local collections



Criar collections locais para:



- categories;

- products;

- variants;

- inventory;

- customers;

- recent sales.



Sem mutations offline ainda.



Implementar bootstrap inicial.



---



# PR 51 — Sync change log



Criar schema:



```text

sync_changes

```



Sequência monotônica.



Registrar mudanças relevantes na mesma transaction do domínio.



Implementar:



```text

sync.pull(cursor)

```



---



# PR 52 — Durable command outbox



Implementar local outbox.



Command:



```text

commandId

type

organizationId

deviceId

baseVersion

lease

payload

```



Persistência sobrevivendo restart.



---



# PR 53 — sync.push



Implementar server protocol.



Regras:



- idempotency;

- same command returns same outcome;

- capability recheck;

- entitlement recheck;

- lease validation;

- organization check.



---



# PR 54 — Offline customer create



Primeiro write offline real.



Fluxo:



```text

create customer offline

→ pending

→ sync

→ confirmed

```



Testar duplicate push.



---



# PR 55 — Offline product create



Criar produto/variant offline.



Com:



- UUIDv7;

- SKU conflict handling;

- optional initial inventory.



Sync deve ser atomic.



---



# PR 56 — Offline stock commands



Implementar:



- receive;

- write-off;

- inventory count.



Rejeição clara em conflitos.



---



# PR 57 — Offline sale



Implementar venda offline.



Estados locais:



```text

pending

syncing

confirmed

rejected

needs_attention

```



Stock server-authoritative.



---



# PR 58 — Conflict UX



Construir página/painel de operações que precisam atenção.



Casos:



- stock insufficiency;

- version conflict;

- entitlement change;

- authorization revoked;

- SKU conflict.



Não ter botão genérico:



```text

Forçar sincronização

```



---



# PR 59 — Logout pending



Implementar proteção.



Se pending:



- tentar sync;

- ou pedir discard explícito.



Após logout:



- purge local tenant data.



---



# PR 60 — PWA service worker



Adicionar:



- app shell;

- offline navigation;

- asset versioning.



Não armazenar API tenant genérica em Cache Storage.



---



# PR 61 — PWA update lifecycle



Implementar:



```text

update available + outbox empty

update available + pending commands

```



Não reload automático destrutivo.



---



# PR 62 — Browser/offline test suite



Automatizar:



- reload;

- kill/reopen;

- reconnect;

- two tabs;

- conflict;

- old app version;

- pending update.



Completar gate Safari físico antes de go-live.



---



# GATE 5



Offline só é considerado pronto quando:



- iPhone real funciona;

- restart preserva outbox;

- duplicate sync é seguro;

- stock conflict não corrompe;

- logout não perde silenciosamente dados.



---



# FASE 6 — DESPESAS, ANALYTICS E METAS



---



# PR 63 — Expense categories



Criar grupos e categorias.



Permitir customização tenant.



---



# PR 64 — Expenses



Criar:



```text

expenses

```



Campos:



- amount;

- category;

- competence date;

- description/payee;

- optional sale_id;

- audit/version.



Sem accounts payable.



---



# PR 65 — Recurring expenses



Criar:



```text

expense_recurring_rules

```



Gerar ocorrências.



Alterar série não muda passado.



Testar catch-up de scheduler.



---



# PR 66 — Sale-linked costs



Integrar despesas vinculadas à venda na margem.



Evitar duplicar:



- processing fee;

- anticipation fee.



---



# PR 67 — Economic metrics engine



Criar cálculos puros em domain:



```text

gross sales

net sales

COGS

gross profit

contribution margin

operating result estimate

```



Property tests obrigatórios.



---



# PR 68 — Dashboard queries



Criar read models otimizados.



Cards:



- net sales;

- operating result;

- margin;

- count;

- ticket;

- items.



Sem cache SQL Hyperdrive.



---



# PR 69 — Result quality indicator



Implementar dados de completude:



- products with known cost;

- sales with known fee;

- expenses present;

- missing inputs.



Evitar falsa precisão.



---



# PR 70 — Goals



Criar goal aggregate.



Tipos:



- net sales;

- operating result;

- sale count.



Implementar lifecycle.



---



# PR 71 — Offline dashboard read



Persistir último snapshot confirmado.



Mostrar:



```text

Atualizado até ...

```



Nunca tratar pending local como resultado oficial.



---



# FASE 7 — BILLING E ENTITLEMENTS



**Risco alto.**



---



# PR 72 — Plan catalog e entitlements



Criar:



```text

billing_plans

billing_prices

entitlements

```



Não integrar provider ainda.



Seed comercial inicial:



Free/Pro.



---



# PR 73 — Entitlement engine



Resolver effective entitlement considerando:



```text

base plan

trial

subscription

temporary grants

downgrade state

```



Criar testes de matriz.



---



# PR 74 — Free quotas



Implementar server-side:



```text

50 variants

1 image/product

50 images total

1 active goal

offline.write false

publicCatalog false

```



Sem esconder apenas UI.



---



# PR 75 — Pro quotas



Adicionar:



```text

2000 variants

10 images/product

5000 images total

3 goals

offline.write

publicCatalog

```



---



# PR 76 — Trial state machine



Estados conceituais:



```text

free

trial_setup

trialing

active

grace

free_over_limit

```



Não integrar pagamento ainda.



Property tests da state machine.



---



# PR 77 — Asaas card adapter



Implementar:



```text

CardRecurringProvider

```



Criar Asaas adapter.



Suportar:



- trial first charge future;

- recurring;

- monthly;

- semiannual;

- annual;

- cancellation;

- refund;

- reconciliation.



Nenhum dado de cartão toca Polaris.



---



# PR 78 — Woovi Pix Automatic adapter



Implementar:



```text

PixAutomaticProvider

```



Fluxo:



```text

authorization QR

→ approval

→ trial

→ future charge

→ recurring

```



Testar sandbox antes de considerar concluído.



---



# PR 79 — Billing inbox/webhooks



Criar durable webhook inbox.



Dedup por provider/event id.



Responder rápido.



Processar via async layer.



---



# PR 80 — Trial UX



Tela:



```text

Testar Pro por 7 dias

```



Escolher:



- cycle;

- card;

- Pix Automatic.



Trial começa somente após método confirmado.



---



# PR 81 — Billing lifecycle



Implementar:



- first charge success;

- first charge fail;

- renewal success;

- renewal fail;

- 7-day grace;

- cancellation;

- scheduled cycle change.



---



# PR 82 — Free Over Limit



Criar entitlement selection.



Permitir escolher:



```text

50 variants operational

```



Bloquear expansão/rotação indevida.



Não alterar product rows com `plan_locked`.



---



# PR 83 — Downgrade resource rules



Implementar:



- public catalog unpublish;

- offline lease stop;

- image restrictions;

- goal pause.



Preservar integridade histórica.



---



# PR 84 — Refund e chargeback



Refund integral:



```text

remove Pro entitlement

```



Chargeback:



```text

immediate entitlement removal

```



Testar reversão posterior.



---



# PR 85 — Temporary entitlement grants



Criar internal grants.



Sempre:



- reason;

- actor;

- start;

- expiry.



Nunca fake subscription.



---



# GATE 7



Staging deve provar com sandboxes reais:



- card trial;

- Pix trial;

- automatic charge;

- renewal;

- failure;

- refund;

- cancel;

- duplicate webhook;

- event reorder.



---



# FASE 8 — CATÁLOGO PÚBLICO



---



# PR 86 — Catalog app scaffold



Criar `apps/catalog` com TanStack Start.



Separado do ERP.



---



# PR 87 — Public catalog profile



Criar perfil explícito.



Campos públicos escolhidos conscientemente.



Nunca reutilizar automaticamente dados privados do owner.



---



# PR 88 — Product publication



Criar publication state.



Somente Pro.



Selecionar produtos publicados.



---



# PR 89 — Public media route



Servir R2 privado via camada pública autorizada.



URLs versionadas/cacheáveis.



---



# PR 90 — SEO/OpenGraph



Implementar:



- title;

- description;

- social preview;

- canonical URLs.



Sem acesso a dados tenant privados.



---



# PR 91 — Unpublish/cache invalidation



Despublicar:



- produto;

- organização;

- downgrade;

- closing.



Purge/invalidate cache.



---



# FASE 9 — ADMIN



---



# PR 92 — Admin app + Cloudflare Access



Criar deployment.



Validar Access JWT:



- signature;

- issuer;

- audience;

- subject.



Não confiar apenas em headers.



---



# PR 93 — Platform principal



Criar:



```text

platform_principals

```



V1:



```text

platform_owner

```



Persistir Access issuer + subject.



Email apenas display snapshot.



---



# PR 94 — Admin capability model



Mesmo com uma role, criar capability engine.



Não hardcode owner em cada use case.



---



# PR 95 — Admin diagnostics



Criar visão de organização:



- status;

- plan;

- entitlement;

- quotas;

- devices;

- sync health;

- billing summary;

- jobs/errors.



Não mostrar business data completo por default.



---



# PR 96 — Support/privacy cases



Criar case system interno.



Mesmo sendo usado apenas pelo owner.



Fields:



- organization;

- reason;

- status;

- context.



---



# PR 97 — JIT tenant access



Criar grant read-only temporário.



Default sugerido:



```text

60 min

```



Associado a case.



RLS valida acesso.



---



# PR 98 — PII reveal



Masked by default.



Criar explicit reveal action.



Audit obrigatória.



Nunca reveal secrets.



---



# PR 99 — Billing admin commands



Adicionar somente commands semânticos:



```text

reconcile

retry

cancel renewal

refund

grant entitlement

```



Nunca status dropdown.



---



# PR 100 — Organization suspension



Implementar:



```text

suspend

reactivate

```



Suspensão:



- separate billing;

- increment authorization epoch;

- revoke leases.



---



# FASE 10 — PRIVACIDADE



---



# PR 101 — Organization closure



Implementar:



```text

active

closing

closed

purge_pending

purged

```



30-day normal recovery.



Revogar acesso imediatamente.



---



# PR 102 — Customer privacy anonymization



Implementar:



```text

customer.anonymizeForPrivacy

```



Preservar fatos econômicos.



---



# PR 103 — Privacy cases / DSR



Criar workflow interno:



- request;

- identity verification;

- role determination;

- scope;

- decision;

- execution;

- resolution.



---



# PR 104 — Export on request



Criar export assíncrono.



Formatos:



- JSON;

- CSV;

- images.



Não oferecer automaticamente no closure.



Arquivo temporário e privado.



---



# PR 105 — Retention framework



Criar retention policies por classe.



Não hardcode “5 anos em tudo”.



Criar jobs somente onde política estiver aprovada.



---



# PR 106 — Deletion ledger



Criar tombstone mínima.



Usada em restore.



Sem business payload.



---



# PR 107 — Full purge workflow



Purge:



- DB;

- R2 masters;

- derivatives;

- catalog cache;

- local references;

- related resources.



Idempotente.



---



# FASE 11 — ASYNC INFRASTRUCTURE



Parte pode ser criada antes se alguma feature depender, mas não deve ser superdimensionada antecipadamente.



---



# PR 108 — Transactional outbox



Criar schema:



```text

event_outbox

```



Fields:



- event;

- type;

- status;

- available_at;

- attempts;

- idempotency;

- correlation.



---



# PR 109 — Queue infrastructure



Criar:



```text

critical

default

media

```



Envelope tipado.



Consumers idempotentes.



---



# PR 110 — Outbox dispatcher/sweeper



Fluxo:



```text

pending DB event

→ queue

→ mark dispatched

```



Crash-safe.



Duplicates acceptable.



---



# PR 111 — DLQ



Configurar DLQ.



DLQ gera operational incident.



Admin permite retry.



---



# PR 112 — Scheduled jobs



Criar scheduler framework.



Jobs:



- outbox;

- grace/trial;

- recurring expenses;

- provider reconcile;

- cleanup.



Todos catch-up safe.



---



# PR 113 — Workflows



Adicionar Cloudflare Workflows somente para:



- exports;

- purge;

- long-running operations necessárias.



Não mover billing canonical state para Workflow.



---



# FASE 12 — OBSERVABILIDADE E SEGURANÇA



---



# PR 114 — evlog



Adicionar evlog à infraestrutura backend.



Criar typed logger wrapper.



Não importar em domain.



---



# PR 115 — Canonical wide events



Criar field schema:



```text

requestId

correlationId

organizationId

actorId

deviceId

commandId

operation

outcome

durationMs

...

```



Proibir aliases inconsistentes.



---



# PR 116 — Redaction policy



Centralizar redaction.



Testar que logs não contêm:



- passwords;

- cookies;

- tokens;

- phone;

- email;

- card;

- secrets.



---



# PR 117 — Cloudflare tracing



Habilitar observabilidade.



Sampling:



- Staging alto;

- Production inicial ~5%.



Error logs 100%.



---



# PR 118 — Sentry Browser



Adicionar somente frontend inicialmente.



Configurar:



- source maps;

- environment;

- release SHA;

- sanitization.



Sem session replay.



---



# PR 119 — Alertas



Criar alertas para:



- 5xx;

- latency;

- DLQ;

- stale outbox;

- billing reconcile failures;

- DB errors;

- R2/media failure;

- sync rejection spike.



---



# PR 120 — Security headers



Centralizar CSP e headers.



Criar tests automatizados.



---



# FASE 13 — TESTING HARDENING



---



# PR 121 — Cloudflare Worker test harness



Padronizar `@cloudflare/vitest-plugin`.



Bindings locais realistas.



---



# PR 122 — PostgreSQL 18 CI



Adicionar PostgreSQL real na CI.



Replay migrations desde zero.



Executar RLS/behavior.



---



# PR 123 — Concurrency suite



Cobrir:



- double sale;

- stock race;

- duplicate command;

- duplicate webhook;

- customer reconciliation race;

- billing transition race.



---



# PR 124 — Property test suite



Expandir fast-check para invariantes.



Não perseguir coverage percentual arbitrário.



---



# PR 125 — E2E Web



Jornadas mínimas:



```text

signup

onboarding

product

stock

customer

sale

return

expense

```



Fixtures determinísticas.



---



# PR 126 — E2E Billing



Mocks em CI.



Sandbox no Staging.



---



# PR 127 — E2E Admin



Cloudflare Access pode ser mockado de maneira segura em CI, mas production guard precisa de prova real.



Testar:



- no access;

- owner access;

- JIT;

- refund;

- suspension.



---



# PR 128 — Visual regression seletiva



Somente superfícies críticas e determinísticas.



Não screenshot de todo o ERP.



Exemplos:



- login;

- dashboard;

- sale form;

- catalog page.



---



# FASE 14 — ENVIRONMENTS



---



# PR 129 — Local env contract



Criar validação tipada das envs.



Cada app conhece apenas suas variáveis.



---



# PR 130 — PR Preview



Configurar Worker Preview.



Criar Neon branch efêmera.



Dados sintéticos.



Nunca clonar Production com PII.



---



# PR 131 — Staging persistente



Provisionar:



- Web;

- Admin;

- Catalog;

- Neon;

- R2;

- Queues;

- Workflows;

- Cron;

- provider sandboxes.



Documentar IDs/resources.



---



# PR 132 — Staging deploy automático



Merge main:



```text

deploy staging

→ migration staging

→ smoke

```



Falha deixa main verde de código, mas release operacional bloqueada até correção.



---



# FASE 15 — PRODUCTION



---



# PR 133 — Production resource provisioning



Provisionar separadamente:



- Workers;

- Neon;

- R2;

- Queues;

- Workflows;

- Hyperdrive;

- Access;

- Turnstile;

- provider production accounts.



Nenhum segredo de staging reutilizado.



---



# PR 134 — Production migration workflow



`workflow_dispatch`.



Exigir:



- SHA;

- target validado;

- migrator credentials;

- concurrency lock.



Nunca migration no build.



---



# PR 135 — Workers Versions release



Workflow:



```text

version upload

→ candidate smoke

→ migrations

→ deploy exact version

→ production smoke

```



Registrar SHA e version id.



---



# PR 136 — Production rollback



Criar runbook real.



Rollback:



- Worker/app only;

- nunca schema automático.



Testar rollback em Staging primeiro.



---



# FASE 16 — BACKUP E RECOVERY



---



# PR 137 — Neon PITR configuration



Configurar conforme plano contratado.



Documentar retention real.



Não presumir default.



---



# PR 138 — External pg_dump backup



Criar job.



Dump:



- cifrado;

- R2 privado;

- retenção definida.



Monitorar falha.



---



# PR 139 — R2 master backup



Ao criar master:



```text

primary

→ async backup copy

```



Backup curto ~7 dias.



Derivatives não precisam.



---



# PR 140 — Restore automation/runbook



Restaurar em ambiente descartável.



Passos:



1. DB;

2. image masters;

3. deletion ledger;

4. migrations;

5. RLS checks;

6. smoke.



---



# PR 141 — Primeiro restore drill real



Executar antes do go-live.



Medir:



```text

RPO

RTO

```



Registrar evidência real.



Só depois definir objetivos oficiais.



---



# GATE DE GO-LIVE



Production não recebe clientes reais até que estes itens estejam comprovados:



## Segurança



```text

RLS real

Cloudflare Access

MFA

Turnstile

security headers

secret isolation

```



## Dados



```text

migrations replay

Neon production role

PITR

external backup

restore drill

```



## Offline



```text

Safari iPhone real

Android

desktop

sync conflict

kill/reopen

PWA update

```



## Billing



```text

Asaas production readiness

Woovi production readiness

card recurring

Pix Automatic

trial

refund

webhooks

```



## Operações



```text

DLQ

alerts

outbox sweeper

staging

production smoke

rollback

```



## Privacidade



```text

closure

purge

customer anonymization

deletion ledger

retention matrix

```



---



# 5. Ordem que o desenvolvedor júnior deve seguir



O desenvolvedor **não deve escolher a próxima feature pelo que parece mais interessante**.



Seguir estritamente:



```text

Fase 0

↓

Fase 1

↓

Gate Foundation

↓

Fase 2

↓

Fase 3

↓

Fase 4

↓

Fase 5

↓

Fase 6

↓

Fase 7

↓

Fase 8+

```



Alguns trabalhos de infraestrutura das fases 11–16 podem entrar antes quando se tornarem dependência concreta.



Exemplo:



billing precisa de async inbox/outbox antes da feature billing estar completa.



Nesse caso:



```text

implementar apenas a fatia mínima necessária do outbox

```



e não todo o sistema operacional antecipadamente.



---



# 6. Regra de YAGNI



Não implementar porque “vamos precisar depois” se o contrato atual já permite extensão futura.



Exemplos deliberadamente adiados:



```text

collaborators

supplier domain

accounts payable

accounts receivable

native app

public API

multi-currency

fractional inventory

barcode

AI

CRM

marketplace

fiscal ERP

feature flag SaaS

session replay

```



Preparar arquitetura não significa implementar tabela/UI vazia.



---



# 7. Regra contra abstração prematura



Não criar:



```text

BaseRepository<T>

GenericCrudService<T>

UniversalProvider

GenericEntityService

AbstractDomainManager

```



sem dois ou mais usos reais que demonstrem a abstração.



Preferir código explícito:



```text

createSale

receiveStock

createCustomer

refundSubscription

```



ao invés de CRUD genérico.



---



# 8. Regra de banco



Toda alteração deve responder:



```text

qual é a fonte da verdade?

qual invariante o DB protege?

qual regra é de domínio?

qual dado é histórico?

qual dado pode mudar?

qual dado é derivado?

```



Evitar duplicar verdade.



Exemplos:



```text

stock_movements = histórico

inventory_balance = projeção

```



```text

sale_items = snapshot econômico

product_variant.price = estado atual

```



---



# 9. Regra de commands



Mutation relevante deve possuir semântica.



Preferir:



```text

cancelSale()

receiveStock()

assignCustomerToSale()

archiveProduct()

```



Não:



```text

updateSale({ status: "cancelled" })

updateStock({ quantity: 12 })

updateSubscription({ status: "active" })

```



---



# 10. Regra de transação



Se duas mudanças precisam existir juntas para o domínio ser válido:



```text

mesma transaction

```



Exemplos:



```text

sale + stock movement

sale + audit

stock movement + balance

domain event + outbox

```



---



# 11. Regra de idempotência



Obrigatória para:



- offline commands;

- webhook processing;

- outbox effects;

- payment operations;

- inventory commands relevantes;

- export/purge workflows.



Uma repetição não pode produzir um segundo efeito econômico.



---



# 12. Regra de UI



A UI não deve esconder complexidade estrutural usando comportamento perigoso.



Exemplo ruim:



```text

clicar Salvar

→ várias mutations independentes

→ uma falha no meio

```



Preferir:



```text

um command de domínio

→ transaction server

→ resultado explícito

```



---



# 13. Regra de erros



Todo erro esperado deve possuir código de domínio.



Exemplos:



```text

INSUFFICIENT_STOCK

DUPLICATE_SKU

VERSION_CONFLICT

ENTITLEMENT_REQUIRED

OFFLINE_LEASE_EXPIRED

TRIAL_ALREADY_CONSUMED

```



UI não deve depender de texto em português para identificar o erro.



---



# 14. Regra de observabilidade



Cada use case crítico deve responder:



```text

o que aconteceu?

para quem?

em qual organization?

qual command?

qual provider?

qual resultado?

quanto demorou?

qual correlation id?

```



Sem colocar conteúdo sensível no log.



---



# 15. Regra de performance



Não otimizar prematuramente.



Antes de adicionar:



```text

Redis

cache SQL

materialized view

complex index

denormalização

```



medir.



Exceções:



- índices obviamente necessários para constraints;

- índices necessários a queries críticas já conhecidas;

- inventory balance materializado por desenho.



---



# 16. Regra de índices



Todo índice novo deve estar ligado a:



- constraint;

- query real;

- foreign-key/access pattern real.



Evitar “indexar tudo”.



Usar `EXPLAIN ANALYZE` com dataset representativo antes de otimização relevante.



---



# 17. Regra de migrations



Nunca editar migration já aplicada em ambiente compartilhado.



Criar nova migration.



Migrations devem poder ser replayadas desde zero em CI.



---



# 18. Regra de offline



Antes de adicionar mutation offline, responder:



```text

qual command?

é idempotente?

qual conflito possível?

qual baseVersion?

qual autoridade server?

como usuário corrige rejeição?

```



Se a resposta não existir, não habilitar offline para aquela operação.



---



# 19. Regra de billing



Provider envia fatos.



Provider não decide produto.



Fluxo:



```text

provider fact

→ reconcile

→ Polaris billing state

→ entitlement state

```



Nunca:



```text

webhook PAYMENT_RECEIVED

→ set plan = pro diretamente

```



---



# 20. Regra de Admin



Admin nunca corrige dados através de SQL manual como operação normal.



Se existe necessidade operacional legítima repetível:



```text

criar command administrativo

```



com:



- autorização;

- confirmação;

- reason;

- audit.



SQL manual é último recurso de incidente, via runbook.



---



# 21. Regra de privacidade



Ao adicionar dado pessoal novo, perguntar:



```text

por que precisamos dele?

é necessário?

quem é controlador?

entra no offline?

entra no log?

entra em export?

quando é apagado?

```



Sem essas respostas, não adicionar o campo.



---



# 22. Regra de documentação



Todo PR que muda regra canônica precisa atualizar a fonte correspondente no mesmo PR.



Exemplos:



mudou produto:



```text

PRODUCT.md

```



mudou terminology:



```text

CONTEXT.md

```



mudou arquitetura:



```text

ADR/docs architecture

```



mudou business invariant:



```text

business-rules

```



Não deixar documentação para “depois”.



---



# 23. Definition of Done por feature



Uma feature só está pronta quando:



```text

domain

server

authorization

RLS

validation

audit when applicable

tests

errors

observability

UI

empty/loading/error states

documentation

```



estão concluídos.



“Funciona na minha máquina” não é Definition of Done.



---



# 24. Critérios especiais para features offline



Além do DoD normal:



```text

online behavior

offline create/edit behavior

restart recovery

sync

idempotency

conflict

rejection UX

old PWA compatibility

logout behavior

entitlement change

```



---



# 25. Critérios especiais para billing



Além do DoD normal:



```text

provider sandbox

webhook duplicate

webhook reorder

timeout

retry

reconciliation

audit

state machine

entitlement

grace

cancel

refund

```



---



# 26. Critérios especiais para migrations high-risk



Antes:



- backup confirmado;

- Staging replay;

- schema compatibility;

- rollback/forward-fix definidos.



Durante:



- execução isolada;

- logs;

- timeout conhecido.



Depois:



- smoke;

- constraints;

- RLS;

- performance básica.



---



# 27. Primeira milestone recomendada

A primeira milestone não deve ser “Cadastro de produtos pronto”. Deve provar a fundação antes de qualquer domínio de produto.

# Foundation Proven

Critérios, correspondentes ao fim da Fase 1:

- monorepo, tooling, boundaries, documentação canônica e CI verdes;
- workspaces Web, Admin e Catalog presentes, ainda vazios;
- Worker React/Vite, Hono e oRPC funcionando;
- PostgreSQL 18, Drizzle e Hyperdrive validados em ambiente remoto;
- isolamento RLS e contexto transacional aprovados no Gate RLS/Hyperdrive;
- migrations replayáveis e testes PostgreSQL/Worker;
- POC de persistência offline aprovado ou alternativa escolhida e documentada.

Better Auth não faz parte desta milestone: é provado no PR13/Gate Auth, no início da Fase 2. Preview/PR, Staging, Cloudflare Access de produção e observabilidade completa ficam nas fases de ambientes, Admin e hardening. Os workspaces vazios de Admin e Catalog não significam que esses produtos ou deployments estejam prontos.

Somente quando Foundation Proven estiver verde começa a Fase 2. Catálogo, inventário, clientes e vendas aguardam também o Gate Auth e o Gate 2 de identidade/tenancy.

# 28. Segunda milestone



# Core Operations Online



Inclui:



- organizations;

- catalog;

- variants;

- inventory;

- customers;

- sales;

- cancellation;

- returns.



Sem billing complexo.



Sem catálogo público.



Sem offline write ainda.



Isso nos permite validar o coração econômico antes de adicionar distribuição e monetização.



---



# 29. Terceira milestone



# Offline Core



Inclui:



- device;

- lease;

- local DB;

- sync;

- command outbox;

- products;

- stock;

- customers;

- sales.



É uma milestone independente porque offline é risco arquitetural alto.



---



# 30. Quarta milestone



# Business Intelligence



Inclui:



- expenses;

- recurrence;

- metrics;

- dashboard;

- goals.



---



# 31. Quinta milestone



# Commercial Launch



Inclui:



- Free/Pro;

- trial;

- Asaas;

- Woovi;

- quotas;

- downgrade;

- catalog public;

- Admin;

- privacy flows.



---



# 32. Sexta milestone



# Production Ready



Inclui:



- queues;

- DLQ;

- alerts;

- staging;

- production release;

- backups;

- restore drill;

- Safari real;

- provider production gates;

- privacy retention;

- incident procedures.



---



# 33. O que não fazer durante a reconstrução



Não copiar arquivos do legacy apenas para acelerar.



O legacy pode ser consultado para:



- comportamento;

- copy;

- casos de borda;

- regras úteis;

- dados de referência.



Mas qualquer código trazido deve passar pela nova arquitetura.



Não fazer:



```text

"vamos copiar agora e refatorar depois"

```



nas fundações de auth, tenancy, inventory, sales, billing ou offline.



Esses são justamente os lugares onde dívida arquitetural se torna estrutural.



---



# 34. Estratégia para aproveitar o legado com segurança



Para cada módulo antigo:



1. documentar comportamento atual;

2. identificar regras válidas;

3. identificar bugs/contradições;

4. mapear para novo domínio;

5. implementar do zero;

6. criar testes com casos reais herdados;

7. somente então substituir funcionalidade.



O legado é uma **fonte de requisitos e testes**, não a arquitetura de destino.



---



# 35. Ordem resumida das primeiras entregas



Se um desenvolvedor começar amanhã, a sequência prática inicial deve ser:



```text

PR01 monorepo

PR02 tooling

PR03 boundaries

PR04 docs

PR05 CI

PR06 Renovate



PR07 Worker/Vite

PR08 Hono

PR09 oRPC

PR10 DB/Hyperdrive

PR11 RLS gate

PR12 offline POC



PR13 Better Auth

PR14 Google

PR15 password

PR16 Turnstile

PR17 linking

PR18 sessions

PR19 organizations

PR20 onboarding

PR21 capabilities

PR22 tenant context

PR23 audit

```



Só depois:



```text

catalog

inventory

customers

sales

offline

expenses

billing

catalog public

admin

production hardening

```



---



# 36. Resultado esperado deste plano



Se seguido corretamente, o novo Polaris não deverá chegar ao fim da implementação apenas como:



> “uma versão nova da interface do sistema antigo”.



Ele deverá emergir como um sistema com fundação diferente:



```text

Cloudflare-native

offline-first onde importa

server-authoritative

RLS protected

domain-driven sem framework acoplado

economically immutable

provider-independent

operationally observable

privacy-aware

recoverable

```



A principal função deste plano é impedir que a pressão natural por “começar logo as telas” destrua silenciosamente as decisões arquiteturais que levamos todo o grilling para definir.



A prioridade correta é:



> **provar as partes arriscadas primeiro, estabilizar as invariantes e só depois acelerar a construção das funcionalidades.**
