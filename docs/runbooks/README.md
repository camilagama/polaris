# Runbooks

Este arquivo é a fonte de verdade para os **procedimentos operacionais repetíveis** e para o checklist de go-live. Runbooks descrevem procedimentos, não decisões de produto ou arquitetura; as decisões estão em [adr/](../adr/).

A fundação atual não provisiona recursos de produção nem dados de clientes reais. Adicione um runbook junto da primeira implementação de outras operações repetíveis, como deploy de staging, backup, restore, purge de privacidade ou resposta a incidente.

Antes de qualquer comando Cloudflare ou Neon, siga [CLI profile policy](./cli-profile-policy.md) para confirmar a identidade autorizada.

Cada runbook deve registrar gatilho, pré-requisitos de acesso, alvo seguro, passos, verificação, rollback ou forward-fix e responsável por escalonamento. Não documente ação de produção como comando executável antes de testá-la em ambiente descartável ou staging.

## Índice

Gates e provas por fase:

- Provas de arquitetura (Fase 1): [Banco e Drizzle](./database-poc.md), [RLS and Hyperdrive gate](./rls-hyperdrive-gate.md) e [Gate de persistência offline](./offline-persistence-gate.md).
- Identidade e acesso (Fase 2): [Gate Auth](./better-auth-gate.md), [E-mail transacional](./email-auth.md), [Auth abuse protection](./auth-abuse-protection.md), [Contexto tenant e audit trail](./tenant-context-gate.md) e [Gate 2 em runtime](./gate2-runtime.md).
- Catálogo, estoque e mídia (Fase 3): [Gate do ledger de estoque](./inventory-ledger-gate.md) e [Media storage reconciliation](./media-storage-reconciliation.md). O Gate 3 formal fica no runbook `docs/runbooks/gate-3-catalog-stock.md`, escrito pelo responsável.
- Catálogo, estoque e mídia (Fase 3): [Gate 3 — catálogo, estoque e mídia privada](./gate-3-catalog-stock.md).
- Clientes e vendas (Fase 4): [Gate 4 — núcleo de vendas](./gate-4-sales-core.md).
- Offline (Fase 5): [Gate 5 — offline](./gate-5-offline.md), com o checklist manual em aparelho físico (iPhone e Android) que bloqueia ligar a escrita offline.

A política de provas de banco (Neon descartável e CI com PostgreSQL 18) está no [ADR 0025](../adr/0025-estrategia-de-testes-de-banco.md). O CI é desenhado para gastar poucos minutos do GitHub Actions (repositório privado; cada job é cobrado arredondado ao minuto): os checks leves são um job só, o gate de navegador roda só quando algo que ele exercita mudou e não se repete na `main`, e a auditoria só quando uma dependência mudou. Uma execução completa sob demanda existe (`workflow_dispatch`). Racional e números no [ADR 0060](../adr/0060-ci-economico-em-minutos.md). Se os jobs não iniciarem com a mensagem "pagamentos recentes falharam ou o limite de gastos precisa aumentar", é a cobrança da conta **dona do repositório** (não de quem faz o push): conferir plano, minutos usados, limite de gastos e forma de pagamento nessa conta.

## Checklist de go-live (Cloudflare e Neon)

> **Nada deste checklist foi executado.** Ele registra o que só o responsável pode fazer nos consoles e CLIs de Cloudflare e Neon, e o que as decisões da revisão do checkpoint Gate 4 (13/10/2026) exigem antes de qualquer exposição pública. Cada item é uma verificação a executar e registrar com evidência (sem connection strings nem segredos), seguindo a [política de perfis de CLI](./cli-profile-policy.md). Itens de código dependem das mudanças implementadas por outros agentes e devem ser conferidos no código antes.

### Hyperdrive e banco

