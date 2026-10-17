# Visão geral do sistema

Este documento é a fonte de verdade para a **estrutura do sistema**: aplicações, pacotes, fronteiras, acesso a dados e infraestrutura. Ele descreve o desenho vigente e aponta para os ADRs que explicam as escolhas; invariantes de negócio estão em [business-rules/](../business-rules/), termos em [CONTEXT.md](../../CONTEXT.md) e a sequência de implementação em [doc/plano-inicial.md](../../doc/plano-inicial.md). Decisões já tomadas mas ainda não implementadas aparecem nos ADRs, com o estado de implementação indicado.

O Polaris começa como um monólito modular TypeScript, priorizando Cloudflare Workers e usando Neon PostgreSQL ([ADR 0001](../adr/0001-cloudflare-modular-monolith.md)). A lógica de domínio permanece separada de runtime, transporte e persistência; a V1 não é uma coleção de microsserviços.

## Aplicações e packages

- apps/web é o ERP autenticado: React/Vite servido com seu Worker; Hono e oRPC expõem as procedures do servidor.
- apps/admin é um deployment separado para operações da plataforma, protegido por Cloudflare Access e capabilities internas. Não compartilha a sessão Better Auth do ERP. O Worker verifica o token do Access em todo pedido, acha o operador por emissor e subject e pede uma capacidade nomeada por rota; seu papel de banco só lê os principais ([ADR 0070](../adr/0070-admin-acesso-identidade-e-capacidades.md)).
- apps/catalog é uma aplicação pública separada para conteúdo de catálogo explicitamente publicado. Ela não lê tabela alguma: um papel de banco dedicado executa quatro funções que devolvem só o que está publicado e olham o plano a cada pedido ([ADR 0069](../adr/0069-catalogo-publico-leitura-por-funcoes.md)).
- packages/domain contém lógica de negócio pura.
- packages/contracts contém contratos de transporte.
- packages/db contém adapters de persistência e migrations.
- packages/billing contém adapters de providers de assinatura.
- packages/ui contém componentes de apresentação compartilhados.

Os workspaces billing e ui são, por enquanto, apenas estrutura prevista; o admin tem a verificação de acesso, `/api/whoami` o diagnóstico de organizações (contagens, datas e estados, [ADR 0071](../adr/0071-admin-diagnostico-sem-acesso-ao-tenant.md)) e os casos de suporte com acesso temporário, leitura mascarada e revelação auditada ([ADR 0072](../adr/0072-admin-casos-acesso-temporario-e-revelacao.md)), sempre por funções que o papel do Admin executa sem ler nenhuma tabela; o catalog já tem a aplicação pública de leitura (páginas da loja e do produto, SEO, `robots.txt` e a rota pública de imagens, que lê o bucket privado só depois de a base autorizar o pedido); ter um pacote na arquitetura não significa que sua funcionalidade esteja pronta.

O Worker de Web responde por autenticação, procedures, mídia, health, sincronização, acesso ao banco e bindings assíncronos. A V1 não tem um deployment apps/api separado. A casca da SPA é servida pelos Static Assets sem passar pelo Worker, então seus headers de segurança são configurados à parte ([ADR 0027](../adr/0027-separacao-de-roles-auth-tenant-e-superficies-poc.md)).

## Acesso a dados e isolamento por organização

PostgreSQL 18 no Neon é o baseline ([ADR 0002](../adr/0002-neon-postgresql18-hyperdrive-rls.md)). Hyperdrive fornece connection pooling com SQL query caching desabilitado para caminhos tenant e Admin.

Uma request tenant resolve a sessão Better Auth antes de abrir a transação de dados. O servidor recebe a organização solicitada como contexto não confiável; dentro de uma única transação explícita, define app.user_id com o ID da sessão, lê apenas o membership próprio, valida membership ativo e a capability no mapa de domínio, define app.organization_id e lê uma organização ativa. Só então chama o callback tenant. Os dois GUCs são transaction-local e não substituem autenticação nem autorização da aplicação.

As tabelas de domínio usam FORCE ROW LEVEL SECURITY com policies por organização, e as chaves estrangeiras são compostas com a organização. A role principal de tenant recebe apenas os privilégios mínimos de cada tabela; GUCs transaction-local são contexto mutável, não identidade nem defesa contra SQL arbitrário. O onboarding autentica a sessão Better Auth no Worker e chama uma única função SECURITY DEFINER pela binding ONBOARDING_HYPERDRIVE, com a role polaris_onboarding_runtime dedicada ([ADR 0007](../adr/0007-gate2-onboarding-and-category-rls.md)). A separação entre a role de autenticação e a role de tenant é decisão do [ADR 0027](../adr/0027-separacao-de-roles-auth-tenant-e-superficies-poc.md).

