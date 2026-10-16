---
status: accepted
---

# Fase 8 (catálogo público) antes do Gate 7

## Contexto

O plano põe o Gate 7 (billing provado com sandboxes reais do provedor de pagamento) entre a Fase 7 e a Fase 8. O Gate 7 depende de contas sandbox do provedor e dos adaptadores reais (PR77, PR78, PR80), que ainda não existem: o núcleo de billing, a rota de webhooks, a manutenção horária, o reembolso, o chargeback e as concessões já estão implementados e provados em PostgreSQL 18, mas a prova com o provedor não pode ser executada sem as contas. Esperar por elas pararia o resto do roadmap, e a Fase 8 não depende do provedor: ela depende apenas de o plano em vigor dizer se o catálogo público está incluído (`public_catalog`), o que o motor de entitlements já responde, inclusive para concessões.

## Decisão

- A Fase 8 é implementada **antes** do Gate 7. Isso muda a ordem do plano, por isso este ADR e uma nota datada na seção 0 do plano (ADR 0016).
- O Gate 7 continua sendo o gate de saída do billing e **não é dispensado**: ele roda quando as contas sandbox existirem, antes de qualquer cobrança real e antes do go-live. Nenhum código da Fase 8 supõe que ele já passou.
- A Fase 8 é entregue em quatro pull requests coesos: 8A (dados e comandos do catálogo público, PR87 e PR88, com o gate de banco), 8B (aplicação `apps/catalog` e SEO, PR86 e PR90), 8C (rota pública de mídia e despublicação, PR89 e PR91) e 8D (interface do ERP para o perfil e a publicação). O gate da fase cresce a cada pull request (`bun run gates:gate8`).

## Consequências

- O roadmap segue sem esperar por contas de terceiros; o risco de billing que o Gate 7 cobre (webhooks reais, ordem de eventos do provedor) continua aberto e registrado no status.
- O catálogo público depende só de uma leitura do plano que já está provada, então não cria dívida contra o provedor.

## Alternativas rejeitadas

- **Esperar o Gate 7 para começar a Fase 8:** bloqueia trabalho que não depende do provedor.
- **Considerar o Gate 7 satisfeito pelos gates de banco:** os gates de banco provam a máquina de estados, não o comportamento real do provedor; chamar isso de Gate 7 enfraqueceria o critério.
