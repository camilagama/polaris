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

As tabelas organizations e memberships usam FORCE ROW LEVEL SECURITY e policies de SELECT conforme o contexto de membership ativo. A role principal HYPERDRIVE recebe somente SELECT nessas tabelas; GUCs transaction-local são contexto mutável, não identidade nem defesa contra SQL arbitrário. O onboarding autentica a sessão Better Auth no Worker e chama uma única função SECURITY DEFINER pela binding ONBOARDING_HYPERDRIVE, com a role polaris_onboarding_runtime dedicada: a role tenant comum não executa a função e não recebe DML em organizations/memberships. A função revalida email_verified, aplica lock/idempotência e grava organização, membership e auditoria atomicamente. Categories é a primeira entidade de negócio com FORCE RLS; o PR24 adiciona renomeação, archive/restore, tombstone, leitura serializável compatível com futuro offline e UI mínima, sem sync.

RLS é defesa em profundidade, não substituto da autorização da aplicação. O gate remoto Worker → Hyperdrive → Neon precisa passar antes das features tenant; os casos obrigatórios estão registrados no [ADR 0002](../adr/0002-neon-postgresql18-hyperdrive-rls.md) e no [runbook de contexto tenant](../runbooks/tenant-context-gate.md).

## Identidade e ownership do domínio

Better Auth é responsável por identidade, credenciais e sessões. Organização, membership, capabilities, billing e entitlements são dados do domínio Polaris. O cliente pode solicitar uma organização, mas não autorizar seu próprio acesso.

## Operação offline

Mutations offline usam commands idempotentes e versionados. O servidor valida cada command e permanece autoritativo; command pendente local ainda não é venda aceita. TanStack DB é o primeiro candidato de persistência local; Dexie e IndexedDB são fallback. O protocolo de sync não depende da escolha de storage.

## Infraestrutura posterior

Mídia no R2 permanece privada por padrão; o catálogo público só expõe conteúdo autorizado pela aplicação. O master WebP de até 1200 px é fonte imutável; derivados 320/640 são cache regenerável e também passam pela autorização tenant. O cron horário reconcilia markers de staging e masters órfãos com uma role Hyperdrive dedicada, sem query caching. Nenhuma mídia é servida por bucket público. Queues, Workflows, release automation e recovery entram quando as respectivas milestones exigirem esses mecanismos.
Mutações tenant críticas escrevem `tenant_audit_event` na mesma transação da mutação, usando a identidade já autorizada. O runtime só pode inserir eventos e não pode consultá-los ou alterá-los nesta etapa; payload livre e snapshots não são armazenados. A política de retenção continua pendente para go-live, e a purga física da organização remove seus eventos.

A confirmação de venda (`sale.confirm`, PR43) é a primeira escrita multi-tabela de negócio: uma única transação tenant grava `sales`, `sale_items`, `sale_adjustments`, `sale_payments`, os movimentos `sale` do ledger, o saldo e a auditoria. O runtime recebe INSERT (com policy de organização) e nenhum UPDATE/DELETE nas quatro tabelas de venda; como o grant de INSERT é genérico, a função `check_sale_confirmation_complete` roda em gatilhos de restrição deferidos e recusa no commit qualquer venda incompleta, itens acrescentados depois ou movimento `sale` sem venda. Não há outbox transacional no servidor nesta etapa.

A atribuição de cliente (PR44) é um histórico versionado e somente de acréscimo em `sale_customer_links`, escrito por comandos nomeados (`assign`, `reassign`, `unassign`) com `expectedVersion`, na mesma transação da auditoria. Ela nunca toca as tabelas econômicas da venda; o runtime tem SELECT e INSERT apenas, e o gatilho `guard_sale_customer_link_transition` impõe a sequência de versões, as transições válidas e o cliente ativo da mesma organização.

O cancelamento de venda (PR45) segue ADR 0005: registro compensatório em `sale_cancellations` mais movimentos inversos do ledger na mesma transação, sem editar a venda. Gatilhos deferidos (`check_sale_cancellation_complete`) garantem no commit que todo cancelamento inverte todos os itens. A leitura de vendas (`sale.list`, `sale.get`) usa a capability `sale:read` e deriva o status da existência do cancelamento.

A devolução parcial (PR46) também é compensatória (ADR 0005): `sale_returns` e `sale_return_items` mais movimentos inversos apenas para as unidades repostas, na mesma transação. Devolução e cancelamento de uma venda serializam por um lock consultivo de transação (`lockSaleForCompensation`) e o banco repete as regras no commit (`check_sale_return_complete`, e `check_sale_cancellation_complete` recusa venda com devoluções).

As datas da venda (PR47) ficam separadas: `occurred_at` (momento comercial), `occurred_on` (data comercial no calendário da organização, calculada no servidor a partir do fuso da organização lido dentro da transação tenant), `recorded_at` (evidência do dispositivo) e `confirmed_at` (relógio do servidor, `clock_timestamp()`). O banco exige que todo movimento `sale` tenha a data comercial da venda (`check_sale_confirmation_complete`). A janela retroativa depende do papel e é aplicada depois do replay; a tolerância de futuro é de 5 minutos.
