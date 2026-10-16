---
status: proposed
---

# Teto de custo e free tier primeiro

## Contexto

O Polaris roda em serviços com franquia gratuita — Cloudflare Workers Free, R2, Cloudflare Images (Transformations Free), Hyperdrive, Neon Free, Resend Free, Sentry Developer e GitHub — e nenhum plano pago de infraestrutura contratado para o Polaris. Sem um teto declarado, o primeiro estouro de cota vira cobrança inesperada ou indisponibilidade silenciosa, e cada serviço reagiria de um jeito. O usuário decidiu manter os serviços no free tier por enquanto; o Workers Paid, em particular, não foi contratado. Alertas de orçamento da Cloudflare em US$ 1, US$ 5, US$ 6 e US$ 10 já existem.

## Decisão

- **Teto de US$ 10 por mês, BRUTO, para a infraestrutura de desenvolvimento do Polaris.** Nenhum gasto acima disso sem nova decisão do responsável.
- **Tudo no free tier:** Cloudflare Workers Free, R2, Cloudflare Images (Transformations Free), Hyperdrive, Neon Free, Resend Free, Sentry Developer e GitHub.
- **Workers Paid não contratado.** Decisão do usuário: manter Free por enquanto.
- **Asaas e Woovi ficam fora do teto:** são custo por transação do cliente (repasse), não infraestrutura de desenvolvimento da plataforma.
- **Assinatura GitHub Pro da conta:** assinatura da conta, fora deste teto (a confirmar pelo responsável).
- **Upgrade pago só com decisão explícita do responsável.** Nenhum serviço sobe de plano sozinho ao bater cota.
- **Cada serviço degrada com segurança ao bater cota:** servir o que existe, avisar e/ou enfileirar, sem cobrar e sem quebrar a tela. Para mídia, o fallback acima da franquia do Images está na emenda ao [ADR 0018](0018-midia-privada-cloudflare-images-r2.md); as cotas de plano já vivem no servidor ([ADR 0058](0058-cotas-do-plano-no-servidor.md)).
- **Gatilhos de revisão (propostos, para o time validar):** Neon — 60% do armazenamento (600 MB de 1 GB por projeto) ou 70% da computação (70 de 100 CU-h/mês por projeto); Images — 50% das 5.000 transformações únicas no mês; Resend — 50% da cota mensal (1.500 de 3.000) ou 80% da diária (80 de 100).
- **GitHub Actions (conta camilagama, plano Pro):** a franquia de minutos acabou e os jobs foram bloqueados sem cobrança; o repositório ficou público em 15/10/2026 e permanece público até o lançamento. O [ADR 0060](0060-ci-economico-em-minutos.md) está desatualizado neste ponto: descreve repositório privado e cobrança por minuto.

## Consequências

- O custo de desenvolvimento fica limitado e previsível; não há cobrança surpresa sem decisão humana.
- Cota estourada bloqueia ou degrada em vez de cobrar, então o produto precisa continuar utilizável no free tier; a emenda ao ADR 0018 é o primeiro caso concreto. Bater no limite bloqueia o novo e preserva o que existe, como nos [ADR 0064](0064-free-acima-do-limite-variantes-operacionais.md) e [ADR 0065](0065-efeitos-do-downgrade-metas-pausadas.md).
- Os gatilhos antecipam a decisão: ao cruzar qualquer um, o responsável decide entre otimizar consumo, degradar mais ou contratar plano pago.
- Transações de pagamento (Asaas e Woovi) seguem fora do teto por serem repasse do cliente.

## Alternativas rejeitadas

- **Manter tudo no free tier sem teto declarado:** menos regra, mas transforma o primeiro gasto inesperado em decisão de emergência.
- **Contratar Workers Paid desde já:** remove o limite diário de requisições do Workers Free, mas cria custo fixo mensal sem demanda provada; adiada por decisão do usuário.
- **Teto por serviço em vez de global:** mais preciso, porém mais burocrático; o teto global de US$ 10 já dá a trava mínima.
- **Incluir Asaas e Woovi no teto:** misturaria custo por transação do cliente com infraestrutura de desenvolvimento e travaria venda.
