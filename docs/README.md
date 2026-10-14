# Mapa de documentação

Cada assunto possui uma fonte de verdade, e cada documento declara sua própria autoridade:

- objetivos, público, escopo e hipóteses comerciais: [PRODUCT.md](../PRODUCT.md);
- linguagem do domínio: [CONTEXT.md](../CONTEXT.md);
- direção visual, telas e interação: [DESIGN.md](../DESIGN.md);
- fluxo de trabalho e guardrails para agentes: [AGENTS.md](../AGENTS.md);
- estrutura do sistema, modelo de dados e fluxos: [architecture/](architecture/);
- decisões técnicas difíceis de reverter e seus motivos: [adr/](adr/);
- invariantes de domínio: [business-rules/](business-rules/);
- procedimentos operacionais repetíveis e checklist de go-live: [runbooks/](runbooks/).

[doc/doc-inicial.md](../doc/doc-inicial.md) é o material original de produto e arquitetura. [doc/plano-inicial.md](../doc/plano-inicial.md) é a autoridade para a sequência de implementação e os critérios dos gates ([ADR 0016](adr/0016-ordem-das-fases-gate-auth-e-gate-2.md)). [doc/status-implementacao.md](../doc/status-implementacao.md) registra o estado de entrega, sem criar regras. [doc/checkpoint-gate4.md](../doc/checkpoint-gate4.md) e [doc/revisao-checkpoint-gate4.md](../doc/revisao-checkpoint-gate4.md) são o dossiê e a revisão do fim da Fase 4. Para conteúdo de produto, termos, design, arquitetura e invariantes, use os arquivos canônicos acima. Quando essas fontes exigirem uma mudança, atualize o plano no mesmo pull request.

## Regras de higiene

- Cada regra vive em um único arquivo; os demais apenas linkam. A janela retroativa e a tolerância de futuro, por exemplo, vivem somente em [time-and-dates.md](business-rules/time-and-dates.md).
- Documentos canônicos não carregam histórico de PR: números de PR e estado de entrega ficam no status; modelo de dados e fluxos, em architecture/; comportamento de interface, em DESIGN.md; a razão das decisões, nos ADRs.
- Decisões ainda não implementadas são descritas como "decididas na revisão do checkpoint Gate 4 (13/10/2026)" e indicam que o código deve ser conferido.

## Decisões arquiteturais (ADRs)

