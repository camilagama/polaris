---
status: accepted
---

# Despesas recorrentes

## Contexto

O aluguel, o contador e as assinaturas se repetem, e o documento inicial pede que a recorrência entre na V1: uma regra gera ocorrências, e editar a regra não reescreve o passado. O plano pede também testar o catch-up do agendador. A infraestrutura de agendamento (Fase 11) ainda não existe, então a geração não pode depender de um job que rode todo dia.

## Decisão

- **Uma regra é um molde; cada ocorrência é uma despesa comum.** `expense_recurring_rules` guarda valor, categoria, descrição, favorecido, frequência (semanal, mensal ou anual), data de início e data de fim opcional. Cada ocorrência gerada é uma linha de `expenses` que copia a regra naquele momento e aponta para ela (`recurring_rule_id`, `recurring_occurrence`); depois disso ela é editada, anulada e somada como qualquer despesa. O índice único `(rule, occurrence)` torna a geração idempotente.
- **A ocorrência N está N passos depois do início, sempre contados do início.** Uma regra mensal que começa no dia 31 cai no último dia dos meses mais curtos e volta ao 31 depois (28/29 de fevereiro, 30 de abril); uma anual de 29 de fevereiro cai em 28 nos anos comuns. Contar do início, e não da ocorrência anterior, evita que o dia derive para baixo.
- **Gera-se quando vence, ao ler.** Uma ocorrência é gerada quando sua data chega (hoje, no calendário da organização, ou antes), e a geração roda no início da listagem de despesas e de regras e logo depois de criar uma regra, sob o bloqueio da própria regra: leituras simultâneas geram cada ocorrência uma só vez. Não há job. Quando o agendador da Fase 11 chegar, ele só chama a mesma função.
- **Catch-up completo.** Uma regra criada com início no passado (ou uma conta que ficou muito tempo sem ser aberta) gera tudo o que foi perdido, com as datas originais, em passos de até 500 por regra e no máximo dez passos por chamada; o resto continua na chamada seguinte.
- **Editar a regra só muda o que ainda não foi gerado.** Valor, categoria, descrição, favorecido e data de fim podem mudar; frequência e data de início **não**: outro calendário é outra regra (pausa-se a antiga e cria-se uma nova). O que já foi gerado, editado ou anulado nunca é reescrito nem regerado; anular uma ocorrência é definitivo.
- **Pausar é arquivar, e retomar pula o que passou.** Uma regra pausada não gera nada. Ao retomar, os períodos que passaram durante a pausa não aconteceram: são pulados, não gerados depois (o contador avança até a última ocorrência já vencida). Quem quer o contrário cria uma regra nova com início no passado.
- **A categoria arquivada depois não interrompe a série.** Criar ou mudar a categoria de uma regra exige categoria ativa; uma categoria arquivada depois não impede a geração, porque o aluguel continua existindo.
- **Mesmas regras de valor, texto e datas.** O valor e o texto seguem as da despesa; a data de início segue a janela da competência (de 2000-01-01 a hoje mais 366 dias); a de fim não pode ser anterior à de início. O banco repete valor, texto, frequência, datas e a coerência da origem (uma despesa tem regra e ocorrência juntas ou nenhuma) em CHECKs, e o papel de runtime só atualiza as colunas editáveis.
- **Mesma capability e mesma auditoria.** `expense:create` governa tudo; cada mudança de regra e cada passo de geração (um evento por regra e passo, sem valores) deixa um evento de auditoria.

## Consequências

- A despesa de qualquer mês passado já aparece quando a pessoa abre a tela, sem depender de job; o custo é uma consulta de regras ativas por leitura (uma linha por regra) e, depois de um longo intervalo, uma escrita em lote.
- A listagem passa a escrever (como a semeadura das categorias padrão): ela exige a capability e roda numa transação do tenant.
- Pausar e retomar não deixa buraco inventado nem dívida de geração; uma pausa longa nunca cria um monte de despesas de uma vez.
- Mudar a frequência de uma série exige uma regra nova; o histórico das duas fica visível separado.
- O catch-up de mais de 5.000 ocorrências por regra levaria mais de uma chamada (uma semanal desde 2000 gera cerca de 1.300, bem abaixo).

## Alternativas rejeitadas

- **Gerar ocorrências futuras com antecedência:** criaria despesas que ainda não aconteceram e que a pessoa teria de anular se a regra mudasse.
- **Contar cada ocorrência da anterior:** o dia 31 viraria 28 para sempre depois de fevereiro.
- **Retomar gerando o que ficou para trás:** um mês de pausa viraria quatro despesas de uma vez, contrariando o motivo da pausa.
- **Editar a regra reescrevendo as ocorrências geradas:** contraria a regra do documento inicial (editar a recorrência não reescreve o histórico).
- **Depender de um job agendado:** a infraestrutura ainda não existe e deixaria o resultado do mês errado até o job rodar.
