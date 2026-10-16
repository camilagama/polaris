---
status: accepted
---

# Reembolso e chargeback da assinatura

## Contexto

O plano (PR84) pede: reembolso integral remove o Pro; chargeback remove o Pro imediatamente, sem carência e sem nova lease offline; e "testar reversão posterior". O ADR 0062 deixou o estorno de fora (limite aceito): um pagamento estornado mantinha o Pro até o fim do período. O reembolso parcial é um gesto comercial que "pode manter o entitlement".

## Decisão

- **Três fatos novos, todos nomeando o período que concerne** (`periodEndsAt`, o fim do período que o pagamento cobriu, sem dado pessoal): `charge_refunded` (reembolso **integral**; um reembolso parcial não é fato, o adaptador não o reporta), `charge_disputed` (chargeback) e `dispute_reversed` (chargeback decidido a favor do Polaris).
- **O período do fato é o que vale, com a tolerância do provedor.** Dois fins de período a menos de um dia um do outro são o mesmo período (provedores arredondam de um evento para outro). Um fim de período que nenhum provedor reportaria (já passado quando não há o que remover, ou além do maior período pago, 400 dias) é ignorado.
- **Efeito imediato e sem carência.** Um reembolso ou chargeback do período pago em vigor (`active`, ou `grace`, que se apoia no período que acabou) leva ao novo evento da máquina de estados, `access_revoked`: `free`, ou `free_over_limit` se a organização passa do limite Free (e então valem a janela e a escolha do ADR 0064). Como o entitlement é derivado do estado, o lease offline e as demais capacidades Pro somem com ele: nenhum lease novo é emitido e um comando que chega depois é rejeitado sem perder a fila (ADR 0058). Um fato de período **anterior** ao em vigor (uma renovação já o superou) não muda nada.
- **O pagamento tirado fica registrado** em `organization_billing` (`revoked_through`, `revoked_reason`, `revoked_cycle_months`, `revoked_cancel_at_period_end`, todos ou nenhum, nunca sobre um período pago). Serve a três coisas: a **confirmação tardia do mesmo pagamento** (`charge_succeeded` de período igual ou anterior) nunca revive o acesso; um pagamento de período novo o revive e apaga o registro; e a **reversão** sabe o que restaurar (fim do período, ciclo e se estava cancelada). Uma nova referência de assinatura no provedor (`attachProvider`, um checkout novo) apaga o registro: o pagamento tirado na assinatura antiga não acompanha a nova.
- **Fato que chega antes da cobrança.** Um reembolso ou chargeback de um período ainda não pago no registro (um registro Free, um trial em andamento ou em preparação: a confirmação da cobrança vem depois) também é **registrado**, sem mudar o estado (um trial segue rodando), para que a confirmação, quando chegar, não conceda o que já foi devolvido; um pagamento de período posterior é outra cobrança e passa.
- **Reembolso vence chargeback.** Um reembolso do mesmo pagamento depois do chargeback troca o motivo do registro para reembolso: a reversão do chargeback não restaura nada (o cliente tem o dinheiro e não terá o acesso). Um chargeback depois de um reembolso não acrescenta nada.
- **Reversão restaura, de forma auditável.** `dispute_reversed` para o chargeback registrado, do mesmo período, restaura o acesso até o fim daquele período, com o ciclo e o cancelamento que a assinatura tinha, pela transição de pagamento (`subscribe`, ou `payment_succeeded` se um trial corre); o razão mostra o estado antes e depois. Se o período já terminou, não há o que restaurar: o registro só esquece o chargeback. Depois de restaurado, o tempo corre como em qualquer assinatura (sem pagamento no fim, entra em carência).
- **Reversão que chega antes do chargeback** (fora de ordem) é registrada como `won` quando o período ainda está à frente: o chargeback que chega depois não muda nada. Um `won` não bloqueia um pagamento real do período.
- **Fatos de dinheiro nunca são descartados por velhice.** Como o `charge_succeeded`, os três escapam da regra "fato mais antigo que o último aplicado é obsoleto": um reembolso entregue atrás de uma notícia mais nova continua tirando o acesso. O que os protege é o período que nomeiam.
- **Sem estado novo e sem tabela nova.** Os três fatos entram pela mesma caixa de entrada, deduplicados por provedor e ID de evento; as colunas novas são do papel de billing (UPDATE só dele).

## Consequências

- Um adaptador (PR77 e PR78) reduz o reembolso integral, a disputa e a vitória da disputa do seu provedor a esses fatos, informando o fim do período cobrado pelo pagamento em questão; reembolso parcial vira lista vazia. Os fatos devem trazer a referência da assinatura: sem ela a rota não consegue conferir se pertencem à assinatura ligada (responsabilidade do adaptador).
- A restauração depende de o chargeback ter sido registrado e de a reversão nomear o mesmo período.
- Cada saída do Pro por reembolso ou chargeback começa uma nova janela de adequação (ADR 0064), datada do momento da retirada do acesso.

## Limites aceitos

- Reembolso de uma renovação paga **antes** do fim do período em vigor, entregue antes da confirmação da cobrança, é ignorado (o registro está num período pago e não pode guardá-lo): a confirmação, quando chegar, concede o período. Aceito porque um adaptador só deve reportar o reembolso depois de a cobrança existir.
- Reembolso de um período **anterior** ao em vigor não remove nada, mesmo que o cliente tenha pedido o dinheiro de volta de uma renovação antiga: a assinatura segue paga pelo período novo.
- Um chargeback que atinge o pagamento de uma carência (`grace`) guarda o período que acabou: uma vitória posterior só esquece o registro; não devolve a carência.
- Não há reembolso proporcional nem crédito: é tudo ou nada.

## Alternativas rejeitadas

- **Encerrar a assinatura inteira a cada reembolso:** reembolsar uma renovação antiga derrubaria um período que continua pago.
- **Chargeback com carência:** o plano o quer imediato e mais severo que a falha de renovação.
- **Restaurar a partir do evento do provedor sem lembrar o ciclo:** a restauração voltaria com um ciclo que não era o da assinatura, e sem o cancelamento.
- **Tratar o fato como obsoleto quando chega atrás de outro:** um reembolso atrasado deixaria o Pro de quem recebeu o dinheiro de volta.
- **Exigir igualdade exata do fim do período:** um arredondamento diferente do provedor reviveria o acesso de um pagamento devolvido ou ignoraria uma reversão legítima.
