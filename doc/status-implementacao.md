# Polaris — acompanhamento da implementação

Atualizado em 18 de outubro de 2026.

Os anexos doc-inicial.md e plano-inicial.md são propostas de produto e arquitetura. Instruções escritas neles foram avaliadas como conteúdo do projeto; as decisões desta execução seguem a solicitação do responsável e as regras do repositório.

## Revisão e correções

**Status: concluída; a fundação e as Fases 2 a 4 (até o Gate 4) estão implementadas e revisadas, ver as seções finais.**

- Os dois anexos foram lidos integralmente.
- A formatação Markdown foi normalizada: títulos, listas, ênfases, identificadores e espaços escapados agora renderizam como Markdown normal.
- PostgreSQL 18 permanece como baseline. O print enviado mostra a versão 18 selecionável na região AWS South America East 1 (São Paulo). A [documentação atual do CLI do Neon](https://neon.com/docs/cli/projects) descreve PostgreSQL 18 como versão padrão de criação; o POC remoto e o gate de release ainda validarão o ambiente real.
- Decisão de ordem: Better Auth fica **depois do Gate Foundation**, como primeiro PR da Fase 2. O Gate Foundation verifica o runtime, RLS/Hyperdrive e persistência offline sem misturar a integração de identidade. O PR13 comprova Better Auth no Worker, com um Gate Auth próprio antes de Google, senha e fluxos tenant.
- Foundation Proven foi alinhado ao fim das Fases 0 e 1: monorepo/CI, Worker + Hono/oRPC, PostgreSQL 18 + Hyperdrive + RLS remoto, migrations/testes e POC offline. Admin e Catalog são apenas workspaces vazios nesse ponto. Preview, Staging, Access e observabilidade completa ficam nas fases de ambientes e hardening.
- O POC Hyperdrive/RLS foi ampliado nos dois anexos: transação explícita para cada operação tenant; contexto local com set_config; concorrência A/B e conexão reutilizada; commit/rollback; ausência de contexto; falha de statement/conexão; retry da operação inteira em nova transação; cache SQL desabilitado mantendo pooling. A [documentação de query caching do Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) sustenta o modo cache-disabled, mas não substitui o POC real Worker → Hyperdrive → Neon.
- O scaffold usa Turborepo 2.11.7 e TypeScript 7.0.2, estáveis publicados no npm durante a criação. Isso atualiza o TypeScript 6 dos anexos; compatibilidade com plugins posteriores será verificada ao introduzi-los.

## Fase 0 — repositório e governança

| Etapa | Status | Observação |
| --- | --- | --- |
| PR01 — Scaffold do monorepo | Concluído | Oito workspaces; Bun 1.4.2 e Node 24.21.0; lock congelado, check, typecheck e build passaram. |
| PR02 — Biome, Ultracite e convenções | Concluído | Biome 2.5.15 + Ultracite 7.12.4; import sorting, no explicit any e unused imports pelo preset. fix, check e build passaram. |
| PR03 — Knip e boundaries | Concluído | Knip 6.39.0; boundaries por Biome; fixtures negativos para domain/contracts; check e build passaram. Branch chore/workspace-boundaries. |
| PR04 — Documentação canônica inicial | Concluído | PRODUCT, CONTEXT, DESIGN, AGENTS, architecture, ADRs, regras de negócio, moeda, tempo, despesas/resultados e runbooks; autoridade dos anexos esclarecida. |
| PR05 — CI baseline | Concluído | .github/workflows/ci.yml cobre lint/boundaries, typecheck, unit, Knip e build; SHAs completos, permissions read-only, cache por lockfile e sem deploy. Vitest passWithNoTests registra que ainda não há testes de domínio. |
| PR06 — Renovate e dependency policy | Concluído | Renovate agrupa TanStack, Cloudflare, Biome/Ultracite, Vitest e Playwright; majors exigem dashboard approval; automerge desativado. renovate-config-validator --strict --no-global passou. |
| Gate 0 | Concluído | Baseline PR01–PR06 limpa; CI do PR05 verde; boundaries, documentação e builds vazios confirmados antes da Fase 1. |

## Fase 1 — provas de arquitetura

| Etapa | Status | Observação |
| --- | --- | --- |
| PR07 — React + Vite + Cloudflare Worker | Concluído | Check, build e smoke local aprovados; CI remoto do PR #5 verde; draft aguarda revisão e merge do responsável. |
| PR08 — Hono shell | Concluído | Check, build e smoke HTTP aprovados; CI remoto do PR #6 verde; draft aguarda revisão e merge do responsável. |
| PR09 — oRPC POC | Concluído | Client React → RPCLink → Hono → RPCHandler → use case retornou `pong`; check/build locais e CI remoto do PR #7 passaram; draft aguarda revisão e merge. |
| PR10 — PostgreSQL + Drizzle + Hyperdrive POC | Concluído | PostgreSQL 18.6 POC passou query, commit, rollback e reuso com tabela TEMP; Worker local via binding respondeu 200; check/build e CI final do PR #8 verdes. Pooling/cache Hyperdrive remoto permanece no Gate PR11. |
| PR11 — Gate RLS/Hyperdrive | Concluído | PR #9 draft publicado. Neon descartável PostgreSQL 18 em São Paulo; fixture, policy, grants, role, memberships e constraints PG18 validados; senha do runtime role rotacionada; Hyperdrive `ebe151e5081344479947edb6028279bb` criado com cache desativado e limite de origem 5. O gate remoto Worker → Hyperdrive → Neon passou: isolamento concorrente, contexto transacional e reset no mesmo backend, rollback, rejeição de escrita cruzada e retry após terminar um backend. A correção usa pool de cliente por requisição (recomendação do Hyperdrive) e trata SQLSTATEs encapsulados pelo Drizzle e a falha de conexão observada no rollback; concorrência do gate limitada a 16 chamadas. `bun run check` e `bun run build` passaram; preview remoto parado e `.dev.vars` temporário removido. CI do commit `7f20292` passou nos cinco jobs; PR aguarda revisão do responsável. Rotacionar a credencial owner fornecida depois do teste. |
| PR12 — Offline persistence POC | Concluído | CI remoto com seis jobs verdes; 16/16 cenários Playwright em Chromium desktop e Pixel 5 emulado. Responsável confirmou Safari no iPhone 12/iOS 26.6.2, navegação normal: todos os testes do roteiro passaram, sem erros. Preview e Worker temporários removidos; ambos os endereços retornam HTTP 404. Edge desktop real, Android Chrome físico e migração provider-native com mesmo ID permanecem adiados; offline do app shell fora do escopo. PR draft aguarda revisão. |
| Gate Foundation | Aprovado tecnicamente | RLS/Hyperdrive, oRPC, Worker e persistência offline passaram os critérios do gate. Better Auth permanece para PR13. Edge desktop real, Android Chrome físico e migração provider-native com mesmo ID ficam adiados; PRs draft aguardam revisão/merge do responsável. |

### PR12 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Implementação local e integração CI | Concluída | Laboratório sintético, reset idempotente com journal IndexedDB persistente e recovery serializado por Web Locks, outbox separado, migração versionada e job Playwright adicionados. |
| Check e build padrão | Concluída | `bun run check` e `bun run build` passaram. |
| Fluxos Chromium automatizados | Concluída | 16/16 casos passaram em Chromium desktop e Pixel 5 emulado, serialmente. |
| WebKit Playwright no Windows | Adiada | O binário 26.6 falha ao abrir `createSyncAccessHandle()`; não é evidência sobre Safari no iPhone. |
| Edge desktop real | Adiado | O job Playwright executa Chromium; não houve teste dedicado no canal Edge nesta etapa. |
| Safari real no iPhone | Concluída | iPhone 12, iOS 26.6.2, navegação normal; responsável confirma todos os cenários propostos sem erros. Preview/Worker removidos; ambos os endereços deram HTTP 404. |
| Android Chrome físico | Adiado | Não há aparelho Android disponível; emulação não substitui o teste físico. |
| Migração provider-native com mesmo ID | Adiada | O POC prova cópia explícita entre IDs de coleção versionados e preserva v1; não prova migração in-place de `schemaVersion`. |
| Offline do app shell | Fora do escopo | Não há service worker nesta POC. |
| Gate Foundation | Aprovado tecnicamente; revisão pendente | Critérios técnicos cumpridos. Os itens explicitamente adiados estão listados acima; Better Auth começa no PR13. |

## Fase 2 — identidade e acesso

| Etapa | Status | Observação |
| --- | --- | --- |
| PR13 — Better Auth base | Implementação e gates local/remoto concluídos; draft PR #11 para revisão | Better Auth 1.6.23 no Worker com Drizzle/PostgreSQL, migration para user/account/session/verification; password, OAuth e Organization seguem desligados. Check, build, dois testes Vitest e integração local Worker + Neon passaram. O Gate Auth local e remoto passou; Worker, Hyperdrive, papel de runtime e fixture temporários foram removidos; nenhum segredo foi commitado. |
| Gate Auth | Concluído | O Worker remoto leu e revogou uma sessão persistida via Hyperdrive e Neon PostgreSQL 18; a leitura posterior foi nula. O papel temporário teve CRUD somente nas quatro tabelas Better Auth. Worker, config Hyperdrive, papel e fixture foram removidos. A branch Neon expira em 2026-10-08 às 09:29 (America/Sao_Paulo). |
| PR14 — Login Google | Implementação e testes mock concluídos; draft aguardando revisão | Better Auth 1.6.23 configura OAuth Google server-side com linking desativado; sete testes mock passam. Migration 0003 aplicada à branch Neon descartável; o runtime tem INSERT-only na auditoria. Login Google real e retenção da auditoria ficam adiados conforme credenciais e revisão pré-go-live. |
| PR15 — Email/password | Implementação e testes mock concluídos; Resend integrado; draft aguardando revisão | Better Auth habilita signup/verificação/login/reset com password policy e HIBP; Resend usa templates sem imagens, timeout e idempotência por token. Sem API key nem domínio verificado no Worker; flag `EMAIL_PASSWORD_AUTH_ENABLED` segue `false` até Resend, Turnstile, bindings de abuso e UI estarem configurados. Nenhum email real enviado. Outbox/Queue e webhooks ficam adiados para hardening pré-go-live. |
| PR16 — Turnstile e auth abuse | Implementação concluída; draft PR #14 publicado; 6/6 checks verdes no commit de código; revisão pendente | Siteverify, limites Workers, fail-closed, testes mock e runbook concluídos; nenhuma configuração/secret foi aplicada ao Worker remoto. |
| PR17 — Account linking | Implementação concluída; PR #15 draft publicado; CI 6/6 verde; usuário autorizou seguir para PR18 | Vínculo explícito Google/senha; linking implícito desligado; email local e provider verificados; proteção contra account takeover. |
| PR18 — Sessões | PR #16 draft publicado; implementação e gate PostgreSQL 18 concluídos; CI 6/6 verde; continuidade para PR19 autorizada; revisão/merge pendentes | Idle 7d, absoluto 30d, múltiplas sessões, listagem/revogação, logout e reset de senha revogando todas. |
| PR19 — Organizations e memberships | Draft PR #17 publicado; gate PostgreSQL 18, check/build locais e CI 6/6 remotos verdes; continuidade para PR20 autorizada; revisão/merge pendentes | Migration e constraints verificadas em branch Neon descartável; onboarding idempotente permanece no PR20. |
| PR20 — Onboarding idempotente | Draft PR #18 publicado; gate Neon PG18, check (58 testes), build (8 workspaces) e CI 6/6 verdes; continuidade para PR21 autorizada; revisão/merge pendentes | Sem rota HTTP, grants ou policies RLS; integração com autorização/tenant permanece em PR21/22. |
| PR21 — Capabilities tenant | Draft PR #19 publicado; mapa V1, review independente sem blockers, check (62 testes), build (8 workspaces) e CI remoto 6/6 concluídos; aguardando revisão do usuário | Mapa puro owner→capability; autenticação/membership/status e enforcement permanecem no PR22. |

### PR13 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Better Auth no Worker e route Hono | Concluída | GET/POST em /api/auth/*; configuração ausente responde 503; secret exige pelo menos 32 caracteres. |
| Schema e migration PostgreSQL | Concluída | Migration 0002 cria user, account, session e verification; aplicada com a cadeia Drizzle na branch Neon temporária. |
| Sessão: criar, ler, revogar | Concluída local e remotamente | Dois testes Vitest e integrações local e remota leram sessão persistida, revogaram e confirmaram leitura autoritativa nula. |
| Hyperdrive remoto no Gate Auth | Concluído | A prova Worker → Hyperdrive → Neon passou com o role polaris_pr13_runtime restrito às quatro tabelas de autenticação. A leitura e a revogação de sessão passaram; o role temporário e a config Hyperdrive foram removidos após o teste. |
| Login senha/OAuth/Organization | Fora do escopo | Este PR só prepara o runtime, schema e sessão de fixture; os fluxos previstos ficam nos PRs seguintes. |

A branch Neon descartável pr13-better-auth-gate expira em 2026-10-08 às 09:29 (America/Sao_Paulo). O branch production do PR11 permaneceu intacto. Worker e config Hyperdrive temporários foram removidos após o Gate Auth remoto passar.
### PR14 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| OAuth Google server-side | Concluída com provider mock | Authorization URL, callback, criação de sessão, logout, provider error e callback inválido testados sem credenciais reais. |
| Linking e tokens | Concluída | Account linking está desativado até PR17; login por ID token enviado pelo cliente está desativado; access/refresh tokens cifrados; idToken não persiste, acesso online sem scope offline. |
| Security audit no PostgreSQL | Concluída | Migration 0003 cria audit event com tipo, outcome, provider, actor ID interno, request ID e error code sanitizado. A branch Neon de teste confirma grant INSERT-only ao papel persistente `polaris_pr11_runtime`. Não registra email, query, code, state, token ou provider payload. |
| Login com Google real | Adiado | Exige OAuth Web client ID/secret e redirect URI autorizada. Nenhuma credencial Google foi fornecida ou publicada. O teste live no Worker temporário depende de autorização explícita para guardar client ID/secret como Cloudflare Secrets. |
| Retenção da auditoria | Adiada até pre-go-live | A regra de privacidade exige revisão jurídica/contábil dos prazos antes do lançamento; a migration não apaga eventos automaticamente. |

### PR15 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Política de senha | Concluída | 15–128 pontos de código Unicode após NFC; espaços e Unicode aceitos; sem composição arbitrária ou expiração; HIBP fail-closed antes de armazenar/alterar senha.
| Hash e verify NFC | Concluído | Scrypt mantém os parâmetros e formato salt:key de Better Auth, normalizando NFC; teste confirma que caracteres fullwidth não colapsam para ASCII. |
| Verificação e reset por email | Implementados com mock; envio real adiado | Better Auth exige email verificado antes da sessão de senha; verificação expira em 24h e reset em 1h. Resend é o provider escolhido, mas API key e domínio verificado ainda não estão configurados.
| Signup/login/reset | Concluídos com testes mock | Login antes de verificar é recusado; reset usa resposta anti-enumeração e revoga todas as sessões. As flags do Worker seguem desligadas até widget, secrets, bindings e Resend estarem configurados.
| HIBP | Concluído e testado | SHA-1 calculado no Worker, consulta range com prefixo de 5 caracteres e Add-Padding, comparação local do sufixo; falha externa bloqueia signup/reset/alteração. Senha e hash completo não saem do Worker. Lista complementar de senhas comuns/contextuais fica adiada para decisão pré-go-live conforme NIST. |

### PR16 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Siteverify e cobertura de rotas | Concluídos com testes mock | Signup, login, solicitação/conclusão de reset e reenvio de verificação exigem token de uso único, ação esperada e hostname de `BETTER_AUTH_BASE_URL`. |
| Rate limiting | Implementado; limites remotos aproximados | 10/60s geral por IP e 3/60s para envio de email por IP; HMAC nas chaves. Contadores Cloudflare são por localidade, não globais. |
| Testes, check e build | Concluídos localmente e no CI | 14 testes novos; `bun run check` passou com 37 testes no total; `bun run build` passou. Os seis jobs de CI remoto passaram no commit de código `bb7040e`, incluindo o gate Playwright. Siteverify real não foi chamado. |
| UI Turnstile, segredo e bindings remotos | Adiados | O app ainda não tem UI de autenticação. Nenhum widget/secret foi provisionado; IDs `901016`/`901017` são placeholders e precisam ser confirmados como únicos na conta antes de deploy. |

### PR17 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Configuração Better Auth | Concluída | Linking explícito permitido; linking implícito desligado; `trustedProviders` vazio; emails diferentes não permitidos; perfil local não é sobrescrito. |
| Google → conta de senha | Concluída com provider mock | Sessão local verificada exige OAuth redirect; claim Google precisa ter email verificado igual; tentativa de mover um Google subject já ligado a outra conta é rejeitada. |
| Google → senha | Concluída via API server-only | Worker valida sessão e email verificado, aplica NFC/HIBP antes de `auth.api.setPassword`, e o login por senha retorna o mesmo user ID. |
| Account takeover e auditoria | Concluídas com testes mock | Testados email local/provider não verificado, email diferente, sessão ausente, `idToken` do cliente, linking implícito e subject já vinculado. Callback registra evento de segurança com actor ID interno; `id_token` não persiste e access token não fica em claro. |
| Testes, check e build | Concluídos localmente | 10 testes novos; `bun run check` passou com 47 testes totais; `bun run build` passou. Nenhum OAuth Google real foi executado. |
| Revisão independente | Concluída | Nenhum blocker confirmado no diff de implementação. |
| Draft PR e CI remoto | Concluídos | [PR #15](https://github.com/camilagama/polaris/pull/15), draft empilhado sobre #14; seis checks, incluindo Playwright browser gate, passaram no commit de código a5fdbff. |
| Revisão do usuário | Continuidade autorizada | Usuário respondeu “prossiga”; PR #15 permanece draft aberto e não foi mergeado. |
| OAuth Google real | Adiado | Nenhum client ID/secret Google foi configurado; os fluxos OAuth foram exercitados com provider e token endpoint mock. |
| UI de gerenciamento | Adiada | A UI de autenticação/contas ainda não existe; o endpoint de vínculo está pronto para futura integração. |
| Ativação da senha | Desligada | Habilitar somente quando UI, site key, secret Turnstile, IDs dos bindings, Resend e domínio verificado estiverem prontos. |

### PR18 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| TTL idle | Concluído | Better Auth usa 7 dias de expiração, refresh a cada 24 horas no uso autenticado e cookie cache desativado. |
| TTL absoluto | Concluído | Worker revoga sessão ao atingir 30 dias; migration cria trigger PostgreSQL que limita `expires_at`, mantém criação imutável e ajusta sessões antigas. |
| Múltiplas sessões, listagem e revogação | Concluídas com testes | Duas sessões simultâneas listadas; revogação remove apenas a sessão alvo; usuário diferente não lista nem revoga sessão alheia. Token cru não autentica sem cookie assinado. |
| Logout e reset de senha | Concluídos com testes | Logout invalida a sessão atual; reset de senha revoga duas sessões ativas do mesmo usuário. |
| Migration PostgreSQL 18 | Concluída em branch Neon descartável | `pr18-sessions-gate`, auto-delete em 2026-10-08 às 21:30 (America/Sao_Paulo). Backfill, INSERT e UPDATE foram testados; ambos os registros ficaram com TTL máximo de 30 dias e `created_at` não pôde ser movido. A branch production permaneceu intacta. |
| Check e build | Concluídos localmente | `bun run check` e `bun run build` passaram; 54 testes totais. |
| Draft PR e CI remoto | Concluídos | [PR #16](https://github.com/camilagama/polaris/pull/16), draft empilhado sobre #15; seis checks passaram no commit de código dcf42ab. |
| UI de gerenciamento | Adiada | A UI de autenticação ainda não existe; endpoints server-side Better Auth estão disponíveis. |
| Revisão independente | Concluída | Nenhum blocker; revisão confirmou que o token listado não autentica sem cookie assinado e que revogação confere o proprietário. |
| Revisão do usuário | Continuidade autorizada; revisão/merge pendentes | Usuário autorizou PR19; PR #16 continua draft aberto e sem merge. |

### PR19 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Schema e migrations | Concluídos | Drizzle criou `organizations` e `memberships`, PK composta, FKs, checks, índice e snapshots; `db:generate` repetido não produziu mudanças. |
| Gate PostgreSQL 18 | Concluído em branch Neon descartável | Checks de moeda/status, `owner`/`active`, chave composta e FKs passaram. Dois memberships do mesmo usuário em organizações distintas foram aceitos; exclusão física da organização removeu memberships em cascade; exclusão física do usuário foi bloqueada por `RESTRICT`. Branch `pr18-sessions-gate` expira automaticamente em 2026-10-08 às 21:30 (America/Sao_Paulo). |
| Segurança do runtime | Concluída para escopo schema-only | `polaris_pr11_runtime` continua sem `SELECT` nas novas tabelas; este PR não adicionou grants, policies RLS ou rotas tenant. Production não foi alterada. |
| Check e build | Concluídos localmente | `bun run check` passou com 54 testes; `bun run build` passou nos oito workspaces. |
| Revisão independente | Concluída | Sem blockers após documentar o cascade e proteger os valores iniciais de membership com checks. |
| Draft PR e CI remoto | Concluídos | [PR #17](https://github.com/camilagama/polaris/pull/17), draft empilhado sobre #16; 6/6 checks passaram no commit `8ba60ad`, incluindo o browser gate Playwright (16/16 testes desktop e mobile emulado). |
| Onboarding e limite V1 | Adiados para PR20 | Criação transacional e idempotente; email verificado e timezone IANA validados no servidor; lock transacional por usuário para duas requests concorrentes com chaves distintas. |
| RLS, grants e rotas tenant | Adiados para PR21/22 | Devem ser ligados com capabilities e contexto tenant antes de expor operações tenant. |
| Exclusão física | Limitação para decisão de domínio | Usuário não pode ser apagado com membership; organização removida fisicamente apaga memberships, mas transferência, retenção e exclusão ainda não têm fluxo definido. `closed` não significa apagar. |
| Revisão do usuário | Continuidade autorizada | Usuário respondeu “prossiga” em 8 de outubro; PR #17 permanece draft aberto e sem merge. |
### PR20 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Use case e adapter DB | Concluídos localmente | `apps/web` normaliza a entrada; `packages/db` executa a transação e o lock, sem dependência Drizzle direta no Worker. |
| Identidade e validação | Concluídas no use case | Email verificado vem de `public.user.email_verified` sob row lock; nome é trimmed e timezone IANA é validado/canonicalizado antes da transação. |
| Atomicidade e concorrência | Concluídas | Advisory transaction lock por usuário; criação de organization e membership owner/active ocorre na mesma transação `READ COMMITTED`. Retry retorna o existente sem alterar nome/timezone; membership múltiplo preexistente falha fechado. |
| Defaults | Concluídos com schema existente | BRL, organization active e membership owner/active. Não há categorias/produtos seed definidos pelas regras do produto. Nenhuma migration adicional foi necessária. |
| Gate Neon PostgreSQL 18 | Concluído em branch descartável | Criação, retry, concorrência, email não verificado, usuário ausente, timezone inválido e memberships múltiplos testados. Runtime role continua sem SELECT/INSERT/UPDATE/DELETE; fixtures foram removidas e a checagem não encontrou resíduos. Branch `pr18-sessions-gate` expira em 2026-10-08 às 21:30 (America/Sao_Paulo). |
| Check e build | Concluídos localmente | `bun run check` passou com 58 testes; `bun run build` passou nos oito workspaces. |
| Rota e acesso runtime | Adiados para PR21/22 | O use case permanece interno; não expõe HTTP nem concede grants/RLS antes dos controles de capabilities e contexto tenant. |
| Revisão independente | Concluída | Sem blockers após os ajustes do gate de privilégios e da validação do ID autenticado. |
| Draft PR e CI remoto | Concluídos | [PR #18](https://github.com/camilagama/polaris/pull/18), draft empilhado sobre #17; 6/6 checks verdes no commit `51ddeda`, incluindo o browser gate Playwright. |
| Revisão do usuário | Continuidade autorizada | Usuário respondeu “prossiga” em 8 de outubro; PR #18 permanece draft aberto e sem merge. |

### PR21 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Mapa domain owner→capability | Concluído localmente | owner mapeia para as oito capabilities do plano; role ou capability desconhecido falha fechado. |
| Autenticação, membership e status | Adiados para PR22 | O helper de domínio não é autorização completa; esse gate depende do request context server-side. |
| Rota tenant, grants e RLS | Adiados para PR22 | Nenhuma rota ou acesso runtime deve ser exposto neste PR. |
| Testes, check e build | Concluídos localmente | bun run check passou com 62 testes; bun run build passou nos oito workspaces. |
| Revisão independente | Concluída | Sem blockers; confirmação de fail-closed para roles/capabilities desconhecidos, mapa owner exato e subpath exportado. |
| Draft PR e CI remoto | Concluídos | PR #19, draft empilhado sobre #18; 6/6 checks passaram no commit 99d1860. |
| Revisão do usuário | Continuidade autorizada | O usuário respondeu “prossiga” em 8 de outubro; PR #19 segue draft aberto e sem merge. |

### PR22 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Escopo, documentação e baseline | Concluídos | Plano/ADRs/runbook lidos; branch codex/pr22-tenant-context baseada no PR21; install congelado, baseline check/build passaram. |
| Compositor Better Auth → tenant | Concluído | Sessão Better Auth resolvida antes da transação; user ID vem somente da sessão; a organização enviada é contexto não confiável; nenhuma rota tenant neste PR. |
| Membership, capability e status | Concluídos | Uma transação valida membership active, capability central e organização active antes do callback tenant; GUC de organização só é setado após membership/capability. |
| RLS, grants e migration | Concluídos após correção de segurança | Migrations 0007/0008 deixam ENABLE/FORCE RLS, duas policies de SELECT e grant SELECT-only; runtime não tem INSERT/UPDATE/DELETE em organizations/memberships, mesmo com GUCs falsificados. |
| Onboarding gravável pelo runtime | Adiado | O use case interno continua idempotente, mas exige conexão privilegiada separadamente controlada; foi validado com owner BYPASSRLS. Sem rota HTTP ou INSERT grant para runtime até existir writer controlado. |
| Reconciliação do fixture PR11 | Concluída | A URL descartável tinha somente a fixture RLS sintética, role runtime e journal vazio. Preflight validou tabela/policy/grants e duas sementes, mais uma única retry UUID conhecida; a tabela foi recriada pela cadeia Drizzle e as sementes-base foram restauradas. Nenhum outro objeto público foi alterado. |
| Gate Neon PostgreSQL | Concluído | `server_version` 18.6 (gate exige major 18); polaris_pr11_runtime NOBYPASSRLS e sem ownership; conexão owner BYPASSRLS; duas policies SELECT; leituras próprias e isolamento cross-tenant passaram; INSERT runtime negado mesmo com GUCs falsificados; onboarding/retry pelo owner, rollback e reuso do mesmo backend passaram; revoke temporário foi verificado. |
| Rota de produto / gate Worker específico | Adiados | Conforme plano PR22, nenhuma rota tenant foi exposta. O gate PR11 Worker → Hyperdrive → Neon continua como prova de pooling/contexto; uma rota tenant exige gate próprio antes de feature de produto. |
| Check e build final | Concluídos | Após as correções: `bun run check` passou (72 testes em 10 arquivos, lint, format, typecheck, boundaries e Knip); `bun run build` passou nos oito workspaces. |
| Revisão independente | Concluída sem blockers | A primeira revisão encontrou INSERT persistente autorizável por GUC forgeável e cleanup frágil; correções foram aplicadas; o follow-up não encontrou achados Critical, Important ou Minor. |
| Draft PR e CI remoto | Concluídos | Draft PR [#20](https://github.com/camilagama/polaris/pull/20) publicado sobre PR #19; CI 6/6 verde no commit de código `17dff66`. |
| Revisão do usuário | Continuidade autorizada | O usuário respondeu “prossiga” para a próxima etapa; PR #20 continua draft e sem merge enquanto PR23 é implementado sobre ele. |

### Gate 2 — aprovado tecnicamente

| Critério | Status | Evidência / trabalho restante |
| --- | --- | --- |
| Autenticação | Gate aprovado; integrações externas adiadas | O Worker validou sessão Better Auth e email verificado. OAuth Google, email/Resend, Turnstile e credenciais reais continuam pré-go-live. |
| Organização inicial | Concluída | RPC deriva o ator da sessão; função SECURITY DEFINER usa `ONBOARDING_HYPERDRIVE` e role dedicada. Gate PostgreSQL e Worker passaram com onboarding idempotente e auditado. |
| Contexto e tenancy | Concluídos | Worker local passou autenticação, `category.list/create`, capability server-side e negação de acesso cross-tenant. |
| RLS em entidade de negócio | Concluído | Migration 0012 aplicada à branch descartável Neon PostgreSQL 18.6. `categories` tem ENABLE/FORCE RLS, grants mínimos, isolamento e negação de DML forjado confirmados. |
| Capabilities | Concluídas | `catalog:read` e `category:create` foram exercitadas pelos procedimentos do Worker; auditoria da criação passou. |
| Gate PostgreSQL + Worker | Concluídos | Gates passaram na branch `gate2-runtime-proof`, região São Paulo, PostgreSQL 18.6. O database gate confirmou roles, grants, SECURITY DEFINER, rollback e cascade; o Worker confirmou onboarding, retry, isolamento e auditoria. Branch é descartável e expira automaticamente. |
| Revisão independente | Concluída, sem achados Critical/Important | Um achado Minor sobre registro incremental de fixtures foi corrigido; revisão final recomendou seguir. |
| Check e build finais | Concluídos | `bun run check`: lint, formato, typecheck, boundaries, Knip e 79 testes em 13 arquivos passaram. `bun run build` passou nos oito workspaces. |
| Draft PR e CI | Concluídos no commit de implementação | Draft PR [#22](https://github.com/camilagama/polaris/pull/22) publicado sobre `codex/pr23-tenant-audit`; CI 6/6 verde no commit `a1de720`. Continua draft e sem merge. |
| Próxima etapa | PR24 em andamento | O responsável autorizou avançar antes da revisão humana do PR #22. PR24 fica empilhado sobre o PR22 draft; ambos permanecem sem merge até revisão. |

### PR23 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Plano, escopo e worktree | Concluídos | PR23 autorizado por “prossiga”; branch codex/pr23-tenant-audit baseada no HEAD do PR22. Leitura de histórico e rota ficam fora do escopo. |
| Modelo e privacidade | Concluídos | Stream tenant separado do auth audit; organização, ator interno, tipo/alvo, request ID UUID opcional e timestamp; sem payload livre, snapshots ou secrets. Retenção legal permanece pré-go-live. |
| Schema, RLS e writer | Concluídos | Migration 0009 cria tenant_audit_event com ENABLE/FORCE RLS e INSERT-only; migrations 0010/0011 limitam códigos e exigem entity ID UUID. Runtime não recebe SELECT/UPDATE/DELETE; writer usa a transação e identidade existentes. |
| Mutação transacional | Concluída | organization.created é auditado junto com organização e membership no onboarding owner-only; retry idempotente não duplica o evento. |
| Gate Neon PostgreSQL | Concluído após hardening | PostgreSQL 18.6 descartável: onboarding, INSERT autorizado, cross-tenant negado, runtime SELECT negado, email em entity ID rejeitado, rollback conjunto e cascade de purge passaram; runtime NOBYPASSRLS/não-owner. Uma execução inicial retornou `timeout expired`; probe read-only confirmou DB/migration 0011 e gates subsequentes passaram; causa inicial não confirmada. |
| Check e build | Concluídos após hardening | `bun run check` passou com 75 testes em 11 arquivos; `bun run build` passou nos oito workspaces. |
| Revisão independente | Concluída sem achados | A revisão final não encontrou Critical/Important/Minor; ID opaco UUID e cleanup independente corrigiram os dois minors. Um timeout inicial do gate não se reproduziu nas verificações posteriores; causa não confirmada. |
| Draft PR e CI remoto | Concluídos | [GitHub PR #21](https://github.com/camilagama/polaris/pull/21), draft empilhado sobre PR #20; os seis checks passaram no commit bab4ce7, incluindo o gate de navegador offline. |
| Revisão do usuário | Pendente | PR #21 aguarda sua revisão; nenhum merge foi feito. |
| Retenção e histórico de audit | Adiados | Sem expiração automática ou leitor de eventos; decidir retenção/legal hold e autorização de leitura antes do go-live. |

### PR24 — Categories (em andamento; revisão humana pendente)

| Subetapa | Status | Evidência / trabalho restante |
| --- | --- | --- |
| Sequência e worktree | Concluídos | Por autorização do responsável (“prossiga”), branch `codex/pr24-categories` foi criada sobre o head `afe056d` do PR22 antes da revisão humana. PR22 segue draft; PR24 será empilhado nele e nenhum dos dois será mesclado nesta etapa. |
| Regras de catálogo | Definidas | Nomes únicos por organização ignorando caixa/espaços externos conforme resposta do responsável; rename em ativos/arquivados; archive reversível; tombstone terminal sem hard-delete. Produtos ainda não existem; PR25 deverá bloquear remoção com referência ativa. |
| Schema e RPC | Implementados e aplicados à branch de teste | Migration 0013 adiciona lifecycle, índice único, policy/grant UPDATE sem DELETE físico; procedures create/list/rename/archive/restore/delete registram auditoria transacional. Aplicada na branch descartável `gate2-runtime-proof`, PostgreSQL 18.6. |
| Read contract e UI | Implementados localmente | DTO estável com UUID, organização, nome, estado e timestamps serializados; tela de gestão responsiva com temas claro/escuro. Cache, comandos e sync offline e UI de login permanecem adiados. |
| Verificação local | Concluída | `bun run check`: lint, format, types, boundaries, Knip e 91 testes em 14 arquivos passaram. `bun run build` passou nos oito workspaces; `db:generate` não encontrou mudanças adicionais. |
| Gate Neon PostgreSQL + Worker | Concluído | O gate PostgreSQL passou em 18.6: RLS/grants, isolamento cross-tenant, unicidade dentro da organização e nome repetido permitido entre organizações, lifecycle, auditoria, rollback e cascade. O gate Worker local passou autenticação, onboarding idempotente, capabilities, conflito/rename, lifecycle, leitura e auditoria. Produção não foi tocada. Uma primeira fixture de rename usou outra organização e foi corrigida; a falha inicial do Worker não se reproduziu no gate completo posterior. |
| Cleanup da branch Neon | Pendente de expiração automática | Não restaram categorias, organizações ou memberships dos gates, nem roles temporárias `polaris_g2_*`. Um registro de usuário de teste `Gate 2 unverified` permanece sem memberships, sessões ou accounts, após uma execução anterior com falha de cleanup; a branch descartável expira automaticamente. Nenhum dado de produção foi alterado. |
| Revisão independente | Concluída após correção | A revisão identificou que `maxLength` do HTML limita unidades UTF-16 e poderia truncar nomes com emojis. A documentação Zod 4.6.5 confirma que `.max()` conta code points; o contrato e a UI agora usam validação/contador explícitos alinhados ao domínio. Regressão RPC confirma 100 emojis aceitos e 101 rejeitados. Nenhum outro achado concreto foi reportado. |
| Draft PR e CI | Concluídos no commit de implementação | [PR #23](https://github.com/camilagama/polaris/pull/23), draft empilhado sobre PR #22. Commit `3b387f5` publicado; GitHub Actions 6/6 passaram, incluindo o gate Playwright. PR permanece draft, sem conflito e sem merge. |

### PR25 — Products (draft publicado; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Sequência e regra de variantes | Concluídas | PR25 adiciona a estrutura mínima de product_variants e cria a variante padrão na mesma transação do produto. PR26 foi atualizado para ampliar essa tabela e trocar a variante padrão por combinações atomicamente. Nomes repetidos são permitidos conforme decisão do responsável; não foi inventado limite de comprimento. |
| Schema e migrations 0014/0015 | Concluídas | Migration 0014 cria products/product_variants com FKs compostas; migration 0015 adiciona índice `(organization_id, category_id)` para o guard de tombstone. Ambas aplicadas somente à branch Neon descartável PostgreSQL 18.6. |
| Invariantes e RLS | Concluídos | RLS habilitado/forçado, policies e grants restritos; trigger diferido exige variante; categoria arquivada não recebe novos vínculos; tombstone é bloqueado enquanto produtos a referenciam. Gate PostgreSQL 18.6 passou após 0015; `pg_indexes` confirmou o novo índice; isolamento, UUIDv7, lifecycle/version, auditoria, rollback e cascade passaram. |
| RPC, domínio e UI | Concluídos | Criar/listar/editar/arquivar/restaurar com capabilities, optimistic version e auditoria; página de produtos com criação, edição, categorias, status, loading/vazio/erro. Estoque, custo, preço, SKU, opções, mídia, escrita offline e exclusão de produto ficam adiados. |
| Gate Worker | Concluído em branch descartável | Worker local autenticado provou onboarding, categorias e produtos, duplicatas, variante default, isolamento, lifecycle/version, bloqueio do tombstone e auditoria. A emulação local de Hyperdrive aponta timeout de conexão no SELECT de sessão; o harness usa override de 30 s, enquanto o default fora do gate permanece 5 s. |
| Verificação local | Concluída após 0015 | `bun run check`: 101 testes em 17 arquivos; lint, format, typecheck, boundaries e Knip passaram. `bun run build` passou nos oito workspaces. `db:generate` não encontrou drift. |
| Revisão independente | Concluída | A revisão apontou ausência de índice para o predicado do guard de tombstone. Migration 0015 corrigiu o caminho; a revisão focada do follow-up não encontrou achados. |
| Draft PR e CI | Concluídos | [PR #24](https://github.com/camilagama/polaris/pull/24) está como draft, empilhado sobre [PR #23](https://github.com/camilagama/polaris/pull/23); CI 6/6 passou no commit `cb60ef7`, incluindo o gate Playwright. Permanece sem merge e aguarda revisão do responsável. |
| Branch Neon descartável | Expiração automática | `gate2-runtime-proof` (`br-autumn-resonance-b6jkwg2y`) está no projeto `polaris-pr11-rls-gate`, PostgreSQL 18.6, São Paulo, e expira em 2026-10-09 13:02 (America/Sao_Paulo). Migrations 0014/0015 permanecem apenas nessa branch de teste. |

### PR26 — Variants (implementado; publicação pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Regras de domínio | Concluídas | O responsável confirmou subconjuntos de Modelo/Cor/Tamanho; valores aparados, não vazios, preservando caixa e únicos por opção sem distinção de caixa; combinação completa e única; teto 50 no estado final da transação. PR26 configura uma vez; reconfiguração/remoção aguardam regras de preservação dos IDs para SKU/estoque. |
| Worktree e baseline | Concluídos | Branch `codex/pr26-variants` criada sobre o head `8230577` do PR25. `bun install --frozen-lockfile`, `bun run check` (101 testes) e `bun run build` dos oito workspaces passaram antes da implementação. |
| Domínio | Concluído | Normalização valida subconjuntos, valores únicos e combinações completas e não repetidas; 7 testes red-first passaram. Configuração inicial versionada e auditada; edição posterior está adiada. |
| Schema, repositório e migration 0016 | Concluídos em branch descartável | Novas tabelas com FKs compostas tenant/product, RLS/grants mínimos, UUIDv7, posições estáveis e constraints diferidas. Migration aplicada somente à branch Neon `gate2-runtime-proof` (PostgreSQL 18.6). |
| Contratos e RPC | Concluídos | `product.getVariants` exige `catalog:read`; `product.configureVariants` exige `product:update`, `expectedVersion` e audita a troca inicial do default. Testes RPC confirmam capabilities, versões e erros. |
| UI | Concluída | Painel acessível seleciona opções, cadastra valores e combinações manualmente e lista variantes após configuração. Sem geração cartesiana; edição posterior adiada por preservação dos IDs. |
| Verificação local | Concluída | `bun run check`: 111 testes em 18 arquivos; lint, format, typecheck, boundaries, Knip passaram. `bun run build` passou nos oito workspaces; `db:generate` não encontrou drift. |
| Gate Neon PostgreSQL 18 | Concluído | PostgreSQL 18.6 após a correção de leitura: RLS/grants, incluindo `FOR SHARE` com o papel runtime, e isolamento; troca default→combinações explícitas (3 de 4 possíveis); UUIDv7 e audit; configuração única; concorrência com um vencedor; teto final 50 aceito e 51 rejeitado; lifecycle, rollback e cascade. |
| Gate Worker | Concluído | Runtime local autenticado passou onboarding e RPC de variantes: criação, configuração, releitura, audit, negação cross-tenant e conflito ao tentar reconfigurar. Fixtures temporárias limpas. |
| Revisão independente | Concluída | Revisão sem blockers. O revisor identificou uma corrida entre a leitura do marcador e as consultas das variantes; `getProductVariants` agora trava a linha do produto com `FOR SHARE`, serializando a resposta com a configuração `FOR UPDATE`. O follow-up confirmou grants/RLS, compatibilidade com `READ COMMITTED` e efeito de espera breve sobre alterações concorrentes no produto. |
| Draft PR e CI | Concluídos | [GitHub PR #25](https://github.com/camilagama/polaris/pull/25) publicado como draft, empilhado sobre PR #24; CI 6/6 verde no commit de código `e9f9f5a`; sem merge. |
| Branch Neon descartável | Expiração automática | `gate2-runtime-proof` (`br-autumn-resonance-b6jkwg2y`) no projeto `polaris-pr11-rls-gate`, PostgreSQL 18.6, São Paulo, expira em 2026-10-09 13:02 (America/Sao_Paulo). Migration 0016 e fixtures de gate permanecem apenas nessa branch. |

## Publicação GitHub

- `origin` aponta para https://github.com/camilagama/polaris.git; o checkout de referência permanece em `main`.
- PRs draft empilhados: #1 chore/workspace-boundaries → main; #2 docs/canonical-docs → #1; #3 ci/baseline → #2; #4 chore/renovate-policy → #3; #5 feat/web-worker → #4; #6 feat/hono-shell → #5; #7 feat/orpc-poc → #6; #8 feat/postgres-hyperdrive-poc → #7; #9 codex/pr11-rls-hyperdrive-gate → #8; #10 codex/pr12-offline-persistence → #9; #11 codex/pr13-better-auth → #10; #12 codex/pr14-google → #11; #13 codex/pr15-password → #12; #14 codex/pr16-turnstile → #13; #15 codex/pr17-account-linking → #14; #16 codex/pr18-sessions → #15; #17 codex/pr19-organizations → #16; #18 codex/pr20-onboarding → #17; #19 codex/pr21-capabilities → #18; #20 codex/pr22-tenant-context → #19; #21 codex/pr23-tenant-audit → #20.
- Mapa PR ↔ GitHub: PR03–06 → #1–4; PR07–23 → #5–21; Gate 2 → #22; PR24–47 → #23–46 (número do GitHub = número do PR − 1); o PR31 (#30) foi aberto contra main. As cinco branches da rodada de revisão ficam sobre codex/pr47-sale-dates e estão publicadas como rascunhos empilhados: [#47](https://github.com/camilagama/polaris/pull/47) (integridade do banco, base codex/pr47-sale-dates) → [#48](https://github.com/camilagama/polaris/pull/48) (borda) → [#49](https://github.com/camilagama/polaris/pull/49) (interface) → [#50](https://github.com/camilagama/polaris/pull/50) (documentação) → [#51](https://github.com/camilagama/polaris/pull/51) (CI e ferramentas).
- PR07 foi publicado em https://github.com/camilagama/polaris/pull/5; CI remoto verde e draft aguardando revisão/merge.
- PR08 foi publicado em https://github.com/camilagama/polaris/pull/6; CI remoto verde e draft aguardando revisão/merge.
- PR09 foi publicado em https://github.com/camilagama/polaris/pull/7; CI remoto verde e draft aguardando revisão/merge.
- PR10 foi publicado em https://github.com/camilagama/polaris/pull/8; CI remoto verde e draft aguardando revisão/merge.
- PR11 foi publicado em https://github.com/camilagama/polaris/pull/9 como draft; Neon descartável e Hyperdrive criados; subdomínio account-level workers.dev habilitado; gate remoto passou e CI do commit `7f20292` está verde.
- PR12 está como draft em https://github.com/camilagama/polaris/pull/10, empilhado sobre PR11; o GitHub registrou os seis jobs de CI como verdes, incluindo Playwright. Validação manual relatada: Safari em iPhone 12/iOS 26.6.2, navegação normal, roteiro completo sem erros. Preview e Worker temporários removidos; ambos os endpoints retornam HTTP 404. Edge real, Android físico e migração provider-native do mesmo ID permanecem adiados.
- PR13 está como draft em https://github.com/camilagama/polaris/pull/11, empilhado sobre PR12. A migration 0002 e as integrações local e remota Worker + PostgreSQL 18 passaram. O Gate Auth remoto via Hyperdrive foi concluído; Worker, config Hyperdrive, role temporário e fixture foram removidos. A branch Neon de teste expira em 2026-10-08 às 09:29 (America/Sao_Paulo).

- PR14 está como draft em https://github.com/camilagama/polaris/pull/12, empilhado sobre PR13. Check completo, sete testes mock e build passaram. A migration 0003 foi aplicada à branch Neon descartável; teste Google real aguarda credenciais e autorização para adicioná-las ao Worker temporário.
- PR15 está como draft em https://github.com/camilagama/polaris/pull/13, empilhado sobre PR14; 23 testes mock, check completo e build local passaram. Nenhuma credencial Resend foi configurada e nenhuma mensagem real foi enviada.
- PR16 está como draft em https://github.com/camilagama/polaris/pull/14, empilhado sobre PR15. Revisão independente sem blockers; check local passou com 37 testes, build passou e os seis jobs remotos passaram no commit de código `bb7040e`. Esta atualização de status é somente documental. Nenhum segredo, widget ou recurso Cloudflare foi provisionado.
- PR17 está como draft em https://github.com/camilagama/polaris/pull/15, empilhado sobre PR16. Implementação passou bun run check (47 testes, 10 novos) e bun run build; revisão independente sem blockers; os seis checks remotos, incluindo Playwright, passaram no commit de código a5fdbff. OAuth Google real e UI de gerenciamento permanecem adiados; nenhuma credencial ou recurso externo foi configurado.
- PR18 está como draft em https://github.com/camilagama/polaris/pull/16, empilhado sobre PR17. 54 testes, check e build passaram; o gate de sessão PostgreSQL 18 passou na branch Neon descartável; revisão independente sem blockers; CI 6/6 verde no commit de código dcf42ab. UI de gerenciamento permanece adiada; a branch de teste expira automaticamente em 2026-10-08 às 21:30 (America/Sao_Paulo).
- PR19 está como draft em https://github.com/camilagama/polaris/pull/17, empilhado sobre PR18. `bun run check` passou com 54 testes; `bun run build` passou nos oito workspaces; CI remoto 6/6 verde, incluindo 16/16 testes Playwright desktop/mobile emulado. Gate PostgreSQL 18 em branch Neon descartável passou; revisão independente sem blockers. PR20 foi autorizado pelo usuário em 8 de outubro; PR21 foi autorizado pelo usuário em 8 de outubro; o mapa local de capabilities foi implementado e revisado sem blockers na branch codex/pr21-capabilities.
- PR20 está como draft em https://github.com/camilagama/polaris/pull/18, empilhado sobre PR19. `bun run check` passou com 58 testes; `bun run build` passou nos oito workspaces; CI remoto 6/6 verde no commit `f6e3cda`. O gate PG18 descartável verificou criação, retry idempotente, concorrência, email/timezone, privilégios runtime e limpeza. Revisão independente sem blockers. PR21 foi autorizado pelo usuário em 8 de outubro; o mapa local foi implementado e revisado sem blockers, com draft PR/CI pendentes.
- PR21 está como draft em https://github.com/camilagama/polaris/pull/19, empilhado sobre PR20. O mapa owner→capabilities está centralizado no package domain; roles/capabilities desconhecidos falham fechado. `bun run check` passou com 62 testes; build dos oito workspaces passou; CI remoto 6/6 verde no commit `99d1860`; revisão independente sem blockers. PR22 foi implementado na branch `codex/pr22-tenant-context`; gate Neon PostgreSQL 18.6 e check/build locais passaram. O review encontrou e levou à remoção do INSERT runtime baseado em GUC; follow-up sem achados; draft PR #20 publicado e CI 6/6 verde no commit `17dff66`; revisão do usuário pendente. PR #19 permanece draft sem merge.
- A etapa PR23 está como draft no [GitHub PR #21](https://github.com/camilagama/polaris/pull/21), empilhada sobre PR #20; bun run check (75 testes), build em oito workspaces, gate Neon PostgreSQL 18.6 e revisão independente passaram; CI remoto 6/6 passou no commit de código bab4ce7. Retenção/legal hold e leitor do histórico de audit permanecem adiados até antes do go-live; revisão do usuário pendente, sem merge.
- PR25 Products está publicado como [GitHub PR #24](https://github.com/camilagama/polaris/pull/24), draft empilhado sobre PR #23; migration 0015, gate PostgreSQL 18.6 e revisão independente passaram; CI remoto 6/6 passou no commit `cb60ef7`. O PR aguarda revisão e segue sem merge.
- PR26 Variants está publicado como [GitHub PR #25](https://github.com/camilagama/polaris/pull/25), draft empilhado sobre PR #24. `bun run check` passou com 111 testes; build dos oito workspaces, gate Neon PostgreSQL 18.6, gate Worker local e revisão independente passaram. CI remoto 6/6 verde no commit de código `e9f9f5a`. Configuração é inicial; edição/remoção aguardam decisão sobre referências de SKU/estoque. O PR segue sem merge.

### PR27 — SKU (regras confirmadas; implementação em andamento)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Escopo documentado | Concluído | PR27 adiciona SKU opcional à variante, único por organização; o mesmo valor em organizações diferentes é permitido. Código de barras segue fora da V1. |
| Normalização | Concluída | O responsável confirmou aparar espaços, tratar vazio como ausência, preservar a grafia e comparar sem distinção de caixa dentro da organização, sem limite inventado de tamanho/formato. |
| Worktree e baseline | Concluídos | Branch `codex/pr27-sku` criada sobre o head `3633d3f` do PR26. `bun install --frozen-lockfile`, `bun run check` (111 testes) e `bun run build` nos oito workspaces passaram sem mudanças de código. |
| Troca/limpeza de SKU | Concluída | O responsável confirmou atribuir, trocar ou limpar o SKU em uma variante existente; mudanças reais usam `expectedVersion` do produto, incrementam a versão, gravam auditoria e preservam o UUID da variante. |
| SKU na variante padrão | Concluído | O responsável confirmou bloquear configuração de opções enquanto a variante padrão tiver SKU; ele deve ser limpo e atribuído à combinação correta após configurar. A camada de domínio e o banco rejeitam a exclusão que perderia esse SKU. |
| Implementação | Concluída | Migration 0017, normalização, índice tenant-scoped case-insensitive, update column-level sob RLS, mutation versionada/auditada e edição dos SKUs no painel. Configuração da variante padrão é bloqueada enquanto houver SKU; o SKU precisa ser limpo antes de a configuração inicial substituí-la. |
| Verificação local | Concluída | `bun run check`: 117 testes em 19 arquivos; lint, formatação, tipos, boundaries e Knip passaram. `bun run build` passou nos oito workspaces; `db:generate` não encontrou drift. |
| Gate Neon PostgreSQL 18 | Concluído em branch descartável | A branch antiga `gate2-runtime-proof` expirou. Criada `pr27-sku-gate` no projeto `polaris-pr11-rls-gate`, região São Paulo, PostgreSQL 18.6, com auto-expiração em 2026-10-10 17:37 (America/Sao_Paulo). Migrations 0012–0017 foram aplicadas pelo SQL Editor e registradas no journal Drizzle. `poc:gate2:verify` passou: RLS/grants, onboarding, categorias, lifecycle, variantes, SKU, auditoria, concorrência, limite, rollback e cascade. Provas SQL adicionais passaram; fixtures, logins temporários e SKUs foram removidos, e a membership temporária foi revogada/restaurada. |
| Gate Worker | Concluído localmente | `test:gate2-worker` terminou com exit code 0 na branch descartável. Passaram autenticação, onboarding, isolamento, categorias, produtos, variantes, SKU (normalização, conflito, troca/limpeza e auditoria) e lifecycle. Logins/fixtures temporários foram limpos; produção e recursos Cloudflare remotos não foram alterados. |
| Revisão independente | Concluída | Revisão do commit `464d1c1` sem achados; o revisor confirmou consistência da migration/RLS, versionamento e auditoria atômicos, conflitos de unicidade, limpeza/reuso e bloqueio de perda do SKU padrão. |
| Draft PR e CI | Concluídos | [PR #26](https://github.com/camilagama/polaris/pull/26) publicado em draft, empilhado sobre PR #25. CI remoto passou 6/6 nos commits `d1d945b` e `bc74545`; sem merge. |

### PR28 — Inventory ledger (implementação e gates concluídos; draft PR #27 aberto; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Regras confirmadas | Concluídas | O responsável confirmou um saldo por organização e variante, sem locais/depósitos; variante sem movimentos lê como quantidade zero. Também confirmou bloquear a configuração inicial depois de qualquer movimento na variante padrão, preservando UUID e histórico sem transferência presumida. |
| Worktree e baseline | Concluídos | Branch `codex/pr28-inventory` criada sobre `codex/pr27-sku`; `bun install --frozen-lockfile`, `bun run check` (117 testes) e `bun run build` nos oito workspaces passaram antes das mudanças. |
| Modelo e implementação | Concluídos | Schema, migration 0018, RLS/grants, projeção lazy e primitivo interno de movimento+saldo+audit em transação tenant-scoped; sem UI/RPC nem command genérico. Os commands `receiveStock`, `writeOffStock` e `inventoryCount` seguem para PR29–31; custo médio e rounding para PR29. |
| Verificação local | Concluída | `bun run check`: 122 testes, lint, formato, typecheck, boundaries e Knip passaram; `bun run build`: oito workspaces passaram. |
| Gate Neon PostgreSQL 18 | Concluído | Migration aplicada e gate passou em PostgreSQL 18.6 na branch descartável `pr28-inventory-gate`; verificou RLS/grants, rollback atômico, concorrência, saldo não negativo, isolamento, ledger append-only e bloqueio da variante padrão mesmo após saldo voltar a zero. A branch expira automaticamente em 2026-10-10 18:47 BRT; as fixtures são sintéticas e ficam nela até expirar. |
| Purge físico com histórico | Adiado | ON DELETE RESTRICT e ledger append-only bloqueiam purge físico de organização com movimentos. PR107 precisa definir e validar um caminho privilegiado compatível com retenção/deletion ledger antes do go-live. |
| Revisão independente | Concluída | Revisor independente sem achados; confirmou as transações, RLS, grants, proteção de histórico, gate PostgreSQL 18 e a dependência de purge registrada para PR107. |
| Draft PR e CI remoto | Concluídos | [PR #27](https://github.com/camilagama/polaris/pull/27), draft empilhado sobre PR #26; CI remoto 6/6 passou no commit `5043a51`; sem merge. |
| Revisão do usuário | Pendente | PR #27 aguarda revisão; não será mergeado sem autorização. |

### PR29 — Receive stock (implementação, gates e CI concluídos; PR #28 draft; revisão pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base isolada | Concluída | Branch local codex/pr29-recovery baseada no head c9f94a1 do PR #27; alterações de PR29 isoladas da branch principal. |
| Política monetária e data de ocorrência | Concluída | Custo unitário/médio com até 18 dígitos inteiros e 6 casas, aritmética decimal exata e half-up após cada recebimento; occurredOn é data de calendário e a média segue a ordem de confirmação no servidor. ADR 0008 registra a escolha. |
| Compatibilidade de histórico anterior | Concluída | PR28 podia criar receipts internos sem custo; a migration 0020 usa CHECK NOT VALID para preservar linhas append-only existentes sem inventar valoração. PostgreSQL ainda aplica a constraint aos novos writes. ADR 0009 documenta o comportamento. |
| Implementação | Concluída | receiveStock valida data/custo/quantidade, calcula custo médio exato, persiste custo e metadados idempotentes, grava ledger+saldo+audit na mesma transação e exige inventory:adjust. O writer genérico rejeita receipts; migrations 0019–0020 acrescentam campos e constraints. |
| Verificação local | Concluída | bun run check: lint, formato, typecheck nos oito workspaces, boundaries, Knip e 135 testes passaram. bun run build: oito workspaces passaram; Wrangler emitiu aviso EPERM ao gravar log local, mas o build terminou com exit code 0. |
| Revisão independente | Concluída | A revisão encontrou risco de compatibilidade com receipts PR28 sem custo; migration 0020 foi alterada para NOT VALID e o gate agora prova compatibilidade do histórico e rejeição de novos receipts inválidos. Revisor não encontrou outros achados críticos/importantes. |
| Gate Neon PostgreSQL 18 | Concluído | O gate passou em PostgreSQL 18.6 na branch descartável `pr28-inventory-gate`; migrations 0019–0020 aplicadas e 19 verificações passaram, incluindo RLS/grants, rollback atômico, idempotência, custo médio half-up, concorrência sem saldo negativo, append-only, proteção de variantes com histórico e auditoria. O resultado reportou 15 movimentos; fixtures sintéticas permanecem até a expiração automática da branch em 2026-10-10 18:47 BRT. A branch schema-only `pr29-receive-stock-gate`, sem dados, também permanece até 2026-10-10 23:58 BRT e não foi usada neste gate. |
| Saldo positivo com custo desconhecido | Adiada | receiveStock bloqueia o recebimento se o saldo for positivo e o custo médio nulo. PR31 deve definir a valoração da contagem inicial; nenhum custo histórico é presumido. |
| Push e PR draft | Concluídos | Branch `codex/pr29-receive-stock` publicada e [PR #28](https://github.com/camilagama/polaris/pull/28) aberto em draft contra `codex/pr28-inventory` (PR #27); os dois commits locais estão no PR. Nenhum merge foi feito. |
| CI remoto | Concluído | GitHub Actions run #70 passou 6/6 no commit `d3113cc`: build, Knip, lint/boundaries, typecheck, 135 unit tests e offline persistence browser gate. |
| Revisão do usuário | Pendente | PR #28 segue em draft e aguarda revisão; nenhum merge será feito sem autorização. |

### PR30 — Write-off stock (implementação, gate remoto e CI concluídos; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e baseline | Concluídos | Worktree isolado `D:\2 - Dev\2 - Worktree\pr30-write-off\polaris`, branch `codex/pr30-write-off-stock` baseada no commit `5ed1f5d` do PR #28; dependências instaladas do lockfile. O CI de base passou 6/6. |
| Motivo estruturado | Concluído | Usuário confirmou a lista fechada `damaged`, `expired`, `lost`, `stolen`, `internal_use`, `other`, com nota obrigatória para `other`. |
| Data de ocorrência | Concluída | Usuário confirmou `occurredOn` obrigatório como data de calendário da organização, seguindo `receiveStock`. |
| Valoração da baixa | Proposta para revisão | Implementação proposta preserva a média móvel, captura o snapshot unitário quando conhecido, permite baixar saldo sem custo conhecido com snapshot nulo e não cria lançamento de despesa. Decisão está em ADR 0010. |
| Implementação | Concluída | `writeOffStock` nomeado grava ledger, saldo, audit e metadados na transação tenant-scoped; writer genérico rejeita write-offs. Contrato RPC, validação/versionamento, idempotência, motivo estruturado, snapshot de custo e compatibilidade append-only estão cobertos. Migration 0021 adiciona motivo/nota e constraint `NOT VALID`, preservando baixas históricas sem metadados. |
| Revisão independente | Concluída | Sem achados restantes após fechar limite de nota em 500 pontos de código, equivalência do trimming Unicode entre JS e PostgreSQL e status proposto da valoração no ADR. |
| Verificação local | Concluída | `bun run db:generate` não encontrou drift; `bun run check` passou com 144 testes; `bun run build` passou nos oito workspaces. O build foi repetido isoladamente após uma corrida transitória com a fixture temporária de boundaries do check. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0021 aplicada; gate passou em PostgreSQL 18.6 na branch descartável `pr28-inventory-gate`. Verificou RLS/grants, motivo/data/nota, limite e trimming Unicode, snapshot de custo, replay/conflito, saldo não negativo, custo desconhecido, concorrência, isolamento e audit. Resultado: 18 movimentos; fixtures sintéticas permanecem até a expiração automática da branch em 2026-10-10 18:47 BRT. |
| Push e PR draft | Concluídos | Branch `codex/pr30-write-off-stock` publicada; [PR #29](https://github.com/camilagama/polaris/pull/29) aberto em draft, empilhado sobre PR #28. |
| CI remoto | Concluído na revisão atual | GitHub Actions passou 6/6 no commit `8826a63` (build, Knip, lint/boundaries, typecheck, testes unitários e offline browser gate). |
| Revisão do usuário | Pendente | Revisar a proposta de valoração em ADR 0010 e o PR draft; decisão sobre custo permanece proposta, não aprovada. |

### PR31 — Inventory count (implementação e publicação concluídas; CI passou; gate remoto e revisão pendentes)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base isolada | Concluída | Branch `codex/pr31-inventory-count` criada em clone isolado; a branch principal permaneceu intacta. |
| Contrato e concorrência | Concluídos | `inventory.getBalance` expõe a versão do saldo; `inventoryCount` exige `expectedVersion`, quantidade física absoluta e identidade idempotente. A checagem ocorre sob lock da variante; versões antigas conflitam. |
| Evento de contagem sem diferença | Concluído | Delta zero é persistido como `inventory_count`, auditado e incrementa a versão do saldo; replay compara quantidade absoluta e versão originais, inclusive após comandos posteriores. |
| Valoração | Proposta para revisão | Custo conhecido é preservado; custo desconhecido permanece `NULL` salvo `valuationUnitCost` explícito em uma contagem positiva. Custo zero não é presumido; recebimentos continuam bloqueados com saldo positivo sem valoração. Decisão está no ADR 0011, proposto. |
| Migration 0022 | Implementada localmente | Armazena quantidade física, versão esperada e input de valoração explícita separado do snapshot efetivo; CHECKs `NOT VALID` preservam movimentos `inventory_count` históricos append-only e impedem valoração explícita com quantidade física zero. Aplicação em Neon ainda pendente. |
| Revisão independente | Concluída | O revisor encontrou replay que podia omitir uma valoração explícita; input separado e comparação idempotente foram adicionados. Também identificou e verificou a constraint DB contra valuation explícita com quantidade zero; sem achados restantes no follow-up. |
| Verificação local | Concluída | `bun run check` passou: lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 154 testes em 25 arquivos. |
| Build local | Concluído | `bun run build` passou nos oito workspaces após a implementação. Wrangler exibiu `EPERM` ao gravar log local, mas o build terminou com exit code 0. |
| Perfis de CLI | Corrigidos | A política separa as identidades: Cloudflare `junior-pessoal` → `contato.juniordiniz@gmail.com`; Neon `junior-pessoal` → `juniordiniz56@gmail.com`. O runbook em `docs/runbooks/cli-profile-policy.md` é a fonte autoritativa; Neon plugin conectado continua fora de uso. |
| Gate Neon PostgreSQL 18 | Pendente | Migration 0022 ainda não foi aplicada. A URL de conexão anterior não foi reutilizada; para provar migration, RLS, idempotência e concorrência é necessária uma branch descartável acessível. O caminho pelo console Neon não ficou disponível nesta sessão. |
| UI de contagem | Adiada | O PR31 no plano define o command e os dados, mas não especifica fluxo/tela de contagem; não inventar interação visual sem critério de aceite. |
| Push e PR draft | Concluídos | Branch `codex/pr31-inventory-count` publicada e [PR #30](https://github.com/camilagama/polaris/pull/30) aberto em draft contra `main`. Nenhum merge foi feito. |
| CI remoto | Concluído | GitHub Actions passou 6/6 no commit `95dbc20`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. O PR está limpo e mergeable, mas permanece draft. |
| Revisão do usuário | Pendente | Revisar o PR #30 e ADR 0011, especialmente a proposta de `valuationUnitCost` opcional. Nenhum merge será feito sem autorização. |

### PR32 — Archive/delete catalog (implementação, revisão estática, verificações locais e remotas, publicação e CI concluídos; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base isolada | Concluída | Branch codex/pr32-archive-catalog criada sobre o head 95dbc20 do PR31; branch principal e PR31 permaneceram intactos. |
| Correção da identidade Neon | Concluída | O perfil `junior-pessoal` usa `juniordiniz56@gmail.com`, confirmado por `neon me` antes do gate. As operações de banco ficaram restritas à branch descartável `pr32-archive-catalog-gate`. |
| Regra de tombstone | Confirmada | Usuário aprovou tombstone terminal com saldo agregado zero, mesmo havendo movimentos históricos; preservar variantes, UUIDs, SKUs, ledger, vínculos e auditoria; saldo positivo bloqueia. |
| Archive/restore | Reutilizados | Já implementados no PR25. PR32 não os duplica; adiciona somente o comando terminal de remoção lógica. |
| Domínio e RPC | Implementados localmente | product.delete exige expectedVersion, atualiza lifecycle e auditoria na transação; repetição é idempotente. Produto tombstoned não admite restore, edição, SKU, configuração de variante ou novos movimentos; leitura histórica e replay permanecem válidos. |
| Migration 0023 | Aplicada e validada | `drizzle-kit migrate` aplicou as migrations pendentes 0019–0023 na branch Neon descartável `pr32-archive-catalog-gate`; `bun run db:generate` não encontrou drift. |
| Gate PostgreSQL | Implementado localmente | verify-inventory-gate.ts agora cobre tombstone com histórico e saldo zero, bloqueio de saldo positivo, proteção SQL direta, replay idempotente e corrida entre recebimento e tombstone. |
| Verificação local | Concluída | bun run check passou: lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 157 testes em 25 arquivos. O check precisou rodar fora do sandbox devido a paths temporários inacessíveis do Vitest no sandbox do Windows. |
| Build local | Concluído | bun run build passou nos oito workspaces. |
| Gate Neon PostgreSQL 18 | Concluído | Gate passou em PostgreSQL 18.6 na branch `pr32-archive-catalog-gate`, derivada de `production`, com 26 movimentos e todos os cenários listados aprovados. A branch expira em 2026-10-10 13:00 BRT; fixtures sintéticas permanecem até a expiração. A connection string ficou somente no ambiente do processo. |
| UI de exclusão | Adiada | O plano não define affordance nem confirmação para uma ação terminal; archive/restore continuam como já implementados. |
| Revisão independente | Concluída sem achados | Revisão do diff `95dbc20..b3781fd`: nenhum achado crítico, importante ou menor. O gate PostgreSQL 18 passou na branch descartável `pr32-archive-catalog-gate`. |
| Push e PR draft | Concluídos | Branch `codex/pr32-archive-catalog` publicada; [PR #31](https://github.com/camilagama/polaris/pull/31) aberto em draft sobre `codex/pr31-inventory-count` (PR #30). Nenhum merge foi feito. |
| CI remoto | Concluído | GitHub Actions passou 6/6 no commit `5c3704a`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. |
### PR33 — Media schema (implementação, revisão independente, checks locais, gate Neon, publicação e CI concluídos; revisão do usuário autorizada)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Branch isolada | Concluída | `codex/pr33-media-schema` foi criada sobre o head `d0c6640` do PR32; ainda local, sem push. |
| Decisões de domínio | Confirmadas | Assets são por organização e vinculam a no máximo um produto; `variant_media` reutiliza o asset do mesmo produto. As tabelas de associação têm `position` ordenada, sem semântica separada de capa. |
| Migration 0024 | Implementada e aplicada | `media_assets`, `product_media` e `variant_media` com UUIDv7, FKs compostas, unicidade por produto/posição e `ON DELETE RESTRICT`. Storage/provider metadata e upload ficam para PR34. |
| RLS e grants | Concluídos | FORCE RLS nas três tabelas; runtime recebe somente SELECT neste schema-only PR. Triggers sincronizam escrita de associações com a linha do produto e bloqueiam mutações após tombstone. |
| Gate Neon PostgreSQL 18 | Concluído | Gate passou em PostgreSQL 18.6 na branch descartável `pr33-media-schema-gate`, derivada de `production`; oito grupos de cenário passaram. A branch expira em 2026-10-11 às 13:00 BRT; fixtures são sintéticas e permanecem até a expiração. URLs ficaram somente no ambiente dos processos. |
| Verificação local | Concluída | `bun run check` passou com 157 testes em 25 arquivos; lint, formato, typecheck, boundaries e Knip também passaram. `bun run db:generate` não encontrou drift. |
| Build local | Concluído | `bun run build` passou nos oito workspaces (exit code 0). Wrangler mostrou `EPERM` somente ao gravar log fora do repositório. |
| Upload, locator e metadata | Adiados | PR33 não faz upload e não persiste provider-specific fields; pipeline Cloudflare Images → WebP → R2 fica para PR34; derivados e cleanup para PR35. R2 permanece privado. |
| Quotas Free/Pro | Adiadas | `PRODUCT.md` classifica os limites como hipóteses ajustáveis; PR33 não fixa contagens em constraints. Enforcement fica no modelo de entitlements. |
| Revisão independente | Concluída sem achados | Revisão do diff `d0c6640..caf8824`: nenhum achado Critical, Important ou Minor; migration 0024, RLS/grants, guard de tombstone e gate revisados. |
| Push, PR draft e CI remoto | Concluídos | Branch `codex/pr33-media-schema` publicada; [PR #32](https://github.com/camilagama/polaris/pull/32) aberto em draft sobre `codex/pr32-archive-catalog` (PR #31). CI passou 6/6 no commit `5e66fba`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. Nenhum merge foi feito. |
| Revisão do usuário | Autorizada em 2026-10-11 | O responsável confirmou que os PRs revisados estão autorizados a prosseguir. PR #32 continua draft; nenhum merge foi feito. |

### PR34 — Upload/crop pipeline (implementação, gates, preview e validação no iPhone concluídos; revisão do PR autorizada)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Branch isolada | Concluída | `codex/pr34-media-upload` criada no clone de trabalho sobre `codex/pr33-media-schema`; `main` permaneceu intacta. |
| HEIC, recorte e saída | Concluídos localmente | Conversão HEIC/HEIF para JPEG no navegador, com fallback `<img>` para Safari; seleção de recorte por arraste/toque e teclado; recorte normalizado; Cloudflare Images configurado para WebP quality 85, limite de 1200 px e `scale-down` sem ampliação. |
| Migration 0025 e RLS/grants | Concluídos | Metadados de storage, tamanho, MIME, dimensões, fingerprint e upload command; runtime recebe `SELECT` e `INSERT`, sem `UPDATE`/`DELETE`; asset exige associação ao produto por trigger deferred. Migration aborta com mensagem explícita se `media_assets` já contiver linhas sem metadados migráveis. `bun run db:generate` não encontrou drift. |
| Rotas, repositório e painel | Concluídos localmente | Upload binário autenticado e tenant-scoped, leitura privada, fingerprint idempotente, posições append-only, auditoria e associação do mesmo asset a variantes do produto. IDs de variante são validados antes do R2. A chave R2 contém organização, produto, comando e fingerprint. Rejeições determinísticas antes do commit removem o objeto recém-criado; falhas ambíguas de commit podem deixar objeto privado órfão, cuja reconciliação geral fica para PR35. |
| Gate Neon PostgreSQL 18 | Concluído | `0025` aplicada e gate passou em PostgreSQL `18.6` na branch descartável `pr34-media-upload-gate`, projeto `green-tooth-16857010`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Verificou RLS/grants, inserts tenant-scoped, replay/conflito, mesma imagem associada a duas variantes do produto, bloqueio de associação do asset a outro produto, auditoria, constraints, asset órfão, cross-tenant em `media_assets`, `product_media` e `variant_media`, tombstone e imutabilidade. A branch expira em `2026-10-11 13:00 BRT`; fixtures sintéticas ficam até a expiração. URLs não foram registradas. |
| Verificação local | Concluída | `bun run check`: lint, formatação, tipos, boundaries, Knip e 189 testes em 30 arquivos passaram. |
| Build local | Concluído | `bun run build` passou nos oito workspaces. |
| Gate real Cloudflare Images/R2 | Concluído com ressalva registrada | O perfil `junior-pessoal` foi confirmado pela CLI `cf` como `contato.juniordiniz@gmail.com`; todos os comandos Cloudflare desta etapa usaram `--profile junior-pessoal`. A instalação global `cf` beta12 falhava ao iniciar `cf dev --remote` com `spawn EFTYPE`; `cf@1.0.0-beta.14` em execução isolada contornou o problema. Após o responsável habilitar R2 no Dashboard, `cf r2 buckets create --name polaris-media --profile junior-pessoal` criou o bucket. Workers temporários provaram Images e R2 separadamente e combinados: JPEG sintético 320×240 com crop central virou WebP 160×120, 292 bytes, assinatura RIFF/WEBP; R2 passou put/get, metadados, delete e confirmação de remoção. No teste combinado instrumentado, tanto o fluxo com resultado textual quanto o fluxo que gravou bytes WebP passaram e os objetos foram lidos e removidos. Uma primeira tentativa combinada respondeu HTTP 404/código 1042; o erro não se reproduziu no retry instrumentado e sua causa exata permanece desconhecida. Os Workers foram removidos; os prefixos de gate ficaram vazios. O bucket permanente `polaris-media` permanece criado e vazio. |
| Preview completo da aplicação | Concluído; recursos temporários removidos | O Worker `polaris-pr34-upload-preview` foi publicado com `cf@1.0.0-beta.14 --profile junior-pessoal` usando uma cópia isolada. A migração Wrangler→`cloudflare.config.ts` e o plugin Vite v2 beta ficaram somente nessa cópia; checkout e lockfile do PR não mudaram. Hyperdrive temporário `d146d27dfa3c40afb4637313b5477bbc` apontou para a branch descartável PR34 com o role `polaris_pr11_runtime`; o Worker usou R2 `polaris-media` e Images. Smoke headless confirmou sessão Better Auth, catálogo e painel “Imagens”, sem erros de página/RPC. Após o teste manual, o Worker (incluindo versões, deployments e secrets) e o Hyperdrive foram excluídos. O endpoint retorna 404, e a lista de Hyperdrive mantém apenas a configuração anterior do PR11. |
| Safari/iPhone | Concluído pelo responsável | No iPhone 12/iOS 26.6.2, em navegação Safari normal, o responsável confirmou que o fluxo de seleção HEIC, conversão, recorte, envio e exibição da miniatura funcionou como esperado, sem erros. O único objeto R2 do fixture foi apagado e o prefixo da organização ficou vazio; o bucket permanente `polaris-media` permanece criado e vazio. Usuário, organização, produto, sessão, associações de mídia e auditoria do fixture foram removidos da branch Neon; os demais fixtures do gate anterior não foram tocados. |
| Revisão independente | Concluída | Duas revisões estáticas corrigiram o gesto sem arraste, validação de variante pós-R2, cobertura cross-tenant de `variant_media` e compensação para rejeições determinísticas após storage. A reconciliação de falhas ambíguas permanece agendada para PR35. |
| Push da branch | Concluído | `codex/pr34-media-upload` publicada em `origin` sobre `codex/pr33-media-schema`; [PR #33](https://github.com/camilagama/polaris/pull/33) permanece em draft. |
| Draft PR e CI remoto | Concluídos | O workflow `38072317058` passou 6/6 no commit `a4d8708`: build, browser gate offline, unit tests, typecheck, lint/boundaries e Knip. Este checkpoint só altera documentação; PR #33 permanece draft e nenhum merge foi feito. |
| Revisão do usuário | Autorizada em 2026-10-11 | O responsável confirmou que os PRs revisados estão autorizados a prosseguir. PR #33 continua draft; nenhum merge foi feito. |

### PR35 — Derivatives e media cleanup (correção de migration/gate publicada; review, checks locais e CI concluídos; revisão do usuário autorizada)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Branch/worktree isolada | Concluída localmente | Worktree `D:\\2 - Dev\\2 - Worktree\\pr35-media-derivatives\\polaris`, branch `codex/pr35-media-derivatives`, baseada no head `87cbc27` do PR34. O checkout principal permaneceu intacto. |
| Derivados 320/640 | Implementados | Derivação sob demanda via Cloudflare Images, `scale-down`, sem upscale, WebP quality 85; keys `media/derivatives/v1/{assetId}/{size}.webp`. A rota continua tenant-authorized e entrega privada `no-store`. O painel atual solicita o derivado 320. |
| Tentativas físicas e staging | Implementados | Chave master v2 inclui UUID exclusivo por tentativa. Marker privado `media/staging/v1/{UTC}/{attemptId}.json` é gravado antes do master e removido após commit confirmado; falhas mantêm o marker. |
| Migration 0026, lock e grants | Corrigida; replay PG18 passou | O replay Neon revelou que `ALTER FUNCTION OWNER` exige SET ROLE, os REVOKEs precisam executar como owner e o trigger precisa ser criado antes de retirar EXECUTE do migrator. A migration agora concede SET temporário, transfere ownership, instala o trigger na mesma transação, usa `SET ROLE polaris_media_cleanup_owner` para revogar PUBLIC/tenant e conceder claim só ao cleanup, depois reseta e revoga o SET explícito. ACL pós-migration verificada: tenant/PUBLIC sem EXECUTE, cleanup só no claim, owner sem SET residual. |
| Escopo de purge futuro | Adiado | PR35 não adiciona hard-delete de assets. A futura purge física deve remover também `media/derivatives/v1/{assetId}/`; o tombstone de produto atual preserva assets. |
| Gate Neon PostgreSQL 18 | Concluído após correção | Replay 0000–0026 e verificador passaram em PostgreSQL 18.6 na branch schema-only `pr36-customers-gate`, projeto `green-tooth-16857010`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Onze verificações confirmaram FORCE RLS, owner/ACLs, ausência de EXECUTE para PUBLIC/tenant/roles de limpeza na função de trigger, claim executável só pelo cleanup runtime, idempotência, bloqueio de insert após claim e corrida real insert/cleanup. Login temporário removido; fixtures sintéticas permanecem até expiração automática `2026-10-11 15:00 UTC`. URLs de conexão não foram registradas. |
| Gate Cloudflare Images/R2/Hyperdrive | Concluído | Perfil `junior-pessoal` confirmado como `contato.juniordiniz@gmail.com`; comandos usaram o perfil explicitamente. Um JPEG sintético 1600×1200 virou master WebP 1200×900 e derivados 320×240 e 640×480; os dois caches passaram put/get com bytes iguais. O reconciliador remoto apagou um master órfão e seu marker via Hyperdrive cleanup, sem falhas. |
| Teardown remoto | Concluído e verificado | Worker e preview removidos; `cf workers list` e a lista de previews voltaram vazias. Hyperdrive temporário foi removido; a lista mantém somente a configuração anterior do PR11. As roles/login de cleanup de teste foram removidas da branch Neon. Os prefixes R2 `media/staging/v1/`, `media/derivatives/v1/` e `media/v2/` estão vazios; o bucket privado permanente permanece criado. |
| Observação do preview | Registrada | Deploy comum retornou HTTP 1042 quando a rota `workers.dev` não estava ativa; o Preview temporário serviu os endpoints autenticados do gate. A URL raiz `/health` do preview mínimo serviu a página estática 404; `/gate?stage=image`, `r2`, `database` e o fluxo completo responderam 200. |
| Verificação local final | Concluída | `bun run check` passou: lint, formatação, typecheck nos oito workspaces, import boundaries, Knip e 203 testes em 31 arquivos. `bun run build` passou nos oito workspaces; `bun run --filter @polaris/db db:generate` confirmou que não há drift. |
| Revisão independente | Concluída sem achados | Revisão estática do follow-up `181a3c5..681bcd6`; sem achados Critical, Important ou Minor. A semântica de `acldefault`/`aclexplode` e dos privilégios efetivos foi conferida contra PostgreSQL 18; o gate real passou na branch Neon descartável. |
| Push e PR draft | Concluídos | Branch `codex/pr35-media-derivatives` atualizada até `e70aa23`; [PR #34](https://github.com/camilagama/polaris/pull/34) segue em draft sobre `codex/pr34-media-upload` (PR #33). Nenhum merge nem deploy de produção foi feito. |
| CI remoto | Concluído | Workflow `38138069207` passou 6/6 no head `e70aa23`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. |
| Revisão do usuário | Autorizada em 2026-10-11 | O responsável confirmou que os PRs revisados estão autorizados a prosseguir. PR #34 continua draft; nenhum merge foi feito. |


Os status serão atualizados ao concluir ou adiar cada etapa e apresentados para revisão.



### PR36 — Customers (implementação, gates local/Neon, revisão independente e CI concluídos; draft PR #35 publicado; revisão do usuário autorizada)



| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e base | Concluídos | Worktree isolado `D:\\2 - Dev\\2 - Worktree\\pr36-customers\\polaris`, branch `codex/pr36-customers`, rebased sobre o head publicado `e70aa23` do PR35; as alterações locais do PR36 foram preservadas. `main` e PR35 permanecem intactos. |
| Regra de identificação | Confirmada | Usuário definiu nome obrigatório e ao menos um contato (telefone ou email); contatos repetidos são permitidos. Não aplicar unicidade rígida nem mesclagem automática. |
| Schema e migration 0027 | Concluídos | `db:generate` não encontrou drift; migration 0027 foi aplicada na branch schema-only `pr36-customers-gate`. Customers usa FORCE RLS, exige nome e telefone/email, aceita contatos repetidos e não concede DELETE ao runtime. |
| Commands, RPC e interface | Concluídos localmente | Create/list/update/archive/restore com `expectedVersion`, auditoria sem PII e tela Clientes; capacidades V1 usam `customer:update`. Associação a vendas e possíveis duplicados ficam para etapas posteriores. |
| Gates local e Neon | Concluídos | `bun run check` passou no head `ae9a88d` com 212 testes em 33 arquivos; `bun run build` passou nos oito workspaces. Gate em Neon PostgreSQL 18.6 passou os nove grupos de cenários de migration/ACL, RLS, duplicatas, isolamento, invariantes, versionamento, lifecycle, auditoria e cleanup do role temporário. Fixtures sintéticas permanecem na branch schema-only até a expiração automática `2026-10-11 15:00 UTC`. |
| Revisão independente | Concluída sem blockers | O review identificou respostas antigas da lista aparecendo após erro ou corrida entre filtros; fix em `ae9a88d` limpa resultados durante load e descarta respostas obsoletas. O uso V1 de `customer:update` em leitura/criação foi mantido: o mapa atual só tem `owner`, não tem `customer:read`, e isso não muda o acesso atual. Refinar capabilities fica para quando papéis por operação forem definidos. |
| Push e PR draft | Concluídos | Branch `codex/pr36-customers` publicada; [PR #35](https://github.com/camilagama/polaris/pull/35) aberto em draft sobre `codex/pr35-media-derivatives` (PR #34). Nenhum merge ou deploy de produção foi feito. |
| CI remoto | Concluído | GitHub Actions run `38139378431` passou 6/6 no head `d3861f3`: build, Knip, lint/boundaries, typecheck, unit tests e offline persistence browser gate. |
| Revisão do usuário | Autorizada em 2026-10-11 | O responsável confirmou que os PRs revisados estão autorizados a prosseguir. PR #35 continua draft; nenhum merge foi feito. |

### PR37 — Possible duplicates (implementação, gates, revisão independente e CI concluídos; draft PR #36 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e base | Concluídos | Branch local `codex/pr37-possible-duplicates`, isolada em `.codex-worktrees/pr37-possible-duplicates`, sobre o head PR36 `d3861f3`. O branch `main` não foi alterado. |
| Regra de correspondência | Confirmada | Email exato sem distinção de caixa após trim; telefone exato após trim; sem normalização de pontuação e sem busca por nome. Incluir ativos e arquivados, usar OR entre contatos e apresentar todos os candidatos; nunca mesclar automaticamente. |
| Contrato, repository e RPC | Concluídos | Consulta exige ao menos um contato, usa capability `customer:update`, autorização e organização definidas no servidor, filtro explícito de organização e retorna os campos que coincidiram. |
| UI de cadastro | Concluída localmente | A criação consulta possíveis duplicados antes de gravar. A pessoa pode abrir o registro existente para revisão/edição ou criar mesmo assim. A busca falhando bloqueia a criação até nova tentativa. Escolher registro arquivado não restaura automaticamente. |
| Migration 0028 | Concluída | Índices parciais não únicos para `(organization_id, lower(email))` e `(organization_id, phone)`; `bun run db:generate` reportou “No schema changes”. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0028 aplicada e gate passou em PostgreSQL `18.6` na branch descartável `pr36-customers-gate`, projeto `green-tooth-16857010`, CLI perfil `junior-pessoal` / `juniordiniz56@gmail.com`. O gate comprovou definição dos índices, contatos repetidos, email case-insensitive, telefone exato após trim, inclusão de arquivados, exclusão de nome/pontuação, retorno de todos os candidatos e isolamento tenant. A branch contém apenas fixtures sintéticas e expira em `2026-10-11 15:00 UTC`; URLs não foram registradas. Uma branch schema-only criada durante a preparação ficou sem alterações e expira em `2026-10-11 16:00 UTC`. |
| Verificação local | Concluída | `bun run check` passou com lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 216 testes em 33 arquivos. `bun run db:generate` confirmou ausência de drift. |
| Build local | Concluído com observação | `bun run build` terminou com exit code 0 nos oito workspaces. Wrangler registrou `EPERM` transitório ao abrir arquivo de log no perfil local e, em seguida, informou que os logs foram gravados; o build concluiu normalmente. |
| Revisão independente | Concluída sem blockers | A revisão identificou falta de asserção sobre expressões/predicados dos índices. O gate agora valida o DDL esperado e passou novamente no PostgreSQL 18.6. |
| Push e PR draft | Concluídos | Branch `codex/pr37-possible-duplicates` publicada; [GitHub PR #36](https://github.com/camilagama/polaris/pull/36) em draft sobre `codex/pr36-customers` (PR #35). CI passou 6/6. Nenhum merge foi feito. |
| Revisão do usuário | Pendente | Revisar o PR37 draft e os gates depois da publicação. |

### PR38 — decisões confirmadas para a próxima etapa

| Decisão | Status | Regra |
| --- | --- | --- |
| Origem de preço | Confirmada | Capturar no comando da venda preço de tabela e preço cobrado; não adicionar preço ao catálogo nesta etapa. |
| Custo desconhecido | Confirmada | Permitir a venda, registrar custo desconhecido e exibir margem indeterminada; não substituir ausência por zero. |
| Quantidade | Confirmada | Quantidade inteira positiva, limitada atomicamente ao saldo disponível, sem teto arbitrário adicional. |
| Escala monetária | Confirmada | Valores comerciais BRL com duas casas e até 18 dígitos inteiros; custo em seis casas; percentuais em até seis casas; cálculo exato e half-up na persistência, com pontos definidos por operação. |
| Estados persistidos | Confirmada | Apenas vendas confirmadas no banco. Estados pending/syncing/rejected/needs_attention ficam na outbox local; sem rascunho persistido. |

### PR38 — Sale aggregate (implementação, migrations, gate Neon, checks, build, revisão e CI concluídos; draft PR #37 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Domínio | Concluído localmente | `normalizeConfirmedSaleSnapshot` exige ao menos um item, IDs UUID válidos, quantidade inteira positiva dentro do limite do PostgreSQL, preços BRL exatos com duas casas e custo null ou decimal com seis casas; preserva a ordem dos itens. Não calcula total, que fica para PR39/40. |
| Migrations 0029–0030 | Concluídas | `0029` cria `sales` e `sale_items`, command ID único por organização, `confirmed_at`, moeda BRL, snapshots por item, FKs compostas, posição única e FORCE RLS. O índice composto que a FK referencia é criado antes da FK. `0030` remove as policies e o grant de INSERT do runtime: ele permanece somente leitura até PR43 entregar a confirmação transacional do cabeçalho com todos os itens. |
| Gate Neon PostgreSQL 18 | Concluído | Migrations aplicadas e gate passou em PostgreSQL `18.6` na branch descartável `pr36-customers-gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Sete grupos cobrem FORCE RLS, runtime somente leitura, snapshot com custo desconhecido, command identity, moeda, escala/quantidade, FKs e isolamento tenant. Um login/policies temporários e isolados exercitam as constraints e são removidos ao final; fixtures são sintéticos. A branch expira em `2026-10-11 15:00 UTC`. |
| Verificação local | Concluída | `bun run check` passou fora do sandbox: lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 221 testes em 34 arquivos. A primeira execução dentro do sandbox falhou ao importar módulos por caminhos TEMP redirecionados; a repetição fora dele passou. `bun run db:generate` reportou “No schema changes”. |
| Build local | Concluído com observação | `bun run build` terminou com exit code 0 nos oito workspaces; Wrangler registrou EPERM transitório ao abrir log no perfil local, depois informou logs gravados. |
| Revisão independente | Concluída sem blockers | A revisão apontou que grants de INSERT permitiriam confirmar cabeçalho sem itens e inserir itens em commits posteriores. A migration `0030` revoga a escrita do runtime até PR43; follow-up confirmou o isolamento do role temporário no gate e sem blockers. O cleanup também só tenta remover login se `CREATE ROLE` teve sucesso. |
| Push e PR draft | Concluídos | Branch `codex/pr38-sales-aggregate` publicada; [GitHub PR #37](https://github.com/camilagama/polaris/pull/37) em draft sobre `codex/pr37-possible-duplicates`. CI passou 6/6. Nenhum merge foi feito. |
| Revisão do usuário | Pendente | Revisar o PR38 draft depois da publicação. |

### PR39 — Money library (implementação, revisão independente, checks e CI concluídos; draft PR #38 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e base | Concluídas | Branch `codex/pr39-money-library`, isolada em `D:\2 - Dev\2 - Worktree\pr39-money-library\polaris`, parte do commit PR38 `6a2f5c9`. Baseline passou com 221 testes/34 arquivos e build dos oito workspaces. |
| Regras monetárias | Confirmadas com convenção técnica registrada | BRL tem 2 casas e até 18 dígitos inteiros; custo mantém 6 casas; percentual aceita até 6 casas. A implementação representa percentual em pontos percentuais (`2.5` = `2,5%`) e usa a direção do tipo de operação. Intermediários não arredondam até a conversão half-up escolhida pela operação. |
| Primitives | Concluídas | `Money` usa centavos BigInt; `Percentage` usa pontos percentuais; `DecimalAmount` preserva valores exatos com até 10 casas intermediárias e arredonda somente quando solicitado. O pacote exporta `money/money`. |
| Testes de propriedade | Concluídos | 14 testes financeiros passaram; oito properties executam 300 casos cada para soma, desconto, quantidade, soma/subtração de intermediários, arredondamento half-up e aplicação exata de percentual. Há também casos de limite, escala, entrada inválida e ties negativos. |
| Verificação local | Concluída | `bun install --frozen-lockfile` não alterou dependências; `bun run check` passou: lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 235 testes em 35 arquivos. `bun run build` passou nos oito workspaces. |
| Gate Neon | Adiado até PR43 | PR39 é aritmética de domínio, sem schema, migration, grants ou gravação no banco. O gate de persistência e atomicidade será executado junto do comando transacional de PR43. |
| Revisão independente | Concluída sem blockers | A revisão confirmou precisão BigInt, escalas, arredondamento assinado, aplicação percentual sem arredondamento antecipado e limite inteiro de quantity. Não foi inferido teto inteiro para `DecimalAmount`/`Percentage`, pois a documentação não o define. |
| Revisão do responsável | Pendente | Revisar especialmente a convenção percentual em pontos percentuais (`2.5` representa `2,5%`), registrada em `CONTEXT.md` e `docs/business-rules/money.md`. |
| Publicação | Concluída | Branch `codex/pr39-money-library` publicada; [GitHub PR #38](https://github.com/camilagama/polaris/pull/38) em draft sobre `codex/pr38-sales-aggregate`. CI passou 6/6. Nenhum merge foi feito. |

### PR40 — Sale adjustments (implementação, checks, gate, revisão e CI concluídos; draft PR #39 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base e worktree | Concluídas | Branch `codex/pr40-sale-adjustments`, isolada em `D:\2 - Dev\2 - Worktree\pr40-sale-adjustments\polaris`, sobre PR39 `5740ff7`. Baseline passou com 235 testes/35 arquivos e build dos oito workspaces. |
| Regras de ajuste | Confirmadas | Negociação por item permanece em `charged_unit_price` versus `listed_unit_price`; ajustes são de venda. Desconto/acréscimo aceitam valor fixo ou percentual; frete e sobretaxa de pagamento são fixos. Percentuais usam o mesmo subtotal, sem composição, arredondam half-up uma vez por ajuste e desconto total não excede o subtotal. |
| Sobretaxa de pagamento | Confirmada | Soma ao total devido pelo comprador; taxas do processador e de antecipação são custos separados de PR42. |
| Domínio | Concluído localmente | `calculateSaleAdjustments` calcula subtotal pelo preço cobrado, ajusta valor fixo ou percentual e retorna totais separados. Percentuais compartilham a base negociada, são arredondados half-up uma vez cada e não compõem; desconto agregado acima do subtotal é rejeitado. |
| Migration 0031 e RLS | Concluídas localmente | `sale_adjustments` guarda tipo, modo fixo/percentual, percentual de entrada e valor monetário calculado, vinculados por FK composta à venda e posição única. FORCE RLS; runtime tem SELECT somente até PR43. `db:generate` não encontra drift. |
| Verificação local | Concluída | `bun run check` passou com 244 testes em 36 arquivos, lint, formato, tipos, boundaries e Knip. `bun run build` passou nos oito workspaces; `bun run db:generate` não encontrou drift. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0031 aplicada; gate passou em PostgreSQL `18.6` na branch descartável `pr36-customers-gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Nove grupos verificaram FORCE RLS/runtime read-only, snapshots, tipo/escala/modo/posição, FKs compostas, isolamento tenant e imutabilidade. O gate criou fixtures e policies de teste temporárias e as removeu; a branch expira em `2026-10-11 15:00 UTC`. |
| Revisão independente | Concluída sem blockers | A revisão confirmou coerência do cálculo, schema, migration e gate. Follow-up confirmou que arrays esparsos são rejeitados e que arrays válidos mantêm o cálculo. |
| Revisão do responsável e publicação | Publicação concluída; revisão pendente | Branch `codex/pr40-sale-adjustments` publicada; [GitHub PR #39](https://github.com/camilagama/polaris/pull/39) em draft sobre `codex/pr39-money-library`. CI passou 6/6. Nenhum merge será feito. |

### PR41 — Sale payments (implementação, checks, gate, revisão independente e CI concluídos; draft PR #40 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base e worktree | Concluídas | Branch `codex/pr41-sale-payment`, isolada em `D:\2 - Dev\2 - Worktree\pr41-sale-payment\polaris`, sobre PR40 `6d74f70`. Baseline passou com 244 testes/36 arquivos e build dos oito workspaces. |
| Regras de pagamento | Confirmadas | Valor igual ao total devido, sem parcial ou saldo pendente; dinheiro não registra valor entregue/troco; método não prova liquidação; parcelas positivas só para `credit_card`, limitadas pelo `integer` do PostgreSQL. |
| Domínio | Concluído localmente | `normalizeSalePayment` deriva o valor do total devido, aceita os seis métodos V1 e exige parcelas inteiras positivas apenas para `credit_card`. Erros de método/parcela/valor negativo são rejeitados; seleção do método não representa liquidação. |
| Migration 0032 e RLS | Concluídas localmente | `sale_payments` permite no máximo uma linha por venda via unicidade tenant-scoped, snapshot de valor BRL, método e parcelas; FK composta para venda. FORCE RLS e runtime somente SELECT até PR43. `db:generate` não encontra drift. |
| Verificação local | Concluída | `bun run check` passou com 251 testes em 37 arquivos, lint, formato, tipos, boundaries e Knip; `bun run build` passou nos oito workspaces. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0032 e gate combinado passaram em PostgreSQL `18.6` na branch descartável `pr36-customers-gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Onze grupos verificaram RLS/grants, método/valor/parcelas, unicidade por venda, FKs tenant, imutabilidade e os gates de venda/ajuste. Fixtures são sintéticas; a branch expira `2026-10-11 15:00 UTC`. |
| Revisão independente | Concluída sem blockers | Revisão confirmou o snapshot derivado do total devido, métodos/parcelas, unicidade, FK tenant-scoped, RLS/grants e gate/cleanup; nenhuma falha concreta foi encontrada. |
| Revisão do responsável/publicação | Publicação concluída; revisão pendente | Branch `codex/pr41-sale-payment` publicada; [GitHub PR #40](https://github.com/camilagama/polaris/pull/40) em draft sobre `codex/pr40-sale-adjustments`. CI passou 6/6. Nenhum merge será feito. |

### PR42 — Payment profiles (implementação, migration, gate PG18, checks locais, build, revisão independente e CI concluídos; draft PR #41 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e base | Concluídas | Branch `codex/pr42-payment-profiles`, isolada em `D:\2 - Dev\2 - Worktree\pr42-payment-profiles\polaris`, baseada no checkpoint PR41 `27a7ec4`. |
| Auditoria documental | Concluída | O plano PR42 define perfis/regras por método e parcelas, taxas de processamento e antecipação e snapshots. `doc/doc-inicial.md` §29 também pede modalidade merchant/issuer e prazo esperado, omitidos no plano. |
| Regras já resolvidas | Confirmadas | Parcelas positivas limitadas pelo `integer` do PostgreSQL, sem teto arbitrário, prevalecem sobre a referência antiga de 1–12. Custos desconhecidos continuam `null`, nunca zero; sobretaxa do comprador permanece separada das taxas do negócio. |
| Decisões de domínio | Confirmadas | Taxas podem combinar componente fixo e percentual efetivo sobre o total devido; half-up uma vez por custo. Modalidade `merchant`/`issuer` e prazo inteiro em dias entram no perfil/snapshot. Antecipação é marcada por venda. Perfil selecionado explicitamente; sem perfil/regra a venda segue com custo desconhecido. |
| Domínio e schema | Concluídos localmente | Normalização e cálculo exato das taxas; snapshots de perfil/versão/regra, componentes e valores; configuração por método, tipo e parcelas; profiles e regras tenant-scoped, versionados e arquiváveis. `0033` preserva pagamentos antigos sem modalidade como desconhecidos, sem inferir `merchant` ou `issuer`. Runtime pode criar/ler/editar perfis e regras, não apagá-los; pagamentos seguem read-only até PR43. |
| Contracts/RPC e interface | Concluídos localmente | CRUD versionado com `organization:manage`; página `/payment-profiles` para criar/editar/regras e arquivar/restaurar, com estado de custo desconhecido explícito. A seleção explícita do perfil (ou ausência) e persistência do snapshot no comando/UI de venda são requisitos obrigatórios do PR43, onde o fluxo de venda será criado. |
| Migration 0033 e drift | Concluídos | Migration gerada pelo Drizzle e endurecida com FORCE RLS/grants. Índices compostos são criados antes das FKs que os referenciam; migration marca modalidade antiga como desconhecida. `bun run db:generate` confirma ausência de drift. |
| Gate Neon PostgreSQL 18 | Concluído | 24 cenários passaram em PostgreSQL 18.6 na branch schema-only `pr42-payment-profiles-gate`, database `polaris_pr42_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Cobre CRUD/RLS/ACL, cross-tenant, taxas/precisão/arredondamento, modalidade, antecipação, snapshot, concorrência de versão e preservação de regras antigas. Fixtures são sintéticas; a branch expira `2026-10-12 15:45 UTC`. Nenhum dado de produção foi copiado. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, tipos dos oito workspaces, boundaries, Knip e 267 testes em 39 arquivos. `bun run build` passou nos oito workspaces; `bun run --filter @polaris/db db:generate` confirmou ausência de drift. |
| Revisão independente | Concluída sem blockers | O reviewer inicialmente apontou a seleção por venda como possível lacuna; após formalizar no plano sua conexão obrigatória no PR43 (que cria a transação e o pagamento), confirmou a divisão e não encontrou outros achados Critical/Important no escopo PR42. |
| Publicação | Concluída | Commit `cee49e5`; branch `codex/pr42-payment-profiles` publicada; [GitHub PR #41](https://github.com/camilagama/polaris/pull/41) em draft sobre `codex/pr41-sale-payment`. CI passou 6/6 no head `1ca6330`; o handoff documental terá CI próprio. Nenhum merge foi necessário para a continuidade; a cadeia permanece em draft. |

### PR43 — Sale transaction (implementação, checks, gates PG18 e UI concluídos; revisão independente e publicação: ver linhas abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: GitHub PR #41 aberto em draft, base `codex/pr41-sale-payment`, head `5c38919`, CI 6/6; `main` (`f1edde9`) não contém PR42. Worktree `D:\2 - Dev\2 - Worktree\pr43-sale-transaction\polaris`, branch `codex/pr43-sale-transaction` criada sobre `origin/codex/pr42-payment-profiles` (`5c38919`); o upstream acidental para a branch do PR42 foi removido para evitar push errado. Baseline antes de editar: `bun run check` com 267 testes, `bun run build` e `db:generate` sem drift. |
| Domínio | Concluído | `packages/domain/src/sales/confirm-sale.ts`: valida e precifica o comando (itens, ajustes via `calculateSaleAdjustments`, pagamento igual ao total devido), exige a escolha explícita do perfil (`{id, expectedVersion}` ou `null`), compõe o snapshot com `snapshotPaymentProfileForSale`, resume totais e converte o instante comercial na data de ledger no fuso da organização. 24 testes novos. |
| Repositório transacional | Concluído | `packages/db/src/sale-repository.ts#confirmSale`: replay por `commandId` (comparação de payload), cabeçalho com `ON CONFLICT DO NOTHING`, perfil lido com `FOR SHARE` (existente, ativo, versão esperada), produtos bloqueados em ordem de id, movimentos `sale` pelo ledger existente (`recordSaleStockMovement`; a autorização por capability segue obrigatória em todo caminho do ledger), itens, ajustes, pagamento com snapshots e auditoria `sale.confirmed`, tudo na transação tenant. Organização e usuário vêm da identidade autorizada. |
| Contrato e RPC | Concluídos | `sale.confirm` em `packages/contracts` (versão 1, `paymentProfile` obrigatório e anulável, `anticipationRequested` explícito) e `apps/web/src/server/rpc/sale-handlers.ts`; mapeamento de erros para 400/404/409. 19 testes do roteador. |
| Migration 0034, RLS e ACL | Concluídos | Colunas `occurred_at`, `client_created_at`, `item_count`, `adjustment_count`; policies de INSERT por organização; runtime com SELECT+INSERT e sem UPDATE/DELETE nas quatro tabelas; gatilhos de restrição deferidos (`check_sale_confirmation_complete`) recusam no commit venda sem itens/ajustes declarados, sem um pagamento igual ao total, sem movimentos correspondentes, itens acrescentados depois e movimento `sale` órfão. Função sem EXECUTE para PUBLIC. `db:generate` sem drift. |
| Interface `/sales` | Concluída localmente | `apps/web/src/sales/*`: tela "Nova venda" com uma única chamada `sale.confirm`, escolha explícita de perfil ou "Sem perfil", intenção de antecipação, prévia exata de totais e taxas (desconhecida ≠ R$ 0,00), estados de carregamento, vazio, envio, sucesso e erro, `commandId` e instante congelados por tentativa (nova tentativa idêntica reaproveita; qualquer alteração gera novo `commandId`). 64 testes na camada de modelo (sem jsdom nesta etapa), incluindo a trava após resultado desconhecido e as mensagens por data.reason. Verificação manual no navegador com servidor `/rpc` simulado (2026-10-13): formulário, falha 503 forçada, trava dos campos, descarte em duas etapas com aviso, repetição com o mesmo `commandId` e horário, mensagem de replay e reinício do formulário. Layout a 360 px (painel do navegador sem viewport) e E2E automatizado em navegador **não** foram executados. |
| Outbox | Não aplicável | O passo 10 do plano não gera intents: o outbox transacional do servidor é PR108 e a venda não tem consumidores definidos. Registrado em `docs/business-rules/sales.md` e no plano. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, typecheck (8 workspaces), boundaries, Knip e 377 testes em 42 arquivos; `bun run build` passou nos 8 workspaces; `bun run --filter @polaris/db db:generate` reportou "No schema changes". |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only nova `pr43-sale-transaction-gate` (projeto `green-tooth-16857010`, database `polaris_pr43_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 16:30 UTC`), migrations 0000–0034 reaplicadas do zero em PostgreSQL 18.6, fixtures sintéticas, sem dados de produção. `poc:sales:transaction:verify` (novo): 18 grupos — snapshots completos, custo conhecido/desconhecido, perfil ausente/sem regra/zero conhecido/antecipação, replay e conflito de payload, versão e ciclo de vida do perfil, validações sem escrita, estoque insuficiente, falha injetada em 8 pontos de escrita com rollback conjunto, corridas de saldo (8 vendas × 3 unidades vendem 3; 2×2 sobre 3 vende 1), 6 entregas simultâneas do mesmo comando, ordem oposta sem deadlock, isolamento entre organizações, recusa de commits parciais no PostgreSQL, RLS de INSERT e ACL. `poc:sales:verify` (adaptado ao novo modelo de escrita: fixtures de venda completa em vez de cabeçalho solto, sem policies temporárias): 24 cenários dos PRs 38–42 passaram. A URL de conexão ficou só no ambiente do processo e foi removida. |
| Revisão independente | Concluída sem Critical/Important | Revisão estática da fronteira transacional, do SQL dos gatilhos, de RLS/ACL, da concorrência e do domínio. Minors tratados: limite técnico de ano (1900–2200) em `occurred_at` para não gerar erro 500; `recordStockMovement` não aceita mais `sale`; gate ganhou os casos de fuso horário (data de ledger na organização), instante irrepresentável e contagem de itens do cabeçalho divergente. Minors registrados e não alterados: `confirmed_at` usa `defaultNow()` (início da transação); o gatilho não acopla venda e saldo (a atomicidade do estoque é do código da aplicação); o limite de 200 itens/20 ajustes é salvaguarda de transporte, custo por linha não medido; a migration 0034 falha se `sales` tiver linhas (o runtime nunca pôde inserir antes); id de comando reutilizado por outro comando de estoque devolve conflito de estoque. Gates e `check` repetidos depois dessas mudanças: passaram (377 testes). |
| Publicação | Concluída | Commit `5e17b26`; branch `codex/pr43-sale-transaction` publicada; [GitHub PR #42](https://github.com/camilagama/polaris/pull/42) em draft sobre `codex/pr42-payment-profiles` (PR #41). CI 6/6 verde no head `0898277` (build, Knip, lint/boundaries, typecheck, unit tests, offline persistence browser gate). Sem merge nem deploy. |
| Perguntas levantadas no PR43 | Decididas (responsável delegou ao projeto em 2026-10-13) | (1) **Horário comercial:** passado ilimitado (venda offline); occurred_at mais de 5 minutos à frente do relógio do servidor é rejeitado com sale_occurred_in_future. (2) **Resultado desconhecido:** a tela trava a venda e só permite repetir a mesma tentativa (replay seguro); descartar exige confirmação explícita; deduplicação no servidor além do commandId não foi criada porque o replay já cobre a repetição e a venda não tem outra chave natural. (3) **Mensagens de conflito:** erros 400/404/409 carregam data.reason com o código de domínio estável; a tela mostra mensagem específica por motivo. (4) **Capabilities:** sale:create, organization:manage e inventory:read seguem todas no papel owner; a tela de venda lista perfis com organization:manage até existirem papéis por operação. |

### PR44 — Customer attribution (implementação, checks, gates PG18 e UI concluídos; revisão independente e publicação: ver linhas abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: GitHub PR #42 (PR43) aberto em draft, head `ba538f7`, CI 6/6; `main` (`f1edde9`) não contém PR42 nem PR43. Worktree `D:\2 - Dev\2 - Worktree\pr44-customer-attribution\polaris`, branch `codex/pr44-customer-attribution` criada sobre `origin/codex/pr43-sale-transaction`, sem upstream até a publicação. Baseline: `bun run check` 377 testes e `bun run build`. |
| Decisões de domínio | Tomadas pelo projeto (responsável delegou em 2026-10-13) | Histórico versionado somente de acréscimo; `expectedVersion` em toda mudança; ações já válidas são no-op; `assign` só sem cliente, `reassign` só para outro cliente, `unassign` só com cliente; somente clientes ativos são associáveis (já associado e depois arquivado continua visível); capability dedicada `sale:assign_customer` (leitura e escrita, só `owner` hoje); auditoria apenas com tipo e UUID da versão. O plano não definia esses pontos. |
| Domínio | Concluído | `packages/domain/src/sales/sale-customer-link.ts`: normalização do comando, plano de transição puro, erros próprios e nome do evento de auditoria. 14 testes (inclui capability). |
| Schema, migration 0035, RLS e ACL | Concluídos | `sale_customer_links` (versão única por venda, FKs compostas para venda e cliente, checks de ação/cliente), policies de SELECT/INSERT, runtime com SELECT+INSERT sob FORCE RLS e sem UPDATE/DELETE/TRUNCATE, gatilho `guard_sale_customer_link_transition` (sequência de versões, transições válidas, cliente ativo da mesma organização) sem EXECUTE para PUBLIC. `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `getSaleCustomerLink` e `changeSaleCustomerLink` na transação tenant com capability, venda e cliente escopados por organização, `FOR SHARE` no cliente, mapeamento de conflito de versão (índice único ou guard) e auditoria na mesma transação; procedures `sale.getCustomerLink`, `assignCustomer`, `reassignCustomer`, `unassignCustomer`; erros 400/404/409 com `data.reason`. 12 testes de roteador. |
| Interface | Concluída localmente | Painel "Cliente da venda" (colapsado e opcional após a confirmação em `/sales`) e página `/sales/customer?saleId=` (não existe lista de vendas para reconciliar vendas antigas); mostra só o nome do cliente, ações permitidas por estado, histórico e a nota de que os valores da venda não mudam. 57 testes de modelo. Verificação manual no navegador com servidor `/rpc` simulado (2026-10-13): estado sem cliente, picker só com clientes ativos, associar (v1), trocar (v2) com o cliente atual fora do picker, remover (v3), histórico com nomes e conflito de versão provocado por mudança externa (mensagem, recarga e nada alterado). Layout a 360 px e E2E automatizado **não** foram executados. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, typecheck, boundaries, Knip e 444 testes em 45 arquivos; build nos 8 workspaces; `db:generate` sem drift. |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only nova `pr44-customer-attribution-gate` (projeto `green-tooth-16857010`, database `polaris_pr44_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 18:02 UTC`), migrations 0000–0035 reaplicadas do zero em PostgreSQL 18.6, fixtures sintéticas. `poc:sales:customer-link:verify` (novo) cobre estado inicial, assign/reassign/unassign com auditoria, no-ops, conflitos de versão e de estado, economia da venda idêntica após quatro mudanças, ciclo de vida do cliente, isolamento entre organizações, capability e associação, corrida de seis atribuições (uma vencedora), interleavings determinísticos pelos dois caminhos do banco (índice único e guard de sequência), archive concorrente com associação (`FOR SHARE`), rollback por falha de auditoria, guards do banco, ACL e a policy de INSERT provada sozinha (guard desabilitado só durante a sonda: organização alheia, usuário sem membership e organização suspensa). Os gates `poc:sales:transaction:verify` e `poc:sales:verify` também passaram nesta branch (a checagem do nome da branch virou um padrão `prNN-...-gate`). Nota: um INSERT com `organization_id` de outra organização é recusado pelo guard (`customer_active`) antes da policy de RLS; a sonda com o guard desabilitado prova que a policy também recusa sozinha. |
| Revisão independente | Concluída sem Critical/Important | Revisão estática de migration, gatilho, repositório, RPC, UI e gate. Minors tratados: gate com interleavings determinísticos, corrida archive × associação, rollback de auditoria, ausência de auditoria em no-op, policy de INSERT provada sem o guard, asserções menos frágeis (contagem de migrations, snapshot com o id da venda); UI limpa a seleção quando ela vira o cliente atual, descarta respostas fora de ordem e usa `key` por venda. Registrados e não alterados: o histórico é somente de acréscimo por ACL/RLS (dono da tabela ou papel com BYPASSRLS poderia alterá-lo, como nas demais tabelas de venda; um gatilho de rejeição de UPDATE/DELETE seria endurecimento opcional); o guard consulta o cliente sem lock, seguro apenas via repositório (`FOR SHARE`); erros 23514 de `transition_valid`/`customer_active` não são mapeados e só são alcançáveis por SQL direto; repetir um comando cuja resposta se perdeu devolve conflito de versão (não replay), a tela recarrega e mostra o resultado. |
| Publicação | Concluída | Commit `ee7b264`; branch `codex/pr44-customer-attribution` publicada; [GitHub PR #43](https://github.com/camilagama/polaris/pull/43) em draft sobre `codex/pr43-sale-transaction` (PR #42). CI do PR em andamento na publicação. Sem merge nem deploy. |

### PR45 — Sale cancellation (implementação, checks, gates PG18 e UI concluídos; revisão independente e publicação: ver linhas abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: GitHub PR #43 (PR44) aberto em draft sobre o PR #42, CI 6/6; `main` (`f1edde9`) não contém PR42–PR44. Worktree `D:\2 - Dev\2 - Worktree\pr45-sale-cancellation\polaris`, branch `codex/pr45-sale-cancellation` sobre `origin/codex/pr44-customer-attribution` (`ae5eee2`). |
| Decisões de domínio | Tomadas pelo projeto (checkpoint pede revisão) | O plano só diz "operação compensatória, nunca editar itens antigos, movimentos inversos". Decidido: cancelamento total (uma vez por venda, irreversível, idempotente por `commandId`); motivo estruturado opcional com lista V1 `customer_request`/`entry_error`/`payment_issue`/`other` (nota obrigatória só para `other`); estoque devolvido ao custo do próprio item, recalculando a média como em um recebimento quando custo e média são conhecidos, sem bloquear nem inventar custo; produto arquivado recebe o estoque, produto removido bloqueia o cancelamento; atribuição de cliente segue permitida em venda cancelada (resolve a pergunta deixada no handoff do PR44); capabilities `sale:cancel` e `sale:read`. |
| Domínio | Concluído | `sale-cancellation.ts` (comando, motivos, erros, plano de reposição), `restockMovingAverageCost` em `inventory-cost.ts`, `SaleNotFoundError` compartilhado em `sale-errors.ts`. 12 testes novos de domínio. |
| Schema, migration 0036, RLS e ACL | Concluídos | `sale_cancellations` (única por venda, comando único por organização, `cancelled_by` obrigatoriamente o usuário autorizado, motivo validado), runtime com SELECT+INSERT sob FORCE RLS sem UPDATE/DELETE/TRUNCATE, gatilhos deferidos `check_sale_cancellation_complete` (movimentos inversos de todos os itens com quantidade, produto, variante e custo corretos; comando distinto do da venda; movimento `sale_cancellation` órfão). `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `cancelSale` (replay, ordem de locks por produto, reposição pelo ledger via `recordSaleRestockMovement`, auditoria `sale.cancelled`), `listSales`/`getSale`; procedures `sale.cancel`, `sale.list`, `sale.get`; erros 400/404/409 com `data.reason`. 16 testes de roteador. |
| Interface | Concluída localmente | `/sales/history` (lista com status, cliente, total, paginação), `/sales/detail?saleId=` (snapshot completo, cancelamento, painel de cliente) e cancelamento em duas etapas com a mesma disciplina de `commandId` e de resultado desconhecido da confirmação de venda. 50 testes de modelo. Sem clique em navegador nesta etapa. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, typecheck, boundaries, Knip e 522 testes em 49 arquivos; `bun run build`; `db:generate` sem drift. |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only `pr45-sale-cancellation-gate` (projeto `green-tooth-16857010`, database `polaris_pr45_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 19:00 UTC`), migrations 0000–0036 do zero em PostgreSQL 18.6, fixtures sintéticas. `poc:sales:cancellation:verify` (novo): cancelamento completo com venda e movimentos originais byte a byte idênticos, replay e conflitos, valoração (média ponderada, saldo zero, custo desconhecido), produto arquivado × removido, isolamento e capability, falha injetada em 5 pontos com rollback conjunto, corridas (6 cancelamentos → 1 vencedor; 5 entregas do mesmo comando; cancelamento × vendas novas sem deadlock), guards do banco e ACL, leitura de status e atribuição de cliente em venda cancelada. Os gates dos PRs 38–44 também passaram nesta branch. Limite do plano Neon: branches só de schema contam como raiz; a branch do gate do PR43 (minha, já registrada) foi removida para liberar espaço. |
| Revisão independente | Concluída sem Critical/Important | Revisão estática de atomicidade, valoração, locks, RLS/ACL, leitura e UI. Tratados: nota do cancelamento agora é limitada (2000 unidades no contrato, 500 pontos de código no domínio) e rejeita NUL e surrogate solitário, que o PostgreSQL gravaria de forma diferente e fariam um replay legítimo parecer conflito; o gate ganhou negativos de formato (movimento ausente, quantidade, custo, variante trocada e movimento extra). Registrados e não alterados: venda com produto removido não pode ser cancelada (decisão do projeto, sem escape; documentada); estouro do limite de quantidade ao devolver estoque não tem mensagem própria na tela; o banco não liga saldo a movimento (mesma postura das vendas); `sale.get` expõe `cancelledBy` (id de usuário) e custo por item, aceitável enquanto só `owner` tem `sale:read`; corridas só foram exercitadas contra `confirmSale` em um produto. |
| Publicação | Concluída | Commit `2a8ef21` e follow-up; branch `codex/pr45-sale-cancellation` publicada; [GitHub PR #44](https://github.com/camilagama/polaris/pull/44) em draft sobre `codex/pr44-customer-attribution` (PR #43). Sem merge nem deploy. |

### PR46 — Partial returns (implementação, checks, gates PG18 e UI concluídos; revisão independente e publicação: ver linhas abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: GitHub PR #44 (PR45) aberto em draft sobre o PR #43; `main` (`f1edde9`) não contém PR42–PR45. Worktree `D:\2 - Dev\2 - Worktree\pr46-partial-returns\polaris`, branch `codex/pr46-partial-returns` sobre `origin/codex/pr45-sale-cancellation`, com o follow-up do PR45 (`a5f7b6a`) trazido por merge. |
| Decisões de domínio | Tomadas pelo projeto (checkpoint pede revisão) | O plano define `sale_returns`, `sale_return_items`, `returned <= available_to_return`, `restocked <= returned` e property tests. Decidido: itens identificados pela posição; várias devoluções por venda até esgotar o disponível; só as unidades repostas geram movimento, ao custo do item (mesma regra de média do cancelamento); motivo estruturado opcional (`customer_request`/`defective`/`wrong_item`/`other`); devolução e cancelamento total se excluem (serializados por lock consultivo por venda e repetidos no commit pelo banco); capability `sale:return`; **sem valor monetário nem reembolso** (a especificação de origem diz que o Polaris não processa o dinheiro devolvido e que o impacto em vendas líquidas pertence ao motor de métricas). |
| Domínio e property tests | Concluídos | `sale-return.ts` (comando, regras, plano de devolução, erros). 17 testes, incluindo 3 property tests (300 execuções cada): devolvido acumulado nunca excede o vendido e reposto ≤ devolvido; plano rejeitado não tem efeito; devolver tudo em qualquer divisão usa cada unidade uma única vez. |
| Schema, migration 0037, RLS e ACL | Concluídos | `sale_returns` e `sale_return_items` (FKs compostas por organização, venda e posição do item), runtime com SELECT+INSERT sob FORCE RLS sem UPDATE/DELETE/TRUNCATE, `returned_by` = usuário autorizado, gatilhos deferidos `check_sale_return_complete` (linhas, quantidade acumulada, movimentos exatos, venda não cancelada, comando distinto) e `check_sale_cancellation_complete` substituída para recusar venda com devoluções. `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `createSaleReturn` (replay mesmo com a venda toda devolvida, lock por venda antes de ler a disponibilidade, ordem de locks por produto, reposição pelo ledger, auditoria `sale.returned`), `lockSaleForCompensation` também no cancelamento; `sale.return`, `sale.get` com devoluções e disponibilidade, `sale.list` com `hasReturns`. 13 testes de roteador. |
| Interface | Concluída localmente | Painel de devolução no detalhe da venda (disponível por item, devolvido e "volta ao estoque", confirmação em duas etapas, mesma disciplina de `commandId` e de resultado desconhecido), histórico de devoluções, selo "Com devoluções" e cancelamento oculto quando há devoluções. 38 testes novos de modelo. Sem clique em navegador nesta etapa. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, typecheck, boundaries, Knip e 591 testes em 52 arquivos; `bun run build`; `db:generate` sem drift. |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only `pr46-partial-returns-gate`, recriada do zero depois do endurecimento da migration 0037 (projeto `green-tooth-16857010`, database `polaris_pr46_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 19:00 UTC`), migrations 0000–0037 do zero em PostgreSQL 18.6, fixtures sintéticas. `poc:sales:return:verify` (novo): devolução parcial com venda e movimentos originais byte a byte idênticos, devolução que não repõe nada, regras de disponibilidade e rejeições sem efeito, replay e conflitos, exclusão mútua com o cancelamento, valoração (13,333333 após recebimento posterior), produto removido, isolamento e capability, falha injetada em 6 pontos com rollback conjunto, corridas (8 devoluções de 3 unidades sobre 10 vendidas → 3 vencedoras; 5 entregas do mesmo comando; 5 duelos devolução × cancelamento nunca ambos; devolução × vendas novas sem deadlock), sequência aleatória de 32 tentativas (com devoluções de várias linhas) contra um modelo em memória, guards do banco e ACL, escritores diretos serializados no commit, namespaces de `commandId`, leitura de disponibilidade. Os gates dos PRs 38–45 também passaram nesta branch. A branch do gate do PR44 (minha, já registrada) foi removida para respeitar o limite de branches raiz do plano Neon. |
| Revisão independente | Concluída sem Critical | A revisão independente da fronteira transacional/RLS não encontrou Critical. Importante: a sequência aleatória do gate era degenerada (multiplicador LCG acima de 2^53 perdia bits e as posições nunca eram sorteadas por igual). Corrigido: gerador Park–Miller exato em doubles, devoluções de uma e de duas linhas, rodadas 0 e 1 fixas (uma devolução válida de duas linhas e uma recusada atomicamente) e asserção de que ambas as posições recebem devoluções. Endurecimentos adotados: lock consultivo da venda também dentro dos gatilhos `check_sale_return_complete` e `check_sale_cancellation_complete` (mesma chave do repositório, para escritores que pulam o repositório); `planSaleReturn` rejeita a mesma posição duas vezes; UI mapeia `stock_command_conflict` (descarta a tentativa) e `inventory_quantity_limit`. Novos casos no gate: devolução acima do que as devoluções já comitadas deixaram (cumulativo, no commit), dueto de dois escritores diretos sobre as unidades restantes (um só vence), reuso de `commandId` de movimento de outra venda (`stock_command_conflict` sem rastro) e replay de comando contra outra venda. Não adotados: `sale.get` em uma só consulta (otimização) e preservação do rascunho da devolução quando o disponível muda (a chave do painel descarta o rascunho de propósito). |
| Publicação | Concluída | Commits `e3ce409` e `8143f37`; branch `codex/pr46-partial-returns` publicada; [GitHub PR #45](https://github.com/camilagama/polaris/pull/45) em draft sobre `codex/pr45-sale-cancellation` (PR #44). Sem merge nem deploy. |

### PR47 — Sale dates (implementação, checks, gates PG18 e UI concluídos; revisão independente concluída; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: PRs #41–#44 em draft e com CI verde; `main` (`f1edde9`) não contém PR42–PR46. Worktree `D:\2 - Dev\2 - Worktree\pr47-sale-dates\polaris`, branch `codex/pr47-sale-dates` sobre `codex/pr46-partial-returns`. |
| Decisões de domínio | Tomadas pelo projeto (checkpoint pede revisão) | O plano pede `occurred_at`, `recorded_at`, `confirmed_at`, fuso da organização e limite retroativo. Decidido: `recorded_at` substitui `client_created_at` (evidência do dispositivo, sem efeito em regra); `occurred_on` (data de `occurred_at` no calendário da organização, calculada no servidor) é coluna obrigatória e a data dos movimentos; janela retroativa de 30 dias **de calendário** no fuso da organização para o `owner` (a mesma data local de 30 dias atrás vale), papel desconhecido recebe 0 dias; futuro até 5 minutos; replay responde antes da janela; `confirmed_at` passa a `clock_timestamp()`, monotônico entre vendas sequenciais. |
| Domínio e testes | Concluídos | `sale-dates.ts` (janela, dias de calendário, papéis) com testes de borda (30/31 dias, dois fusos, propriedade de monotonicidade); `confirm-sale` normaliza `recordedAt`. |
| Schema, migration 0038 | Concluídos | Renomeia `client_created_at` → `recorded_at`; adiciona `occurred_on` com backfill pelo fuso da organização (NO FORCE/FORCE RLS no próprio `sales` durante o backfill) e depois NOT NULL; `confirmed_at` default `clock_timestamp()`; `check_sale_confirmation_complete` substituída para exigir `movement.occurred_on = sale.occurred_on`. Snapshot do Drizzle montado à mão (`--custom`); `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `confirmSale` calcula `occurredOn` no fuso da organização e aplica a janela depois do replay; contrato/handler expõem `occurredOn` e `recordedAt`; `sale_occurred_too_old` (400) com `data.reason`; testes de roteador. |
| Interface | Concluída localmente | Campo opcional "Data e hora da venda" (`datetime-local`, fuso do dispositivo) com dica, "Usar agora" e resumo; tentativa congelada (`commandId`, `occurredAt`, `recordedAt`); editar a data gera novo `commandId`; futuro validado com o relógio do dispositivo e retroativo só pelo servidor; datas da venda confirmada (data da venda, registrada no dispositivo, confirmada no servidor) no resultado e no detalhe. 16 testes novos de modelo. Sem clique em navegador. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, tipos, boundaries, Knip e 616 testes em 53 arquivos; `bun run build`; `db:generate` sem drift. |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only `pr47-sale-dates-gate` (projeto `green-tooth-16857010`, database `polaris_pr47_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 19:00 UTC`), migrations 0000–0038 do zero em PostgreSQL 18.6, fixtures sintéticas. `poc:sales:dates:verify` (novo): colunas, três datas e evidência, janela de 30 dias até o primeiro segundo da data local, ledger na data comercial (não UTC, não a de confirmação), fuso da organização (mesmo instante, datas diferentes em Tóquio e São Paulo), tolerância de 5 minutos, replay e conflito com a nova evidência, replay após a janela (linha envelhecida pelo dono da tabela), expressão do backfill igual à data da aplicação, NOT NULL. As datas dos gates anteriores agora são relativas ao dia da execução, para que não expirem com a janela. Todos os gates de venda (agregado, transação com o novo caso de data do movimento, cliente, cancelamento, devolução) e `poc:gate4:verify` passaram. |
| Revisão independente | Concluída sem Critical | Itens Important tratados: backfill sem prova (gate compara a expressão e a visibilidade de `organizations` sob FORCE RLS), predicado novo do gatilho sem prova (caso de movimento com data diferente no gate de transação) e replay após a janela sem prova (gate envelhece a linha). Aceitos e documentados: rótulo "Venda retroativa" usa o dia local do dispositivo; renomear o campo quebra clientes em cache; lista de vendas continua com `occurred_at`. |
| Publicação | Concluída | Branch `codex/pr47-sale-dates` publicada; [GitHub PR #46](https://github.com/camilagama/polaris/pull/46) em draft sobre `codex/pr46-partial-returns` (PR #45). Sem merge nem deploy. |

### Gate 4 — núcleo de vendas (fim da Fase 4)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Gate consolidado | Concluído | `poc:gate4:verify` (`verify-gate4-sales-core.ts`): um cenário ponta a ponta sobre PostgreSQL 18.6 contra um oráculo independente. Venda atômica (venda sem estoque na segunda linha não deixa rastro; replay não muda nada), estoque correto (movimento por item ao custo do snapshot, razão explica todos os saldos), dinheiro correto (subtotal, desconto percentual, frete e total em centavos inteiros e nas linhas persistidas), cancelamento correto (reposição ao custo original, venda não editada, replay, totais preservados, sem devolução depois), devoluções corretas (devolvido ≠ reposto, só o reposto move estoque, excesso recusado, venda com devoluções não cancela), reconciliação de cliente sem tocar a economia (digests idênticos), venda retroativa na data comercial e conservação de estoque por variante. |
| Runbook | Concluído | [`docs/runbooks/gate-4-sales-core.md`](../docs/runbooks/gate-4-sales-core.md): alvo seguro, sequência dos gates, mapa propriedade → evidência, limites. |
| Dossiê para a revisão completa | Concluído | [`doc/checkpoint-gate4.md`](checkpoint-gate4.md): mapa PR01–PR47, decisões tomadas pelo projeto, perguntas, lacunas e próximos passos. |
| Checkpoint seguro | Alcançado | Fim da Fase 4. Nada foi integrado ao `main` nem implantado; PRs permanecem em draft. A próxima etapa seria a Fase 5 (PR48), mas o responsável pediu parar aqui para rever tudo desde a etapa 1. |

## Rodada de correções pós-revisão (checkpoint Gate 4)

**Status: implementada em cinco branches empilhadas (rascunho); validação em Neon descartável concluída; merge e itens de nuvem pendentes com o responsável.**

A revisão completa ([`doc/revisao-checkpoint-gate4.md`](revisao-checkpoint-gate4.md)) gerou 5 frentes de correção, cada uma em uma branch empilhada sobre `codex/pr47-sale-dates`: `codex/review-1-db-integrity` → `codex/review-2-security-edge` → `codex/review-3-product-ui` → `codex/review-4-docs-adrs` → `codex/review-5-tooling`.

### Decisões tomadas pelo projeto (delegadas pelo responsável)

| Decisão | Escolha | Efeito |
| --- | --- | --- |
| D-1 — produto removido e compensações | (a) Cancelamento e devolução continuam possíveis; itens de produto removido não geram movimento de estoque | `sale-cancellation-repository.ts`, gatilho `check_sale_cancellation_complete` (conta só itens de produtos vivos), gate de cancelamento |
| D-2 — custo desconhecido na reposição | Saldo zero → custo médio desconhecido (`null`); saldo positivo mantém a média | `restockMovingAverageCost`, ADR 0020, testes de propriedade |
| D-3 — instantes | Todas as colunas de instante viram `timestamptz` | Migration 0039 (inclui `create_initial_organization`, que retornava `timestamp without time zone`) |
| D-4 — custo de venda retroativa | Usa a média vigente hoje; documentado | ADR 0020, runbook do Gate 4 |
| D-5 — integração da cadeia | Integrar por fase (Gate 0–4) antes da Fase 5; **nenhum merge foi feito** | Decisão do responsável executar |
| D-6 — preço de tabela | Entra na variante no PR50 | `doc/plano-inicial.md` |
| D-7 — UI de estoque e organização pela sessão | Antes do Gate 5, já implementados | `organization.listMine`, `inventory.listBalances`, telas de estoque |

### Banco (frente 1)

| Item | Status | Evidência |
| --- | --- | --- |
| Migration 0039 — `timestamptz` | Concluída | Recria políticas e gatilhos dependentes, converte todas as colunas e a função de onboarding |
| Migration 0040 — integridade do razão | Concluída | `variant_sequence` por variante (gatilho + índice único); gatilho diferido de reconciliação razão × saldo; GRANT UPDATE por coluna para o runtime; CHECKs de limites; CHECK de chave de mídia; endurecimento de funções (`search_path` fixo, `REVOKE` de PUBLIC) |
| Migration 0041 — role de autenticação | Concluída | `polaris_auth_runtime` (NOLOGIN) detém user/account/session/verification/auditoria de auth; o runtime de tenant perde acesso a essas tabelas |
| Timeouts e isolamento da transação tenant | Concluídos | `statement_timeout` 30 s, `lock_timeout` 20 s, `idle_in_transaction_session_timeout` 60 s; `REPEATABLE READ` opcional (leituras de venda) |
| Estoque operado em data futura | Recusado | `InventoryOccurredInFutureError` |
| Comandos de devolução/cancelamento com `commandId` de outro namespace | Recusados | `SaleReturnCommandConflictError`, `SaleCancellationCommandConflictError` |
| Limites de texto e de taxas | Concluídos | Domínio, contratos e CHECKs SQL; `Percentage.fromRate` ≤ 100 |

### Borda e segurança (frente 2)

Verificação de `Origin`, limites de taxa para mutações RPC e upload (bindings `RPC_MUTATION_RATE_LIMIT`, `MEDIA_UPLOAD_RATE_LIMIT`), CSP/HSTS e demais headers de segurança montados pelo pacote `@polaris/http-security` (ADR 0090) e aplicados no `public/_headers` (gerado), no Worker do web, no Admin e no catálogo, sessão com teto absoluto de 30 dias, logs estruturados sem dados pessoais, validação de UUID nas rotas de mídia, `cf-connecting-ip` como única fonte de IP, `X-Request-Id` somente UUID, e-mail via `waitUntil`, no máximo 20 mídias por produto, pool de autenticação separado (`AUTH_HYPERDRIVE`) e PoCs movidos para `apps/web/poc/` sem flags de runtime.

### Produto e interface (frente 3)

Seleção de organização pela sessão (`organization.listMine`), tentativa de venda não confirmada preservada em `sessionStorage` por organização (30 min) para o reenvio idêntico após recarregar a página, saldos de estoque (`inventory.listBalances`) com busca, filtros e paginação por cursor, telas de receber, contar e baixar estoque, shell do aplicativo, página 404 e `ErrorBoundary`, rotas com carregamento tardio, seletor de produto da venda com preços lembrados, filtros do histórico de vendas e correções de acessibilidade.

### Ferramentas e CI (frente 5)

Corredor único de gates (`packages/db/scripts/run-gates.ts`, suítes `gate3`, `gate4`, `ci`), gate de endurecimento da revisão e gate dos modelos de leitura; CI com `format:check`, checagem de drift do Drizzle, job consultivo `database` (Postgres 18) e job consultivo `audit`; verificadores próprios de fronteiras de importação (17 fixtures negativos) e de ciclos (Tarjan); `turbo.json` com `agentGuidance: false`.

### Evidência

| Verificação | Resultado |
| --- | --- |
| Branch Neon descartável `pr472-review-final-gate` (schema-only; database `polaris_pr472_gate`) | Migrations 0000–0041 aplicadas do zero em PostgreSQL 18 |
| Gates em sequência a partir do head final (`run-gates.ts`, um por vez) | Passaram: `sales-aggregate`, `sale-transaction`, `sale-customer-link`, `sale-cancellation`, `sale-return`, `sale-dates`, `gate4`, `read-models`, `gate2-runtime`, `inventory`, `customers`, `media-upload`. O `review-hardening` falhou duas vezes na primeira passada por defeitos reais (abaixo) e por fixtures do próprio gate; depois das correções passou inteiro |
| Defeitos reais encontrados pelos gates em banco novo | (1) `create_initial_organization` ainda retornava `timestamp without time zone` depois da 0039 e quebrava o onboarding; (2) o repositório do razão trocava um `null` legítimo do cálculo de média pela média antiga (`?? currentAverageCost`), então D-2 não tinha efeito na reposição de venda de custo desconhecido em saldo zero |
| `bun run check` no head final | lint, formato, tipos, fronteiras (17 fixtures negativos), ciclos (158 arquivos), Knip e 899 testes em 78 arquivos passaram |
| `bun run build` e `db:generate` | Build dos oito workspaces passou; `db:generate` sem mudanças |

### Backlog registrado (não bloqueia a Fase 5)

- Manutenibilidade: dividir `apps/web/src/server/router.ts`, `packages/contracts/src/index.ts`, `sale-form-model.ts` e `sale-page.tsx`; unificar os helpers de gates (`sales-gate-support.ts` e os scripts mais antigos).
- Repositório de estoque: `recordStockMovement` é exportado apenas como ponto de teste dos gates; `getProductVariants` ainda lê com `FOR SHARE`; `inventory_quantity_limit` e `insufficient_stock` compartilham o mesmo status HTTP.
- Capabilities: `expense:create` ainda não é usada por nenhum procedimento; algumas leituras exigem capabilities de escrita (`customer:update`, `organization:manage`) até a Fase de papéis finos.
- `/offline-poc` continua empacotada fora do modo DEV; remover ou proteger antes de produção.
- Mídia: prova de EXIF/orientação em Cloudflare Images real, consumo de memória por upload e comandos de remover/substituir/reordenar mídia (antes da Fase 7).
- CI: promover os jobs consultivos `database` e `audit` a checks obrigatórios depois de um histórico verde.
### Pendências que só o responsável pode executar

Criar e verificar as configurações Hyperdrive (cache desativado, `AUTH_HYPERDRIVE`); reservar os namespaces de rate limit; apagar Workers e Hyperdrive de PoC implantados (`ebe151e5081344479947edb6028279bb`); rotacionar a credencial owner usada no PR11; testar em Android físico; provar EXIF/orientação em Cloudflare Images real; verificar os cabeçalhos em staging; decidir o merge da cadeia de PRs.
## Fase 5 — offline

### PR48 — Device model (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr48-device-model` sobre `codex/review-5-tooling`. A cadeia de revisão ainda não está integrada ao `main`: o push direto foi bloqueado pelo classificador de permissões e a integração ficou com o responsável. |
| Decisões de domínio | Tomadas pelo projeto | [ADR 0028](../docs/adr/0028-dispositivos-e-grants-offline.md): dispositivo do usuário (não da organização), sem fingerprint, rótulo opcional curto, limite de 20 vivos; grant por organização e dispositivo, no máximo 72 h; revogação terminal e idempotente; revogar o dispositivo revoga os grants em todas as organizações; capability `offline:manage`; sem RPC (chega com o lease assinado no PR49). |
| Domínio | Concluído | `packages/domain/src/offline/offline-grant.ts`: rótulo, janela de 72 h, motivos de revogação e estado do grant, com testes de propriedade. |
| Schema e migration 0042 | Concluídos | Tabelas `devices` e `offline_grants` com RLS forçada, FKs compostas (usuário/dispositivo e organização/usuário), CHECKs de janela e de revogação, GRANT por coluna, gatilhos de revogação terminal e de dispositivo vivo (`FOR SHARE`). O índice único de `devices` precisou ser criado antes das FKs; descoberto ao aplicar do zero. |
| Repositório | Concluído | `device-repository.ts` (registrar, listar, tocar e revogar dispositivo; registrar, listar e revogar grant) e `user-transaction.ts` (transação só de usuário). |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-devices:verify` (`offline-devices` no corredor de gates, suíte `gate5`): privilégios e RLS, limite de 20 sob concorrência, isolamento entre usuários, revogação terminal por SQL cru, janela de 72 h no domínio e no banco, dispositivo de outro usuário ou revogado recusado, revogação em duas organizações com uma auditoria por grant e corrida entre grant e revogação sem grant vivo restante. |
| Limites | Registrados | Sem RPC nem UI; época de autorização, lease assinado e validação no servidor são PR49; o registro de dispositivo não é idempotente por retry do cliente. |

### PR49 — Offline authorization (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr49-offline-authorization` sobre `codex/pr48-device-model`. |
| Decisões | Tomadas pelo projeto | [ADR 0029](../docs/adr/0029-lease-de-autorizacao-offline.md): token `v1.<keyId>.<payload>.<assinatura>` com HMAC-SHA256 (Web Crypto); só o servidor assina e verifica, o cliente só lê; rotação por `KEY_ID` e segredo anterior; falha fechada sem segredo; época de autorização por membership; reset de senha invalida todos os leases; suspensão invalida pelo estado da organização; assinatura dentro da transação. |
| Domínio | Concluído | `offline-lease.ts`: claims, janela `min(agora + 72 h, fim do direito)`, validade, serialização determinística; testes de propriedade. |
| Token | Concluído | `apps/web/src/lib/offline-lease-token.ts` (assinar, verificar com várias chaves, ler sem verificar para a UI): adulteração, assinatura trocada, chave desconhecida, formato inválido, expirado e relógio adiantado cobertos. |
| Banco, migration 0043 | Concluída | `memberships.authorization_epoch`; função `SECURITY DEFINER` `bump_user_authorization_epoch` (lock consultivo por usuário, revoga grants com `security_event` e audita um evento por grant), executável só pela role de auth; o runtime de tenant lê e não escreve a época. |
| Repositório e RPC | Concluídos | `offline-lease-repository.ts` (emitir e revalidar no servidor com motivos distintos), `authorization-epoch.ts`, procedimentos `device.register|list|revoke` e `offline.issueLease`; o gancho `onPasswordReset` do Better Auth chama a função. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-lease:verify` (`offline-lease`, suíte `gate5`): privilégios e função pinada, emissão com época, capabilities e 72 h, teto do trial e direito encerrado, revalidação (principal, organização, grant, expiração, capability, dispositivo, época, revogado), reset de senha por usuário em duas organizações sem tocar outro usuário e corrida entre emissão e reset sem época vencida. |
| Limites | Registrados | Nenhum cliente consome o lease ainda (PR50 em diante); o fim do direito (trial) não é informado por nenhum chamador porque billing não existe; `OFFLINE_LEASE_SECRET` precisa ser criado em cada ambiente (checklist de go-live). |

### PR50a — Preço de tabela por variante (D-6) (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr50a-variant-list-price` sobre `codex/pr49-offline-authorization`. Dividido do PR50 do plano para manter os PRs coesos; o PR50b traz as coleções locais e o bootstrap. |
| Decisão | Registrada | Preço de tabela opcional na variante, só sugestão na venda (o último preço confirmado da variante tem precedência); `catalogVersion` será o cursor do PR51. Ver [ADR 0026](../docs/adr/0026-ui-de-estoque-organizacao-pela-sessao-e-preco-de-tabela.md) e `docs/business-rules/products.md`. |
| Domínio, banco e RPC | Concluídos | `normalizeVariantListPrice`; migration 0044 (`list_price`, CHECK de escala e limite, GRANT de UPDATE só na coluna); `setProductVariantListPrice` (versionado, auditado, idempotente); `product.setVariantListPrice`; `listPrice` nas variantes e nas entradas de saldo. |
| Interface | Concluída | Seção "Preço de tabela das variantes" no painel de variantes (vírgula ou ponto, vazio remove) e pré-preenchimento dos preços do item ao escolher a variante na venda. |
| Gate Neon PostgreSQL 18 | Concluído | `gate2-runtime` cobre normalização, versão, repetição sem mudança, conflito de versão, valores inválidos e os CHECKs do banco; `read-models` continua verde. |

### PR51 — Sync change log (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Ordem | Alterada pelo projeto | O PR51 vem **antes** do PR50b (coleções locais e bootstrap): o bootstrap consistente depende do cursor do log (cursor, snapshot por páginas, pull a partir do cursor). Branch `codex/pr51-sync-change-log` sobre `codex/pr50a-variant-list-price`. |
| Decisões | Tomadas pelo projeto | [ADR 0030](../docs/adr/0030-change-log-de-sincronizacao.md): registro por gatilho nas tabelas de domínio; sequência por organização atribuída no COMMIT sob lock do contador (ordem de commit, sem buracos, sem consumo por rollback); escrita só por funções `SECURITY DEFINER`, runtime só lê; o log leva chaves (tipo, id, seq), não conteúdo; capability `sync:read`. |
| Banco, migration 0045 | Concluída | `sync_changes` (RLS, append-only por gatilho) e `sync_cursors`; triggers em categorias, produtos, variantes, saldos, clientes, perfis de pagamento, regras, vendas, cancelamentos, devoluções e vínculos. |
| Repositório e RPC | Concluídos | `getSyncCursor`, `pullSyncChanges` (dedupe por entidade, páginas, cursor validado), procedimentos `sync.getCursor` e `sync.pull`. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:sync-log:verify` (`sync-log`, suíte `gate5`): privilégios e funções, mudança por escrita de cada tipo, sequência por organização sem buracos, rollback sem consumo, dedupe e páginas, runtime sem escrita (inclusive dono sem editar), escrita por SQL manual registrada e escritores concorrentes com leitor em polling sem nenhum salto. |
| Limites | Registrados | Sem retenção do log (sem piso de cursor); o pull devolve chaves e o conteúdo vem do cliente (PR50b); `payment_profile` e `sale` entram por já serem necessários ao offline de vendas. |

### PR50b — Coleções locais e bootstrap (implementação, gates Neon e de navegador, verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr50b-local-collections` sobre `codex/pr51-sync-change-log`. É a segunda metade do PR50 do plano (a primeira é o preço de tabela, PR50a). |
| Decisões | Tomadas pelo projeto | [ADR 0031](../docs/adr/0031-colecoes-locais-e-bootstrap.md): uma base OPFS por usuário e organização (nome por hash); seis coleções com modelos de leitura menores (sem custo, sem auditoria); bootstrap em três tempos com o cursor do PR51 registrado antes da leitura; estado `bootstrapping` retomável; falha fechada; apagar o namespace como gancho do logout. |
| Servidor | Concluído | `sync.bootstrapPage` (páginas por chave de cinco coleções, ou entidades por id; variantes por produto) sobre `bootstrap-repository.ts`; as vendas recentes usam `sale.list`. |
| Cliente | Concluído | `apps/web/src/offline/`: `namespace`, `bootstrap` (orquestração pura), `local-store` (TanStack DB sobre SQLite WASM em OPFS) e `orpc-source`. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:bootstrap:verify` (`bootstrap`, suíte `gate5`): páginas de dois e de 500 cobrem cada linha uma vez em ordem de id, linhas sem custo nem dados de organização, releitura por id (variantes por produto, saldos por variante), isolamento entre organizações e entradas inválidas recusadas. |
| Gate de navegador | Concluído em Chromium | `e2e/offline-local-collections.e2e.ts` no laboratório `/offline-local-lab` (só no modo offline-poc): sincronização do zero, persistência após recarregar sem servidor, catch-up por cursor, bootstrap interrompido retomado, isolamento entre usuários e organizações e apagar só o namespace escolhido; seis cenários em Chromium desktop e em Pixel 5 emulado. Android físico, Edge real e Safari continuam sem prova desta etapa. |
| Limites | Registrados | Ainda não está montado no aplicativo (o worker OPFS é carregado sob demanda e a montagem vem com a primeira tela offline, PR52+); sem mutações offline; a prova em Android real do ADR 0015 continua bloqueando o PR52. |

### PR52 — Durable command outbox (implementação, gate de navegador e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base e decisão | Concluídas | Branch `codex/pr52-command-outbox` sobre `codex/pr50b-local-collections`. O responsável pediu para seguir sem o teste em Android; a condição do [ADR 0015](../docs/adr/0015-offline-persistence-tanstack-db-opfs-indexeddb.md) passou de "antes de iniciar o PR52" para **"antes de ligar a escrita offline em produção"** ([ADR 0032](../docs/adr/0032-outbox-duravel-de-comandos.md)); o outbox não está montado em nenhuma tela. |
| Regras | Concluídas | `apps/web/src/offline/outbox/`: envelope do comando (ID, tipo, organização, dispositivo, versão-base, lease, payload), posição local monotônica, idempotência por ID e conteúdo, fila que não pula nem reordena, `sending` recuperável, `rejected` bloqueante, descarte e confirmação explícitos, limites e lease que bloqueia comandos novos mas preserva a fila. 13 testes sobre armazenamento em memória. |
| Armazenamento | Concluído | IndexedDB por usuário e organização (transação atômica, contador de posição na mesma transação); apagar recusa com comandos pendentes sem aceite explícito; `requestPersistentStorage()` com estado visível. |
| Gate de navegador | Concluído em Chromium | `e2e/offline-outbox.e2e.ts` no laboratório `/offline-outbox-lab`: sobreviver a recarregar mantendo a ordem, comando repetido sem duplicar, resposta perdida recuperada com a mesma posição, rejeição bloqueante, lease vencido, isolamento entre usuários e organizações, apagar sem descarte silencioso, posição nunca reutilizada e pedido de armazenamento persistente; nove cenários em Chromium desktop e em Pixel 5 emulado. |
| Limites | Registrados | Sem prova em Android físico (bloqueia ligar a escrita offline); `sync.push` é o PR53; nenhum comando de domínio usa o outbox ainda. |

### PR53 — sync.push (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr53-sync-push` sobre `codex/pr52-command-outbox`. |
| Decisões | Tomadas pelo projeto | [ADR 0033](../docs/adr/0033-protocolo-sync-push.md): uma transação de tenant por comando, em ordem, com `not_processed` depois de uma rejeição; idempotência por ID e organização com hash do conteúdo (`command_id_reused` não grava nada); revalidação por comando; lease vencido ainda cobre o que foi criado enquanto valia; trabalho de domínio em savepoint; registro de manipuladores vazio até o PR54. |
| Banco, migration 0046 | Concluída | `sync_commands` (RLS forçada; o runtime só lê e insere; imutável até para o dono por gatilho); `runSyncCommand` com lock por comando, repetição do resultado, revalidação do lease (grant, dispositivo, época, capabilities), janela de criação e savepoint. |
| Servidor | Concluído | Procedimento `sync.push` (até 50 comandos, capability `sync:push`, 503 sem o segredo do lease), verificação da assinatura sem janela, hash do JSON canônico, ordem e códigos estáveis; 9 testes da orquestração e 6 do roteador. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:sync-push:verify` (`sync-push`, suíte `gate5`): privilégios, aceito uma vez e repetido igual, mesmo ID com outro conteúdo, recusa sem rastro, falha inesperada reenviável, revogação, época, dispositivo, capabilities, janela de criação, lease vencido com comando feito a tempo, direito perdido, oito envios simultâneos executando uma vez e isolamento entre organizações. |
| Limites | Registrados | Nenhum comando de domínio registrado ainda (PR54 em diante); direito (billing) é só um ponto de extensão; sem retenção de `sync_commands`; o cliente que envia o outbox pelo `sync.push` ainda não existe. |

### PR54 — Cliente criado offline (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr54-offline-customer-create` sobre `codex/pr53-sync-push`. |
| Decisões | Tomadas pelo projeto | [ADR 0034](../docs/adr/0034-cliente-criado-offline.md): o dispositivo gera o UUIDv7 do cliente; idempotência por `commandId` e por `customerId` (`customer_id_conflict`); validação repetida no servidor; sem capability nova (`customer:update`). |
| Servidor | Concluído | `createCustomer` aceita `id` (validado, em savepoint, conflito limpo); manipulador `customer.create` registrado em `server/sync/registry.ts`, com 9 testes do manipulador e do roteador. |
| Cliente | Concluído | `lib/uuidv7.ts`; `offline/customer-create.ts` (enfileira, grava a linha otimista, restaura após queda, estado pendente/rejeitado); `offline/sync-runner.ts` (lotes em ordem, `sending` antes da requisição, aplicação dos resultados, atualização das coleções pelo change log); servidor sintético com resposta perdida e rejeição. |
| Gate Neon PostgreSQL 18 | Concluído | `customers` (ID do cliente mantido, duplicata na mesma organização e em outra, transação do chamador intacta após o conflito, ID inválido recusado) e `sync-push` verdes. |
| Limites | Registrados | Nenhuma tela monta o fluxo (a prova em Android físico ainda bloqueia ligar a escrita offline); sem laboratório de navegador para este fluxo; o sincronizador ainda não tem agendamento (online, foco, tentativa com espera). |

### PR55 — Produto criado offline (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr55-offline-product-create` sobre `codex/pr54-offline-customer-create`. |
| Decisões | Tomadas pelo projeto | [ADR 0035](../docs/adr/0035-produto-criado-offline.md): um comando atômico `product.create` (produto, variante padrão e estoque de abertura opcional); IDs do dispositivo; SKU em conflito recusa o comando inteiro (`sku_conflict`) e o descarte é explícito; `product:create` mais `inventory:adjust` quando há estoque, via `extraCapabilities`. |
| Banco | Concluído | Sem migration. `createProduct` aceita `id`, `defaultVariantId`, `sku` e `listPrice`, em savepoint, com `ProductIdConflictError` e `InvalidProductIdError`. |
| Servidor | Concluído | Manipulador `product.create` registrado; `extraCapabilities` no `sync.push` (lease precisa carregar todas); 8 testes do manipulador e 1 do `push`. |
| Cliente | Concluído | `offline/product-create.ts` (valida, enfileira, linhas otimistas de produto/variante/saldo, restauração, estado pendente/recusado, descarte explícito com bloqueio por dependentes e por `sending`); servidor sintético atômico com SKU único e resposta perdida; 9 testes. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-product:verify` (`offline-product`, suítes `ci` e `gate5`): IDs, SKU, preço e estoque preservados; change log; reenvio cria uma vez; SKU em uso (qualquer caixa) recusa tudo; ID de produto ou variante ocupado (mesma ou outra organização); atomicidade com estoque recusado e categoria indisponível; `receiveStock` negado sob `sync:push` puro. |
| Limites | Registrados | Só a variante padrão é criada offline (opções e variantes continuam online); sem laboratório de navegador nem tela; a prova em Android físico ainda bloqueia ligar a escrita offline. |

### PR56 — Comandos de estoque offline (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr56-offline-stock-commands` sobre `codex/pr55-offline-product-create`. |
| Decisões | Tomadas pelo projeto | [ADR 0036](../docs/adr/0036-comandos-de-estoque-offline.md): `stock.receive`, `stock.write_off`, `stock.count` (capability `inventory:adjust`); servidor autoritativo (`insufficient_stock`, `inventory_version_conflict`), sem "forçar"; o cliente não edita o saldo local, o saldo exibido é a linha do servidor mais a fila; descarte explícito. |
| Banco | Concluído | Sem migration e sem mudança de repositório: os manipuladores chamam `receiveStock`, `writeOffStock` e `inventoryCount`. |
| Servidor | Concluído | `handlers/stock-commands.ts` (três manipuladores, códigos estáveis, contagem exige `baseVersion`), `handlers/identity.ts` (`withCapability`); 13 testes. |
| Cliente | Concluído | `offline/stock-commands.ts`: `effectiveStock`, `receiveStockOffline`, `writeOffStockOffline`, `countStockOffline` (leva a versão-base), `pendingStockCommands`, `discardPendingStock`; leitor `inventoryRow` no armazenamento local; servidor sintético do razão; 12 testes. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-stock:verify` (`offline-stock`, suítes `ci` e `gate5`): entrada uma vez e replay; fila com a versão-base prevista igual à do razão; baixa acima do saldo e contagem obsoleta recusadas sem rastro; variante inexistente; data futura; duas contagens concorrentes (uma conflita); duas baixas concorrentes (saldo nunca negativo); isolamento entre organizações. |
| Limites | Registrados | Sem tela nem laboratório de navegador; a prova em Android físico ainda bloqueia ligar a escrita offline; contagem obsoleta após descarte de um movimento anterior só é percebida pelo servidor. |

### PR57 — Venda offline (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr57-offline-sale` sobre `codex/pr56-offline-stock-commands`. |
| Decisões | Tomadas pelo projeto | [ADR 0037](../docs/adr/0037-venda-offline.md): um comando `sale.confirm` (capability `sale:create`) pela mesma `confirmSale` da venda online; estoque autoritativo do servidor (venda recusada inteira, sem rastro); aviso local sem bloqueio; estados `pending`, `syncing`, `confirmed`, `rejected`, `needs_attention`; correção por reenvio como comando novo ou descarte, sem "forçar"; estoque exibido desconta a fila. |
| Banco | Concluído | Sem migration e sem mudança de repositório. |
| Contrato | Concluído | `offlineSalePayloadSchema` em `@polaris/contracts` (perfil de pagamento opcional a partir do ADR 0049). |
| Servidor | Concluído | `handlers/sale-confirm.ts` (esquema mais normalização do domínio sem checagem de relógio, códigos estáveis, snapshot inválido classificado); 6 testes. |
| Cliente | Concluído | `offline/sale-confirm.ts`: `createOfflineSale` (preço de tabela local, total, avisos de estoque), `pendingSales` com os cinco estados, `confirmedSales`, `resubmitRejectedSale`, `discardPendingSale`; `syncOutbox` informa `acceptedCommands`; `effectiveStock` desconta vendas na fila; leitor `variantRow`; 13 testes. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-sale:verify` (`offline-sale`, suítes `ci` e `gate5`): confirmada uma vez com `recordedAt` e replay; versão por linha; recusa total sem rastro; recusa gravada e reenvio como comando novo; janela de datas; disputa pelas últimas unidades; isolamento entre organizações. |
| Limites | Registrados | Sem perfil de pagamento offline; sem tela nem laboratório de navegador; a prova em Android físico ainda bloqueia ligar a escrita offline; aparelho offline além da janela retroativa tem as vendas recusadas por `sale_occurred_too_old`. |

### PR58 — Painel de atenção das operações offline (implementação, gate de navegador e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr58-conflict-attention` sobre `codex/pr57-offline-sale`. |
| Decisões | Tomadas pelo projeto | [ADR 0038](../docs/adr/0038-painel-de-atencao-offline.md): modelo puro de itens de atenção (causa, explicação, ações honestas por causa); sem "forçar sincronização"; descarte em duas etapas; reenvio só da venda recuperável, como comando novo; mudança de direito leva à revisão da conta sem descartar. |
| Modelo | Concluído | `offline/attention.ts` (`buildAttention`, `discardAttentionItem`, `resubmitAttentionItem`, `discardWarning`); `discardPendingCustomer` no módulo do cliente; 8 testes. |
| Painel | Concluído | `offline/attention-panel.tsx` e CSS (só apresentação, botões desabilitados durante a resolução); 5 testes de marcação (sem botão que force a sincronização). |
| Gate de navegador | Concluído | `e2e/offline-attention.e2e.ts` sobre o laboratório `/offline-attention-lab` (outbox real em IndexedDB): venda recusada aparece, bloqueia a fila e sobrevive a recarregar; reenvio como comando novo; descarte com confirmação; direito alterado só leva à revisão da conta. 4 cenários em Chromium desktop e Pixel 5 emulado. |
| Limites | Registrados | O painel ainda não está montado no app (a interface offline não está montada); sem edição guiada de SKU; a prova em Android físico ainda bloqueia ligar a escrita offline. |

### PR59 — Sair com operações pendentes (implementação, gate de navegador e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr59-logout-pending` sobre `codex/pr58-conflict-attention`. |
| Decisões | Tomadas pelo projeto | [ADR 0039](../docs/adr/0039-saida-com-operacoes-pendentes.md): enviar primeiro; bloquear a saída com razão e contagens; nada é apagado em nenhuma organização enquanto uma tiver trabalho; descarte só com confirmação explícita, em duas etapas; limpeza que se recusa a perder comandos; encerrar a sessão só depois de `ready`. |
| Guarda | Concluído | `offline/logout-guard.ts` (`attemptLogout`, `discardAndLogout`), `offline/logout-purge.ts` (`purgeNamespace`: outbox e depois coleções locais); 9 testes. |
| Diálogo | Concluído | `offline/logout-dialog.tsx` e CSS (sem "sair assim mesmo", descarte em duas etapas, aviso de comandos já enviados); 5 testes de marcação. |
| Gate de navegador | Concluído | `e2e/offline-logout.e2e.ts` sobre `/offline-logout-lab` (outbox em IndexedDB e banco em OPFS reais, rede e servidor simulados): 6 cenários em Chromium desktop e Pixel 5 emulado. |
| Limites | Registrados | O app ainda não tem tela de conta: o guarda não está ligado a um botão "Sair" nem ao `signOut`; sem registro das organizações do usuário no aparelho (quem chama informa as organizações); a prova em Android físico ainda bloqueia ligar a escrita offline. |

### Gate 5 — offline (provas automáticas concluídas; aparelho físico adiado)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Runbook | Concluído | [gate-5-offline.md](../docs/runbooks/gate-5-offline.md): cada critério do plano ligado à prova que o cobre, passos, e o checklist manual em iPhone e Android; ligado ao índice e ao checklist de go-live. |
| Gate ponta a ponta | Concluído | `poc:offline-e2e:verify` (`offline-e2e`, suítes `ci` e `gate5`, em `apps/web/scripts`): o cliente offline real (outbox, construtores de comando, sincronizador, atenção) contra o código real do servidor (`sync.push`, verificação do lease, todos os manipuladores) sobre o banco real, com oráculo independente: fila de sete comandos feita offline, primeira resposta perdida, reenvio que repete os sete sem executar nenhum duas vezes; saldos e versões iguais à previsão do aparelho; totais da venda em centavos; razão explica todos os saldos; conflito de estoque recusado sem corromper e corrigido do cliente (reenvio como comando novo, contagem obsoleta descartada); SKU em uso recusa o produto inteiro; aparelho revogado confirma nada e vira `needs_attention`. |
| Suíte completa de gates | Concluída | Os 22 gates em Neon descartável PostgreSQL 18 (migrations reaplicadas do zero, dados sintéticos) passam, inclusive os de venda, estoque, clientes, mídia e os nove da Fase 5. |
| Navegador | Concluído | Persistência, coleções locais, outbox, painel de atenção e saída com pendências em Chromium desktop e Pixel 5 emulado (CI). |
| Aparelho físico | **Adiado (bloqueia ligar a escrita offline)** | iPhone real (Safari e PWA instalado), Android real (Chrome), matar e reabrir durante envio, duas abas, saída com pendências e relógio errado: checklist no runbook, nada executado. |
| Limites | Registrados | A interface offline (telas) e o botão "Sair" ainda não estão montados no app; PWA, service worker e atualização (PR60 a PR62 do plano) não foram feitos; promover os jobs de CI `database` e `audit` a obrigatórios é decisão do responsável. |

### PR60 — Service worker do app shell (implementação, prova em navegador e verificações locais concluídas; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr60-pwa-service-worker` sobre `codex/pr59-logout-pending`. |
| Decisões | Tomadas pelo projeto | [ADR 0040](../docs/adr/0040-service-worker-do-app-shell.md): worker próprio de três funções (pré-guardar o shell, navegação rede-primeiro com o shell como reserva, arquivos pré-guardados do cache); nunca intercepta `/rpc`, `/api`, `/health`, `/ready`; cache por build; sem `skipWaiting` nem `clients.claim()`; sem biblioteca de PWA. |
| Worker | Concluído | `src/pwa/sw.ts` (roteamento, nome de cache ordenável, limpeza que mantém a build atual e a anterior, mensagem `SKIP_WAITING`); busca ignorando `Vary`. |
| Build | Concluído | `pwa/service-worker-plugin.ts` emite `sw.js` com o id da build, o instante e a lista de arquivos; `public/_headers` revalida `/sw.js`. |
| Instalável | Concluído | `manifest.webmanifest`, ícones PNG (any, maskable, apple-touch) por `scripts/generate-pwa-icons.mjs`, links no `index.html`. |
| Registro | Concluído | `src/pwa/register.ts` (produção, suporte, contexto seguro, depois do `load`, nunca nos laboratórios offline); chamado em `main.tsx`. |
| Testes | Concluído | 14 do worker e do manifesto de build (inclusive a simulação do worker compilado) e 3 do registro, mais o teste dos cabeçalhos. |
| Prova em navegador | Concluída | `e2e-pwa/app-shell.e2e.ts` (`bun run test:pwa`, no job de navegador do CI): instala e controla a página; abre offline, inclusive em rota interna; a API não passa pelo cache; manifesto e ícones; os laboratórios não registram o worker. Chromium desktop e Pixel 5 emulado. |
| Limites | Registrados | O ciclo de atualização para o usuário (aviso, esperar a fila vazia, recarregar sem perder trabalho) é o PR61; as telas ainda não leem os dados locais offline; Safari de iPhone e instalação na tela inicial dependem do checklist físico do Gate 5. |

### PR61 — Ciclo de atualização do app (implementação, prova em navegador e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr61-pwa-update-lifecycle` sobre `codex/pr60-pwa-service-worker`. |
| Decisões | Tomadas pelo projeto | [ADR 0041](../docs/adr/0041-ciclo-de-atualizacao-do-app.md): quatro ofertas (nenhuma, pronta, enviar primeiro, adiada por recusa); nunca atualizar por cima de trabalho na fila; nunca automático (avisa, a pessoa clica, recarrega uma vez); build esperando só conta como atualização quando a página já é controlada; a fila entra por `PendingWorkSource`. |
| Modelo | Concluído | `pwa/update-model.ts` (`offerFor`, `applyWhenSafe`); `pwa/update-controller.ts` (`watchForUpdate`, `takeOver` com recarga única); `pwa/update-store.ts` (store externa para `useSyncExternalStore`). |
| Interface | Concluída | `pwa/update-banner.tsx` e CSS, montado no topo do app; sem botão de atualizar enquanto há recusa; procura por builds novas ao voltar para o app e a cada hora (`pwa/runtime.ts`). |
| Testes | Concluído | 23 testes (decisão, envio seguro, controlador, store, aviso renderizado). |
| Prova em navegador | Concluída | `e2e-pwa/update.e2e.ts` com duas builds reais do app (a segunda com marcador no `index.html`): a nova versão vira aviso sem recarregar; só troca ao clicar; ficam os caches das duas builds; a primeira instalação não é anunciada. Servidor estático próprio que lê o disco a cada pedido (`scripts/serve-static.mjs`), porque `vite preview` não sobrevive a uma recompilação. Chromium desktop e Pixel 5 emulado, um teste de cada vez. |
| Limites | Registrados | A fila ainda é "ociosa" no app (o outbox não está montado), então hoje o aviso sempre oferece "Atualizar agora"; as provas com fila usam a interface de fonte; falta o PR62 (suíte de navegador do offline: duas abas, versão antiga, atualização pendente) e o checklist físico do Gate 5. |

### PR62 — Suíte de navegador do offline (implementação e verificações locais concluídas; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr62-offline-browser-suite` sobre `codex/pr61-pwa-update-lifecycle`. |
| Decisões | Tomadas pelo projeto | [ADR 0042](../docs/adr/0042-suite-de-navegador-do-offline-e-versoes.md): cada cenário no nível mais barato que o prova de verdade, mapeado no runbook do Gate 5; arquivo dourado dos payloads para a compatibilidade entre versões; o contrato só cresce e o servidor vai ao ar antes do app que usa um campo novo. |
| Duas abas | Concluído | `e2e/offline-outbox`: duas abas do mesmo usuário compartilham a fila; um comando em envio não é enviado de novo pela outra aba; o próximo vai depois da confirmação. |
| Atualização pendente | Concluído | `e2e-pwa/update-with-queue.e2e.ts` (duas builds reais, gancho só na build `pwa-e2e`): com fila e sem rede a atualização espera e nada se perde; com rede envia e só então atualiza; com recusa não há botão. |
| Versão antiga do app | Concluído | `server/sync/command-compatibility.test.ts` e `__golden__/command-payloads.json`: o que cada construtor emite hoje, aceito por todos os manipuladores registrados e coberto para todos os tipos; um campo desconhecido (app mais novo que o servidor) é `invalid_payload`. |
| Execução | Concluída | `bun run test:offline-browser` (as duas configurações de navegador); o CI roda ambas. |
| Limites | Registrados | Safari de iPhone e Chrome de Android reais seguem no checklist do Gate 5 e bloqueiam ligar a escrita offline; o outbox ainda não está montado no app, então a atualização com fila usa a interface de fonte. |

### Runtime offline no app (implementação, prova em navegador e verificações locais concluídas; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr63-offline-runtime` sobre `codex/pr62-offline-browser-suite`. |
| Decisões | Tomadas pelo projeto | [ADR 0043](../docs/adr/0043-runtime-offline-no-app.md): um runtime por organização, sem React e com dependências injetadas; o usuário vem das claims do lease (segunda visita offline sem nenhuma chamada); aparelho de outro usuário é esquecido e registrado de novo, uma vez; sincronização de uma execução por vez; atrás de `VITE_OFFLINE_RUNTIME_ENABLED`, desligada por padrão. |
| Runtime | Concluído | `offline/runtime/offline-runtime.ts` (aparelho, lease com renovação, abertura dos armazenamentos, restauração, bootstrap, sincronização, figuras, `workSource`, `logoutWorkspace`, `context`), `runtime-api.ts` (RPC), `runtime-stores.ts` (IndexedDB e OPFS). |
| No app | Concluído | Provedor, chip de sincronização no cabeçalho, página `/attention` com o painel de atenção, "Sair" com o fluxo completo (`logout-flow.ts`), aviso de atualização ligado à fila real. |
| Testes | Concluído | 15 do runtime (início, segunda visita offline, indisponibilidade, renovação, outro usuário, troca de organização, sincronização, execução única, falha e recuperação, fonte de trabalho, saída) e 11 do chip, da rota e do fluxo de saída. |
| Prova em navegador | Concluída | `e2e/offline-runtime.e2e.ts` sobre `/offline-runtime-lab` (runtime real, IndexedDB e OPFS reais, servidor simulado): iniciar online, trabalhar sem rede, recarregar e abrir offline do aparelho, enviar quando a rede volta, indisponível sem acesso anterior. Chromium desktop e Pixel 5 emulado. |
| Limites | Registrados | Nenhuma tela lê as coleções locais nem enfileira comandos ainda (converter vender, estoque, produtos e clientes é o trabalho seguinte; clientes e produtos estão na seção seguinte); a chave de build fica desligada até o checklist em aparelho físico; o app ainda não tem tela de entrada, então "Sair" só leva ao início. |

### Telas lendo do aparelho: clientes, produtos, venda e estoque (implementação, prova em navegador e verificações locais concluídas; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/offline-screens` sobre a `main` (já com os seis PRs de revisão mesclados). |
| Decisões | Tomadas pelo projeto | [ADR 0045](../docs/adr/0045-telas-lendo-do-aparelho.md) (clientes e produtos): a tela só troca de fonte quando o runtime está pronto e com cópia completa (sem modo misto); só cadastrar vai offline (já tem comando); editar, arquivar, variantes e imagens continuam online e ficam desabilitados sem rede ou sem confirmação do servidor. [ADR 0046](../docs/adr/0046-venda-e-estoque-sem-conexao.md) (venda e estoque): servidor quando alcançável, aparelho só sem conexão; venda sem perfil e sem data digitada; uma venda travada nunca muda de conteúdo e pode ir ao aparelho como a mesma venda quando o comando do aparelho a carrega exatamente (provado no gate `offline-sale`, passo 1b); o custo médio não vai ao aparelho (ADR 0031). |
| Base técnica | Concluída | `LocalWriter.rows`, `dataVersion` no estado do runtime e `localDataChanged()`, hook `useLocalWorkspace`. |
| Clientes | Concluído | `customers/local-customers.ts` (lista, ordem e repetidos como o servidor), página com leitura local, cadastro enfileirado, selos de envio, edição bloqueada sem rede. |
| Produtos | Concluído | `catalog/local-products.ts`, página com leitura local de produtos e categorias, cadastro enfileirado, selos, ações bloqueadas sem rede ou sem confirmação. |
| Venda | Concluído | O formulário real com busca e saldos locais (`offline/local-stock-entries.ts`), pedido validado guardado como um comando (`sales/queue-offline-sale.ts`), aviso de estoque do aparelho, painel "guardada neste aparelho", lista de vendas pendentes, formulário sem perfil e sem data sem rede (e a volta), venda travada nunca muda de conteúdo e, quando elegível, pode ser guardada no aparelho como a mesma venda. |
| Estoque | Concluído | Lista do aparelho com a fila aplicada e sem custo médio, receber/contar/baixar guardados (`inventory/queue-offline-stock.ts`), alvo sem custo (sem bloqueio nem valoração), mensagem de resultado "guardado neste aparelho". |
| Testes | Concluído | 34 de unidade novos (helpers, runtime, junção e filtros locais, comando de venda e repetição, formulário offline, estoque) e 28 cenários de navegador (14 por projeto) sobre `/offline-screens-lab`: telas reais, runtime real, IndexedDB e OPFS reais, servidor e rede simulados. Os 1.243 testes de unidade passam. O gate de banco `offline-sale` (com o passo 1b novo) passou numa branch Neon descartável de esquema, apagada em seguida. |
| Segurança | Verificada | Chave desligada por padrão: sem ela as telas são as de antes. O laboratório e o provedor de organização fixa não entram na build de produção (conferido no `dist/client`). |
| Duas abas | Concluído | Canal `BroadcastChannel` por namespace (`offline/runtime/data-channel.ts`): quem escreve ou sincroniza avisa, as outras abas sobem o `dataVersion` e releem. 2 testes de unidade e 1 cenário de navegador (que falha sem o canal, verificado). |
| Histórico | Concluído | Sem conexão a lista do histórico é a janela das vendas recentes do aparelho, filtrada no aparelho (`sales/local-history.ts`), somente leitura, mais a lista de vendas pendentes; com conexão é a do servidor. 4 testes de unidade e 1 cenário de navegador (2 execuções). |
| Revisão independente | Concluída | Duas leituras independentes e somente de leitura (venda e estoque; entrada, privacidade e abas) sem achados críticos; corrigidos em seguida, cada um com teste: corrida entre `stop()` e `start()` na troca de organização, sessão recusada com o app aberto, modo da tela de venda congelado durante envio e venda travada (e o formulário em branco pelo modo atual), contagem de estoque com a versão revisada, estoque travado reenviado só ao servidor, organização conferida ao enfileirar, marca de saída em curso, botão de guardar venda travada só com o runtime pronto e mensagem de falha, escolha de perfil da pessoa restaurada ao voltar a conexão, e a junção local indexada por variante (10.000 variantes: de cerca de 470 ms para cerca de 75 ms). |
| Aparelhos | Concluído | [ADR 0048](../docs/adr/0048-tela-de-aparelhos.md): tela `/devices` (menu só com o runtime ligado) para listar e revogar aparelhos da conta, com confirmação que diz o que se perde, só com conexão, sem revogar o próprio aparelho (usa "Sair"). Fecha o risco "sem tela de revogação" do ADR 0044. 5 testes de unidade e 4 cenários de navegador (8 execuções). |
| Perfil de pagamento | Concluído | [ADR 0049](../docs/adr/0049-perfil-de-pagamento-na-venda-sem-conexao.md): `sale.confirm` do aparelho carrega `paymentProfile` opcional (id e versão vista); o servidor recusa venda com versão antiga, perfil arquivado ou inexistente (`payment_profile_changed`, `payment_profile_unavailable`) sem rastro; a tela de venda guarda os perfis da última conexão e os oferece sem rede; recusa por perfil ganha "Reenviar sem perfil de pagamento" em Pendências; a venda travada pode ir ao aparelho também com perfil. Gates `offline-sale` (1c a 1e) e `offline-e2e` passaram numa branch Neon descartável, apagada em seguida. 13 testes de unidade novos (2 antigos saíram com a regra substituída) e 2 cenários de navegador. |
| Edição de cliente | Concluída | [ADR 0050](../docs/adr/0050-edicao-de-cliente-sem-conexao.md): `customer.update` carrega a versão que a pessoa editou (`baseVersion`); o servidor aplica só sobre essa versão e recusa a edição obsoleta inteira (`customer_version_conflict`), sem sobrescrever; sem rede a edição é guardada e sobreposta na exibição a partir do outbox (a linha local não muda), com selo e uma edição pendente por cliente; a recusa fica em Pendências só com "Descartar"; arquivar e restaurar continuam online. Manipulador e módulo do aparelho com testes, arquivo dourado atualizado, 3 cenários de navegador (6 execuções) e gate `offline-customer` (`poc:offline-customer:verify`, suítes `ci`, `all` e `gate5`) passado numa branch Neon descartável de esquema, criada e apagada nesta sessão. |
| Entrada offline | Concluída | [ADR 0047](../docs/adr/0047-abrir-o-app-sem-rede.md): o app só abria depois de ler as organizações ao servidor; agora a última lista (id, nome, papel, fuso) é guardada com o runtime ligado, usada só em falha de conexão ou de servidor, apagada ao sair e quando a sessão acaba, e relida quando a rede volta. 6 testes de unidade e 8 cenários de navegador com o app real (`e2e/offline-entry.e2e.ts`). |
| Limites | Registrados | Detalhe de venda (e a busca por item no histórico), cancelamento, devolução e vínculo de cliente continuam online; sem perfil de pagamento nem data retroativa offline; edição offline só existe para clientes (ADR 0050); recebimento offline sobre saldo com custo desconhecido pode ser recusado ao sincronizar (risco aceito no ADR 0046); uma venda travada com perfil de pagamento ou data digitada só pode ser reenviada ao servidor; falta o checklist em aparelho físico, agora com itens para estas telas. |

### Handoff para continuação por outro desenvolvedor

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Documento de passagem PR42 → PR43 | Concluído | [`doc/handoff-pr43.md`](handoff-pr43.md) registra o head exato, cadeia de PRs, decisões, artefatos, segurança das CLIs, sequência do PR43, verificações e documentos que devem continuar atualizados. |
| Merge para habilitar o handoff | Não necessário | O PR42 já está publicado no branch remoto e é a base cumulativa para PR43. Integrar ao `main` exigiria decidir e processar a cadeia anterior de PRs; o novo desenvolvedor pode iniciar sobre `origin/codex/pr42-payment-profiles`. |
| Próxima etapa | PR43 concluído em draft | A confirmação transacional da venda foi implementada em `codex/pr43-sale-transaction` (ver seção PR43). PR44 — Customer attribution foi implementado em `codex/pr44-customer-attribution` (ver seção PR44). PR45 — Sale cancellation foi implementado em `codex/pr45-sale-cancellation` (ver seção PR45). PR46 — Partial returns foi implementado em `codex/pr46-partial-returns` (ver seção PR46). PR47 — Sale dates foi implementado em `codex/pr47-sale-dates` (ver seção PR47) e o Gate 4 foi fechado (ver seção Gate 4). O checkpoint seguro foi alcançado; a próxima etapa do plano seria a Fase 5 (PR48), depois da revisão completa descrita em [`doc/checkpoint-gate4.md`](checkpoint-gate4.md). |

## Fase 6 — despesas, análises e metas

Ordem do plano ([doc/plano-inicial.md](plano-inicial.md), PR63 a PR71). O Gate 5 só termina com o iPhone real, que depende do responsável e está adiado (ver o checklist do [runbook](../docs/runbooks/gate-5-offline.md)); a Fase 6 não depende dele e segue em PRs agrupados por tema.

### PR63 e PR64 — categorias de despesa e despesas (implementação, prova em navegador, gate PostgreSQL 18 e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/expenses-core` sobre a `main` (PR #80 já mesclado). Os dois PRs do plano vão juntos: a categoria só existe para classificar a despesa. |
| Decisões | Tomadas pelo projeto | [ADR 0051](../docs/adr/0051-despesas-categorias-e-lancamentos.md): cinco grupos fixos e categorias da organização (nome único, grupo imutável, só arquivadas); 14 categorias padrão semeadas uma vez; lançamento pequeno (valor, categoria, competência, descrição, favorecido, venda opcional); editar com versão e anular em vez de apagar; competência entre 2000-01-01 e hoje + 366 dias; uma capability, `expense:create`, para tudo (inclusive leitura). Regras em [expenses-and-results.md](../docs/business-rules/expenses-and-results.md); modelo em [expenses-data-model.md](../docs/architecture/expenses-data-model.md). |
| Domínio | Concluído | `packages/domain/src/expenses/expense.ts`: grupos, categorias padrão, normalização do valor (decimal exato, duas casas, maior que zero), janela de competência, ciclo anular e reativar, erros estáveis. 21 testes. |
| Banco, migration 0047 | Concluídos | `expense_categories` e `expenses`: RLS e `FORCE RLS`, sem `DELETE`, `UPDATE` por coluna, CHECKs de valor, texto e data, chaves estrangeiras compostas com a organização para categoria e venda, índices de lista. O índice único que a chave composta exige precede a chave na migration. `db:generate` sem drift. |
| Repositório | Concluído | `expense-repository.ts`: categorias (padrão, criar, renomear, arquivar, restaurar), despesas (lançar, editar, anular, reativar, listar com cursor, filtros e total exato calculado no banco), auditoria de cada mudança, capability repetida no repositório. |
| Contrato e RPC | Concluídos | `expense.*` (10 procedimentos) em `packages/contracts`, `expense-handlers.ts`, mapeamento de erros para `BAD_REQUEST`, `CONFLICT` e `NOT_FOUND`; 14 testes de roteador. O contrato só cresce. |
| Interface | Concluída | Tela `/expenses` ("Despesas", no menu depois de Clientes): lançamento com valor em formato brasileiro, lista por mês com filtros, total do período, anular e reativar, e painel de categorias. Só com conexão. Modelo puro com 24 testes. [DESIGN.md](../DESIGN.md) atualizado. |
| Prova em navegador | Concluída | `e2e/expenses.e2e.ts` sobre o laboratório (`?screen=expenses`) com um servidor RPC simulado em memória: registrar com "1.500,50", valor inválido sem chamar o servidor, anular e reativar, conflito de versão, categoria repetida. 5 cenários em Chromium desktop e Pixel emulado (10 execuções), mais captura visual conferida. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:expenses:verify` (`expenses`, suítes `ci`, `all` e `gate6`) numa branch Neon descartável de esquema, criada e apagada nesta sessão (perfil `junior-pessoal`, identidade conferida), migrations do zero: padrão semeado uma vez mesmo com duas chamadas simultâneas, nome único por organização, versões, uma entre duas edições concorrentes vence, CHECKs do banco recusam valor e texto inválidos mesmo fora dos repositórios, isolamento entre organizações (RLS e chaves compostas), `UPDATE` e `DELETE` indevidos negados ao papel de runtime, janela de competência (366 dias sim, 367 não), total exato e paginação estável sem repetir nem pular, anulação, vínculo com venda real, eventos de auditoria. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura (isolamento, dinheiro, concorrência, erros, interface). Corrigidos, com prova no gate: o total da lista estourava com duas despesas do valor máximo (cast para `numeric(20,2)` removido; o gate soma dois valores máximos), cursor ou datas impossíveis (`2026-02-30`) viravam erro de banco 500 em vez de entrada inválida, limites de texto do contrato contavam unidades UTF-16 em vez de caracteres, e duas mensagens da tela diziam a causa errada. Aceitos: a edição digitada se perde num conflito de versão (a tela avisa e recarrega); a categoria pode ser arquivada entre a checagem e a gravação (sem efeito entre organizações); a unicidade do nome usa `lower()` e depende de a collation do banco não ser `C` (o gate prova a unicidade sem diferenciar caixa na Neon e no PostgreSQL do CI). |
| Verificação local | Concluída | `vitest run` (1.331 testes), lint, `format:check`, `bun run typecheck`, knip, boundaries, `bun run build`, `db:generate` sem drift. |
| Correção de gates com data | Concluída | O CI do PR falhou entre 00:00 e 03:00 UTC: o fuso das organizações dos gates é America/Sao_Paulo, e as datas "hoje" de `offline-product`, `offline-stock`, `offline-e2e` e `read-models` eram calculadas em UTC, então um movimento datado de hoje era recusado como futuro (5 de 7 comandos aceitos). As datas passam a ser as do calendário da organização; os quatro gates passaram numa branch Neon descartável durante a própria janela do erro (criada e apagada nesta sessão). |
| Limites | Registrados | Sem recorrência (PR65), sem efeito na margem da venda (PR66, a coluna `sale_id` só existe e é validada), sem métricas, painel nem metas (PR67 a PR71); sem despesas offline. |

### PR65 — despesas recorrentes (implementação, prova em navegador, gate PostgreSQL 18 e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/expenses-recurring` sobre a `main` (PR #81 já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0052](../docs/adr/0052-despesas-recorrentes.md): regra como molde e ocorrência como despesa comum; a ocorrência N é contada sempre do início (o dia 31 cai no fim dos meses curtos e volta); gera-se ao ler, quando a data chega, sem job (a Fase 11 só chamará a mesma função); catch-up completo; editar a regra só muda o que ainda não foi gerado, e frequência e início não mudam; pausar e retomar pula o que passou; a categoria arquivada depois não interrompe a série. Regras em [expenses-and-results.md](../docs/business-rules/expenses-and-results.md). |
| Domínio | Concluído | `expenses/recurrence.ts`: `occurrenceDate`, `dueOccurrences`, `occurrencesThrough`, validação da regra. Testes de unidade e de propriedade (datas sempre reais e crescentes; continuar de qualquer ponto dá as mesmas datas que um passo só; a contagem concorda com a geração). |
| Banco, migration 0048 | Concluídos | `expense_recurring_rules` (RLS, `FORCE RLS`, sem `DELETE`, `UPDATE` por coluna, CHECKs de valor, texto, frequência, datas e contadores, chave composta com a categoria) e as colunas de origem em `expenses` (juntas ou nenhuma em CHECK, chave composta com a regra, índice único por regra e ocorrência). Um `CHECK` que deixava passar a origem pela metade (`NULL >= 0` não falha) foi achado pelo gate e corrigido na migration ainda não publicada. `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `generateDueExpenses` (idempotente, sob o bloqueio de cada regra, passos de 500), regras (listar, criar, editar, pausar, retomar) e a leitura de despesas gerando as vencidas antes; contrato `expense.*Rule`, selo de origem na despesa; testes de roteador (19 no total). |
| Interface | Concluída | Painel "Despesas recorrentes" (lista, criar, editar, pausar e retomar) e selo "Recorrente" nas despesas geradas. [DESIGN.md](../DESIGN.md) atualizado. |
| Prova em navegador | Concluída | `e2e/expenses.e2e.ts` com 2 cenários novos (criar regra com início no passado e ver a ocorrência com o selo; pausar e retomar), 7 cenários no total em Chromium desktop e Pixel emulado (14 execuções). |
| Gate Neon PostgreSQL 18 | Concluído | `poc:expense-recurrence:verify` (`expense-recurrence`, suítes `ci`, `all` e `gate6`) numa branch Neon descartável de esquema, criada e apagada nesta sessão: catch-up a partir de 2024-01-31 com as datas do fim de mês, tudo gerado uma vez mesmo com gerações e leituras simultâneas, edição da regra só para o futuro, ocorrência anulada ou editada nunca regerada, pausa que não gera e retomada que pula o que passou, data de fim, catch-up de mais de mil ocorrências em passos, isolamento entre organizações, `UPDATE` e `DELETE` indevidos negados, CHECKs e chaves do banco, auditoria. O "tempo passando" é simulado recuando o início e o fim da regra. |
| Verificação local | Concluída | `vitest run` (1.366 testes), lint, `format:check`, `bun run typecheck`, knip, boundaries, `db:generate` sem drift. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura. Corrigidos, com prova no gate: a geração travava todas as regras ativas a cada leitura (agora lê sem bloqueio e trava só as que têm algo vencido, sempre em ordem de ID, o que também evita bloqueio cruzado entre duas leituras), retomar numa data de ocorrência pulava a ocorrência do dia (agora só pula até ontem) e pausar perdia o que já vencera e não fora gerado (pausar gera antes). Aceito: erros de infraestrutura do banco (deadlock, tempo de bloqueio) continuam sem mapeamento específico. |
| Limites | Registrados | A margem da venda e as métricas (PR66 e PR67) e o painel e as metas (PR68 a PR71) seguem; sem job agendado (Fase 11); a regra não muda de frequência nem de início. |

### PR66 e PR67 — despesas vinculadas à venda e motor econômico (implementação, gate PostgreSQL 18 e verificações locais concluídos; publicação: ver linha abaixo)

Os dois PRs do plano vão juntos: a margem da venda com a despesa vinculada (PR66) precisa da cadeia de cálculo que o motor (PR67) define.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/economics-engine` sobre a `main` (PR #81 e #82 já mesclados). |
| Decisões | Tomadas pelo projeto | [ADR 0053](../docs/adr/0053-motor-de-resultado-economico.md): cadeia vendas brutas, descontos, devoluções, vendas líquidas, CMV, lucro bruto, acréscimos, custos variáveis (taxas do snapshot e despesas vinculadas), margem de contribuição, despesas operacionais, resultado estimado; venda cancelada não conta; a devolução devolve o preço menos a parte do desconto rateada (maior resto) e não devolve acréscimo, frete nem sobretaxa (**fecha a pendência deixada em [sales.md](../docs/business-rules/sales.md)**); o CMV desfaz só o que voltou ao estoque; desconhecido nunca vira zero e é contado; taxa só do snapshot e despesa só da tabela (sem duplicar); a despesa vinculada entra no período da venda; período de calendário da organização, no máximo 366 dias; capability `report:read`. |
| Domínio | Concluído | `economics/sale-economics.ts` (`saleEconomics`, `periodResult`) em decimais exatos, sem ponto flutuante nem relógio. 22 testes: exemplos de cada regra e propriedades (a cadeia vale para qualquer venda válida; a devolução nunca passa do vendido líquido e a total é exata; dividir as vendas em dois grupos soma o todo em qualquer ordem; venda cancelada não muda nada; custo desconhecido sai do CMV). |
| Repositório | Concluído | `economics-repository.ts` (`readPeriodFacts`, `readPeriodResult`): lê vendas, itens, ajustes, taxas do snapshot, linhas de devolução, cancelamentos e despesas (vinculadas e operacionais) e alimenta o motor; a capability `report:read` é conferida no repositório; período inválido ou maior que 366 dias é recusado. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:economics:verify` (`economics`, suítes `ci`, `all` e `gate6`) numa branch Neon descartável de esquema, criada e apagada nesta sessão: vendas reais (desconto, frete, taxa de 1,5% por perfil, custo desconhecido, devolução com reposição, cancelamento) e despesas (vinculada, anulada, vinculada a venda cancelada, operacional, fora do período), conferidas contra números feitos à mão (vendas brutas 519,70; devoluções 54,00; CMV 60,00; margem de contribuição 376,62; resultado estimado 176,62) e contra agregados SQL independentes; custo e taxa desconhecidos mantidos como nulos; período sem venda; outra organização não vê nada; capability e período inválido recusados. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura. Corrigidos, com prova: as vendas são lidas em blocos de 5.000 identificadores (um período grande estouraria o limite de 65.535 parâmetros do PostgreSQL); a leitura exige uma transação em `REPEATABLE READ` (várias consultas sobre várias tabelas precisam do mesmo instante; o gate recusa `READ COMMITTED`); uma despesa ligada a venda cancelada passa a ser despesa operacional por competência (o custo foi real; antes sumia do resultado e o superestimava); um tipo de ajuste desconhecido falha em vez de sumir da conta; o gate compara texto decimal exato em vez de ponto flutuante. Anotado no ADR: a devolução de produto removido, quando implementada, deve gravar quantidade reposta zero. |
| Verificação local | Concluída | Ver a linha da publicação. |
| Limites | Registrados | Sem RPC nem tela: os cartões do painel, as consultas otimizadas (sem carregar vendas na memória) e o indicador de qualidade são o PR68 e o PR69; metas, PR70; leitura offline do painel, PR71. |

### PR68 e PR69 — painel de resultado e indicador de qualidade (implementação, prova em navegador, gate PostgreSQL 18 e verificações locais concluídos; publicação: ver linha abaixo)

Os dois PRs do plano vão juntos: o indicador de qualidade é a metade do painel que impede a falsa precisão.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/dashboard` sobre a `main` (PR #83, motor econômico, já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0054](../docs/adr/0054-painel-de-resultado-e-indicador-de-qualidade.md): um só procedimento `report.periodSummary` (cartões, cadeia e qualidade de uma vez, numa transação `REPEATABLE READ`, sem cache SQL); os cartões vêm do motor e não de uma segunda conta em SQL (a "consulta otimizada" é a leitura limitada a 366 dias e em blocos); a qualidade lista o que ficou de fora (item sem custo, venda sem taxa de processamento ou de antecipação, nenhuma despesa em período com vendas) com as contagens, e não uma nota; a tela nunca diz mais do que o indicador permite. Regras em [expenses-and-results.md](../docs/business-rules/expenses-and-results.md). |
| Domínio | Concluído | `economics/period-summary.ts` (`dashboardCards`, `resultQuality`): margem em percentual com duas casas e ticket arredondados para cima na metade, em inteiros; contagens novas no resultado do período. Testes de unidade e de propriedade (a margem mostrada é a razão exata com erro de no máximo meio ponto-base). |
| Contrato e RPC | Concluídos | `report.periodSummary` (capability `report:read`, isolamento `REPEATABLE READ`, período inválido vira `BAD_REQUEST`, datas mal formadas recusadas antes de abrir o contexto do tenant); 2 testes de roteador. |
| Interface | Concluída | Tela "Resultado" (`/dashboard`, no menu depois de Despesas): seletor de mês, seis cartões, aviso de qualidade em frases com as contagens, etiqueta "estimativa incompleta" quando parcial e a tabela "Como chegamos a este resultado". [DESIGN.md](../DESIGN.md) atualizado. |
| Prova em navegador | Concluída | `e2e/dashboard.e2e.ts` sobre o laboratório com servidor RPC simulado (mês completo, mês parcial, mês anterior, erro). |
| Gate Neon PostgreSQL 18 | Concluído | `economics` ampliado, numa branch Neon descartável criada e apagada nesta sessão: os cartões (vendas líquidas 443,70; margem 84,88%; 3 vendas; ticket 147,90; 7 itens) e a qualidade (um item sem custo, duas vendas sem taxa de processamento, despesas presentes, nível parcial) conferidos nos mesmos dados reais do motor; outra organização é `no_data` e um período só com despesas é `complete`. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura. Corrigidos: um período com vendas e só despesas ligadas a venda era dado como sem despesas (agora "nenhuma despesa" significa nenhuma de qualquer tipo); a margem, a mais inflada por custo desconhecido, também leva a etiqueta de estimativa incompleta; a contagem de custo desconhecido diz "linhas de itens vendidos" (são linhas, não unidades); a lista de cartões deixou de ser uma região viva anunciada inteira a cada recarga; a lista de navegação pode quebrar linha com nove itens. Aceitos: um período com 366 dias numa organização enorme pode estourar o limite de 30 s (erro genérico na tela); o menu mostra "Resultado" a todos (só existe `owner`). |
| Verificação local | Concluída | `vitest run` (1.423 testes), lint, `format:check`, `bun run typecheck`, knip, boundaries, 12 execuções do navegador do painel e 14 das despesas, gate `economics` no Neon descartável. |
| Limites | Registrados | Só com conexão e só o confirmado (a leitura offline do último retrato, com "atualizado até", é o PR71); metas, PR70; a agregação em SQL fica para quando o volume pedir, conferida contra o motor. |

### PR70 — metas (implementação, prova em navegador, gate PostgreSQL 18 e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/goals` sobre a `main` (PR #84, painel, já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0055](../docs/adr/0055-metas.md): alvo exato para um período de até 366 dias, medido por vendas líquidas, resultado estimado ou número de vendas; o progresso é derivado do resultado do período até hoje (o do painel), nunca guardado; o ciclo só avança a partir de ativa (concluída na primeira vez que o alvo é alcançado e **não reabre** se os números caírem depois, não atingida quando o período acaba sem alcançá-lo, ou cancelada; todas finais); mudar o alvo de uma meta ativa é permitido e cada mudança fica registrada; a conclusão é gravada em duas etapas (avaliação em `REPEATABLE READ`, depois uma transação curta que só aplica se a meta ainda estiver ativa na versão avaliada); capability `goal:manage`. Regras em [expenses-and-results.md](../docs/business-rules/expenses-and-results.md). |
| Domínio | Concluído | `goals/goal.ts`: tipos, alvo exato por tipo, período, avaliação do progresso (percentual de uma casa, arredondado para cima na metade) e a regra de liquidação. 26 testes, com propriedades (uma meta concluída nunca pede mudança de estado, o percentual é a razão exata). |
| Banco, migration 0049 | Concluídos | `goals` e `goal_target_changes` (RLS e `FORCE RLS`, sem `DELETE`, `UPDATE` só em nome, alvo, estado, valor atingido, instante da conclusão, carimbo e versão; CHECKs de tipo, estado, alvo por tipo, período e coerência da conclusão; histórico de alvos só de acréscimo; o índice único que a chave composta exige precede a chave). `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `goal-repository.ts` (criar, editar alvo e nome, cancelar, histórico, `evaluateActiveGoals`, `settleGoals`) e `goal.*` no contrato; a listagem orquestra avaliação e liquidação em duas transações; 8 testes de roteador. O repositório econômico aceita `goal:manage` além de `report:read`. |
| Interface | Concluída | Painel "Metas" na tela Resultado (criar, editar alvo, histórico do alvo, cancelar com confirmação, metas finais somente leitura, barra de progresso acessível). [DESIGN.md](../DESIGN.md) atualizado. |
| Prova em navegador | Concluída | `e2e/goals.e2e.ts` sobre o laboratório com servidor RPC simulado (criar e ver o progresso, meta concluída que fica concluída, editar o alvo e ver o histórico, cancelar com confirmação, metas finais sem ações, conflito de versão). |
| Gate Neon PostgreSQL 18 | Concluído | `poc:goals:verify` (`goals`, suítes `ci`, `all` e `gate6`) numa branch Neon descartável de esquema, criada e apagada nesta sessão, com vendas reais: conclusão no momento em que o alvo é alcançado (valor atingido gravado), meta de período vencido não atingida, meta que ainda não começou mede zero; liquidar é idempotente e três liquidações simultâneas aplicam uma só; uma devolução posterior não reabre a meta concluída; a mudança de alvo é registrada uma vez com o valor anterior e o novo, e uma liquidação avaliada numa versão antiga é pulada; cancelar; isolamento entre organizações e capabilities; CHECKs, `UPDATE` e `DELETE` indevidos negados; auditoria. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura. Corrigidos, com prova no gate e nos testes: editar ou cancelar agora liquida antes as metas ativas (uma meta que já alcançou o alvo não é alterada por um cartão antigo), editar uma meta de período encerrado é recusado, a meta de resultado operacional só é liquidada ao fim do período (a conclusão é irreversível e o resultado antes do fechamento é otimista), o progresso só aparece quando é da versão atual da meta, no máximo 20 metas ativas por organização, o alvo é comparado como texto exato (um número de ponto flutuante perdia precisão acima de 9×10¹⁵), nomes com NUL ou substitutos soltos são recusados, e o texto do cartão diz "conferido em". Aceito e documentado: a conclusão é constatada quando as metas são lidas (não há gatilho na venda). |
| Verificação local | Concluída | `vitest run` (1.491 testes), lint, `format:check`, `bun run typecheck`, knip, boundaries, navegador (metas e painel), gate `goals` no Neon descartável. |
| Limites | Registrados | Só com conexão e só o confirmado; sem reabrir nem editar metas finais; a leitura offline do painel (e das metas) é o PR71. |

### PR71 — leitura offline do painel (implementação, prova em navegador e verificações locais concluídas; publicação: ver linha abaixo)

Último item da Fase 6 do plano.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/offline-dashboard` sobre a `main` (PR #85, metas, já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0056](../docs/adr/0056-leitura-offline-do-painel.md): o aparelho guarda o último resumo confirmado de cada mês (no máximo seis por organização, validados na leitura, apagados com a sessão e nunca gravados depois de a saída começar) e só mostra a cópia quando o servidor não pôde responder (falha de rede ou indisponibilidade; uma recusa do servidor nunca cai na cópia); o "atualizado até" é o horário do servidor (`generatedAt`, contrato que só cresce); trabalho pendente nunca é somado ao resultado, só avisado; metas continuam só com conexão; atrás da chave `VITE_OFFLINE_RUNTIME_ENABLED`. |
| Servidor | Concluído | O resumo do período devolve `generatedAt` (relógio do servidor); teste de roteador. O servidor sobe antes do app. |
| Aparelho | Concluído | `lib/period-summary-cache.ts` (validação campo a campo, seis meses, limpeza só do prefixo, guarda de chave desligada e de saída em andamento), `use-period-summary.ts` (grava depois de ler, cai na cópia só nos erros certos, sem misturar mês nem organização), `offline-copy-notice.tsx`, limpeza junto da dos perfis de pagamento na saída e no "não autenticado". |
| Interface | Concluída | Linha "Atualizado até" e aviso de cópia com a contagem de operações guardadas; [DESIGN.md](../DESIGN.md) atualizado. |
| Prova em navegador | Concluída | 5 cenários novos em `e2e/dashboard.e2e.ts`: carregar com rede e cair na cópia quando a rede falha, mês nunca aberto com erro normal, "não autenticado" que não cai na cópia, entre outros; painel e metas continuam verdes (44 execuções). A limpeza na saída e a linha de operações guardadas têm teste de unidade. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura (privacidade, decisão de cair na cópia, atraso, chave desligada). Corrigidos: o aviso dizia "Sem conexão" também num servidor fora do ar (agora "Não foi possível falar com o servidor"), um "não autenticado" do próprio resumo agora apaga as cópias, uma resposta que não é um resumo (portal cativo) cai na cópia em vez de quebrar a tela, e o "atualizado até" é tomado antes da leitura do instantâneo. Aceitos e documentados no ADR: sessão que expira sem "Sair" mantém a cópia até o próximo "não autenticado" (como os perfis de pagamento), a cópia não leva o usuário na chave, e o aviso não menciona operações rejeitadas. |
| Verificação local | Concluída | `vitest run` (1.507 testes), lint, `format:check`, `bun run typecheck`, knip, boundaries, navegador (painel, metas e as cinco cenas novas). |
| Limites | Registrados | Só o resumo do painel é guardado (não as metas); a cópia envelhece e o horário mostrado é a defesa; checklist em aparelho físico (iPhone e Android) do Gate 5 segue com o responsável. |

## Fase 6 — encerramento

PR63 a PR71 mesclados (PR #81 a #86). O Gate 5 em aparelho físico (iPhone e Android) segue com o responsável e não bloqueia a Fase 7 no servidor.

## Fase 7 — billing e entitlements

Ordem do plano ([doc/plano-inicial.md](plano-inicial.md), PR72 a PR82 e Gate 7). Os adaptadores de provedor (Asaas cartão e Woovi Pix Automático, PR77 e PR78), o inbox de webhooks (PR79) e o Gate 7 exigem contas sandbox reais dos provedores e ficam fora do alcance enquanto elas não existirem; a base do domínio e do servidor, que não depende de provedor, segue em PRs agrupados.

### PR72, PR73 e PR76 — catálogo de planos, entitlements e máquina de estados (implementação, gate PostgreSQL 18 e verificações locais concluídos; revisão independente e publicação: ver linhas abaixo)

Agrupados em um só PR: são a mesma base (o que um plano dá, o que a organização pode fazer agora e como a assinatura muda de estado), sem provedor.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/billing-core` sobre a `main` (PR #86, leitura offline do painel, já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0057](../docs/adr/0057-catalogo-de-planos-e-entitlements.md): catálogo em dados (planos, preços e quotas por migration, não por deploy), runtime só lê; sem linha de billing a organização é Free; o plano em vigor depende do relógio do banco (acesso vencido conta como Free sem varredura); concessões temporárias só elevam; máquina de estados pura e independente de provedor. |
| Domínio | Concluído | `billing/entitlements.ts` (catálogo inicial Free/Pro, `planInForce`, `resolveEntitlements` com concessões, `assertFlag` e `assertWithinLimit`) e `billing/subscription-state.ts` (tabela de transições, trial e carência de 7 dias, `free_over_limit`). |
| Banco | Concluído | Migration 0050: `billing_plans`, `billing_prices`, `plan_entitlements` (globais, semente do plano e de PRODUCT.md), `organization_billing` e `entitlement_grants` (por organização); `FORCE RLS`, só SELECT para o runtime e constraints de coerência (Pro sempre com fim, chave e tipo de valor, preço com duas casas). Repositório `billing-repository.ts` (`getEffectiveEntitlements`). |
| Testes | Concluídos | Matriz de entitlements, tabela de transições e propriedades sobre sequências aleatórias (o registro permanece coerente; Pro só começa por método de renovação ou pagamento; `free_over_limit` só segue o uso; trial não começa duas vezes). |
| Gate PostgreSQL 18 | Concluído | `billing-catalog` (suíte `gate7`, também em `ci` e `all`), em branch Neon descartável criada só com o esquema, migrações do zero: a semente é igual ao catálogo inicial do domínio e aos preços de PRODUCT.md, o runtime não escreve nenhuma das cinco tabelas (nem a própria concessão), o banco recusa registros incoerentes, entitlements por organização sem vazar entre elas, acesso vencido conta como Free pelo relógio do banco, concessão eleva e expira. Branch apagada depois. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura (domínio, SQL/RLS e repositório). Corrigidos: um catálogo com linha faltando liberava o limite (agora o catálogo só vale completo e o limite que não é número recusa a adição); `periodEndsAt` passou a ser validado (data real, no futuro, até cerca de um ano) e um pagamento velho ou repetido não recua o acesso; uma falha de pagamento não encurta o período pago; `grace_expired`, `period_ended` e `trial_ended_without_payment` só valem depois do fim do acesso; trial oferecido uma vez (`trial_started_at` e `trialConsumed`); índice único de preço ativo por intervalo; datas devolvidas como cópia; relógio do banco sem fallback; `PRO_STATES` e `grantsPro` unificados; ADR corrigido (preços por migration, leitura escopada pela organização). Aceito: `overLimit` reflete o registro, não o uso, até o ciclo de vida (PR81) atualizá-lo; o `CHECK` das chaves no SQL repete a lista do TypeScript e o gate compara a semente com o catálogo do domínio. |
| Verificação local | Concluída | `vitest run` (1.547 testes), lint, `format:check`, `bun run typecheck`, knip, boundaries. |
| Limites | Registrados | Nenhum limite é aplicado neste PR (as cotas são o PR74 e PR75, abaixo); nenhum comando muda o estado de billing (ciclo de vida, PR81); nada de provedor, pagamento, webhook nem tela. |

### PR74 e PR75 — cotas do plano no servidor (implementação, gate PostgreSQL 18 e verificações locais concluídos; revisão independente e publicação: ver linhas abaixo)

Agrupados: o Free e o Pro são os mesmos limites com valores diferentes, aplicados no mesmo lugar.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/quotas` sobre a `main` (PR #87, base de billing, já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0058](../docs/adr/0058-cotas-do-plano-no-servidor.md): a verificação mora no repositório que escreve, dentro da transação, com lock consultivo por organização e limite (sem corrida); variantes contam as de produto não excluído (arquivar não libera, excluir libera) e configurar conta a adição líquida; imagens por produto e na organização atrás do teto técnico de 20; metas ativas atrás do teto técnico de 20; escrita offline é recurso do plano (sem lease no Free, lease limitado pelo fim do acesso, comando após downgrade rejeitado com código guardado); downgrade restringe sem apagar. |
| Servidor | Concluído | `entitlement-enforcement.ts` (`assertRoomFor`, `isFlagEnabled`); aplicado em `createProduct`, `configureProductVariants`, a capacidade de mídia (por produto e total), `createGoal`, `issueOfflineLeaseGrant` e `runSyncCommand`; erros `entitlement_limit_reached` e `entitlement_denied` como conflito (RPC) e 409 (upload, com compensação do arquivo). O contrato só cresce. |
| Gate PostgreSQL 18 | Concluído | `entitlements` (suítes `gate7`, `ci` e `all`) em branch Neon descartável: 50 variantes no Free e a 51ª recusada com a chave do limite, imagens por produto e total, concessões que elevam, produto excluído que libera, configurar variantes pela adição líquida, oito criações simultâneas nas quatro últimas vagas (exatamente quatro), metas do Free e do Pro com o teto técnico atrás, lease recusado no Free e limitado pelo fim do acesso, comando após downgrade rejeitado sem rodar. Os demais gates seguem verdes com a organização de teste paga por padrão. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura (caminhos de escrita, corridas, lease, mapeamento de erros). Corrigidos: a recusa por plano era gravada para sempre sob o ID do comando e travava a fila do aparelho (agora não é gravada, e a tela de atenção oferece "Tentar de novo" com o mesmo comando); um plano sem escrita offline fazia o aparelho se registrar de novo a cada abertura (agora fica online); a meta concluída só liberava a vaga depois de liquidada (o servidor liquida antes de criar); o gate `gate2-runtime` usa organização paga; adicionar zero não é recusado acima do limite; o 409 do upload informa o limite; o gate ganhou o downgrade acima do limite e arquivar sem liberar. Aceitos e documentados: excluir produto libera a vaga mas os arquivos da mídia ficam (a limpeza de mídia é um item à parte), a chave do limite ainda não viaja na resposta de RPC, e o gate demora cerca de cinco minutos em um Neon remoto. A afirmação de que a pré-verificação do upload pulava o plano não procedia: ela já chama a mesma checagem antes de processar a imagem. |
| Verificação local | Concluída | `vitest run` (1.549 testes), lint, `format:check`, `bun run typecheck`, knip, boundaries, build, `db:generate` sem drift; gate `entitlements` e mais 15 gates afetados (produtos, metas, mídia, offline, sincronização) passaram em branch Neon descartável, apagada depois; os demais gates e o de navegador rodam no CI. |
| Limites | Registrados | `public_catalog` ainda não tem onde ser aplicado (a página pública não existe); a interface não mostra ainda o convite ao Pro nem o motivo da recusa (PR80); nenhum comando muda o estado de billing (PR81); arquivar produto não libera quota. |

### Antes da Fase 7 (pendência da Fase 3) — remover e reordenar imagens de produto (implementação, gate PostgreSQL 18 e verificações locais concluídos; revisão independente e publicação: ver linhas abaixo)

Fecha o item "comandos para remover, substituir e reordenar mídia de produto" que o plano e o ADR 0018 pediam antes da Fase 7: com a cota do Free (uma imagem por produto), sem isso não havia como trocar a foto.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/media-commands` sobre a `main` (PR #88, cotas, já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0059](../docs/adr/0059-remover-e-reordenar-imagens-de-produto.md): remover tira as associações e mantém o asset e o objeto (idempotente; a vaga volta para o plano na hora); reordenar recebe a lista inteira, que precisa ser exatamente as imagens atuais, em um único `UPDATE`; substituir é remover e depois enviar; rotas HTTP com a capacidade `product:update`; sem remoção lógica nem troca atômica. |
| Banco | Concluído | Migration 0051: `DELETE` em `product_media` e `variant_media` e `UPDATE (position)` em `product_media`, com políticas de linha que exigem a organização ativa e o produto não excluído; o trigger de tombstone (migration 0024) continua guardando identidade e produto excluído. |
| Servidor | Concluído | `removeProductMedia` e `reorderProductMedia` (com `planMediaOrder` no domínio), rotas `DELETE /api/products/:productId/media/:assetId` e `PUT /api/products/:productId/media/order`, eventos de auditoria; `invalid_media_order` como 409. |
| Gate PostgreSQL 18 | Concluído | `media-commands` (suítes `gate3`, `ci` e `all`) em branch Neon descartável: remoção solta vínculos de produto e de variante e mantém o asset, imagem removida não é mais servida, repetir não muda nada, ordem exata (lista desatualizada ou repetida recusada, posições arrumadas, mesma ordem não é mudança, imagem nova por último), a vaga volta para um Free na hora, outra organização não toca em nada, produto excluído não aceita nem pelo SQL direto, o runtime continua sem apagar asset nem mudar o vínculo além da posição, e concorrência (de seis remoções simultâneas só uma remove; duas reordenações deixam posições arrumadas em uma das duas ordens). Branch apagada depois. |
| Interface | Concluída | Painel de mídia do produto (`product-media-panel.tsx`, com o modelo de decisão em `media-commands-model.ts`): "Para antes" e "Para depois", "Remover" e "Substituir" com confirmação na própria linha, comandos que nunca se sobrepõem, lista atrasada descartada, mensagens em português por código de erro (nunca o código), recarga automática quando a lista mudou em outro lugar; [DESIGN.md](../DESIGN.md) atualizado. |
| Revisão independente | Concluída sem Critical nem High | Uma leitura independente e somente de leitura (SQL e políticas, travas e concorrência, rotas, interface). Confirmado seguro: o truque de posição (+1.000.000 e depois 0..n-1 em um único `UPDATE`) não colide, o runtime só muda a posição, o tombstone barra tudo. Corrigidos: reordenar a mesma ordem com buracos agora os arruma; o corpo da ordem é limitado por `Content-Length` e por bytes; o ADR agora diz sem rodeios que **nada reclama o objeto de uma imagem removida** (custo e retenção, item do checklist de go-live); o DESIGN.md descreve o foco como ele é; o gate ganhou o tombstone pelo SQL direto (inclusive com a conexão que ignora a segurança por linha), SQL de outra organização, remoção por outro produto, vínculo de variante que sobrevive à reordenação, buracos arrumados e o reenvio de um comando de envio de imagem removida. Aceitos e documentados: o aviso de "uma imagem a menos" vale só enquanto a tela está aberta, a auditoria registra o produto e não o ID da imagem (os eventos não carregam carga, por desenho), a caixa de confirmação não tem `aria-modal` nem Escape, e o 403 da checagem de origem aparece como "sem permissão".  |
| Verificação local | Concluída | `vitest run` (1.586 testes), lint, `format:check`, `bun run typecheck`, knip, boundaries, build, `db:generate` sem drift; gate `media-commands` em branch Neon descartável (apagada depois). A interface não foi exercitada em navegador real: o painel não tem testes de componente no repositório, então a lógica de decisão e o cliente HTTP têm testes de unidade e o fluxo de confirmação, o foco e o layout de 360 px ficam para a revisão do responsável. |
| Limites | Registrados | Objetos de imagens removidas ficam no armazenamento sem prazo, porque nada os reclama (custo e retenção; item novo no checklist de go-live); substituir não é atômico (se o envio falha, o produto fica com uma imagem a menos); sem prova em navegador real. |

## CI econômico em minutos (15/10/2026)

O GitHub Actions deixou de iniciar jobs ("pagamentos recentes falharam ou o limite de gastos precisa aumentar"). Medido nos 201 runs do repositório (6 a 15/10): 1.146 minutos de tempo real e cerca de 1.890 cobrados (o GitHub arredonda cada job ao minuto); o gate de navegador foi 30% do total. A conta dona do repositório é `camilagama`, não a que faz o push; a causa do bloqueio (plano, pagamento ou limite de gastos) só pode ser confirmada nessa conta e **continua aberta**.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Decisão | Tomada pelo projeto | [ADR 0060](../docs/adr/0060-ci-economico-em-minutos.md): checks leves em um job só (cada passo roda mesmo se outro falhar); gate de navegador só quando algo que ele exercita mudou (`scripts/ci-changed.mjs`, testado) e nunca repetido na `main`; auditoria só quando uma dependência mudou; um cache de instalação por lockfile (eram 55 caches, 10,8 GB, acima do limite de 10 GB); gates de banco em todo pull request. Nenhum check removido ou afrouxado. |
| Implementação | Concluída | `.github/workflows/ci.yml` (pins das actions idênticos aos anteriores), `scripts/ci-changed.mjs` e seus testes, `workflow_dispatch` para uma execução completa. |
| Economia estimada | Medida no histórico | ~18% (cerca de 340 de 1.890 minutos cobrados), aplicando a regra a cada pull request pelos arquivos que ele mudou: 103 do gate de navegador na `main`, 14 do gate em pull requests só de documentação ou banco, 24 da auditoria e ~200 do job único. O grosso (o gate de navegador, 468 s por execução, serial por causa do SQLite WASM) continua: reduzi-lo mais exige acelerar o gate ou rodar menos execuções, decisão à parte. **Medição do gate de navegador (15/10):** 190 testes, 275 s no computador do desenvolvedor (cerca de 7 a 8 minutos no CI), média de 1,4 s por teste e nenhum dominante; o projeto de celular repete o de desktop (41% do tempo). Não há ganho barato sem cortar provas, então a regra de detecção foi ampliada em vez disso: o servidor, o Worker e os scripts de gate do app web (`apps/web/src/server`, `worker`, `scripts`) também não acionam o gate, porque ele serve o bundle estático e responde às chamadas `/rpc` com `page.route` (a economia estimada passa de ~18% para ~20% sobre o histórico). |
| Verificação local | Concluída | YAML válido (leitor de YAML do Bun), pins das actions iguais, classificação de mudanças com testes de unidade (6) e exercitada em um repositório temporário (só documentação, só banco, web com `package.json`, primeiro commit), `vitest run`, lint, `format:check`, knip e boundaries. |
| Limites | Registrados | O workflow novo **não rodou no GitHub**: não há minutos para isso enquanto o bloqueio durar, então a primeira execução real é o próprio pull request, e uma expressão errada só apareceria ali. A conta dona do repositório continua sem diagnóstico de cobrança. |

### Limpeza dos objetos de imagens removidas (implementação, gate PostgreSQL 18 e verificações locais concluídos; revisão independente e publicação: ver linhas abaixo)

Fecha a lacuna registrada no [ADR 0059](../docs/adr/0059-remover-e-reordenar-imagens-de-produto.md): uma imagem removida deixava o arquivo no bucket sem prazo (custo e retenção de algo que a pessoa quis apagar).

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/media-cleanup` sobre a `main` (PR #89, remover e reordenar, já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0061](../docs/adr/0061-limpeza-de-imagens-removidas.md): imagem removida é um asset sem vínculo; duas funções `SECURITY DEFINER` no desenho de privilégios da migration 0026; objeto primeiro e banco depois (nunca um objeto sem dono); espera de uma hora; no cron horário já existente, de forma independente do reconciliador de markers. |
| Banco | Concluído | Migration 0052: privilégios mínimos da role dona da limpeza (leitura dos ids de `media_assets` e dos vínculos, `DELETE` do asset, com políticas próprias), as funções `list_unlinked_media_for_cleanup` (com lista de excluídos) e `finalize_unlinked_media_cleanup`, e o gatilho `product_media_new_asset_only`, que só deixa inserir um vínculo de produto na transação que criou o asset (a invariante de que a limpeza depende). |
| Servidor | Concluído | `reconcileRemovedMedia` (apaga master e derivados 320 e 640, depois finaliza; até 500 por execução; falha reportada ao fim), `listUnlinked` e `finalizeUnlinked` no cliente de limpeza, integrado ao cron. |
| Testes | Concluídos | 8 de unidade do reconciliador com bucket falso (ordem objeto-depois-banco, falha do R2 sem registrar nada, falha do banco, chave fora do namespace, ativo que ganhou vínculo, vários lotes, nada a fazer). |
| Gate PostgreSQL 18 | Concluído | `media-commands` (nova seção) em branch Neon descartável: o papel de limpeza lista a imagem removida e nunca uma vinculada (nem a de produto excluído) nem uma jovem demais, finaliza só a removida (a linha sai e a chave vai para o tombstone, sem reutilização possível), finalizar duas vezes não muda nada, o login de limpeza não lê nem apaga tabelas e a role tenant não executa as funções, argumentos inválidos recusados. O gate `media-upload` foi atualizado: o runtime pode apagar vínculos (migration 0051) e não o asset; o #89 o havia deixado desatualizado porque ele só roda na suíte `gate3`, que não está no CI. |
| Revisão independente | Concluída sem Critical nem High | Uma leitura independente e somente de leitura (privilégios, corridas, ordem e reconciliador). Corrigidos: a invariante "vínculo só em asset novo" agora é imposta pelo banco (gatilho) e um asset que ganha vínculo depois de seus objetos apagados é erro registrado, não silêncio; cada falha é registrada com o ID do asset e as duas falhas do cron não se escondem (`AggregateError`); um asset que falha sai do resto da execução (não há inanição pela cabeça da fila); lotes menores (150 imagens por execução) por causa do teto de chamadas do Worker; ADR 0059 e 0061 e a regra de mídia corrigidos (a espera conta da criação do asset; um reenvio atrasado do mesmo comando de envio, depois da limpeza, cria uma imagem nova). Aceitos: um derivado gravado por uma leitura em andamento no instante da remoção pode ficar órfão (janela muito estreita); a finalização não confere idade (a role de limpeza é de confiança e o asset já está sem vínculo). |
| Verificação local | Concluída | `vitest run`, lint, `format:check`, `bun run typecheck`, knip, boundaries, build, `db:generate` sem drift; gates `media-commands` (incluindo o gatilho novo), `media-upload` e os de mídia passaram em branch Neon descartável, apagada depois. |
| Limites | Registrados | Sem prova no R2 real (implantação adiada pelo responsável; passo no runbook); o limite de envio por organização continua aberto (a limpeza não impede o envio em massa); a espera de uma hora conta da criação do asset, não da remoção. |

### PR79 e PR81 (parte independente de provedor) — caixa de entrada, reconciliação e ciclo de vida do billing (implementação, gate PostgreSQL 18 e verificações locais concluídos; revisão independente e publicação: ver linhas abaixo)

O núcleo que não depende de qual provedor chegar; a rota de webhook, o registro de adaptadores e a integração com o cron são o PR seguinte, e os adaptadores (PR77 e PR78) precisam de contas sandbox.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/billing-lifecycle` sobre a `main` (PR #92). |
| Decisões | Tomadas pelo projeto | [ADR 0062](../docs/adr/0062-ciclo-de-vida-do-billing-e-caixa-de-entrada.md): cinco fatos normalizados e sem dado pessoal; reconciliação pura sobre a máquina de estados (fato obsoleto ou que não cabe fica ignorado, só o aplicado avança o relógio dos fatos); o tempo move o registro (varredura idempotente); `billing_events` como caixa de entrada e razão numa tabela (um evento, uma linha); papel de escrita próprio, nunca o do tenant; "acima do limite Free" decidido no banco pelas mesmas contagens das escritas. |
| Domínio | Concluído | `billing/facts.ts` (`reconcileFact`, `dueTransition`, serialização e leitura dos fatos) com 28 testes (e um teste novo na máquina de estados para o reinício do trial), entre eles propriedades sobre sequências aleatórias: o registro fica coerente, o relógio dos fatos nunca volta e aplicar o mesmo fato duas vezes não o aplica duas vezes. |
| Banco | Concluído | Migration 0053: colunas de ciclo de vida em `organization_billing` (cancelamento ao fim do período, ciclo, ciclo pendente, último fato, provedor e referência únicos, com constraints), tabela `billing_events`, papéis `polaris_billing_owner` e `polaris_billing_runtime` e a função `organization_exceeds_free_limits`. |
| Servidor | Concluído | `billing-store.ts` (`recordEvent`, `processEvent`, `sweepDue`, `retryPending`, `startTrial`, `attachProvider`). |
| Gate PostgreSQL 18 | Concluído | `billing-lifecycle` (suítes `gate7`, `ci` e `all`) em branch Neon descartável: privilégios (o papel de billing não lê tabelas de tenant nem apaga; o tenant não escreve billing nem roda a função), oito entregas simultâneas de um evento viram uma linha, o trial do início à primeira cobrança com o razão de cada passo, falha de renovação, carência, recuperação e expiração pela varredura (idempotente), pagamento tardio que reativa, fato obsoleto ignorado, cancelamento e troca de ciclo, saída do Pro para `free_over_limit` ou `free`, dois fatos simultâneos sem atualização perdida, evento de organização desconhecida resolvido depois pelo reprocessamento, evento malformado com no máximo cinco tentativas, e o histórico visível só da própria organização. O gate `gate2-runtime` foi ajustado: as políticas de leitura do dono de billing em `products` e `product_variants` são verificadas à parte. Branch apagada depois. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura (privilégios, reconciliação, travas e razão). Os achados altos eram de correção do domínio e foram corrigidos: uma confirmação de pagamento atrasada atrás de um cancelamento ou troca de ciclo era descartada como obsoleta (agora o pagamento nunca é obsoleto e não desfaz um cancelamento posterior); a referência da assinatura só podia ser ligada uma vez e os fatos nunca conferiam a referência (agora uma assinatura que não está viva pode ser substituída e um fato de outra referência é ignorado como `reference_mismatch`). Também corrigidos: relógio dos fatos limitado ao presente; carência contada do fim do período pago, por mais tarde que a varredura ou a falha cheguem; falha da primeira cobrança que encerra o trial mesmo um pouco antes do nosso fim; método pronto que ultrapassa o opt-in; trial dispensado ao assinar sem ele; trial em preparação que pode ser reiniciado; reprocessamento com espera crescente; falhas da varredura e do reprocessamento registradas; tamanho da referência limitado no banco. Aceitos e documentados no ADR: sem estorno (PR84), a checagem de limite Free ignora concessões, a chave estrangeira do razão bloqueia o purge físico. |
| Verificação local | Concluída | `vitest run`, lint, `format:check`, `bun run typecheck`, knip, boundaries, build, `db:generate` sem drift; gate `billing-lifecycle` e os gates vizinhos em branch Neon descartável, apagada depois. |
| Limites | Registrados | Sem rota de webhook, sem adaptador e sem tela (PR B, PR77 a PR80); nada foi provado contra um provedor real e o plano exige o sandbox para o Gate 7; a varredura e o reprocessamento ainda não estão no cron. |

### PR79 (rota) e PR81 (manutenção) — rota de webhooks de billing, porta de adaptador e cron (implementação, revisão independente e verificações locais concluídas; publicação: ver PR)

Fecha a parte do PR79 e do PR81 que não depende de um provedor: o caminho público por onde os fatos chegam e o trabalho horário. Os adaptadores (PR77 e PR78) e o Gate 7 dependem das contas sandbox.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/billing-webhooks` sobre a `main` (PR #93, núcleo do ciclo de vida, já mesclado). |
| Decisões | Tomadas pelo projeto | [ADR 0063](../docs/adr/0063-rota-de-webhooks-de-billing.md): `POST /webhooks/billing/:provider` fora de `/api` e `/rpc` (provedor não é navegador; autentica por assinatura do adaptador); porta de adaptador pequena e sem banco (verifica, depois reduz a eventos); guardar uma vez e responder, processar depois da resposta (503 se não guardou, para o provedor reenviar); `BILLING_HYPERDRIVE` próprio; manutenção horária que reprocessa antes de varrer. |
| Servidor | Concluído | `routes/billing-webhooks.ts`, `billing/provider-adapter.ts` (`WebhookRejectedError`, `WebhookMalformedError`, a porta), `billing/adapters.ts` (registro **vazio**), `billing/maintenance.ts`, montagem no `app.ts` fora da checagem de origem, binding em `environment.ts` e `wrangler.jsonc`, cron do Worker com mídia e billing independentes. |
| Testes | Concluídos | 23 de unidade. Rota (14): guarda uma vez e responde antes de o processamento terminar, redelivery é entregue ao processamento na ordem, processamento adiado registrado sem mensagem, 401 sem dizer por quê, 200 para payload ilegível, para mais de 50 eventos e para entrega vazia, 404 para provedor sem adaptador, nome inválido ou nome herdado de objeto (`constructor`, `__proto__`), 503 sem binding, sem poder guardar, com guarda parcial e com falha inesperada do adaptador, corpo grande recusado por tamanho declarado, real e em partes sem tamanho declarado, limite em bytes e corpo entregue sem alteração (marca de ordem de bytes), e o caminho do webhook montado fora da checagem de origem. Manutenção (3): reprocessa antes de varrer, termina com erro se algo falhou, e roda a outra parte mesmo quando uma lança exceção. Cron do Worker (6): mídia e billing independentes (mídia não configurada, conexão que não abre, billing não provisionado, fechamento que falha, os dois falhando com `AggregateError`). |
| Revisão independente | Concluída | Sem achado crítico ou alto. Corrigidos: nome de provedor herdado de objeto (`constructor` virava 503; agora 404, com teste que falha sem a correção); corpo em partes sem tamanho declarado lido por inteiro antes do limite (agora contado no fluxo); 400 e 503 que fariam o provedor pausar o webhook (agora 200 com registro, exceto falha inesperada); redelivery nunca processado pela rota (agora processado na ordem); cron e manutenção que não cumpriam a independência prometida (exceção ao abrir ou fechar conexão, ou na primeira consulta); registro de mensagem de erro (agora só o nome); evento adiado sem registro (agora registrado); ADR e runbook alinhados ao comportamento. |
| Verificação local | Concluída | `bun run format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (146 arquivos, 1656 testes) e `build`; sem mudança de schema nem de migration, então `db:generate` e os gates em branch Neon não se aplicam a este PR (a rota não tem acesso a banco além do repositório já provado no PR #93). |
| Limites | Registrados | **Nenhum webhook é aceito ainda**: o registro de adaptadores está vazio até o PR77 e o PR78; nada foi provado contra um provedor real; a rota não tem limite de taxa próprio; o cron não foi exercitado em Cloudflare (implantação adiada pelo responsável). |

### PR82 — Free acima do limite: variantes operacionais (implementação, gates, revisão independente e verificações locais concluídos; publicação: ver PR)

Quem sai do Pro com mais variantes do que o Free permite mantém todas; só as variantes escolhidas (ou as vendidas mais recentemente, se não escolheu) recebem nova venda ou entrada de estoque. A tela de escolha vem com o PR80.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/operational-selection` sobre a `main` (PR #94). |
| Decisões | Tomadas pelo projeto | [ADR 0064](../docs/adr/0064-free-acima-do-limite-variantes-operacionais.md): escolha em tabela própria (nada de `plan_locked` na variante); venda e entrada de estoque bloqueadas, correções e cancelamentos não; sete dias de adequação com tudo operacional, depois a escolha só cresce (anti-rotação); padrão gravado uma vez, por vendas até o fim da janela; início da janela é o fim do acesso Pro, mantido durante um checkout de trial abandonado; sem início gravado, a varredura data o registro pelo fim da concessão ([ADR 0067](../docs/adr/0067-concessoes-temporarias-de-entitlement.md)). |
| Domínio | Concluído | `billing/operational-selection.ts` (fases, início do episódio, plano de mudança da escolha, escolha padrão, erros), 18 testes. |
| Banco | Concluído | Migration 0054: `organization_billing.over_limit_since` (grant de UPDATE só ao papel de billing, check de coerência) e `operational_variant_selections` (RLS com FORCE, sem UPDATE para o tenant, FK para a variante). |
| Servidor | Concluído | `operational-selection-repository.ts` (`assertVariantsOperational`, `readOperationalSelection`, `selectOperationalVariants`); aplicada em `confirmSale` e na entrada de estoque; `billing-store.ts` grava/mantém/limpa `over_limit_since`; recusa vira `entitlement_changed` no comando offline; RPC `plan.operationalSelection` e `plan.selectOperationalVariants` (9 testes de roteador). |
| Gate PostgreSQL 18 | Concluído | `operational-selection` (suítes `gate7`, `ci` e `all`): Pro nunca restrito; janela aberta deixa tudo operacional; escolha validada, trocada e auditada; venda com uma variante de fora recusada inteira sem escrever; entrada recusada; replay, contagem, baixa e cancelamento permitidos; congelada não troca nem remove e cresce só dentro do limite; excluir libera a vaga; voltar ao limite libera tudo; padrão por vendas gravado uma vez sob concorrência; episódio anterior substituído; sem início gravado, a varredura data pelo fim da concessão (a janela não é tratada como aberta até lá); início datado pelo fim do acesso (igual antes e depois da varredura), mantido no checkout de trial e limpo ao voltar o Pro; privilégios e RLS. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura. O achado alto foi corrigido: abandonar um checkout de trial apagava o episódio e a escolha (o limite só era recalculado a partir de estados Pro; agora é recalculado em todo estado e o episódio é mantido). Também corrigidos: registro sem início que ganhava janela nova ao abrir um trial; escolha acima do limite depois de uma concessão expirar (agora limitada, preservando as primeiras escolhidas); custo da checagem para Free comum (agora uma consulta); variantes de produto arquivado no fim do padrão; violação de chave estrangeira numa corrida com a reconfiguração de variantes (agora `variant_unavailable`). Aceitos e documentados no ADR: Free comum acima do limite sem episódio (PR85), gravação do padrão desfeita por uma recusa e leitura que escreve, regra "só cresce" só no comando, carência que substitui o episódio. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (148 arquivos, 1683 testes), `build` e `db:generate` sem drift; gates `operational-selection`, `entitlements`, `sync-push`, `offline-sale`, `inventory`, `gate2-runtime`, `billing-catalog` e `billing-lifecycle` em branch Neon descartável (apagada depois). |
| Limites | Registrados | Sem tela de escolha nem convite ao Pro (PR80); efeitos do downgrade sobre catálogo público, lease offline, imagens e metas são o PR83; o catálogo público ainda não existe; sem exportação específica do excedente. |

### PR83 — Efeitos do downgrade: metas pausadas (implementação, gate, revisão independente e verificações locais concluídos; publicação: ver PR)

Fecha os efeitos do downgrade que cabem hoje: as metas excedentes ficam pausadas. Lease offline e restrição de novas imagens já existiam (ADR 0058) e o catálogo público ainda não existe.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/downgrade-effects` sobre a `main` (PR #95). |
| Decisões | Tomadas pelo projeto | [ADR 0065](../docs/adr/0065-efeitos-do-downgrade-metas-pausadas.md): meta pausada é derivada do limite em vigor (as mais antigas rodam, as mais novas pausam), nunca guardada; pausada não é medida nem editada e pode ser cancelada; a de período vencido nunca é pausada (a leitura a liquida); meta que ainda não começou fica depois das que começaram; lease e imagens já cobertos (ADR 0058); catálogo público fica como regra para a Fase 8 (lido do plano a cada pedido). |
| Domínio | Concluído | `goals/goal.ts` (`pausedGoalIds`, `GoalPausedByPlanError`), 6 testes novos. |
| Servidor | Concluído | `goal-repository.ts` (`listPausedGoalIds`; `updateGoal` recusa meta pausada; `evaluateActiveGoals` não mede pausada); contrato: `paused` por meta (o contrato só cresce); roteador mapeia `goal_paused_by_plan` para conflito. |
| Interface | Concluída | A meta pausada mostra "Pausada pelo plano" com o motivo, sem progresso e sem o botão de editar; cancelar continua. |
| Testes | Concluídos | Domínio (6), roteador (a lista informa a meta pausada; o erro vira conflito) o texto do erro (1) e o gate `entitlements` (passos novos 6b e 6c: o 6c prova que uma meta de período vencido não ocupa lugar e é liquidada pela leitura; 6b: nada pausado no Pro; após o downgrade a mais antiga roda e as outras pausam; editar a pausada é recusado e a que roda pode ser editada; a pausada não é medida; cancelar uma pausada e depois a que roda move a próxima). |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura. Corrigidos: uma meta de período vencido ocupava um lugar e a meta em andamento aparecia sem progresso e sem pausa na primeira leitura (agora a de período vencido não ocupa lugar nem é pausada); meta que ainda não começou tomava o lugar da meta do período em curso (agora fica depois das que começaram); texto de erro que dizia "mudou em outra solicitação" para uma meta pausada (agora tem texto próprio); fixture do e2e sem `paused`; limite não finito (agora pausa tudo de forma explícita). Aceitos e documentados no ADR: a meta pausada que volta a rodar é medida desde o início do período e pode concluir na hora; a liquidação não relê a pausa (janela mínima). |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (148 arquivos, 1691 testes), `build` e `db:generate` sem drift; gates `goals` e `entitlements` (com os passos 6b e 6c) em branch Neon descartável, apagada depois. |
| Limites | Registrados | O catálogo público não existe (a regra de despublicar vale quando ele existir, Fase 8); sem tela de plano nem convite ao Pro (PR80); a pausa não tem aviso fora do cartão da meta. |

### PR84 — Reembolso e chargeback (implementação, gate, revisão independente e verificações locais concluídos; publicação: ver PR)

Fecha o ciclo de vida do billing no que não depende de um provedor: dinheiro devolvido ou contestado tira o Pro, e a reversão o restaura.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/refund-chargeback` sobre a `main` (PR #97). |
| Decisões | Tomadas pelo projeto | [ADR 0066](../docs/adr/0066-reembolso-e-chargeback.md): três fatos que nomeiam o período (`charge_refunded` integral, `charge_disputed`, `dispute_reversed`); só o período em vigor conta; efeito imediato e sem carência (evento `access_revoked`); o pagamento tirado fica registrado (impede a confirmação tardia de reviver o acesso e permite restaurar); reversão restaura até o fim do período com o ciclo que tinha; fatos de dinheiro nunca são obsoletos. |
| Domínio | Concluído | `billing/facts.ts` (os fatos, `revokePayment`, `disputeReversed`, `RevokedPayment`, serialização e leitura) e `billing/subscription-state.ts` (`access_revoked`): 18 testes novos (inclui as propriedades sobre sequências aleatórias com os fatos novos: o registro continua coerente e repetir um fato não o aplica duas vezes). |
| Banco | Concluído | Migration 0055: colunas `revoked_through`, `revoked_reason`, `revoked_cycle_months` e `revoked_cancel_at_period_end` em `organization_billing` (grant de UPDATE só ao papel de billing, check de coerência) e os três tipos de fato aceitos na caixa de entrada. |
| Servidor | Concluído | `billing-store.ts` lê e grava o pagamento tirado. |
| Gate PostgreSQL 18 | Concluído | `billing-lifecycle` (seção 12): reembolso integral remove o acesso na hora e fica no razão; redelivery é um efeito; repetição não se aplica; a confirmação tardia do pagamento reembolsado é ignorada e um pagamento novo revive e esquece; reembolso de período anterior não muda nada; reembolso entregue atrás de fato mais novo ainda vale; chargeback imediato, em carência também; reversão restaura fim e ciclo e o tempo corre depois; reversão depois do fim do período só esquece; reversão sem chargeback é `not_applicable`; reembolso antes da confirmação da cobrança (em registro Free e em trial) é lembrado e a confirmação não concede; reversão antes do chargeback faz o chargeback não mudar nada; reembolso depois de chargeback impede a restauração; nova referência de assinatura começa limpa. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura achou três altos e cinco médios, todos tratados: reembolso ou chargeback entregue antes da confirmação da cobrança era descartado e a confirmação concedia Pro (agora o pagamento é lembrado, em registro Free e em trial); um pagamento tirado de um plano anual bloqueava uma nova assinatura mensal (agora o registro é apagado quando a referência da assinatura muda); reembolso depois de chargeback deixava a reversão restaurar (agora o reembolso vence); fim de período sem limite (agora até 400 dias); reversão antes do chargeback tirava o Pro para sempre (agora é lembrada); igualdade exata do fim do período (agora a tolerância de um dia); renovação paga antes do fim do período reembolsada derrubava o período em vigor (agora só conta o período que bate); restauração perdia o cancelamento (agora é guardado). Documentados no ADR: renovação reembolsada antes da confirmação com o registro ainda num período pago, carência restaurada, nova janela de adequação a cada retirada. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (148 arquivos, 1709 testes), `build` e `db:generate` sem drift; gates `billing-lifecycle`, `billing-catalog`, `gate2-runtime`, `operational-selection` e `sync-push` em branch Neon descartável criada do zero com a migration 0055 (apagada depois). |
| Limites | Registrados | Nenhum adaptador reporta esses fatos ainda (PR77 e PR78, sandbox); reembolso parcial não é fato; sem tela; os fatos trazem a referência da assinatura (o adaptador a informa) e o armazenamento a confere: sem ela, ou com a de outra assinatura, o fato não tem efeito (`reference_mismatch`; todos os fatos, não só estes: ver a seção "Referência do provedor em todos os fatos de cobrança").

### Revisão pós-merge do PR #98 (reembolso e chargeback): reversão antes do chargeback e ciclo desconhecido

Uma revisão feita depois do merge achou duas falhas (nenhum adaptador está registrado, então nada chegou a usuários), corrigidas aqui antes do PR77 e do PR78.

| Item | Status | Evidência |
| --- | --- | --- |
| Reversão antes do chargeback com assinatura ativa era ignorada (médio) | Corrigido | A reversão é lembrada como `won` em qualquer estado (período à frente, ou terminado há menos de sete dias, para a carência); a constraint do banco passou a aceitar `won` sobre um período pago (migration 0056); `won` é mantido por renovações e por transições de estado; o chargeback que vem depois não muda nada, e um reembolso do mesmo período ainda tira o acesso. Testes de domínio e passo novo no gate `billing-lifecycle` com a assinatura ativa. |
| Ciclo `?? 1` ao restaurar (baixo) | Corrigido | O ciclo de um chargeback registrado antes da cobrança é aprendido da confirmação recusada; sem ciclo conhecido a reversão só esquece o chargeback (não restaura com ciclo presumido). Testes e passo no gate. |
| O CI roda o gate `billing-lifecycle`? | Sim | O job "PostgreSQL 18 gates" roda `gates:ci` (suíte `ci`), que inclui `billing-lifecycle`, `entitlements` e `operational-selection`. |
| Algum DTO devolve `revoked_*` ao tenant? | Não | Nenhuma rota nem contrato lê essas colunas: `billing-repository` e `operational-selection-repository` selecionam só estado, fim do acesso e início do episódio. As colunas são legíveis pela própria organização na tabela (grant de SELECT da tabela), mas o tenant não tem SQL próprio; restringir o SELECT por coluna fica como endurecimento opcional. |
| Revisão independente da correção | Concluída sem Critical nem alto | Uma segunda leitura, somente de leitura, conferiu o desenho e achou dois pontos, corrigidos: uma reversão para um período já terminado empurrava para fora a de um período ainda à frente (agora uma vitória nunca desloca outra de período posterior, e período terminado só importa a quem está em carência) e os testes de propriedade nunca partiam de um registro com memória (agora partem de todos os tipos, com períodos tirados de um conjunto pequeno para que reembolso, chargeback e reversão se encontrem). Também: aprender o ciclo de uma confirmação recusada não move mais o relógio dos fatos; a vitória guardada não carrega ciclo nem cancelamento (coerência); sondas diretas no gate provam que o banco ainda recusa reembolso ou chargeback lembrado sobre um período pago. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (148 arquivos, 1714 testes), `build` e `db:generate` sem drift; gates `billing-lifecycle`, `billing-catalog`, `gate2-runtime` e `sync-push` em branch Neon criada do zero com a migration 0056 (apagada depois). |

Mesclado no [PR #99](https://github.com/camilagama/polaris/pull/99) (merge `ae3c729`).

### PR85 — Concessões temporárias de entitlement (implementação, gate, revisão independente e verificações locais concluídos; mesclado no PR #102)

Dá a Polaris (e, na Fase 9, ao Admin) uma forma de conceder mais do que o plano por um tempo, sem assinatura falsa, e fecha a lacuna do PR82 para quem passa do limite do Free quando a concessão termina.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/entitlement-grants` sobre a `main` (PR #99). |
| Decisões | Tomadas pelo projeto | [ADR 0067](../docs/adr/0067-concessoes-temporarias-de-entitlement.md): só o papel de billing escreve (comandos `grantEntitlement` e `revokeEntitlementGrant`); sempre autor, motivo, início e fim, até 366 dias; só eleva; nunca muda o estado de assinatura; idempotente por ID; razão sem o motivo; o fim de uma concessão de limite abre a janela de adequação (ADR 0064) para quem passa do limite Free. |
| Domínio | Concluído | `billing/grants.ts` (`normalizeGrant`, limites, `InvalidEntitlementGrantError`) e o início (`startsAt`) na resolução dos entitlements: 7 testes novos. |
| Banco | Concluído | Migration 0057: `granted_by`, `starts_at`, `revoked_at` e `revoked_by` em `entitlement_grants`, checks de autor, período (início antes do fim, no máximo 366 dias) e encerramento, índice por fim, o acesso do papel de billing (inserir, encurtar a vigência; sem apagar nem editar o resto) com as políticas de linha, o gatilho "só encurta" (o fim nunca avança, uma concessão encerrada não volta) e a função `organization_free_limit_excess` (quais limites Free a organização ultrapassa, por chave). |
| Servidor | Concluído | `billing-store.ts`: `grantEntitlement`, `revokeEntitlementGrant` e a varredura das concessões de limite que terminaram dentro de `sweepDue`; `readGrants` lê o início. |
| Gate PostgreSQL 18 | Concluído | `entitlement-grants` (suítes `gate7`, `ci` e `all`): privilégios (o tenant não escreve; o billing só insere e encurta); recusas no comando e no banco; concessão eleva sem virar assinatura e sem tocar o estado; mesmo ID é uma concessão; razão sem o motivo; início e fim; encerramento antecipado; o fim de uma concessão de limite abre a janela uma vez, dá janela nova a quem já estava acima do limite e deixa em paz quem ainda tem concessão, quem está dentro do limite e quem paga. Os gates que inserem concessões (catálogo, entitlements, metas, variantes operacionais) passaram a informar o autor. |
| Revisão independente | Concluída sem Critical | Uma leitura independente e somente de leitura achou um alto e seis médios, todos tratados: a varredura podia deixar sem exame o fim mais novo atrás de candidatos que não precisavam de nada (agora vem do mais novo para o mais antigo e já exclui quem paga, quem monta um trial e quem já passou daquele fim); "só encurta" não era garantido pelo banco (agora um gatilho: o fim nunca avança e uma concessão encerrada não volta, para qualquer papel); encerrar uma concessão podia estendê-la ou deixá-la valendo um segundo (agora o encerramento nunca avança o fim e uma concessão encerrada antes de começar nunca vale); o teste de "ainda em vigor" ignorava a chave (agora é por limite, com a função `organization_free_limit_excess`); o mesmo ID com valores diferentes era descartado em silêncio (agora é recusado). Também: mínimo de um minuto, início até um ano à frente, autor sem e-mail, motivo sem caractere nulo, códigos de erro corretos e organização inexistente. Documentados no ADR: janela nova não carrega a escolha anterior, intervalo até a varredura, Pro com concessão acima do plano. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (149 arquivos, 1721 testes), `build` e `db:generate` sem drift; gates `entitlement-grants`, `billing-lifecycle`, `billing-catalog`, `entitlements`, `goals`, `operational-selection` e `gate2-runtime` em branches Neon criadas do zero com a migration 0057 (apagadas depois). |
| Limites | Registrados | Sem tela de Admin (Fase 9): os comandos são a interface; a varredura olha 90 dias para trás; a checagem de excedente ignora outras concessões ainda não iniciadas. |
| Publicação | Concluída | [GitHub PR #102](https://github.com/camilagama/polaris/pull/102) mesclado na `main` (merge `da50b20`). |

### Ajustes da revisão pós-merge do #99 (issue #101): ADR 0066, comentários e uma CHECK

A revisão pós-merge do PR #99 (aprovada com ajustes; nada bloqueava) pediu cinco ajustes e deixou três pontos em aberto. Os cinco ajustes estão aqui; o endurecimento do SELECT por coluna é o PR seguinte.

| Item da issue | Status | Evidência |
| --- | --- | --- |
| ADR 0066: "nunca sobre um período pago" e "apaga o registro" contradiziam o `won` | Corrigido | O ADR agora diz que reembolso e chargeback nunca ficam guardados sobre um período pago, que o `won` é a única memória que pode ficar (sem ciclo nem cancelamento) e que um pagamento novo apaga o registro de reembolso ou chargeback, mas não o `won`. |
| "Limites aceitos" do ADR 0066 | Corrigido | Acrescentados: o `won` permanece depois do fim do período; só um período fica lembrado por vez; o que o banco garante e o que só o domínio garante. |
| Comentários desatualizados (`schema/billing.ts`, `RevokedPayment`, `BillingRecord.revoked`) | Corrigido | Textos reescritos para o que o código faz. |
| `rememberableWonEnd`: "só em carência" não batia com o código | Corrigido (texto) | A condição está certa (vale para `active` e `grace`, período terminado há até sete dias, que é onde a carência se apoia ou vai se abrir); o comentário e o ADR passaram a dizer isso. |
| A CHECK não forçava ciclo nulo e cancelamento falso no `won` | Corrigido | Migration 0058: a CHECK exige os dois; o gate `billing-lifecycle` prova com sondas diretas que o banco recusa. |
| PR separado para restringir o SELECT de `revoked_*` por coluna | Próximo PR | Aceito pelo time; sem alteração aqui. |
| "PostgreSQL 18 gates" com `continue-on-error: true` (ADR 0025) | Decisão do responsável | Recomendação registrada na descrição do PR: o job passou em todos os PRs desta cadeia e cada falha que ele mostrou era um defeito real (a auditoria de funções do `review-hardening`, uma corrida de milissegundos na revogação de concessões). Tirar o `continue-on-error` é uma linha no workflow, mas é uma decisão sobre bloquear ou não o merge. |
| Nenhum DTO devolve `revoked_*`? (não verificado pelo bot) | Verificado | Nenhum contrato nem rota lê essas colunas (`billing-repository` e `operational-selection-repository` selecionam só estado, fim do acesso e início do episódio; `billing-store` só roda no papel de billing). O SELECT por coluna do PR seguinte torna isso uma garantia do banco. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, testes, `build` e `db:generate` sem drift; gates `billing-lifecycle`, `review-hardening` e `gate2-runtime` em branch Neon criada do zero com a migration 0058 (apagada depois). |

Mesclado no [PR #103](https://github.com/camilagama/polaris/pull/103) (merge `f32cfed`).

### SELECT por coluna do registro de billing e das concessões (ponto em aberto da revisão do #99)

Fecha o ponto "restringir o SELECT de `revoked_*` por coluna" da issue #101 e transforma a verificação de que nenhum DTO devolve essas colunas numa garantia do banco.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Decisão | Tomada pelo projeto | Emenda ao [ADR 0057](../docs/adr/0057-catalogo-de-planos-e-entitlements.md): o tenant lê só colunas nomeadas; colunas novas nascem invisíveis. Foi além do pedido no mesmo espírito: também ficam fora do tenant a referência da assinatura no provedor, o relógio dos fatos e, nas concessões, o motivo, quem deu e quem encerrou. |
| Banco | Concluído | Migration 0059: `REVOKE SELECT` da tabela e `GRANT SELECT` por coluna ao papel do tenant em `organization_billing` e `entitlement_grants`. |
| Código | Sem mudança | Os repositórios já selecionavam colunas nomeadas. |
| Gate PostgreSQL 18 | Concluído | `entitlement-grants`: o tenant é recusado (`42501`) ao ler cada coluna interna e com `SELECT *`, e ainda lê as colunas que o produto usa; os gates de entitlements, metas, variantes operacionais, catálogo, lifecycle, runtime, auditoria e sync passaram na mesma branch descartável. |
| Publicação | Concluída | [GitHub PR #104](https://github.com/camilagama/polaris/pull/104) mesclado na `main` (merge `71ba4f5`). |

### CI: o job de banco deixa de ser consultivo

Cumpre o item "promover os jobs consultivos `database` e `audit` a checks obrigatórios depois de um histórico verde" (linha de pendências do Gate 4), só para o `database`: o job "PostgreSQL 18 gates" perdeu o `continue-on-error` (emenda ao [ADR 0025](../docs/adr/0025-estrategia-de-testes-de-banco.md)). A auditoria de dependências segue consultiva. A proteção de branch que torna o check obrigatório para o merge é do responsável.

Mesclado no [PR #105](https://github.com/camilagama/polaris/pull/105) (merge `f988872`).

### Referência do provedor em todos os fatos de cobrança (POL-21, parte 2; implementação, gate e verificações locais concluídos; publicação: ver PR)

Segue o PR #133: a conferência que o reembolso, o chargeback e a reversão já tinham passa a valer para todos os fatos do provedor, e o `reference_mismatch` deixa de ser silencioso ([ADR 0087](../docs/adr/0087-referencia-do-provedor-em-todos-os-fatos-de-cobranca.md); o número pode mudar).

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `fix/billing-provider-ref-all-facts` sobre a `main` (migration 0074, só aditiva; o PR #126 ainda usa 0072, e quem entrar depois renumera). |
| Servidor | Concluído | `billing-store.ts`: todo fato exige `provider` e `provider_ref` iguais aos do registro; só `attachProvider` liga a referência (o fato deixa de ligá-la); o fato com referência para um registro sem assinatura ligada falha com `unknown_organization` e espera o reprocessamento; o que ainda não achou assinatura na última tentativa é incidente (`reference_unresolved`). |
| Banco | Concluído | `operational_incidents` aceita `billing_reference_mismatch` (causas `reference_mismatch` e `reference_unresolved`, assunto `billing.<tipo do fato>`); função `record_billing_reference_incident` (dono do outbox; o login do billing só a executa), chamada na mesma transação do desfecho; só causa, tipo do fato e ID opaco do evento. |
| Gate PostgreSQL 18 | Local e CI | `billing-lifecycle` (seção 13): para cada um dos oito fatos, sem referência, referência de outra assinatura, de outro provedor, antes da ligação e o caso válido; a referência ligada a outra organização; a ordem entre webhook e ligação (nos dois sentidos); o fato que nenhuma assinatura reivindica virando incidente na última tentativa; privilégios da função e da tabela. |
| Limites | Registrados | O fato que espera a ligação é tentado cinco vezes (cerca de duas horas e meia); o incidente conta por tipo de fato e não se encerra; nenhum adaptador chama `attachProvider` ainda (PR77 e PR78). |

### Fase 8A — catálogo público: dados, comandos e leitura por funções (PR87 e PR88; implementação, gate, revisão independente e verificações locais concluídos; mesclada no PR #106)

A Fase 8 passa a ser implementada antes do Gate 7 ([ADR 0068](../docs/adr/0068-fase-8-antes-do-gate-7.md)), que segue pendente das contas sandbox. Este pull request é só a camada de dados e de comandos; a aplicação `apps/catalog` (8B), a rota pública de mídia e a despublicação (8C) e as telas do ERP (8D) vêm depois.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/public-catalog-data` sobre a `main` (migration 0060). |
| Decisões | Tomadas pelo projeto | [ADR 0069](../docs/adr/0069-catalogo-publico-leitura-por-funcoes.md): perfil digitado (nunca derivado do dono), publicação por produto sem cópia de dados, papel público sem acesso a tabelas e com quatro funções, plano lido a cada chamada com a regra do motor de entitlements. Regras em [public-catalog.md](../docs/business-rules/public-catalog.md). |
| Domínio | Concluído | `catalog/public-catalog.ts` (endereço, nomes reservados, perfil, caracteres ocultos) e a capability `catalog:publish`. |
| Banco | Concluído | Migration 0060: `public_catalog_profiles` e `product_publications` (FORCE RLS, grants por coluna), papéis `polaris_catalog_owner` e `polaris_catalog_runtime`, leitura por coluna e políticas do dono das funções, duas funções internas e quatro públicas (`public_catalog_profile`, `_products`, `_product`, `_media`). |
| Repositório do tenant | Concluído | `public-catalog-repository.ts`: perfil por versão, interruptor, publicar e despublicar produtos (só com o plano para o que expõe), auditoria por produto. |
| Gate PostgreSQL 18 | Concluído | `public-catalog` (suítes `gate8`, `ci` e `all`): o papel público não lê tabela nem executa os auxiliares; o tenant não executa as funções; Free recusado; endereço único, reservados (lista inteira no banco), versão e corrida de dois primeiros salvamentos; paginação, preços e rótulos; chaves exatas sem ID da organização, custo, estoque ou SKU; arquivado, removido e despublicado não saem; downgrade, conta suspensa e encerrada não saem sem escrita; paridade com o motor de entitlements em 54 combinações de estado de billing e concessão; isolamento entre organizações; auditoria por produto. Também passaram na mesma branch Neon: `review-hardening`, `gate2-runtime`, `entitlements`, `billing-catalog`, `billing-lifecycle`, `operational-selection`, `entitlement-grants` e `media-commands`. |
| Revisão independente | Concluída sem Critical | Achou um alto e três médios, tratados: os gates `gate2-runtime` e `tenant-context` fixavam a lista exata de políticas (agora ignoram as do dono das funções); `storageKey` contém o prefixo da organização (documentado: só o servidor a vê, nunca o navegador); dois primeiros salvamentos simultâneos viravam erro cru (agora conflito de versão); a auditoria não dizia qual produto (agora um evento por produto). Também tratados: leitura da tela sem trava, ID de produto inválido, relógio ao despublicar, caracteres ocultos, auditoria de repetição e lacunas do gate. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (150 arquivos, 1728 testes), `build` e `db:generate` sem drift. O gate `poc:tenant:verify` (que não está no runner) recebeu só o filtro das políticas e não foi executado. |
| Limites | Registrados | Endereço antigo liberado na troca; ordem pelo ID do produto (UUIDv7); sem tela (8D) nem aplicação pública (8B); o teste de propriedade de `facts.test.ts` foi ajustado por uma falha intermitente sem relação (um pagamento que só aprende o ciclo não tem transição). |
| Publicação | Concluída | [GitHub PR #106](https://github.com/camilagama/polaris/pull/106) mesclado na `main` (merge `766f2b7`). |

### Fase 8B — aplicação do catálogo público e SEO (PR86 e PR90; implementação, verificação no navegador e verificações locais concluídos; mesclada no PR #107)

Segunda etapa da Fase 8 ([ADR 0068](../docs/adr/0068-fase-8-antes-do-gate-7.md) e [0069](../docs/adr/0069-catalogo-publico-leitura-por-funcoes.md)): a primeira aplicação aberta a quem não tem conta.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/catalog-app` sobre a `main` com a 8A (#106). |
| Aplicação | Concluída | `apps/catalog`: TanStack Start no Cloudflare Workers (`@cloudflare/vite-plugin` com ambiente `ssr`), páginas `/`, `/<endereço>` (grade com cursor) e `/<endereço>/p/<produto>`, `robots.txt`, 404 único para loja ou produto que não está sendo exibido. Ver [DESIGN.md](../DESIGN.md). |
| Leitor | Concluído | `@polaris/db/public-catalog-reader`: as quatro funções, uma conexão por pedido, endereço em minúsculas, ID e cursor inválidos viram `null`, página limitada a 60. Coberto no gate `public-catalog`. |
| SEO | Concluído | Título, descrição (com texto de reserva), endereço canônico a partir de `CATALOG_ORIGIN`, Open Graph e Twitter; 8 testes unitários (`seo.test.ts`). Sem imagem de pré-visualização até a rota de mídia (8C). |
| Fronteiras | Concluídas | Biome e 5 fixtures novas em `verify-import-boundaries`: o app só importa o leitor (nada de `@polaris/db/*` tenant, billing, auth, `pg` nem Drizzle). Knip configurado para as rotas. |
| Verificação no navegador | Concluída | Servidor local contra uma branch Neon descartável, com o login do papel público: loja, produto com variantes e preços, endereço em maiúsculas, 404 de loja inexistente, de ID e de cursor inválidos, `robots.txt`, título e metas no HTML, tela de 375 px. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test`, `build` (inclui `vite build` do app) e o gate `public-catalog` de novo em Neon. |
| Limites | Registrados | Sem imagens (8C), sem cache de borda (8C decide o TTL), sem `sitemap.xml` (não há função que liste lojas; um sitemap por loja pode vir depois), páginas com `?after=` repetem o canonical da primeira (e um cursor que já não existe mostra "sem produtos"); o script de ciclos ignora o arquivo gerado `routeTree.gen.ts`; `CATALOG_ORIGIN` precisa ser definida por ambiente (sem ela o Worker falha em vez de publicar um endereço de desenvolvimento); Hyperdrive real e login do papel público são do go-live (runbook). Sem teste automatizado de navegador do app (a verificação foi manual). |
| Publicação | Concluída | [GitHub PR #107](https://github.com/camilagama/polaris/pull/107) mesclado na `main` (merge `cf78d79`). |

### Fase 8C — rota pública de imagens e despublicação (PR89 e PR91; implementação, verificação no navegador e verificações locais concluídos; mesclada no PR #108)

Terceira etapa da Fase 8: as imagens do catálogo público, sem abrir o bucket.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/catalog-media` sobre a `main` com a 8B (#107). |
| Rota | Concluída | `/<endereço>/m/<produto>/<imagem>` (`?s=320` ou `640`): valida a entrada (sem conexão se não for endereço ou UUID), pergunta à base se a imagem pode ser exibida **agora**, lê o derivado (ou o original, até o ERP gerá-lo) do bucket privado e responde com `Cache-Control` de 60 s, `ETag` e 304. Falha de autorização ou do bucket é uma resposta genérica sem detalhe; a chave de armazenamento nunca sai. 10 testes (`media.test.ts`). |
| Despublicação (PR91) | Concluída | Não há purge: a base é consultada a cada pedido (produto, loja, plano, conta), então despublicar, sair do plano ou encerrar a conta para de servir no pedido seguinte; só caches do navegador e da borda duram até um minuto ([ADR 0069](../docs/adr/0069-catalogo-publico-leitura-por-funcoes.md)). |
| Páginas e SEO | Concluídos | Capa nos cartões, galeria na página do produto (largura e altura declaradas), `og:image` e `twitter:image` absolutos, cartão grande quando há imagem. |
| Domínio | Concluído | `mediaDerivativeKey` e os tamanhos dos derivados passaram para `@polaris/domain/catalog/media`, compartilhados pelo ERP (rota e reconciliador, sem mudança de comportamento) e pelo catálogo. |
| Verificação no navegador | Concluída | Servidor local contra Neon descartável e R2 local: original e derivado ausente, `304`, tamanho inválido, imagem de outro produto (`404`), metas `og:image` no HTML. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test`, `build` e `bun install --frozen-lockfile`. |
| Limites | Registrados | O binding R2 do Worker público não pode ser somente leitura (só `get` é usado); o Worker não gera derivados e os derivados passam a ser gerados no envio pelo ERP (ver a seção abaixo); um teste de navegador automatizado do app continua pendente. |
| Publicação | Concluída | [GitHub PR #108](https://github.com/camilagama/polaris/pull/108) mesclado na `main` (merge `42a4427`). |

### Derivados de imagem gerados no envio (fecha o limite da 8C)

A revisão da 8C notou que nada gerava os derivados de 320 e 640 px, então o catálogo público serviria o original de até 1200 px nos cartões e no `og:image`. O ERP agora gera os dois derivados quando a imagem é enviada (`storeUploadDerivatives`, em `apps/web/src/server/routes/media.ts`): depois de o envio ser confirmado e só se não for um reenvio idempotente, um tamanho de cada vez, com a mesma chave e a mesma função do pedido sob demanda. Uma falha é registrada (`media_derivative_deferred`) e **não** falha o envio: o derivado nasce no primeiro pedido do ERP, como antes. A limpeza horária já apagava os derivados junto da imagem. Testes: o envio escreve a marca, o original e os dois derivados (chaves conferidas), um derivado que falha não derruba o envio, o reenvio não gera nada. Imagens enviadas antes (só ambientes de teste) seguem servidas em tamanho original. Regras em [media.md](../docs/business-rules/media.md), decisão no [ADR 0069](../docs/adr/0069-catalogo-publico-leitura-por-funcoes.md).

Mesclado no [PR #109](https://github.com/camilagama/polaris/pull/109) (merge `2f1c545`).

### Fase 8D — o catálogo público no ERP: perfil, interruptor e produtos (PR87 e PR88, lado da organização; implementação e verificações locais concluídas; mesclada no PR #110)

Última etapa da Fase 8: a organização passa a gerir o catálogo pela interface, sem comandos manuais.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/catalog-erp` sobre a `main` com 8A a 8C e os derivados no envio. |
| Contrato e servidor | Concluídos | `publicCatalog.*` (`setup`, `saveProfile`, `setPublished`, `publishProducts`, `unpublishProducts`) com a capability `catalog:publish`, identidade e organização da sessão (nunca do corpo), ID de auditoria do servidor e a origem pública (`CATALOG_ORIGIN`) só para montar o link. Recusas do domínio viram `BAD_REQUEST` ou `CONFLICT` com o motivo estável. 11 testes de roteador. |
| Tela | Concluída | `/public-catalog` ("Catálogo público" no menu): perfil, interruptor e produtos, com o endereço sugerido pelo nome, contador da descrição, estados "No ar", "Fora do ar" e "Ligado, mas fora do ar" (plano), lotes de até 200 produtos, mensagens em português ([DESIGN.md](../DESIGN.md)). Modelo, mensagens de erro e os três painéis têm testes (`public-catalog-model`, `-errors`, `-panels`). |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (156 arquivos, 1782 testes), `build`. |
| Limites | Registrados | A tela não foi aberta no navegador (o login do ERP exige conta; foi coberta por testes de renderização dos painéis e de roteador); sem teste de navegador automatizado; sem pré-visualização do catálogo dentro do ERP (há o link). |
| Publicação | Concluída | [GitHub PR #110](https://github.com/camilagama/polaris/pull/110) mesclado na `main` (merge `94740f3`). |

Com isso a Fase 8 está completa no código. Pendências da fase: o Gate 7 (billing com sandboxes reais) segue como gate de saída do billing, e o go-live exige o login do papel público, o Hyperdrive sem query cache e as variáveis por ambiente (runbook).

### Fase 9A — Admin: acesso pelo Cloudflare Access, principal de plataforma e capacidades (PR92, PR93 e PR94; implementação, gate, revisão e verificações locais concluídos; mesclada no PR #111)

Primeira etapa da Fase 9 ([ADR 0070](../docs/adr/0070-admin-acesso-identidade-e-capacidades.md)): a pergunta "quem opera o Polaris e o que pode" passa a ter uma resposta verificada.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/admin-access` sobre a `main` com a Fase 8 (migration 0061). |
| Verificação do Access (PR92) | Concluída | `apps/admin/src/access-jwt.ts`: RS256 contra as chaves do time (cache e renovação), emissor, audiência, validade com tolerância, `sub`, tipo `app`; recusa `none`, HS256, outro emissor ou audiência, expirado, adulterado, chave desconhecida, token de serviço. 17 testes com chaves RSA reais (mais 12 da API). |
| API do Admin | Concluída | `apps/admin/src/app.ts` e `worker.ts` (Hono, `wrangler.jsonc`): `/health` sem login, `/api/whoami` com a capacidade `platform:read`; sem configuração, 503; sem token, 401; login que não é principal, 403; `no-store` e demais cabeçalhos; chaves ou banco fora do ar são 503. `wrangler deploy --dry-run` no build. |
| Principal de plataforma (PR93) | Concluído | Tabela `platform_principals` (emissor e subject únicos, papel e estado validados, e-mail só como rótulo), papel de banco `polaris_admin_runtime` que lê e atualiza só o rótulo e a última vez visto; migration 0061; `platform-principal-repository.ts`. |
| Capacidades (PR94) | Concluídas | `@polaris/domain/admin/platform-capabilities`: capacidades nomeadas por papel, separadas das de tenant, falha fechada (5 testes). |
| Gate PostgreSQL 18 | Concluído | `platform-principals` (suítes `gate9`, `ci` e `all`): unicidade e checks, FORCE RLS, o papel do Admin não cria, apaga, trunca nem muda papel, estado, emissor ou subject, não lê nenhuma tabela de tenant, auth ou cobrança nem roda função de tenant; nenhum papel de tenant lê os principais; o operador é achado só por emissor e subject (desconhecido, outro emissor e desativado são ninguém); o rótulo acompanha o login sem nunca achar ninguém; a última vez visto é regravada no máximo a cada cinco minutos. Também passaram na mesma branch Neon `review-hardening` e `gate2-runtime`. |
| Fronteiras | Concluídas | Biome e 6 fixtures novas: o Admin só importa o repositório de principais (nada de tenant, cobrança, auth, `pg` nem Drizzle); Knip configurado. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test`, `build`, `db:generate` sem drift. |
| Limites | Registrados | MFA e duração da sessão são política do Access (runbook), não do Worker; sem tela do Admin (só `/api/whoami`); o fluxo contra um Access real não foi exercitado (precisa da conta do responsável): coberto por testes com chaves e tokens gerados; casos de suporte, acesso temporário, revelação de dados pessoais, cobrança e suspensão são as próximas etapas. |
| Publicação | Concluída | [GitHub PR #111](https://github.com/camilagama/polaris/pull/111) mesclado na `main` (merge `c593c63`). |

### Fase 9B — Admin: diagnóstico de organização sem acesso ao tenant (PR95; implementação, gate e verificações locais concluídos; mesclada no PR #112; revisão independente não registrada nesta seção)

Segunda etapa da Fase 9 ([ADR 0071](../docs/adr/0071-admin-diagnostico-sem-acesso-ao-tenant.md)): o operador enxerga o estado de uma organização sem ler nenhum dado do tenant.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/admin-diagnostics` sobre a `main` com 9A (migration 0062). |
| Banco | Concluído | Duas funções `SECURITY DEFINER` (`admin_organizations_overview`, `admin_organization_diagnostics`) de um papel sem login (`polaris_admin_owner`) que só lê colunas necessárias com políticas próprias; só o papel do Admin as executa. |
| Relatório | Concluído | `@polaris/domain/admin/organization-diagnostics`: plano e concessões pelo motor do produto, uso contra cada limite e pontos de atenção (7 testes). |
| API do Admin | Concluída | `GET /api/organizations` (busca por ID ou começo do nome, páginas de 1 a 50) e `GET /api/organizations/:id/diagnostics`, com a capacidade `organization:diagnose`, entrada validada antes de consultar (4 testes novos de rota). |
| Gate PostgreSQL 18 | Concluído | `admin-diagnostics` (suítes `gate9`, `ci` e `all`): só o papel do Admin executa as funções (tenant, cobrança, catálogo e PUBLIC não), o Admin segue sem alcançar nenhuma tabela além dos principais, as contagens batem numa organização com produtos, imagens, metas, concessão, aparelho, comandos e eventos de cobrança, nenhum texto digitado (produto, e-mail, rótulo, motivo de concessão, caminho de arquivo) aparece, o plano é o do motor (concessão em vigor, período vencido é Free, sem cobrança é Free), busca, páginas e entradas inválidas. Também passaram `platform-principals`, `review-hardening` e `gate2-runtime` (os gates que fixam a lista de políticas passaram a ignorar as do dono das funções do Admin). |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test`, `build`, `db:generate` sem drift. |
| Limites | Registrados | Sem tela do Admin (só API); o nome da organização aparece ao operador; a leitura não é auditada (não é dado sensível); os pontos de atenção são heurísticas fixas. |
| Publicação | Concluída | [GitHub PR #112](https://github.com/camilagama/polaris/pull/112) mesclado na `main` (merge `600db43`). |

### Fase 9C — Admin: casos de suporte, acesso temporário, leitura mascarada e revelação auditada (PR96, PR97 e PR98; implementação, gate e verificações locais concluídos; mesclada no PR #113; revisão independente não registrada nesta seção)

Terceira etapa da Fase 9 ([ADR 0072](../docs/adr/0072-admin-casos-acesso-temporario-e-revelacao.md)): ver dados de um cliente passa a exigir motivo, tempo limitado, mascaramento e registro.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/admin-support-access` sobre a `main` com 9B (migration 0063). |
| Banco | Concluído | Tabelas `support_cases`, `tenant_access_grants` e `platform_audit_events` (somente inserção, até para o dono), dez funções do Admin executáveis pelo papel do Admin (duas da 9B e oito novas), ajudantes e máscaras que ninguém além do dono executa, gatilhos que impedem reabrir um caso e desfazer uma revogação; o dono das funções lê por coluna só `customers` do tenant. O papel do Admin segue sem ler nenhuma tabela. |
| Domínio | Concluído | `@polaris/domain/admin/support-access` (regras de abertura e de resolução, caracteres de controle, minutos de acesso, campos revelaveis, recusas nomeadas; 6 testes) e a capacidade `tenant_data:read`. |
| API do Admin | Concluída | Casos (abrir, listar, ler com trilha, fechar), acesso (dar, revogar), clientes mascarados e revelação, cada rota com a sua capacidade, operador do login (nunca do corpo), corpo JSON limitado, verificação de origem em mudanças, recusas com código e sem texto do banco (11 testes novos de rota). |
| Gate PostgreSQL 18 | Concluído | `admin-support` (suítes `gate9`, `ci` e `all`): sem acesso nada se lê nem revela; as funções certas são as únicas executáveis pelo Admin; casos só para organização real, tipo conhecido e operador ativo; acesso de 5 a 240 minutos (uma hora por padrão), de um operador e um caso; clientes mascarados no formato combinado, sem nenhum valor real, só da organização do caso; revelação só de campo permitido, de cliente da organização, só com acesso, registrada **sem o valor**; auditoria que nem o dono do banco altera; acesso termina por tempo, revogação e fechamento do caso. Os gates `admin-diagnostics` e `platform-principals` passaram a provar também os novos privilégios do dono, por coluna, por tabela e por política. Também `review-hardening` e `gate2-runtime`. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test`, `build`, `db:generate` sem drift. |
| Limites | Registrados | Sem tela do Admin (só API); só clientes são legíveis; o banco confia no ID do operador que o Worker passa (um Worker comprometido age como operador, mas não lê sem acesso nem deixa de auditar); sem aviso ao cliente de que seus dados foram vistos. |
| Publicação | Concluída | [GitHub PR #113](https://github.com/camilagama/polaris/pull/113) mesclado na `main` (merge `12a240f`). |

### Fase 9D — Admin: suspensão de organização e comandos de cobrança (PR99 parcial e PR100; mesclada no PR #114)

Última etapa da Fase 9 ([ADR 0073](../docs/adr/0073-admin-suspensao-e-comandos-de-cobranca.md)). Os comandos de cobrança que dependem de um provedor (reconciliar, cancelar a renovação, reembolsar) ficam para depois do Gate 7.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/admin-suspension` sobre a `main` com 9C (migration 0064). |
| Suspensão (PR100) | Concluída | `admin_suspend_organization` e `admin_reactivate_organization`: exigem operador ativo e caso aberto; mudam status, época de autorização e concessões offline na mesma transação (com o mesmo travamento por usuário da emissão de concessões); não tocam a cobrança; reativar nunca reabre uma organização encerrada nem devolve concessões revogadas; auditadas. |
| Comandos de cobrança (PR99, parte sem provedor) | Concluída | Conceder e encerrar um entitlement temporário pelos comandos do produto, pelo papel de billing (`ADMIN_BILLING_HYPERDRIVE`), com o registro **antes e depois** na auditoria (`admin_audit_billing_command`, que exige caso aberto) e encerramento restrito às concessões da organização do caso (parâmetro opcional novo no comando de billing). |
| API do Admin | Concluída | `POST /api/support-cases/:id/suspend` e `/reactivate` (`organization:suspend`); `POST` e `DELETE /api/support-cases/:id/entitlement-grants` (`billing:operate`); recusas do domínio de concessões viram 400 com código; billing não configurado é 503 (testes de rota e de orquestração novos, inclusive o `commandId` de idempotência e o resultado que não pôde ser gravado, `outcomeRecorded: false`). |
| Gate PostgreSQL 18 | Concluído | `admin-suspension` (suítes `gate9`, `ci` e `all`): exige operador ativo e caso aberto; suspender muda status, época e concessões, deixa a cobrança e outra organização exatamente como estavam, a organização deixa de abrir para os usuários, repetir é uma vez, a suspensão espera uma concessão sendo emitida (mesma chave por usuário) e a revoga, um usuário em duas organizações só perde a suspensa, concessões e livro de cobrança intactos, a auditoria registra o número de concessões; reativar não ressuscita o revogado nem reabre encerrada; passos de cobrança só dos quatro tipos, de caso aberto e operador ativo; o comando de billing recusa encerrar concessão de outra organização. Os gates `admin-support`, `admin-diagnostics` e `platform-principals` provam também os novos privilégios do dono (colunas atualizáveis, políticas) e o conjunto exato de funções do Admin. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test`, `build`, `db:generate` sem drift. |
| Limites | Registrados | Reconciliar, cancelar renovação e reembolsar só existem com provedor (Gate 7); a auditoria dos comandos de cobrança não é atômica com a ação (pedido antes, resultado depois); sem aprovação de uma segunda pessoa; sem aviso ao cliente. Com isto a Fase 9 está completa no código; resta o Gate H do plano (Admin/RLS), cuja parte de banco está nos gates `admin-*`, e a prova com um Cloudflare Access real, que depende da conta do responsável. |
| Publicação | Concluída | [GitHub PR #114](https://github.com/camilagama/polaris/pull/114) mesclado na `main` (merge `70b835c`). |

### Fase 10A — Privacidade: encerramento de organização (PR101; implementação, gate e verificações locais concluídos; mesclada no PR #116)

Primeiro passo da Fase 10 ([ADR 0074](../docs/adr/0074-encerramento-de-organizacao.md)): o dono encerra a organização, o acesso acaba na hora e ele pode desfazer por 30 dias. A purga, a anonimização, os casos de privacidade, o export, a retenção e o deletion ledger são os PR seguintes (PR102 a PR107).

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/organization-closure` sobre a `main` com a Fase 9 (migration 0065). |
| Domínio | Concluído | `@polaris/domain/organization/closure`: os seis estados, a janela de 30 dias, quem pode recuperar e quando, a confirmação pelo nome (sem diferenciar caixa, espaços e acentos compostos), recusas nomeadas; 9 testes. Capacidade nova `organization:close`. |
| Banco | Concluído | Migration 0065: status ampliado, motivo `organization_closed` nas concessões offline, tabela `organization_closures` (sem acesso de nenhum papel de serviço), papéis `polaris_privacy_owner` e `polaris_privacy_runtime` (nunca logins), quatro funções (pedir, recuperar, listar as próprias em encerramento e a varredura). |
| API | Concluída | `organization.requestClosure` (tenant, `organization:close`, confirmação pelo nome), `organization.listClosing` e `organization.recoverClosure` (só o usuário autenticado); recusas viram 400 (nome errado) e 409 (organização inativa, janela vencida); 9 testes de roteador. |
| Varredura | Concluída | `PRIVACY_HYPERDRIVE` no Worker `polaris-web`, lotes de 100 (até 10 por execução), isolada de mídia e billing, sem o binding apenas registra; 4 testes da orquestração e 4 do Worker. |
| Gate PostgreSQL 18 | Concluído | `organization-closure` (suítes `gate10` e `ci`): confirmação pelo nome e capacidade própria; o pedido muda status, época e concessões numa transação e deixa cobrança, concessões de entitlement, livro e outra organização como estavam; recusas da função (janela fora de 1 a 90 dias, usuário que não é membro, sem identidade da transação, organização inativa); espera por uma concessão em emissão e a revoga, sem tocar a do mesmo usuário em outra organização; nenhuma concessão é emitida depois; dois pedidos simultâneos, um vence; listar e recuperar (só o dono, época não volta, concessões revogadas ficam, novo encerramento reescreve o registro); janela vencida (não recupera, não é listada, a varredura fecha exatamente as vencidas, é limitada e idempotente); reativação e suspensão do Admin não reabrem uma encerrada; privilégios exatos do papel dono, funções executáveis só pelos papéis certos e RLS forçado. A suíte `ci` inteira (35 gates) e `gate2-runtime` passaram na mesma branch Neon nova (migrations 0000–0065 do zero). O gate `poc:tenant:verify` (fora do runner) recebeu só o filtro da nova política do dono e não foi executado. |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (167 arquivos, 1883 testes), `build` e `db:generate` sem drift. |
| Revisão independente | Concluída | Sem defeito de segurança; achados tratados: janela em horas (independente do fuso), recusas casadas por SQLSTATE e mensagem (uma permissão faltando não vira recusa educada), cenários novos no gate (concessão depois do pedido, pedidos simultâneos); decisão de produto registrada no ADR: quem encerra a única organização não abre outra até o purge. |
| Limites | Registrados | Sem tela, sem e-mail ao dono, sem export automático, cancelamento da renovação no provedor só no Gate 7 (ver ADR 0074). |
| Publicação | Concluída | [GitHub PR #116](https://github.com/camilagama/polaris/pull/116) mesclado na `main` (merge `29733cd`). |

### Fase 10B — Privacidade: anonimização de cliente (PR102; implementação, gate e verificações locais concluídos; mesclada no PR #117)

Segundo passo da Fase 10 ([ADR 0075](../docs/adr/0075-anonimizacao-de-cliente-por-privacidade.md)): `customer.anonymizeForPrivacy` remove a pessoa do cadastro e preserva os fatos econômicos das vendas.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/customer-anonymization` sobre a `main` com o PR101 (migration 0066). |
| Domínio | Concluído | `ANONYMIZED_CUSTOMER_NAME`, `anonymizedCustomerProfile`, `CustomerAnonymizedError`; capacidade nova `customer:anonymize`; 3 testes. |
| Banco | Concluído | Migration 0066: coluna `anonymized_at`, CHECK que exige o formato anonimizado (nome fixo, sem contato nem observações, arquivado), CHECK de contato só para quem não foi anonimizado, gatilho que recusa qualquer alteração de uma linha anonimizada, `UPDATE` do runtime só na coluna nova. |
| Repositório e API | Concluídos | `anonymizeCustomerForPrivacy` (capacidade própria, versão esperada, idempotente, auditoria só com IDs); editar e restaurar um anonimizado são recusados (409); `customer.anonymizeForPrivacy` no contrato; `anonymizedAt` no modelo de leitura; o comando offline `customer.update` é rejeitado como `customer_anonymized` (pendência indisponível); 3 testes de roteador. |
| Interface | Concluída | Lista de clientes: selo "Anonimizado", sem editar nem restaurar, botão "Anonimizar" com confirmação em duas etapas (desligado sem conexão). Sem clique em navegador nesta etapa. |
| Gate PostgreSQL 18 | Concluído | `customer-anonymization` (suítes `gate10` e `ci`): capacidade própria, versão esperada, só o cliente da própria organização; o cadastro vira o nome fixo sem telefone, email nem observações, é arquivado e a versão avança, com um evento de auditoria só com IDs; a venda, os itens, ajustes, pagamento, vínculo, movimentos de estoque e saldos ficam idênticos byte a byte; nenhum dado da pessoa sobra no cadastro, na auditoria, no log de mudanças, no log de comandos nem nas vendas; repetir não muda nada (nem arquivar com versão velha); editar e restaurar são recusados; direto no banco o runtime não consegue desfazer, recolocar dado nem alterar a linha; o banco recusa um anonimizado com nome, telefone, email ou observações, ou não arquivado; a lista mostra a marca, a busca por duplicados não o acha e uma venda não pode ser ligada a ele de novo. A suíte `ci` inteira (36 gates) e `gate2-runtime` passaram na mesma branch Neon nova (migrations 0000–0066 do zero). |
| Verificação local | Concluída | `format:check`, `lint`, `typecheck`, `boundaries`, `knip`, `test` (167 arquivos, 1892 testes), `build` e `db:generate` sem drift. |
| Revisão independente | Concluída | Sem falha de integridade no banco; achados tratados: as vendas recentes guardadas no aparelho (com o nome do cliente) são atualizadas quando um cliente muda, a tela do aparelho reconhece o anonimizado pelo formato que só ele pode ter, arquivar de novo com versão velha é no-op; limites registrados no ADR (hash do log de comandos é pseudonimização, fila de edições offline). |
| Limites | Registrados | Cópias fora do banco ativo (backups, branches, exportações, aparelhos que não sincronizaram) e texto livre em outros registros ficam para retenção e purge; sem motivo registrado até o PR103; o modelo local não guarda a marca (o servidor recusa). |
| Publicação | Concluída | [GitHub PR #117](https://github.com/camilagama/polaris/pull/117) mesclado na `main` (merge `8188579`). |

### Correções das revisões pós-merge do bot (PR #114 e PR #116)

O bot revisor ([comentário no #114](https://github.com/camilagama/polaris/pull/114) e [no #116](https://github.com/camilagama/polaris/pull/116)) aprovou com ajustes. Tratados num PR à parte:

| Achado | Tratamento |
| --- | --- |
| #114: repetir o mesmo `commandId` do comando de conceder virava erro (o fim "daqui a N horas" muda a cada pedido e o store compara o instante) | O comando lê a concessão do ID antes (`findEntitlementGrant`): a repetição é a mesma concessão se tudo menos o relógio confere (a duração pedida inclusive: 1 hora e depois 720 é conflito), e um conflito é 409 `grant_id_conflict` (antes saía 500). Testes do comando e da rota; o gate `admin-suspension` cobre a leitura do store. |
| #116: `organization_closed` fora da lista de motivos de revogação do domínio | Incluído (espelha o CHECK do banco). |
| #116: a confirmação digitada vale só no TypeScript | Registrado nos limites do ADR 0074. |
| #116 e #114: número de ADR que colide com o rascunho #96 | Não é deste PR: o #96 precisa ir para 0076 ou mais (0074 e 0075 estão em uso). |

Mesclado no [PR #119](https://github.com/camilagama/polaris/pull/119) (merge `12243a9`).

### Fase 10C — Privacidade: casos de privacidade (PR103; implementação, gate e verificações locais concluídos; mesclada no PR #120)

Terceiro passo da Fase 10 ([ADR 0077](../docs/adr/0077-casos-de-privacidade.md)): o fluxo interno de um pedido sobre dado pessoal, no Admin.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/privacy-cases` sobre o PR #117 (migration 0067). |
| Domínio | Concluído | `@polaris/domain/admin/privacy-case`: códigos, ordem das etapas, regras de decisão (identidade que falhou, operador que não aceita por conta própria, encaminhamento), prazo provisório de 15 dias contado de quando o pedido chegou, atraso; 15 testes. |
| Banco | Concluído | Migration 0067: tabelas `privacy_cases` (CHECKs de ordem e de decisão) e `privacy_case_actions` (somente inserção), gatilho que só deixa o caso avançar e não muda passo gravado, nove funções do Admin (abrir, identidade, papel, escopo, decisão, ação, resolver, ler, listar) e a troca das funções genéricas de abrir e fechar caso, que passam a recusar o tipo `privacy`. |
| API do Admin | Concluída | `POST /api/privacy-cases` e um `POST` por etapa, `GET` de lista (abertos, fechados, atrasados) e de leitura, tudo com `privacy_case:manage`; recusas do domínio viram 400, passo fora de ordem e caso fechado viram 409; 10 testes de rota novos. |
| Gate PostgreSQL 18 | Concluído | `privacy-cases` (suítes `gate10` e `ci`): abertura e validações, ordem das etapas, decisões permitidas e recusadas, execução e resolução (fecha o caso e revoga o acesso temporário), o banco recusando pular etapa, voltar, mudar passo gravado, caso resolvido, aceitação indevida e mudar ou apagar ação, lista e atraso, auditoria só com códigos (a nota nunca chega nela) e privilégios exatos. Os gates `admin-support`, `admin-diagnostics`, `platform-principals`, `admin-suspension`, `review-hardening` e `gate2-runtime` também passaram na mesma branch (política do ADR 0025: só os afetados). |
| Revisão independente | Concluída | Achados tratados: `partially_accept` sem motivo (a função deixava passar e o CHECK recusava: virava 500), o motivo de identidade só para identidade que falhou em qualquer decisão, o gatilho só aceitando o passo seguinte (antes a adjacência estava só na função), a ação registrada combinando com a decisão, caso inexistente respondendo 404 (não 409), `admin_not_configured` respondendo 503, a resolução travando o caso de suporte (como o fechamento genérico), a referência ao titular só como identificador, e um teste de paridade no gate entre o banco e o domínio em todas as combinações. Limites no ADR: o papel é declarado pelo operador; o purge (PR107) precisa tratar essas tabelas. |
| Suíte completa em Neon | Parcial | PR101 e PR102 rodaram a suíte `ci` inteira e o `gate2-runtime`; este PR rodou só os afetados (política do ADR 0025). A suíte completa da Fase 10 roda ao entregar o último PR da fase. |
| Limites | Registrados | Sem tela do Admin; sem aviso nem contato do titular; prazo provisório, sem lembrete; um caso é sempre de uma organização; a execução é só registrada (os comandos de anonimizar e encerrar seguem do dono). |
| Publicação | Concluída | [GitHub PR #120](https://github.com/camilagama/polaris/pull/120) mesclado na `main` (merge `ff9343c`). |


### Fase 10D — Privacidade: exportação de dados (PR104; implementação, gate e verificações locais concluídos; revisão e publicação: ver linhas abaixo)

Quarto passo da Fase 10 ([ADR 0078](../docs/adr/0078-exportacao-de-dados-da-organizacao.md)): o dono pede uma cópia dos dados da organização, montada em segundo plano e baixada por tempo limitado.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/data-export` sobre o PR #120 (migration 0068). |
| Domínio | Concluído | `@polaris/domain/privacy/{zip,csv,data-export}`: ZIP sem compressão com nomes validados e bytes determinísticos, CSV com a defesa contra fórmula de planilha, formatos, prazo de 24 horas, nome do arquivo por data; capability `organization:export` (owner). |
| Banco | Concluído | Migration 0068: `data_exports` e `data_export_files` (RLS forçado, CHECKs de estado coerente), um pedido em andamento por organização (índice parcial único), no máximo três por 24 horas (gatilho), e sete funções do papel de privacidade (pegar, gravar arquivo, concluir, falhar, expirar, listar e marcar os arquivos apagados). O papel do tenant só lê e insere as três colunas do pedido. |
| O que entra | Concluído | `export-datasets.ts`: 31 tabelas exportadas e as tabelas da organização deixadas de fora, cada uma com a razão; colunas lidas do catálogo (`has_column_privilege`), leitura paginada pela chave primária sob o RLS do solicitante. O gate falha se uma tabela com `organization_id` não estiver em uma das listas. |
| Job e API | Concluídos | Job no `scheduled` horário (mesma conexão do papel de privacidade), lendo como o solicitante em `REPEATABLE READ`; ZIP de dados (JSON e CSV conforme o pedido, manifesto, LEIA-ME) e partes de imagens de até 32 MiB no R2 em `exports/v1/…`; `dataExport.request` e `dataExport.list`; download por rota autenticada e auditada, sem cache. Testes: job (retentativa, falha definitiva, limpeza, expiração), roteador, rota de download, worker. |
| Gate PostgreSQL 18 | Concluído | `data-export` (suítes `gate10` e `ci`): pedido, um por vez, limite diário (também no banco), o papel do tenant sem atualizar nem apagar, ciclo de vida pelas funções, retomada de execução parada, download só da própria organização e dentro do prazo, expiração e remoção, cobertura completa das tabelas, isolamento entre organizações e privilégios exatos. O gate `organization-closure` teve a lista exata de políticas do dono de privacidade atualizada. |
| Revisão independente | Concluída | Sem vazamento entre organizações nem injeção. Achados tratados: o teto de memória contava só o JSON e guardava as linhas como objetos (agora só texto, teto de 16 MiB e os dados soltos antes das imagens), pedir só imagens ou só CSV lia e media tudo em JSON (agora só o pedido), teto de 400 imagens por causa das chamadas externas por execução, a segunda exportação só começa com folga de tempo, falha ao registrar falha não derruba o laço, as datas saíam no texto cru do banco (agora ISO 8601 em UTC), `HEAD` não roda o download. Registrados nos limites do ADR: execução morta vira abandono sem evento de auditoria, funções sem conferir a tentativa, pedido `requested` parado, contagem de chamadas a medir na conta. |
| Suíte completa em Neon | Parcial | O gate novo e os afetados rodaram (`data-export`, `organization-closure`, `customer-anonymization`, `privacy-cases`, `platform-principals`, `admin-diagnostics`, `admin-support`, `admin-suspension`, `review-hardening`; política do ADR 0025); a suíte completa da Fase 10 roda ao entregar o último PR da fase. |
| Limites | Registrados | Não é imediata (job horário); sem aviso por e-mail nem tela; a trilha de auditoria, cobrança, sincronização e membros não entram; organizações com mais de 16 MiB de dados ou 400 imagens falham (`export_too_large`); miniaturas derivadas não entram; o arquivo baixado fica com quem baixou. |

### Fase 10E — Privacidade: retenção por classe (PR105; implementação e verificações locais concluídas; gates de banco no CI)

Quinto passo da Fase 10 ([ADR 0079](../docs/adr/0079-retencao-por-classe-de-dado.md), proposto; o número pode mudar).

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Registro de retenção | Concluído | `@polaris/domain/privacy/retention`: 20 classes com origem, regra, fontes e estado (a `deletion_ledger` entrou com o PR106, proposta e sem job); só as duas de mídia e a de exportação estão aprovadas, com prazo e job (os jobs horários existentes); as constantes do reconciliador e da exportação vêm do registro. |
| Jobs de expurgo | Nenhum novo | As classes aprovadas com prazo (mídia e exportação) já tinham job; as demais ficam propostas, sem job, até a decisão do responsável. |
| HMAC do `payload_hash` | Concluído | `SYNC_PAYLOAD_HASH_SECRET` (503 sem ele); reenvio compara também o SHA-256 legado e o segredo anterior. Sem migration. O segredo não foi criado em nenhum ambiente. |
| Descarte da edição de cliente anonimizado | Concluído | O aparelho descarta o `customer.update` recusado com `customer_anonymized` e segue a fila. |
| Gate PostgreSQL 18 | No CI | Caso novo no gate `sync-push` (hash legado equivalente); não rodado localmente. |
| Limites | Registrados | Linhas antigas de `sync_commands` mantêm o SHA-256 sem sal até a retenção do log ser aprovada; prazos legais a confirmar pelo responsável. |

### Fase 10F — Privacidade: deletion ledger (PR106; implementação e verificações locais concluídas; gate de banco no CI)

Sexto passo da Fase 10 ([ADR 0080](../docs/adr/0080-ledger-minimo-de-exclusoes.md); o número pode mudar): um tombstone mínimo de cada exclusão, para um restore de backup refazer o que a privacidade já tinha tirado.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `feat/deletion-ledger` sobre a `main` (migration 0069, só aditiva). |
| Domínio | Concluído | `@polaris/domain/privacy/deletion-ledger`: os dois pares permitidos (`customer`/`anonymize`, `organization`/`purge`), IDs opacos, recusa de qualquer campo além do contrato. |
| Banco | Concluído | `deletion_ledger` (RLS forçado, CHECKs de vocabulário e de ID opaco, índice único por tipo, ID e operação, sem chave estrangeira para a organização). O runtime do tenant só insere as quatro colunas de um tombstone, só de cliente já anonimizado na própria organização, e não lê nada; nenhuma política permite `UPDATE` ou `DELETE`; o dono de privacidade só lê. |
| Quem grava | Concluído | `anonymizeCustomerForPrivacy` grava na mesma transação do comando (`recordDeletionLedgerEntry`); o comportamento do comando não muda. O purge (PR107) grava o tombstone da organização antes de apagar, em migration própria. |
| Restore | Concluído (procedimento) | [Runbook](../docs/runbooks/deletion-ledger-restore.md): ler o ledger do ambiente que será substituído, reaplicar, conferir por consulta vazia. Sem automação (Fase 16); item novo no checklist de go-live. |
| Gate PostgreSQL 18 | No CI | `deletion-ledger` (suítes `ci` e `gate10`); não rodado localmente (sem PostgreSQL 18 no ambiente). |
| Retenção | Classe proposta | A classe `deletion_ledger` está no ADR 0079 e no registro de retenção (`proposta`, sem job); a regra vem do ADR 0080 e o prazo final é a confirmar pelo responsável. |
| Limites | Registrados | O ledger mora no mesmo banco: perda total do banco perde os tombstones posteriores ao último backup (cópia fora do banco: Fase 16); reaplicar é manual; o caso de privacidade ainda não é preenchido pelo comando; o ID opaco é pseudônimo enquanto houver backup antigo. |

### Fase 10G — Privacidade: purge completo da organização encerrada (PR107; ADR 0081)

Sétimo passo da Fase 10 ([ADR 0081](../docs/adr/0081-purge-completo-da-organizacao-encerrada.md), proposto; o número pode mudar). Um ato administrativo agenda o purge de uma organização encerrada; o job horário apaga o armazenamento, depois as linhas do tenant, e deixa a organização como tombstone `purged`.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `feat/full-purge` sobre a `main` depois do PR #130 (despachante do outbox): a migration do purge é a 0075 (`0075_organization_purge.sql`, antes 0072), depois da 0074 da `main`, e `event_outbox` e `queue_processing` estão nas listas do purge. |
| Domínio | Concluído | `@polaris/domain/privacy/organization-purge`; registro `ADMIN_TRIGGERED_REMOVALS` (separado de `RETENTION_PURGE_JOBS`); teste que falha se uma classe proposta tiver job. |
| Banco | Concluído | Migration 0075 (refeita sobre a `main`, antes 0072; snapshot e journal regenerados): `organization_purges` (com `storage_touched_at`), `organization_purge_cancellations` (histórico só de inserção dos motivos), `organization_legal_holds` (trava legal, sem texto livre, nunca apagada), papel `polaris_purge_owner` (sem login), seis funções do purge (inclui `mark_organization_purge_storage_touched`) e as duas da trava legal (`admin_place_organization_legal_hold`, `admin_release_organization_legal_hold`), `admin_schedule_organization_purge` (só o caso de exclusão do dono, aceito em integral e com escopo exato da organização inteira: categoria mantida é recusada), `admin_cancel_organization_purge` (recusa depois da primeira exclusão no R2), evento de auditoria da conclusão, exceção estreita nos quatro gatilhos de estoque, mídia e casos, só para o papel de purge (`CREATE OR REPLACE`), CHECK de `platform_audit_events_type_allowed` unida aos tipos da `main` e do purge, apagamento de `queue_dead_letters`, gatilho de `data_export_files` que recusa organização inativa. |
| Admin | Concluído | `POST /support-cases/{caso}/purge` e `POST /support-cases/{caso}/purge/cancel` (motivo obrigatório), capacidade `organization:purge`; trava legal em `POST /support-cases/{caso}/legal-hold` e `/legal-hold/release` (corpo `{ organizationId }`), capacidade `organization:legal_hold`. |
| Worker | Concluído | `runOrganizationPurges` no job horário de privacidade; `deleteObjectsUnderPrefix` em `apps/web/src/server/privacy/storage-prefix.ts`. |
| Gate PostgreSQL 18 | Passou localmente (PostgreSQL 18.4); roda no CI | `organization-purge`: escopo exato, `storage_touched_at` (inclusive a corrida entre a marca e o cancelamento), histórico de cancelamentos append-only, recusa antes de 30 dias e com legal hold (agendamento, tomada e execução), anonimização de `billing_events` (só chaves de `PURGE_BILLING_FACT_KEYS`), texto livre de casos e cancelamentos trocado pelo texto fixo, tabelas novas (`queue_dead_letters` apagada; `operational_incidents` e `scheduled_job_state` sem organização) e o restore reaplicado. |
| Verificação local | Concluída (18/10/2026, depois da refação) | `bun run check` (2412 testes) e `bun run build` passaram; `drizzle-kit generate` sem mudança (sem drift); migrations do zero num PostgreSQL 18.4 local descartável (binário do pacote `@embedded-postgres`, fora do repositório) e a suíte `ci` de gates completa (44, com `organization-purge`) passou. `gates:gate3` (gate2-runtime) e `poc:tenant:verify` exigem hostname Neon e não rodaram. Nada rodou contra Neon ou Cloudflare. |
| Decisões do responsável (18/10/2026) | Implementadas | ADR 0081, seção "Decisões do responsável": 30 dias do encerramento antes do purge (`closure_period_not_elapsed`); trava legal (`legal_hold_active`); cobrança com o pagador anonimizado (`PURGE_BILLING_FACT_KEYS`); texto livre dos casos e dos cancelamentos trocado pelo texto fixo; exceções estreitas nos gatilhos só para o papel de purge; cancelamento mantido; `queue_dead_letters` apagada. |
| Publicação | PR aberto, aguardando revisão | Branch `feat/full-purge`. |

## Fase 11 — infraestrutura assíncrona

### Fase 11A — Outbox transacional (PR108; implementação e verificações locais concluídas; gate de banco no CI)

Primeiro passo da Fase 11 ([ADR 0082](../docs/adr/0082-outbox-transacional.md); o número pode mudar): o evento nasce na mesma transação do comando, sem despachante (PR110), sem filas (PR109).

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `feat/transactional-outbox` sobre a `main` (migration 0070, só aditiva; a do purge, do PR #126, foi renumerada para 0071 depois que este entrou). |
| Domínio | Concluído | `@polaris/domain/events/outbox`: tipos permitidos, corpo só de IDs opacos, inteiros e booleanos (texto livre recusado), chave de idempotência e correlação. |
| Banco | Concluído | `event_outbox` (RLS forçado; `event`, `type`, `status` `pending`/`dispatched`, `available_at`, `attempts`, `idempotency_key`, `correlation_id`; índice único por organização e chave; CHECK do corpo; `ON DELETE CASCADE` na organização). O runtime do tenant só insere cinco colunas, na própria organização e nos tipos que a política lista (cada evento amarrado a uma exportação pedida pelo mesmo usuário); ninguém lê, atualiza ou apaga; nenhum outro papel tem privilégio (o do despachante nasce no PR110). |
| Quem grava | Concluído | `recordOutboxEvent` (`@polaris/db/event-outbox`) na transação do comando. Integração: `requestDataExport` grava `data_export.requested` com o ID do pedido; o comportamento não muda (o job continua achando o pedido pela tabela) e nada consome o evento ainda. |
| Gate PostgreSQL 18 | No CI | `event-outbox` (suítes `ci` e `gate11`); não rodado localmente (sem PostgreSQL 18 no ambiente). O CHECK do corpo e a política foram provados num PostgreSQL 18.6 em memória (PGlite), fora do repositório. |
| Limites | Registrados | Sem despacho, tentativa, recuo, DLQ nem retenção dos despachados (PR110 a PR112); o purge (PR107) não apaga a linha da organização, então o cascade não dispara: `event_outbox` entrou nas listas do purge no PR #126 (`PURGE_DELETE_ORDER`, o `DELETE` e a política do papel do purge); evento de plataforma (sem organização) fica para quando um comando exigir; o banco confere a forma do corpo, não o sentido; a exportação tem dois mecanismos por ora (a varredura vale, o evento não). |

### Fase 11B — Infraestrutura de filas (PR109; implementação e verificações locais concluídas; nada criado na conta Cloudflare)

Segundo passo da Fase 11 ([ADR 0083](../docs/adr/0083-filas-cloudflare-e-consumidor-idempotente.md); o número pode mudar): três filas, envelope tipado e consumidor idempotente, sem despachante (PR110) nem DLQ (PR111).

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `feat/queue-infrastructure` sobre a `main`; sem migration. |
| Plano e custo | Sem decisão pendente de custo | Queues está no Workers Free (10.000 operações por dia, retenção de 24 horas; changelog de 04/02/2026), cerca de 3.300 mensagens por dia; o plano pago continua não contratado. O responsável só precisa aprovar a criação das filas (runbook). |
| Declaração | Concluída | `apps/web/wrangler.jsonc`: produtores `QUEUE_CRITICAL`, `QUEUE_DEFAULT`, `QUEUE_MEDIA` e consumidores de `polaris-critical`, `polaris-default` e `polaris-media`. Nada criado na conta; `bun run build` aceita a configuração. |
| Domínio | Concluído | `@polaris/domain/events/queue-envelope`: versão, tipo, ID do evento do outbox, chave, correlação, organização, tentativa e corpo do outbox (sem texto livre), validado na borda; `queueForEventType`. |
| Consumidor | Concluído | `handleQueueBatch` (`apps/web/src/server/queue`): envelope inválido (inclui tipo ou versão desconhecidos) ou mensagem na fila de outro tipo dá `ack`; chave de idempotência no registro de processamento; `ack` ao concluir; `retry` com recuo; falha permanente dá `ack`; nada do corpo vai ao log. Uma mensagem e uma invocação por vez no `wrangler.jsonc`. Exportado como `queue` do Worker `polaris-web`. |
| Registro de processamento | Em memória | Interface `ProcessingLedger` com adaptador em memória por isolate; o durável (tabela e papel) vem com o despachante (PR110). A idempotência real hoje é a do handler. |
| Handler | Concluído | `data_export.requested` acorda o job de exportação existente (`runDataExports`) para um pedido, sem a varredura de expiração (fica com o job horário); o job horário continua valendo e o comportamento observável não muda (nada envia o evento ainda). |
| Gate PostgreSQL 18 | Não se aplica | Sem migration nem tabela neste PR. |
| Limites | Registrados | Sem despachante, varredor, DLQ nem registro durável; filas não testadas em nuvem; mensagem que expira em 24 horas ou esgota as tentativas se perde (a varredura horária cobre a exportação). |

### Fase 11C — Despachante e varredor do outbox (PR110; implementação e gates locais concluídos; nada criado na conta Cloudflare)

Terceiro passo da Fase 11 ([ADR 0084](../docs/adr/0084-despachante-e-varredor-do-outbox.md); o número pode mudar): evento `pending` → fila → `dispatched`, à prova de queda, duplicata aceita; sem DLQ (PR111).

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `feat/outbox-dispatcher` sobre a `main` (migration 0071, só aditiva; a do PR #126 também é 0071, e o segundo a entrar renumera a migration e o snapshot). |
| Onde roda | Decidido | Workers Free: cron e HTTP com 10 ms de CPU, consumidor de fila com 30 s (documentação da Cloudflare conferida em 18/10/2026). O despachante tem cron próprio (`19 * * * *`); a montagem da exportação sai do cron e vai para o consumidor quando `OUTBOX_HYPERDRIVE` e `QUEUE_DEFAULT` existem. CPU real não medido. |
| Banco | Concluído | Papéis `polaris_outbox_owner` e `polaris_outbox_runtime`; `event_outbox` ganha `locked_until` e `dispatched_at`; funções de tomada (com varredura das tomadas vencidas e teto de 1000 tentativas), marcação e devolução com a cerca das tentativas; tabela `queue_processing` (registro durável do consumidor, RLS forçado); a política do tenant limita as chaves do corpo por tipo; exportação: tomada por ID, recuo na tomada depois de falha (15 min, 1 h) e re-arm do evento enquanto a exportação for devida. |
| Domínio | Concluído | `@polaris/domain/events/outbox` (chaves exatas por tipo) e `@polaris/domain/events/outbox-dispatch` (lote, prazo, recuo, teto). Prazo da exportação: 960 s. |
| Worker | Concluído | `dispatchOutbox` (`apps/web/src/server/queue/dispatcher.ts`); registro durável (`createDurableProcessingLedger`) com conferência chave × ID do evento no banco (o `unknown` traz o motivo, e a linha que some entre o insert e o lock é tomada de novo, esgotadas as tentativas vira `claim_contended` e o consumidor reentrega); handler da exportação por ID; `scheduled` escolhe o trabalho por `controller.cron`; binding `OUTBOX_HYPERDRIVE` (só `local-only` no `wrangler.jsonc`). |
| Retenção | Classe aprovada | `queue_processing`: uma semana, job `outbox.processing_expiry` (execução do despachante). Despachados de `event_outbox` continuam `proposta` (PR112). |
| Gate PostgreSQL 18 | Local e CI | `outbox-dispatcher` (suítes `ci` e `gate11`), novo; `event-outbox` e `data-export` ajustados. `gates:ci` completo passou num PostgreSQL 18.4 local. |
| Limites | Registrados | Nada criado nem medido em nuvem (filas, Hyperdrive, CPU); latência de até uma hora (cadência é do PR112 e decisão de custo); sem DLQ; o purge (PR #126) apaga `queue_processing` (classificada em `PURGE_DELETE_ORDER`). |

### Fase 11D — DLQ, incidente operacional e retry no Admin (PR111; implementação e gates locais concluídos; nada criado na conta Cloudflare)

Quarto passo da Fase 11 ([ADR 0085](../docs/adr/0085-dlq-incidente-operacional-e-retry-no-admin.md); o número pode mudar): a mensagem que esgota as tentativas ou que o consumidor recusa de vez vai para a DLQ e vira incidente operacional; o evento do outbox que passa de 1000 tentativas também; o Admin reenvia um evento morto, com motivo e auditoria.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `feat/dlq` sobre a `main` (migration 0072, só aditiva; a do PR #126 também é 0072, e o segundo a entrar renumera a migration e o snapshot). |
| Filas | Declarado | `polaris-dlq` compartilhada: `dead_letter_queue` nos três consumidores, produtor `QUEUE_DLQ`, consumidor próprio (10 tentativas). O consumidor envia à DLQ um **aviso** (causa e IDs, nunca o corpo) para envelope inválido, tipo ou versão desconhecidos e fila errada. Nada criado na conta: o runbook ganha o passo de criar a DLQ. |
| Banco | Concluído | `operational_incidents` (uma linha por causa, contagem e datas) e `queue_dead_letters` (um evento morto por linha, só IDs); funções `record_dead_letter`, `record_exhausted_outbox_events`, `retry_dead_letter` (dono do outbox) e `admin_list_operational_incidents`, `admin_read_operational_incident`, `admin_retry_dead_letter` (dono do Admin); o evento `operational_incident.retry` na auditoria. Ninguém apaga linha. |
| Domínio | Concluído | `@polaris/domain/events/dead-letter` (aviso e classificação) e `@polaris/domain/admin/operational-incident` (motivo do retry); capacidades `operational_incident:read` e `operational_incident:retry`. |
| Worker e Admin | Concluído | Consumidor da DLQ (`handleDeadLetterBatch`), passo do cron do despachante que registra os eventos no teto; rotas `/api/operational-incidents` (lista, detalhe, retry). |
| Retenção | Proposta | Classe `operational_incident` (sem prazo e sem job; PR112). |
| Gate PostgreSQL 18 | Local e CI | `dead-letter` (suítes `ci` e `gate11`), novo. |
| Limites | Registrados | Nada criado nem medido em nuvem; a DLQ não tem DLQ (retenção de 24 horas no Free); falha permanente do handler continua `ack`; o retry espera o cron do despachante; incidente não se encerra; o PR do purge (#126, a refazer) precisa apagar `queue_dead_letters` explicitamente (política e DELETE do papel do purge, com a prova no gate dele), porque a linha da organização fica e a cascata não dispara, e unir `platform_audit_events_type_allowed` aos tipos do purge; `operational_incidents` não tem organização. Feito no PR #126 (migration 0075): o purge apaga `queue_dead_letters` explicitamente, com política e `DELETE` do seu papel, e a CHECK já une os tipos. |

### Fase 11E — Framework de jobs agendados (PR112; implementação e gates locais concluídos; nada criado na conta Cloudflare)

Quinto passo da Fase 11 ([ADR 0086](../docs/adr/0086-framework-de-jobs-agendados.md); o número pode mudar): um tick por pista de cron despacha os jobs vencidos, cada um sob *lease* e com janelas fixas, catch-up por nível.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `feat/scheduled-jobs` sobre a `main` (migration 0073, só aditiva, depois da 0072 da DLQ (PR #131, já na `main`); o PR #126 ainda usa 0072, e quem entrar depois renumera a migration e o snapshot; refeita sobre a `main` com o #131: o job `outbox.dispatch` também registra os eventos no teto de tentativas). |
| Registro | Concluído | `@polaris/domain/scheduling/scheduled-jobs`: seis jobs (quatro ligados, dois desligados com a pendência), duas pistas (`17 * * * *` e `19 * * * *`), cadência, *lease*, por que repetir é seguro, expurgos que executa; `windowIndex` e `windowsMissed`. Dois dos cinco Cron Triggers do Free em uso; um teste confere o `wrangler.jsonc` contra as pistas. |
| Banco | Concluído | `scheduled_job_state` (RLS forçado, sem organização nem dado pessoal) e `claim_`, `complete_` e `release_scheduled_job`, do papel do outbox (mesmo login e `OUTBOX_HYPERDRIVE`); `OutboxClient` ganha os três métodos. |
| Worker | Concluído | `runLane` (`apps/web/src/server/scheduler/runner.ts`): *lease*, janela, falha isolada por job, métrica `scheduled_job_run` sem dado pessoal; `scheduled` do Worker vira o tick (`17` e `19` migrados sem mudar o comportamento; sem o binding, tudo roda a cada disparo, como antes). |
| grace/trial | Já existia | A regra e a varredura existem (billing-and-entitlements): são o job `billing.maintenance`. |
| recurring expenses | Registrado desligado | A geração ao ler (ADR 0052) já cobre o catch-up; um job exige papel que escreve em todas as organizações: decisão de segurança do responsável. |
| provider reconcile | Registrado desligado | Depende do Gate 7 (Asaas e Woovi, sandbox); sem código de provedor. |
| Cleanup | Só o aprovado | Os quatro expurgos existentes rodam pelo agendador; nenhum job para classe em `proposta` (o teste da retenção e o do registro garantem); expurgo dos `dispatched` e dos incidentes espera o prazo do responsável. |
| Gate PostgreSQL 18 | Local e CI | `scheduled-jobs` (suítes `ci` e `gate11`), novo. |
| Limites | Registrados | Nada criado nem medido em nuvem (CPU dos ticks, em especial a pista `maintenance`, que abre uma conexão a mais); cadência horária (decisão de custo); sem tela de estado no Admin. |

### Fase 11F — Workflows (PR113; decisão sem Workflow; nada criado na conta Cloudflare)

Sexto passo da Fase 11 ([ADR 0088](../docs/adr/0088-workflows-so-quando-necessario.md); o número pode mudar): nenhum Cloudflare Workflow por ora.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Limites | Conferidos | Documentação da Cloudflare de 18/10/2026: Workflows existe no Free, com 10 ms de CPU por step, 3.000 steps por dia e 100 MB de estado por instância; o consumidor da fila tem 30 s de CPU por padrão pela página do Queues (ambígua para o Free, como o ADR 0084 registrou; não medido). Um step nunca tem mais CPU que o consumidor. Nenhum custo criado. |
| Exportação | Sem Workflow | Continua no consumidor da fila (ADR 0084): montar o ZIP não cabe em 10 ms, e a retomada, a idempotência e o recuo já são do banco. |
| Purge | Sem Workflow | Aceito pelo responsável em 18/10/2026; em revisão (PR #126). Roda no job `privacy.maintenance` do agendador; CPU do tick não medido; se não couber no cron, a fila; o estado fica em `organization_purges`. |
| Cobrança | Fora | O estado canônico continua no banco. |
| Guarda | Concluída | Teste em `apps/web/worker/index.test.ts`: nenhum `wrangler.jsonc` declara `workflows` sem um ADR que emende o 0088. |
| Limites | Registrados | Números da documentação, não medidos na conta; não está documentado se o Hyperdrive conta como subrequisição externa no Free. |

## Fase 12 — observabilidade e segurança

### Fase 12A — evlog e logger tipado (PR114; implementação local concluída; nada criado na conta Cloudflare)

Primeiro passo da Fase 12 ([ADR 0089](../docs/adr/0089-evlog-e-logger-tipado-no-backend.md); o número pode mudar): o evlog entra no backend atrás de um wrapper tipado, sem destino externo.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Pacote | Concluído | `@polaris/observability/logger` (`logger`, `configureLogging`), único importador do `evlog` (2.33.0, MIT, compatível com Workers); testes do wrapper. |
| Fronteira | Concluída | Biome recusa `evlog` e o wrapper em `packages/domain` e no código do navegador; `bun run boundaries` tem fixtures para os dois. |
| Migração | Parcial | `server-log`, agendador, entrada do Worker web e relatório do Admin; o resto dos `console.*` migra no PR que tocar cada um. |
| Limites | Registrados | Sem *drain*; a redação embutida do evlog fica ligada e a política própria é do PR116; o esquema de campos é da Fase 12C; o campo `environment` depende do `NODE_ENV` do bundle; sem medida em nuvem. |

### Fase 12B — Headers de segurança e CSP centralizados (PR120; implementação e verificações locais concluídas; nada criado na conta Cloudflare)

Pacote `@polaris/http-security` e [ADR 0090](../docs/adr/0090-headers-de-seguranca-centralizados.md) (o número pode mudar). A Fase 12A é o PR114 (evlog), independente deste.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Módulo | Concluído | `packages/http-security`: perfis `app-shell`, `api`, `admin`, `public-document` e `public-media`; nonce por resposta; origens extras só por `connectSources`/`imgSources`, exatas e em https. |
| Web | Concluído | `public/_headers` gerado pelo módulo (teste de igualdade); o Worker aplica o perfil `api` a toda resposta e `no-store` quando o handler não escolheu outro `Cache-Control`. |
| Admin | Concluído | Perfil `admin` (CSP fechada, HSTS, COOP/CORP, sem referrer, `no-store`) em toda resposta, inclusive 401, 403 e 404. |
| Catálogo | Concluído | Entrada `src/server.ts` (o `main` do Worker) com nonce por requisição e CSP sem `'unsafe-inline'`; páginas nunca em cache compartilhado; imagem pública com `sandbox` e `Cross-Origin-Resource-Policy: cross-origin`. |
| Testes | Concluídos | Unitários do módulo (nenhum curinga, `unsafe-inline` ou esquema solto em nenhum perfil) e de integração nas respostas dos três apps. |
| Gate de navegador | Ver o PR | CSP do shell inalterada na parte de script, estilo e conexão; o resultado de `test:offline-poc` e `test:pwa` está na seção "Verificação" do PR. |
| Limites | Registrados | Catálogo com nonce não aberto em navegador contra o Worker rodando (ADR 0090); sem `report-uri`; Sentry ainda não ligado (nenhuma origem aberta). |

### Fase 12C — esquema canônico de eventos largos (PR115; implementação local concluída; nada criado na conta Cloudflare)

Terceiro passo da Fase 12 ([ADR 0091](../docs/adr/0091-esquema-canonico-de-eventos-largos.md); o número pode mudar): nomes, unidades e valores de campo fixos, aliases proibidos e um evento largo por requisição, comando ou job.

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Esquema | Concluído | `fields.ts`: campos canônicos tipados, `outcome` (`success`, `partial`, `rejected`, `skipped`, `failure`), `durationMs` em ms, IDs opacos (`organizationId`, `actorId`, `deviceId` e afins) conferidos pelo formato. |
| Aliases | Concluído | `LogFields` recusa os aliases no tipo; o logger os descarta e lista em `ignoredFields`; `call-sites.test.ts` falha se uma chamada de log do backend usar um. |
| Evento largo | Concluído | `startWideEvent`, `withWideEvent` e `describeError` (`@polaris/observability/wide-event`); o agendador emite `scheduled_job_run` por eles. |
| Migração | Parcial | Todos os pontos que já chamavam o logger, só nos nomes dos campos (`errorName` → `errorClass`, `status` → `httpStatus`, `outcome` do agendador → `success\|failure\|skipped`); os `console.*` restantes migram no PR que tocar cada um. |
| Limites | Registrados | Nenhum evento por requisição HTTP ainda (volume e amostragem: PR117); a política de redação é do PR116. |