RLS é defesa em profundidade, não substituto da autorização da aplicação. O gate remoto Worker → Hyperdrive → Neon precisa passar antes das features tenant; os casos obrigatórios estão registrados no [ADR 0002](../adr/0002-neon-postgresql18-hyperdrive-rls.md) e no [runbook de contexto tenant](../runbooks/tenant-context-gate.md). A estratégia de provas de banco está no [ADR 0025](../adr/0025-estrategia-de-testes-de-banco.md).

Instantes são guardados em UTC; datas de negócio usam o fuso da organização ([ADR 0024](../adr/0024-colunas-de-instante-timestamptz.md), [time-and-dates.md](../business-rules/time-and-dates.md)).

## Identidade e ownership do domínio

Better Auth é responsável por identidade, credenciais e sessões; organização, membership, capabilities, billing e entitlements são dados do domínio Polaris ([ADR 0004](../adr/0004-separar-autenticacao-de-tenancy.md)). O cliente pode solicitar uma organização, mas não autorizar seu próprio acesso. A política de sessão e de conta está no [ADR 0017](../adr/0017-politica-de-sessao-e-conta.md); as capabilities finas, atribuídas só ao owner na V1, no [ADR 0022](../adr/0022-capabilities-finas-apenas-owner.md).

## Auditoria

Mutações tenant críticas escrevem `tenant_audit_event` na mesma transação da mutação, usando a identidade já autorizada ([ADR 0006](../adr/0006-audit-events-tenant.md)). O runtime só pode inserir eventos e não pode consultá-los ou alterá-los nesta etapa; payload livre e snapshots não são armazenados. A política de retenção continua pendente para go-live, e a purga física da organização remove seus eventos.

## Estoque e vendas

O estoque é um ledger de movimentos imutáveis mais um saldo por variante, que mudam juntos por comandos nomeados. A venda é um snapshot econômico confirmado em uma única transação e corrigido apenas por registros compensatórios (cancelamento total e devolução parcial). O modelo de dados, os fluxos, os locks e os triggers estão em [sales-data-model.md](sales-data-model.md); as regras, em [inventory.md](../business-rules/inventory.md) e [sales.md](../business-rules/sales.md); as razões, nos [ADR 0005](../adr/0005-corrigir-vendas-confirmadas-com-registros-compensatorios.md), [0019](../adr/0019-venda-atomica-por-constraint-triggers-deferidos.md), [0020](../adr/0020-cancelamento-e-devolucao-compensatorios.md) e [0021](../adr/0021-datas-da-venda-e-janela-retroativa.md).

Despesas são lançamentos por competência com categoria da organização, anuláveis e versionados, sem relação com o ledger de estoque. O modelo está em [expenses-data-model.md](expenses-data-model.md); as regras, em [expenses-and-results.md](../business-rules/expenses-and-results.md); a razão, no [ADR 0051](../adr/0051-despesas-categorias-e-lancamentos.md).

## Operação offline

Mutations offline usam commands idempotentes e versionados. O servidor valida cada command e permanece autoritativo; command pendente local ainda não é venda aceita ([ADR 0003](../adr/0003-offline-command-protocol.md)). A persistência local escolhida é TanStack DB com SQLite WASM em OPFS para as coleções e IndexedDB para o outbox, com Dexie como fallback; a escolha, os riscos e as condições estão no [ADR 0015](../adr/0015-offline-persistence-tanstack-db-opfs-indexeddb.md). O protocolo de sync não depende da escolha de storage. A Fase 5 do plano ainda não foi iniciada.

## Infraestrutura posterior

Mídia no R2 permanece privada por padrão; o catálogo público só expõe conteúdo autorizado pela aplicação. O master WebP de até 1200 px é fonte imutável; derivados 320/640 são cache regenerável e também passam pela autorização tenant. O cron horário reconcilia markers de staging e masters órfãos com uma role Hyperdrive dedicada, sem query caching. Nenhuma mídia é servida por bucket público ([ADR 0013](../adr/0013-product-media-ownership-and-order.md), [0014](../adr/0014-private-media-derivatives-and-reconciliation.md), [0018](../adr/0018-midia-privada-cloudflare-images-r2.md)). Queues, Workflows, release automation e recovery entram quando as respectivas milestones exigirem esses mecanismos.
