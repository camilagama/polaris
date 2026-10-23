# Mapa de documentação

Cada assunto possui uma fonte de verdade, e cada documento declara sua própria autoridade:

- objetivos, público, escopo e hipóteses comerciais: [PRODUCT.md](../PRODUCT.md);
- linguagem do domínio: [CONTEXT.md](../CONTEXT.md);
- direção visual, telas e interação: [DESIGN.md](../DESIGN.md);
- fluxo de trabalho e guardrails para agentes: [AGENTS.md](../AGENTS.md);
- estrutura do sistema, modelo de dados e fluxos: [architecture/](architecture/);
- decisões técnicas difíceis de reverter e seus motivos: [adr/](adr/);
- invariantes de domínio: [business-rules/](business-rules/);
- procedimentos operacionais repetíveis e checklist de go-live: [runbooks/](runbooks/);
- invariantes do domínio ligadas aos testes que as provam, e o padrão dos testes de propriedade: [testing/property-invariants.md](testing/property-invariants.md).

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
| [0047](adr/0047-abrir-o-app-sem-rede.md) | Abrir o app sem rede: a cópia das organizações | aceito |
| [0048](adr/0048-tela-de-aparelhos.md) | Tela de aparelhos: revogar um celular perdido | aceito |
| [0049](adr/0049-perfil-de-pagamento-na-venda-sem-conexao.md) | Perfil de pagamento na venda sem conexão | aceito |
| [0050](adr/0050-edicao-de-cliente-sem-conexao.md) | Edição de cliente sem conexão: versão editada e conflito visível | aceito |
| [0051](adr/0051-despesas-categorias-e-lancamentos.md) | Despesas: categorias e lançamentos | aceito |
| [0052](adr/0052-despesas-recorrentes.md) | Despesas recorrentes: regra, ocorrências geradas ao vencer | aceito |
| [0053](adr/0053-motor-de-resultado-economico.md) | Motor de resultado econômico: margem da venda e resultado do período | aceito |
| [0054](adr/0054-painel-de-resultado-e-indicador-de-qualidade.md) | Painel de resultado e indicador de qualidade | aceito |
| [0055](adr/0055-metas.md) | Metas: alvo por período, progresso derivado, conclusão que não reabre | aceito |
| [0056](adr/0056-leitura-offline-do-painel.md) | Leitura offline do painel: o último retrato confirmado | aceito |
| [0057](adr/0057-catalogo-de-planos-e-entitlements.md) | Catálogo de planos, entitlements e estado de assinatura | aceito |
| [0058](adr/0058-cotas-do-plano-no-servidor.md) | Cotas do plano aplicadas no servidor | aceito |
| [0059](adr/0059-remover-e-reordenar-imagens-de-produto.md) | Remover e reordenar imagens de produto | aceito |
| [0060](adr/0060-ci-economico-em-minutos.md) | CI econômico em minutos do GitHub Actions | aceito |
| [0061](adr/0061-limpeza-de-imagens-removidas.md) | Limpeza dos objetos de imagens removidas | aceito |
| [0062](adr/0062-ciclo-de-vida-do-billing-e-caixa-de-entrada.md) | Ciclo de vida do billing e caixa de entrada de eventos | aceito |
| [0063](adr/0063-rota-de-webhooks-de-billing.md) | Rota de webhooks de billing, porta de adaptador e manutenção horária | aceito |
| [0064](adr/0064-free-acima-do-limite-variantes-operacionais.md) | Free acima do limite: variantes operacionais | aceito |
| [0065](adr/0065-efeitos-do-downgrade-metas-pausadas.md) | Efeitos do downgrade sobre metas, imagens, lease offline e catálogo público | aceito |
| [0066](adr/0066-reembolso-e-chargeback.md) | Reembolso e chargeback da assinatura | aceito |
| [0067](adr/0067-concessoes-temporarias-de-entitlement.md) | Concessões temporárias de entitlement | aceito |
| [0068](adr/0068-fase-8-antes-do-gate-7.md) | Fase 8 (catálogo público) antes do Gate 7 | aceito |
| [0069](adr/0069-catalogo-publico-leitura-por-funcoes.md) | Catálogo público: leitura somente por funções, plano lido a cada pedido | aceito |
| [0070](adr/0070-admin-acesso-identidade-e-capacidades.md) | Admin: login pelo Cloudflare Access, principal de plataforma e capacidades | aceito |
| [0071](adr/0071-admin-diagnostico-sem-acesso-ao-tenant.md) | Admin: diagnóstico de organização sem acesso ao tenant | aceito |
| [0072](adr/0072-admin-casos-acesso-temporario-e-revelacao.md) | Admin: casos de suporte, acesso temporário ao tenant e revelação de dados pessoais | aceito |
| [0073](adr/0073-admin-suspensao-e-comandos-de-cobranca.md) | Admin: suspensão de organização e comandos de cobrança | aceito |
| [0074](adr/0074-encerramento-de-organizacao.md) | Encerramento de organização e janela de recuperação | aceito |
| [0075](adr/0075-anonimizacao-de-cliente-por-privacidade.md) | Anonimização de cliente por privacidade | aceito |
| [0076](adr/0076-teto-de-custo-e-free-tier-primeiro.md) | Teto de custo e free tier primeiro | aceito |
| [0077](adr/0077-casos-de-privacidade.md) | Casos de privacidade: o fluxo interno de um pedido sobre dado pessoal | aceito |
| [0078](adr/0078-exportacao-de-dados-da-organizacao.md) | Exportação de dados da organização: uma cópia a pedido do dono, feita em segundo plano | aceito |
| [0079](adr/0079-retencao-por-classe-de-dado.md) | Retenção por classe de dado | aceito |
| [0080](adr/0080-ledger-minimo-de-exclusoes.md) | Ledger mínimo de exclusões para restore | aceito |
| [0081](adr/0081-purge-completo-da-organizacao-encerrada.md) | Purge completo da organização encerrada | aceito |
| [0082](adr/0082-outbox-transacional.md) | Outbox transacional | aceito |
| [0083](adr/0083-filas-cloudflare-e-consumidor-idempotente.md) | Filas Cloudflare e consumidor idempotente | aceito |
| [0084](adr/0084-despachante-e-varredor-do-outbox.md) | Despachante e varredor do outbox | aceito |
| [0085](adr/0085-dlq-incidente-operacional-e-retry-no-admin.md) | DLQ, incidente operacional e retry no Admin | aceito |
| [0086](adr/0086-framework-de-jobs-agendados.md) | Framework de jobs agendados | aceito |
| [0087](adr/0087-referencia-do-provedor-em-todos-os-fatos-de-cobranca.md) | A referência do provedor em todos os fatos de cobrança | aceito |
| [0088](adr/0088-workflows-so-quando-necessario.md) | Cloudflare Workflows: nenhum por ora; a exportação fica no consumidor da fila | aceito |
| [0089](adr/0089-evlog-e-logger-tipado-no-backend.md) | evlog e um logger tipado no backend | aceito |
| [0090](adr/0090-headers-de-seguranca-centralizados.md) | Headers de segurança e CSP centralizados num módulo único | aceito |
| [0091](adr/0091-esquema-canonico-de-eventos-largos.md) | Esquema canônico de campos e eventos largos | aceito |
| [0092](adr/0092-registro-de-acesso-a-aplicacao.md) | Registro de acesso a aplicação (Marco Civil, art. 15) | aceito |
| [0093](adr/0093-funcoes-security-definer-e-privilegios-padrao.md) | Funções SECURITY DEFINER e privilégios padrão do banco | aceito |
| [0094](adr/0094-tracing-e-amostragem-do-workers-observability.md) | Tracing e amostragem do Workers Observability | aceito |
| [0095](adr/0095-onde-os-alertas-operacionais-vao-rodar.md) | Onde os alertas operacionais vão rodar | proposto |
| [0096](adr/0096-migrations-compativeis-com-a-versao-anterior-do-worker.md) | Migrations compatíveis com a versão anterior do Worker (expand/contract) | aceito |
| [0097](adr/0097-staging-fixo-e-producao-em-conta-separada.md) | Staging fixo na conta atual e produção em conta separada | aceito |
| [0098](adr/0098-sentry-no-navegador-so-erros-e-sanitizado.md) | Sentry no navegador: só erros, sanitizado, com source maps escondidos | aceito |
| 0099 | Reservado (backup) | reservado |
| [0100](adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md) | Tela de entrada: e-mail e senha atrás de flag, bloqueio de conta no banco e aceite legal registrado | aceito |
| [0101](adr/0101-adaptador-asaas-porta-de-saida-e-releitura-do-recurso.md) | Adaptador Asaas: porta de saída, releitura do recurso e período pelo vencimento original | aceito |
| [0102](adr/0102-apagamento-automatico-da-loja-encerrada.md) | Apagamento automático da loja encerrada, sem caso de privacidade | aceito |
| [0103](adr/0103-base-de-componentes-shadcn-base-ui-e-tailwind-4.md) | Base de componentes: shadcn na variante Base UI com Tailwind 4 | aceito |

ADRs novos usam o formato Contexto, Decisão, Consequências e Alternativas consideradas.
