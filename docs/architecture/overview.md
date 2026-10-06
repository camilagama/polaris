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

PostgreSQL 18 no Neon é o baseline. Hyperdrive fornece connection pooling com SQL query caching desabilitado para caminhos tenant e Admin. Cada operação com escopo de organização usa uma transação explícita, validação de membership e capability no servidor, contexto de organização transaction-local e RLS do PostgreSQL.

RLS é defesa em profundidade, não substituto da autorização da aplicação. O gate remoto Worker → Hyperdrive → Neon precisa passar antes das features tenant; os casos obrigatórios estão registrados no [ADR 0002](../adr/0002-neon-postgresql18-hyperdrive-rls.md).

## Identidade e ownership do domínio

Better Auth é responsável por identidade, credenciais e sessões. Organização, membership, capabilities, billing e entitlements são dados do domínio Polaris. O cliente pode solicitar uma organização, mas não autorizar seu próprio acesso.

## Operação offline

Mutations offline usam commands idempotentes e versionados. O servidor valida cada command e permanece autoritativo; command pendente local ainda não é venda aceita. TanStack DB é o primeiro candidato de persistência local; Dexie e IndexedDB são fallback. O protocolo de sync não depende da escolha de storage.

## Infraestrutura posterior

Mídia no R2 permanece privada por padrão; o catálogo público só expõe conteúdo autorizado pela aplicação. Queues, Workflows, Staging, release automation e recovery entram quando as respectivas milestones exigirem esses mecanismos.
