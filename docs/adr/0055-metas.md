---
status: accepted
---

# Metas

## Contexto

O plano (PR70) pede o agregado de meta, com os tipos vendas líquidas, resultado operacional e número de vendas, e o ciclo de vida. A regra de negócio diz que a mudança de alvo durante o período é auditada e que uma meta concluída não reabre automaticamente. O progresso precisa ser o mesmo número que o painel mostra, e não um segundo cálculo que possa divergir.

## Decisão

- **Uma meta é um alvo para um período, medido por um dos três indicadores.** Tipo (`net_sales`, `operating_result` ou `sale_count`), período (datas de início e de fim no calendário da organização, de no máximo 366 dias, com início a partir de 2000-01-01 e até 366 dias à frente de hoje), alvo exato (BRL com duas casas para os de dinheiro; número inteiro de 1 a 1.000.000 para o de vendas) e nome opcional. As mesmas regras valem no domínio, no contrato e em CHECKs do banco.
- **O progresso não é guardado: é derivado.** Para uma meta ativa, o progresso é o resultado do período **até hoje** (do início ao menor entre o fim e hoje), calculado pelo motor do [ADR 0053](0053-motor-de-resultado-economico.md) sobre os mesmos fatos do painel. Uma meta que ainda não começou mede zero.
- **Ciclo de vida: só avança a partir de `active`.** Uma meta ativa vira `completed` na primeira avaliação em que o progresso alcança o alvo (mesmo antes de o período acabar; a avaliação acontece quando as metas são lidas, ver abaixo), `missed` quando o período acaba sem alcançá-lo, ou `cancelled` por ação da pessoa. Concluída, não atingida e cancelada são finais e somente leitura. **Uma meta concluída não reabre sozinha**: uma devolução posterior que derrube as vendas líquidas abaixo do alvo não muda o estado, e o valor atingido no momento da conclusão fica gravado (`achieved_value`, `settled_at`). Não existe ação de reabrir: quem quer outra meta cria outra. **Meta de resultado operacional só é liquidada quando o período termina**: a conclusão é irreversível e o resultado antes do fechamento não é confiável (custos datados mais adiante no mês ainda não entram), então ela mostra o progresso durante o período e é concluída ou não atingida no fim.
- **A conclusão é constatada quando as metas são lidas.** Não há gatilho na confirmação da venda: se o alvo for alcançado na terça e uma devolução o derrubar na quarta, sem que ninguém leia as metas no intervalo, a meta não é concluída (o valor gravado e a data são os da primeira leitura que a constata, e o cartão diz "conferido em"). O painel abre lendo as metas, então o intervalo costuma ser curto, mas a garantia de que a conclusão não reabre vale a partir da constatação.
- **Editar e cancelar liquidam antes.** Editar o alvo ou cancelar uma meta primeiro avalia e liquida as metas ativas, para que uma meta que já alcançou o alvo (ou cujo período acabou) seja liquidada em vez de alterada por quem está olhando um cartão antigo; editar uma meta cujo período já acabou é recusado (ela é liquidada pela próxima leitura).
- **A conclusão é gravada em duas etapas.** O motor exige um instante único (`REPEATABLE READ`), e uma escrita com bloqueio nesse nível falharia por serialização quando duas leituras tentassem concluir a mesma meta. Por isso a leitura de metas avalia o progresso das ativas numa transação de leitura e depois, numa segunda transação curta, aplica a conclusão ou o vencimento: cada meta é bloqueada em ordem de ID e só é alterada se ainda estiver ativa **na versão que foi avaliada**; uma meta cujo alvo mudou entre as duas etapas é avaliada de novo na leitura seguinte. Repetir é inofensivo e leituras simultâneas aplicam uma só vez.
- **Mudar o alvo de uma meta ativa é permitido e fica registrado.** Cada mudança grava, em `goal_target_changes` (somente de acréscimo), o alvo anterior, o novo, quem mudou e quando, além do evento de auditoria `goal.target_changed`; mudar para o mesmo valor não grava nada. O nome também pode mudar (`goal.updated`). Período e tipo nunca mudam (outro período ou indicador é outra meta).
- **Uma capability: `goal:manage`.** Cria, edita, cancela e lê metas; como a leitura do progresso usa o resultado do período, o repositório econômico aceita também essa capability. Só `owner` existe na V1.
- **O banco defende o que o código promete.** RLS e `FORCE RLS`, sem `DELETE`, `UPDATE` só em nome, alvo, estado, valor atingido, instante da conclusão, carimbo e versão (tipo, período, organização e criação nunca mudam), CHECKs de tipo, estado, alvo por tipo, período e coerência da conclusão (uma meta concluída ou não atingida sempre tem instante e valor; uma ativa ou cancelada não tem valor), e o histórico de alvos sem `UPDATE` nem `DELETE`.
- **No máximo 20 metas ativas por organização**, porque medir cada uma lê o período inteiro dela; a leitura mostra o progresso de uma meta só quando ele pertence à versão atual dela (se o alvo mudou entre as duas etapas, o progresso fica para a leitura seguinte). Nomes não aceitam NUL nem substitutos soltos.
- **Só com conexão e só o confirmado**, como o painel: o progresso vem do servidor; o trabalho pendente do aparelho nunca conta para a meta.

## Consequências

- Uma meta concluída é um fato: mostra o valor com que foi concluída, não o que o período fechou depois. O painel dos números continua mostrando a verdade corrente do período.
- Ler as metas escreve (como a semeadura das categorias e a geração das recorrências): a leitura exige a capability e custa uma transação a mais quando há metas ativas.
- Uma meta de resultado operacional pode ser concluída por um mês com poucas despesas lançadas; o aviso de qualidade do painel continua valendo e a meta herda a incerteza do resultado.
- Metas por mês sem sobreposição não são impostas: duas metas do mesmo tipo e período são permitidas (por exemplo, uma ambiciosa e uma mínima).

## Alternativas rejeitadas

- **Guardar o progresso:** divergiria do painel a cada devolução, cancelamento e despesa.
- **Reabrir a meta quando o número cai:** o dono veria uma meta que concluiu na terça "desconcluir" na quinta; a regra do produto é que a conclusão não reabre.
- **Concluir só ao fim do período:** esconderia a vitória e quebraria "concluída não reabre" (um fim de período com devoluções pode ficar abaixo do alvo).
- **Escrever a conclusão dentro da transação de leitura:** conflitos de serialização sob leituras simultâneas.
- **Reabrir ou editar metas finais:** apagaria o histórico do que foi alcançado e do que foi mudado.
