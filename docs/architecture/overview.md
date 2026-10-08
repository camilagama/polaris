# Visão geral do sistema

O Polaris começa como um monólito modular TypeScript, priorizando Cloudflare Workers e usando Neon PostgreSQL. A lógica de domínio permanece separada de runtime, transporte e persistência; a V1 não é uma coleção de microsserviços.

## Aplicações e packages

- apps/web é o ERP autenticado: React/Vite servido com seu Worker; Hono e oRPC expõem as procedures do servidor.
- apps/admin é um deployment separado para operações da plataforma, protegido por Cloudflare Access e capabilities internas. Não compartilha a sessão Better Auth do ERP.
- apps/catalog é uma aplicação pública separada para conteúdo de catálogo explicitamente publicado.
- packages/domain contém lógica de negócio pura.
- packages/contracts contém contratos de transporte.
- packages/db contém adapters de persistência e migrations.
- packages/billing contém adapters de providers de assinatura.
- packages/ui contém componentes de apresentação compartilhados.

O Worker de Web responde por autenticação, procedures, mídia, health, sincronização, acesso ao banco e bindings assíncronos. A V1 não tem um deployment apps/api separado.

## Acesso a dados e isolamento por organização

PostgreSQL 18 no Neon é o baseline. Hyperdrive fornece connection pooling com SQL query caching desabilitado para caminhos tenant e Admin.

Uma request tenant resolve a sessão Better Auth antes de abrir a transação de dados. O servidor recebe a organização solicitada como contexto não confiável; dentro de uma única transação explícita, define app.user_id com o ID da sessão, lê apenas o membership próprio, valida membership ativo e a capability no mapa de domínio, define app.organization_id e lê uma organização ativa. Só então chama o callback tenant. Os dois GUCs são transaction-local e não substituem autenticação nem autorização da aplicação.

As tabelas organizations e memberships usam FORCE ROW LEVEL SECURITY e policies de SELECT para limitar leituras conforme o contexto de membership ativo. A role runtime recebe SELECT nessas tabelas, sem INSERT, UPDATE ou DELETE. GUCs transaction-local podem ser definidos pelo próprio runtime e servem como contexto; não são identidade inviolável nem protegem contra SQL arbitrário. Por isso, a criação inicial permanece em um use case interno que exige uma conexão privilegiada separadamente controlada; o onboarding gravável pelo runtime e qualquer rota que o exponha ficam adiados até existir uma fronteira de escrita segura. Nenhuma rota de produto tenant é exposta nesta etapa.

RLS é defesa em profundidade, não substituto da autorização da aplicação. O gate remoto Worker → Hyperdrive → Neon precisa passar antes das features tenant; os casos obrigatórios estão registrados no [ADR 0002](../adr/0002-neon-postgresql18-hyperdrive-rls.md) e no [runbook de contexto tenant](../runbooks/tenant-context-gate.md).

## Identidade e ownership do domínio

Better Auth é responsável por identidade, credenciais e sessões. Organização, membership, capabilities, billing e entitlements são dados do domínio Polaris. O cliente pode solicitar uma organização, mas não autorizar seu próprio acesso.

## Operação offline

Mutations offline usam commands idempotentes e versionados. O servidor valida cada command e permanece autoritativo; command pendente local ainda não é venda aceita. TanStack DB é o primeiro candidato de persistência local; Dexie e IndexedDB são fallback. O protocolo de sync não depende da escolha de storage.

## Infraestrutura posterior

Mídia no R2 permanece privada por padrão; o catálogo público só expõe conteúdo autorizado pela aplicação. Queues, Workflows, Staging, release automation e recovery entram quando as respectivas milestones exigirem esses mecanismos.
Mutações tenant críticas escrevem `tenant_audit_event` na mesma transação da mutação, usando a identidade já autorizada. O runtime só pode inserir eventos e não pode consultá-los ou alterá-los nesta etapa; payload livre e snapshots não são armazenados. A política de retenção continua pendente para go-live, e a purga física da organização remove seus eventos.