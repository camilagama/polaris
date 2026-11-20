---
status: accepted
---

# Teto de custo e free tier primeiro

Aceito pelo responsável em 18/10/2026.

## Contexto

O Polaris roda em serviços com franquia gratuita — Cloudflare Workers Free, R2, Cloudflare Images (Transformations Free), Hyperdrive, Neon Free, Resend Free, Sentry Developer e GitHub — e nenhum plano pago de infraestrutura está contratado para o Polaris. Sem um teto declarado, o primeiro estouro de cota vira cobrança inesperada ou indisponibilidade silenciosa, e cada serviço reagiria de um jeito. O usuário decidiu manter os serviços no free tier por enquanto; o Workers Paid, em particular, não foi contratado. Alertas de orçamento da Cloudflare em US$ 1, US$ 5, US$ 6 e US$ 10 já existem.

## Decisão

- **Teto de US$ 10 por mês, BRUTO, para a infraestrutura de desenvolvimento do Polaris.** Nenhum gasto acima disso sem nova decisão do responsável.
- **Tudo no free tier:** Cloudflare Workers Free, R2, Cloudflare Images (Transformations Free), Hyperdrive, Neon Free, Resend Free, Sentry Developer e GitHub.
- **Workers Paid não contratado.** Decisão do usuário: manter Free por enquanto.
- **Asaas e Woovi ficam fora do teto:** são custo por transação do cliente (repasse), não infraestrutura de desenvolvimento da plataforma.
- **Assinatura GitHub Pro da conta:** assinatura da conta, fora deste teto (decisão do responsável, 16/10/2026).
- **Upgrade pago só com decisão explícita do responsável.** Nenhum serviço sobe de plano sozinho ao bater cota.
- **Cada serviço degrada com segurança ao bater cota:** servir o que existe, avisar e/ou enfileirar, sem cobrar e sem quebrar a tela. Para mídia, o fallback acima da franquia do Images está na emenda ao [ADR 0018](0018-midia-privada-cloudflare-images-r2.md); as cotas de plano já vivem no servidor ([ADR 0058](0058-cotas-do-plano-no-servidor.md)).
- **Gatilhos de revisão (aceitos com o ADR em 18/10/2026; ajustáveis por emenda):** Neon — 60% do armazenamento (600 MB de 1 GB por projeto) ou 70% da computação (70 de 100 CU-h/mês por projeto), conforme os [planos do Neon](https://neon.com/docs/introduction/plans); Images — 50% das 5.000 transformações únicas no mês, conforme os [preços do Cloudflare Images](https://developers.cloudflare.com/images/pricing); Resend — 50% da cota mensal (1.500 de 3.000) ou 80% da diária (80 de 100), conforme as [cotas do Resend](https://resend.com/docs/knowledge-base/account-quotas-and-limits).
- **GitHub Actions (conta camilagama, plano Pro):** o bloqueio tem duas causas compatíveis — a franquia de 3.000 minutos/mês do Pro é da conta e se esgotou em outubro somando os dois repositórios: cerca de 3.150 min no total (painel, 16/10), dos quais aproximadamente 2.020 no polaris (compatível com os ~1.890 min cobrados citados no [ADR 0060](0060-ci-economico-em-minutos.md)) e 1.120 no polaris-erp, outro repositório da conta camilagama, público; os minutos contados contra a franquia foram consumidos enquanto polaris e polaris-erp eram privados, e desde que ficaram públicos os minutos não contam; e o orçamento de Actions está em US$ 0 com status "Usage blocked" (lido no painel Budgets em 16/10) —, então o excedente é bloqueado em vez de cobrado. O repositório ficou público em 15/10/2026 e permanece público até o lançamento. Fonte dos limites: [GitHub Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions).

## Emenda de 19/11/2026: cota diária de consultas do Hyperdrive

O Hyperdrive no Workers Free tem **100.000 consultas por dia**, e conta "qualquer statement" enviado por ele, com ou sem cache. O contador reinicia às 00:00 UTC (21:00 em Brasília). Passado o limite, "further operations of that type will fail with an error" ([preços do Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/), lido em 19/11/2026). Pela doc, passado o limite as consultas falham até o reinício. Que o limite seja da conta toda (e não de cada configuração) é **inferência**: o Worker do catálogo, com 56 consultas em 24 h, falhou junto com o web. O roteiro para reconhecer e agir está em [Cota diária de consultas do Hyperdrive acabou](../runbooks/staging.md#cota-diária-de-consultas-do-hyperdrive-acabou).

- **Provado (doc oficial):** o limite de 100.000 por dia, o que conta e o reinício às 00:00 UTC.
- **Medido (painel e GraphQL em 19/11):** o painel do Hyperdrive mostrou 150,8 mil consultas em 24 h no incidente (tenant 112,96 mil, auth 34,86 mil, billing 2,28 mil, outbox 349, privacy 254, catalog 56, media-cleanup 23). A consulta `hyperdriveQueriesAdaptiveGroups` do GraphQL da Cloudflare deu 142.581 consultas em 19/11 UTC.
- **Inferência, não provada:** que a cota esgotada às 03:05Z de 19/11 seja a causa dos 5xx. O que a sustenta: queda abrupta e total em todos os papéis, falha de ~5 ms, banco saudável por outro caminho, erro que continuou depois que a carga caiu e 150,8 mil acima de 100 mil. O texto exato do erro não foi visto (os logs só trazem a classe).
- **Não provado:** o contador exato e se BEGIN, COMMIT e SET contam como consulta (a doc diz "qualquer statement", sem detalhar); o instante em que o contador cruzou 100.000; se o painel soma as consultas recusadas (150,8 mil acima de 100 mil sugere que sim, ou que o corte não é exato); e o cartão "Total de consultas" do painel, que mostrou 0 / 100.000 na mesma leitura e não deve ser usado como prova.
- **Alerta antes do teto:** proposta, sem decisão; este ADR não registra limiar de alarme. Subir de plano continua decisão do responsável, como no restante deste ADR.

## Consequências

- O custo de desenvolvimento fica limitado e previsível; não há cobrança surpresa sem decisão humana.
- Cota estourada bloqueia ou degrada em vez de cobrar, então o produto precisa continuar utilizável no free tier; a emenda ao ADR 0018 é o primeiro caso concreto. Bater no limite bloqueia o novo e preserva o que existe, como nos [ADR 0064](0064-free-acima-do-limite-variantes-operacionais.md) e [ADR 0065](0065-efeitos-do-downgrade-metas-pausadas.md).
- Os gatilhos antecipam a decisão: ao cruzar qualquer um, o responsável decide entre otimizar consumo, degradar mais ou contratar plano pago.
- Transações de pagamento (Asaas e Woovi) seguem fora do teto por serem repasse do cliente.

## Alternativas rejeitadas

- **Manter tudo no free tier sem teto declarado:** menos regra, mas transforma o primeiro gasto inesperado em decisão de emergência.
- **Contratar Workers Paid desde já:** remove o limite diário de requisições do Workers Free ([limites do Workers](https://developers.cloudflare.com/workers/platform/limits/)), mas cria custo fixo mensal sem demanda provada; adiada por decisão do usuário.
- **Teto por serviço em vez de global:** mais preciso, porém mais burocrático; o teto global de US$ 10 já dá a trava mínima.
- **Incluir Asaas e Woovi no teto:** misturaria custo por transação do cliente com infraestrutura de desenvolvimento e travaria venda.