- [ ] Todos os bindings Hyperdrive de produção e de staging existem de verdade (hoje o `wrangler.jsonc` usa `id: "local-only"`) e têm **query caching desabilitado**: `HYPERDRIVE` (tenant), `ONBOARDING_HYPERDRIVE`, o binding da role de auth (nome definido na implementação) e `MEDIA_CLEANUP_HYPERDRIVE`. Registrar a configuração lida de volta.
- [ ] As roles de aplicação (tenant, auth, onboarding, cleanup) são roles de login sem `SUPERUSER`, `CREATEROLE`, `CREATEDB` nem `BYPASSRLS`, **não são donas** das tabelas e **não são membros de `neon_superuser`**. O Neon CLI `roles create` gerou membros de `neon_superuser` no passado ([media-storage-reconciliation.md](./media-storage-reconciliation.md)); conferir `pg_roles` e a pertença de cada role.
- [ ] A role de autenticação tem DML apenas nas tabelas `user`, `account`, `session` e `verification`, e a role de tenant não tem nenhum acesso a elas ([ADR 0027](../adr/0027-separacao-de-roles-auth-tenant-e-superficies-poc.md)). Provar a negação cruzada num gate.
- [ ] `TimeZone` da sessão das roles de aplicação e do banco é UTC, e as colunas de instante são `timestamptz` ([ADR 0024](../adr/0024-colunas-de-instante-timestamptz.md)); provar com uma sessão em fuso diferente de UTC.
- [ ] Prova remota Worker → Hyperdrive → Neon com **código tenant real** (`withAuthorizedTenantTransaction`) em staging, cobrindo pooling, `set_config` transacional e triggers deferidos através do pooler. A prova do PR11 cobre apenas a tabela sintética.
- [ ] Timeouts de banco (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`) aplicados às roles de aplicação.

- [ ] **Catálogo público (Fase 8, [ADR 0069](../adr/0069-catalogo-publico-leitura-por-funcoes.md)).** O papel `polaris_catalog_runtime` é um grupo sem login: criar o login da aplicação pública como membro dele (sem `SUPERUSER`, `CREATEROLE`, `CREATEDB` nem `BYPASSRLS`, fora de `neon_superuser`), definir `CATALOG_ORIGIN` (o endereço público do catálogo, usado nos links canônicos) em cada ambiente do Worker `polaris-catalog` e apontar `CATALOG_HYPERDRIVE` para esse login com **query caching desabilitado** (a resposta depende do plano a cada pedido) e provar que esse login não lê tabela alguma e só executa as quatro funções `public_catalog_*`. Definir para esse login `statement_timeout` curto, `CONNECTION LIMIT` e sem `TEMP`, porque o papel grupo não transmite configurações aos membros. Definir `CATALOG_ORIGIN` também no Worker `polaris-web` (só para a tela do catálogo público mostrar o link; sem ela o link não aparece). Ligar também o binding `MEDIA_BUCKET` do Worker `polaris-catalog` ao bucket privado de mídia (o Worker só lê; conferir que o bucket continua sem acesso público). Os derivados de 320 e 640 px nascem no envio da imagem; imagens enviadas antes disso (ambientes de teste) são servidas em tamanho original até serem enviadas de novo.

### Superfícies e credenciais de prova

- [ ] **Rotacionar a credencial owner do PR11** (o status pede e não registra conclusão) e registrar a rotação.
- [ ] **Remover os Workers e o Hyperdrive de PoC** criados nos PR11 e PR12 (inclusive subdomínio `workers.dev` temporário e role temporária de gate), e confirmar com um HTTP 404 nos endereços antigos.
- [ ] **Dropar as tabelas de PoC** `db_poc_operations` e `rls_poc_operations` (esta tem uma política `FOR ALL TO PUBLIC` e o papel de tenant mantém DML sobre ela; ver [ADR 0044](../adr/0044-revisao-de-seguranca-adicional.md)) (e fixtures do gate de RLS) no ambiente de produção e remover as rotas e variáveis de PoC (`DB_POC_ENABLED`, `DB_RLS_POC_ENABLED`) do Worker de produção, que devem estar `false` ou ausentes.
- [ ] Confirmar que o laboratório offline não está no bundle de produção.

### Borda e segurança de rede

- [ ] **Namespaces de rate limit** reservados com IDs únicos por conta (os IDs do `wrangler.jsonc` são marcadores) para os limites de autenticação e de e-mail, e para os novos limites de endpoints autenticados caros (upload de mídia).
- [ ] **`public/_headers` e HSTS verificados em staging**: CSP, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy` e `Strict-Transport-Security` presentes na casca da SPA servida pelos Static Assets (que não passa pelo Worker). Registrar a resposta real, não a configuração.
- [ ] Defesa CSRF por `Origin` no `/rpc` e atributos de cookie (`SameSite`, `Secure`, `HttpOnly`) verificados em staging.
- [ ] O Worker usa o IP da borda (`cf-connecting-ip`) e não `X-Forwarded-For`; o contexto autenticado de `/rpc` confere o teto absoluto de sessão ([ADR 0017](../adr/0017-politica-de-sessao-e-conta.md)).

### Autenticação, e-mail e privacidade

- [ ] Turnstile (site key, secret e hostname), Resend (secret, domínio de envio verificado, remetente) e demais segredos configurados conforme [auth-abuse-protection.md](./auth-abuse-protection.md) e [email-auth.md](./email-auth.md); só então ligar e-mail/senha.
- [ ] Política de privacidade atualizada com Resend, Turnstile, IP e user-agent de sessão e vínculo Google, e revisão de DPA e região dos providers ([privacy.md](../business-rules/privacy.md)). Retenção legal e legal hold da auditoria definidas.

### Billing

- [ ] Papel de login do billing criado (membro só de `polaris_billing_runtime`, sem `SUPERUSER`, `CREATEROLE` nem `BYPASSRLS`, não membro de `neon_superuser`) e uma Hyperdrive própria para ele, com query caching desabilitado; conferir em `pg_roles` e nas pertenças. Nunca reutilizar a URL do tenant, a do dono nem a da limpeza de mídia ([ADR 0062](../adr/0062-ciclo-de-vida-do-billing-e-caixa-de-entrada.md)).
- [ ] A binding `BILLING_HYPERDRIVE` do Worker aponta para esse login (conferir que não é a URL do tenant, do dono nem da limpeza de mídia); sem ela a rota de webhook responde 503 (depois que um adaptador existir; até o PR77 e o PR78 o registro de adaptadores está vazio e a rota responde 404 a tudo) e o cron registra `billing_maintenance_not_configured`.
- [ ] Webhook de cada provedor registrado no painel do provedor em `https://<domínio>/webhooks/billing/<provedor>` (`asaas`, `woovi`), com o segredo de assinatura ou o token guardado como segredo do Worker (nome e rotação definidos junto de cada adaptador, [ADR 0063](../adr/0063-rota-de-webhooks-de-billing.md)). Provar com um evento de teste do sandbox: 200 com a contagem, uma linha em `billing_events` e o mesmo evento reenviado como duplicado.
- [ ] A manutenção horária de billing (reprocessa eventos não aplicados e varre o acesso vencido) aparece nos logs do cron como `billing_maintenance_complete`; `billing_event_retry_failed` e `billing_sweep_failed` trazem o ID do evento ou da organização; `billing_maintenance_incomplete` traz só os contadores de cada parte. Os registros `billing_webhook_malformed` e `billing_webhook_too_many_events` são entregas autênticas que a rota reconheceu com 200 sem poder usar: investigar cada um. A URL registrada no provedor não leva barra final (`/webhooks/billing/asaas/` responde 404).
- [ ] Gate 7: cobrança de cartão (Asaas) e Pix Automático (Woovi) provados em sandbox, com webhook duplicado, fora de ordem, tempo esgotado e reconciliação, como exige o plano.

### Mídia

- [ ] Provar a limpeza de objetos de imagens removidas no R2 real (implementada e provada em banco, [ADR 0061](../adr/0061-limpeza-de-imagens-removidas.md)) e decidir o limite de envio de imagens por organização: a limpeza apaga o que foi removido, não impede o envio em massa.

- [ ] Bucket R2 de mídia privado, sem domínio público nem acesso anônimo, e cron horário de reconciliação ativo com a binding de cleanup ([media-storage-reconciliation.md](./media-storage-reconciliation.md)).
- [ ] Prova da orientação EXIF e da remoção de metadados com o Cloudflare Images real, e tetos de tamanho de upload e de transformação configurados.

### Integração e ambiente

- [ ] Estratégia de integração da cadeia de PRs executada por fase, com autorização do responsável, CI verde e gates reexecutados ([ADR 0023](../adr/0023-integracao-da-cadeia-de-prs.md)).
- [ ] **Segredo do lease offline** (`OFFLINE_LEASE_SECRET`, mínimo 32 bytes aleatórios, e `OFFLINE_LEASE_KEY_ID`) criado em cada ambiente antes de ligar o offline; rotação com `OFFLINE_LEASE_PREVIOUS_SECRET` e `OFFLINE_LEASE_PREVIOUS_KEY_ID` ([ADR 0029](../adr/0029-lease-de-autorizacao-offline.md)). Sem o segredo, `offline.issueLease` responde 503 e não grava nada.
- [ ] A role de autenticação tem `EXECUTE` em `bump_user_authorization_epoch` e a role de tenant não (a migration 0043 concede e revoga); verificar no ambiente real.
- [ ] CI com PostgreSQL 18, replay de migrations e checagem de drift ativos ([ADR 0025](../adr/0025-estrategia-de-testes-de-banco.md)).
- [ ] **Chave do runtime offline** (`VITE_OFFLINE_RUNTIME_ENABLED=true` na build): ligada só em staging até o checklist do Gate 5; confirmar que a build de produção está sem ela (nada de aparelho registrado, lease ou dados locais) até lá. Ligá-la registra um aparelho por usuário, emite leases de até 72 horas e grava uma cópia local da organização ([ADR 0043](../adr/0043-runtime-offline-no-app.md)).
- [ ] **Bloqueante para ligar a escrita offline:** concluir o checklist manual do [Gate 5](./gate-5-offline.md#checklist-manual-em-aparelho-físico-adiado-bloqueia-ligar-a-escrita-offline) em iPhone e Android reais.
- [ ] **Bloqueante para ligar a escrita offline:** prova em Android Chrome real do outbox (IndexedDB) e das coleções (OPFS), incluindo sobreviver a matar o processo, e o resultado de `navigator.storage.persist()` visível ao usuário ([ADR 0032](../adr/0032-outbox-duravel-de-comandos.md)). Prova em Android Chrome real da persistência offline antes de ligar escrita offline em produção ([ADR 0015](../adr/0015-offline-persistence-tanstack-db-opfs-indexeddb.md)).