| ADR | Assunto | Estado |
| --- | --- | --- |
| [0001](adr/0001-cloudflare-modular-monolith.md) | Monólito modular em Cloudflare | aceito |
| [0002](adr/0002-neon-postgresql18-hyperdrive-rls.md) | Neon PostgreSQL 18, Hyperdrive e RLS | parcialmente superado (0007, 0027) |
| [0003](adr/0003-offline-command-protocol.md) | Protocolo offline independente do storage | aceito |
| [0004](adr/0004-separar-autenticacao-de-tenancy.md) | Autenticação separada de tenancy | aceito |
| [0005](adr/0005-corrigir-vendas-confirmadas-com-registros-compensatorios.md) | Correção por registros compensatórios | aceito |
| [0006](adr/0006-audit-events-tenant.md) | Auditoria tenant | aceito |
| [0007](adr/0007-gate2-onboarding-and-category-rls.md) | Onboarding isolado e RLS de Categories | aceito |
| [0008](adr/0008-inventory-cost-precision.md) | Precisão do custo médio | aceito |
| [0009](adr/0009-legacy-receipt-compatibility.md) | Recebimentos legados | aceito |
| [0010](adr/0010-inventory-write-off.md) | Baixa de estoque | aceito |
| [0011](adr/0011-inventory-count.md) | Contagem física | aceito |
| [0012](adr/0012-product-tombstone-zero-balance.md) | Tombstone de produto | aceito |
| [0013](adr/0013-product-media-ownership-and-order.md) | Propriedade e ordem da mídia | aceito |
| [0014](adr/0014-private-media-derivatives-and-reconciliation.md) | Derivados privados e reconciliação | aceito |
| [0015](adr/0015-offline-persistence-tanstack-db-opfs-indexeddb.md) | Persistência offline: TanStack DB, OPFS e IndexedDB | aceito |
| [0016](adr/0016-ordem-das-fases-gate-auth-e-gate-2.md) | Ordem das fases, Gate Auth e Gate 2 | aceito |
| [0017](adr/0017-politica-de-sessao-e-conta.md) | Política de sessão e de conta | aceito |
| [0018](adr/0018-midia-privada-cloudflare-images-r2.md) | Mídia: Cloudflare Images, WebP e R2 privado | aceito |
| [0019](adr/0019-venda-atomica-por-constraint-triggers-deferidos.md) | Venda atômica e idempotência | aceito |
| [0020](adr/0020-cancelamento-e-devolucao-compensatorios.md) | Cancelamento, devolução, média e produto removido | aceito |
| [0021](adr/0021-datas-da-venda-e-janela-retroativa.md) | Datas da venda e janela retroativa | aceito |
| [0022](adr/0022-capabilities-finas-apenas-owner.md) | Capabilities finas só para owner | aceito |
| [0023](adr/0023-integracao-da-cadeia-de-prs.md) | Integração da cadeia de PRs | aceito |
| [0024](adr/0024-colunas-de-instante-timestamptz.md) | Instantes em `timestamptz` | aceito |
| [0025](adr/0025-estrategia-de-testes-de-banco.md) | Testes de banco: Neon descartável e CI | aceito |
| [0026](adr/0026-ui-de-estoque-organizacao-pela-sessao-e-preco-de-tabela.md) | UI de estoque, organização pela sessão e preço de tabela | aceito |
| [0027](adr/0027-separacao-de-roles-auth-tenant-e-superficies-poc.md) | Separação de roles auth e tenant, superfícies PoC | aceito |
| [0028](adr/0028-dispositivos-e-grants-offline.md) | Dispositivos e grants de autorização offline | aceito |
| [0029](adr/0029-lease-de-autorizacao-offline.md) | Lease de autorização offline e época de autorização | aceito |
| [0030](adr/0030-change-log-de-sincronizacao.md) | Change log de sincronização com sequência por organização | aceito |
| [0031](adr/0031-colecoes-locais-e-bootstrap.md) | Coleções locais por usuário e organização, e bootstrap | aceito |
| [0032](adr/0032-outbox-duravel-de-comandos.md) | Outbox durável de comandos e a prova em Android antes da escrita offline | aceito |
| [0033](adr/0033-protocolo-sync-push.md) | Protocolo do sync.push | aceito |
| [0034](adr/0034-cliente-criado-offline.md) | Cliente criado offline | aceito |
| [0035](adr/0035-produto-criado-offline.md) | Produto criado offline | aceito |
| [0036](adr/0036-comandos-de-estoque-offline.md) | Comandos de estoque offline | aceito |
| [0037](adr/0037-venda-offline.md) | Venda offline | aceito |
| [0038](adr/0038-painel-de-atencao-offline.md) | Painel de atenção das operações offline | aceito |
| [0039](adr/0039-saida-com-operacoes-pendentes.md) | Sair com operações pendentes | aceito |
| [0040](adr/0040-service-worker-do-app-shell.md) | Service worker do app shell | aceito |
| [0041](adr/0041-ciclo-de-atualizacao-do-app.md) | Ciclo de atualização do app | aceito |
| [0042](adr/0042-suite-de-navegador-do-offline-e-versoes.md) | Suíte de navegador do offline e compatibilidade entre versões | aceito |
| [0043](adr/0043-runtime-offline-no-app.md) | Runtime offline no app | aceito |
| [0044](adr/0044-revisao-de-seguranca-adicional.md) | Revisão de segurança adicional antes do merge | aceito |
| [0045](adr/0045-telas-lendo-do-aparelho.md) | Telas que leem do aparelho: clientes e produtos | aceito |
| [0046](adr/0046-venda-e-estoque-sem-conexao.md) | Venda e estoque sem conexão: o servidor quando alcançável, o aparelho quando não | aceito |

ADRs novos usam o formato Contexto, Decisão, Consequências e Alternativas consideradas.
