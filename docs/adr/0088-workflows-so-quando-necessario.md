---
status: accepted
---

# Cloudflare Workflows: nenhum por ora; a exportação fica no consumidor da fila

> O número deste ADR (0088) é o próximo livre na `main` (a última é a 0087) e nos PRs abertos no momento da escrita (o PR do purge usa 0081, o do teto de custo 0076 e o #134 emenda a 0067); pode mudar se outro entrar antes.

## Contexto

O plano (Fase 11, PR113) pede Cloudflare Workflows **somente** para exportações, purge e operações longas necessárias, e proíbe levar o estado canônico de cobrança para um Workflow. Os PRs anteriores já resolveram parte do problema que um Workflow resolveria:

- **A exportação** ([ADR 0078](0078-exportacao-de-dados-da-organizacao.md)) é montada pelo consumidor da fila `polaris-default` desde o despachante do outbox ([ADR 0084](0084-despachante-e-varredor-do-outbox.md)): uma mensagem `data_export.requested` toma a exportação pelo ID, lê as tabelas numa transação do solicitante, monta o ZIP de dados (até 16 MiB) e as partes de imagens (até 32 MiB cada, no máximo 400 imagens) e grava no R2. A retomada é do banco: tomada com concessão, até três tentativas com recuo, apagar os arquivos da tentativa anterior antes de começar, e o re-arm do job horário devolve o evento à fila enquanto a exportação for devida.
- **O agendador** ([ADR 0086](0086-framework-de-jobs-agendados.md)) dá a cada job *lease*, janela e catch-up; o trabalho pesado vai para a fila.
- **O purge** (PR107, [ADR 0081](https://github.com/camilagama/polaris/pull/126), PR #126) **não está na `main`**: espera o aceite do responsável (POL-81). Nele, o purge roda no job horário de privacidade e retoma pelo estado do banco (`organization_purges`: tomada com concessão de 15 minutos, `storage_touched_at`, `swept_at`).
- O teto de custo (ADR 0076, PR #96, ainda aberto) mantém tudo no plano **Workers Free**; o plano pago não está contratado e contratá-lo é decisão do responsável.

A pergunta é se algum desses fluxos precisa de Workflow e se Workflows cabe no Free.

### Limites conferidos

Documentação oficial da Cloudflare, consultada em 18/10/2026: [limites do Workflows](https://developers.cloudflare.com/workflows/reference/limits/), [preços do Workflows](https://developers.cloudflare.com/workflows/reference/pricing/), [limites do Workers](https://developers.cloudflare.com/workers/platform/limits/) (atualizada em 12/10/2026) e [limites do Queues](https://developers.cloudflare.com/queues/platform/limits/).

| | Workflows no Free | Workflows no pago | Consumidor de fila (ver a ressalva) | Cron no Free |
| --- | --- | --- | --- | --- |
| CPU | **10 ms por step** | 30 s por step (até 5 min) | **30 s** por invocação, padrão (até 5 min) | 10 ms |
| Parede | ilimitada por step | ilimitada por step | 15 min | 15 min |
| Memória | 128 MB por isolate (Workers) | 128 MB | 128 MB | 128 MB |
| Resultado de um step | 1 MiB | 1 MiB | — | — |
| Estado guardado por instância | 100 MB | 1 GB | — | — |
| Steps | 1.024 por Workflow; **3.000 por dia** na conta | 10.000 por Workflow; 500 mil por mês, depois US$ 0,80 por 100 mil | — | — |
| Instâncias simultâneas | 100 | 50.000 | — | — |
| Subrequisições | 50 externas, 1.000 a serviços Cloudflare | 10.000 | 50 e 1.000 no Free | 50 e 1.000 |
| Retenção do estado concluído | 3 dias | 30 dias | — | — |

Workflows **existe no Free** ("included in both the Free and Paid Workers plans"), dividindo as 100 mil requisições diárias do Worker, com 1 GB-mês de armazenamento; com o armazenamento cheio, o Free recusa a escrita de estado (não cobra). No pago, acima das cotas: US$ 0,30 por milhão de requisições, US$ 0,02 por milhão de ms de CPU, US$ 0,20 por GB-mês e US$ 0,80 por 100 mil steps; a cobrança de steps e armazenamento começou em 10/08/2026. **Declarar um Workflow no Free não cria custo; o que limita é o CPU de 10 ms por step.**

## Decisão

- **A exportação continua no consumidor da fila, sem Workflow.** No Free, um step de Workflow tem o mesmo teto de CPU de um cron (10 ms), escrito na página de limites; o consumidor da fila tem 30 s pelo padrão da página do Queues (ver a ressalva em "Limites aceitos"). Nos dois casos o Workflow nunca dá mais CPU que o consumidor. Montar o ZIP não cabe em 10 ms: só o CRC-32 de uma parte de imagens de 32 MiB levou cerca de 0,09 s numa máquina de desenvolvimento (medição do ADR 0078), sem contar serializar até 16 MiB de JSON e CSV. Um Workflow no Free tornaria a exportação **impossível**, não mais robusta; no pago daria o mesmo teto de CPU por step que a fila já dá. Partir a montagem em steps de menos de 10 ms exigiria guardar o ZIP parcial fora do step (o resultado de um step tem no máximo 1 MiB; o estado da instância, 100 MB) e mudaria o formato e o pipeline da exportação, que esta tarefa não muda.
- **O que um Workflow daria a mais, a exportação já tem.** Retomada depois de falha: a tomada com concessão, as três tentativas com recuo e o re-arm. Passos idempotentes: a tentativa apaga os arquivos da anterior antes de começar (nada de ZIP duplicado ou pela metade), e uma mensagem repetida não refaz nada: o registro de processamento do consumidor deduplica a mesma entrega, e um reenvio (despachante ou re-arm, tentativa nova) acha nada a fazer porque o handler toma a exportação pelo ID. Espera longa: o recuo é do banco (`locked_until`), não de `step.sleep`. Um Workflow seria uma **segunda fonte de verdade** do andamento (o estado da instância) ao lado de `data_exports`, que continua sendo a autoridade.
- **Nenhum binding de Workflow em nenhum Worker.** Um teste (`apps/web/worker/index.test.ts`) falha se algum `apps/*/wrangler.jsonc` contiver `"workflows"`: quem adotar um Workflow edita o teste no mesmo PR de um ADR que emende este, com o CPU por step medido ou a decisão do plano pago.
- **Purge: fica como o PR #126 o desenha, sem Workflow, quando o POL-81 for aceito.** O purge já é uma sequência de etapas retomável pelo banco (tomar, marcar o armazenamento, apagar o prefixo das exportações, apagar a mídia em lotes, apagar as linhas numa transação, varrer de novo), e cada etapa é idempotente. Um Workflow repetiria essa sequência fora do banco, com o mesmo teto de 10 ms por step no Free, e o cancelamento (que lê `storage_touched_at` e a concessão no banco) teria de consultar dois estados. Quando o PR do purge entrar:
  - ele roda como job do agendador (ADR 0086), na pista `maintenance`, e mede o CPU do tick com `wrangler tail` (o runbook dos jobs já pede);
  - se não couber nos 10 ms do cron, a saída a avaliar é a mesma da exportação: um evento do outbox e o consumidor da fila (30 s), com o handler tomando o purge pelo ID com a própria autoridade; não um Workflow. Essa rota não é trivial e pede um ADR próprio de papéis e grants: hoje o gatilho do purge é só administrativo e as funções do purge só `polaris_privacy_runtime` executa; o evento precisaria de um produtor do Admin, o consumidor de um papel que execute essas funções, e o purge apaga o `event_outbox` e o `queue_processing` da organização, inclusive o evento e o registro que estariam rodando o próprio handler;
  - o estado do purge continua em `organization_purges`, e nada daqui muda as regras, os papéis ou as migrations dele.
- **Cobrança fora de Workflow.** O estado canônico de cobrança (`organization_billing`, `billing_events`, `entitlement_grants`) continua no banco, mudado por comandos e pela varredura `billing.maintenance` do agendador; nenhum Workflow o lê como autoridade nem o guarda.
- **Operações longas: nenhuma hoje.** Um Workflow passa a valer quando houver uma operação que (a) precise esperar de verdade (horas ou dias, ou um evento externo, com `step.sleep` ou `step.waitForEvent`) **e** (b) não tenha um estado no banco que já faça a retomada, **e** (c) caiba em 10 ms de CPU por step no Free ou tenha a decisão do plano pago. Candidatas futuras, a avaliar quando existirem: a conciliação com os provedores de pagamento (Gate 7; o estado canônico continua no banco) e uma exportação grande demais para o Worker (o "trabalho em lote fora do Worker" do ADR 0078).

## Consequências

- Nada a provisionar, nenhum binding novo, nenhum custo: o PR113 do plano fica atendido por esta decisão.
- A exportação continua limitada pelo que cabe numa invocação do consumidor (128 MB, 30 s de CPU, 15 min de parede): organizações grandes falham com `export_too_large`, como antes.
- O purge, quando aceito, segue o caminho do agendador e da fila; o PR dele não precisa decidir sobre Workflows.

## Limites aceitos

- **Os 30 s de CPU do consumidor no Free não estão garantidos pela documentação.** A [página de limites do Queues](https://developers.cloudflare.com/queues/platform/limits/), em 18/10/2026, diz que os limites da tabela valem para o Free e o pago (só a retenção muda) e que o padrão do consumidor é 30 s, mas também que o consumidor tem "os mesmos limites de CPU por invocação de qualquer Worker", e a página do Workers dá 10 ms ao Free (só lista HTTP e cron). O ADR 0084 já registrou essa ambiguidade e mandou medir. Ela não muda esta decisão: se o Free der 10 ms ao consumidor, a exportação não cabe nele **nem** num step de Workflow, e a saída é a do ADR 0084 (medir; plano pago por decisão do responsável). A medição no runbook continua obrigatória antes do go-live.
- **Os números são da documentação, não medidos na conta.** O CPU real da montagem no `workerd` e o do tick com o purge continuam itens de go-live (runbooks).
- **A página de limites do Workers não diz** se a chamada pelo binding do Hyperdrive conta como subrequisição externa (50 no Free) ou como serviço Cloudflare (1.000): a exportação e o purge abrem uma conexão por execução, então não é limite para eles hoje, mas é para medir antes de um laço com muitas conexões.
- Os limites e preços do Workflows mudaram em 2026 (a cobrança de steps começou em 10/08/2026); conferir de novo antes de adotar.

## Alternativas rejeitadas

- **Workflow para a exportação no Free:** 10 ms de CPU por step não montam um ZIP; partir a montagem mudaria o formato e o pipeline e gastaria a cota de 3.000 steps por dia da conta.
- **Workflow para a exportação no pago:** exige contratar o Workers Paid (decisão de custo do responsável) para ter o mesmo CPU que a fila já dá no Free, e duplica o estado do andamento.
- **Workflow para o purge agora:** o purge não está na `main` (POL-81) e esta tarefa não o toca; e o desenho dele já retoma pelo banco.
- **Declarar o binding sem uso, "para depois":** um binding sem decisão é configuração morta e convida a usar sem medir; o teste impede.
