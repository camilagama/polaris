# Gate 4 — núcleo de vendas (Fase 4)

Gatilho: fechamento da Fase 4 (clientes e vendas online, PR36–PR47) e qualquer mudança posterior em venda, estoque de venda, cancelamento, devolução, atribuição de cliente ou datas da venda.

O Gate 4 prova seis propriedades: venda atômica, estoque correto, dinheiro correto, cancelamento correto, devoluções corretas e reconciliação de cliente que não altera a economia. Ele combina os gates por etapa (profundidade, cada mecanismo isolado) com um cenário ponta a ponta (composição, tudo junto, contra um oráculo independente).

## Pré-requisitos de acesso

- Siga a [política de perfis de CLI](./cli-profile-policy.md): Neon CLI com o perfil `junior-pessoal` (conta `juniordiniz56@gmail.com`). Não use o plugin ou conector Neon.
- Nenhuma connection string, senha ou token é impressa, gravada em arquivo ou colada em chat. A URL do gate vive só nas variáveis de ambiente do processo e é removida ao final.
- Alvo seguro: uma **branch Neon nova e descartável** (schema-only a partir de `production`, expiração de 24 h) com um banco novo `polaris_prNN_gate`. Nunca reutilize uma branch expirada e nunca copie dados de produção. O banco é recriado do zero: as migrations 0000–0038 são reaplicadas do começo.
- O plano Neon limita as branches raiz. Apague apenas as branches de gate que você mesmo criou e que já terminaram antes de criar a próxima.
- Não rode dois gates ao mesmo tempo no mesmo banco: os gates de falha injetada criam gatilhos nas tabelas compartilhadas e contaminam a execução do outro.

## Passos

1. Criar a branch e o banco (descarte a saída: o comando `neon branches create` imprime a connection string).

       neon branches create --name pr47-sale-dates-gate --parent production --schema-only --expires-at <agora+24h, UTC, hora cheia> --project-id green-tooth-16857010 --profile junior-pessoal | Out-Null
       neon databases create --name polaris_pr47_gate --owner-name neondb_owner --branch pr47-sale-dates-gate --project-id green-tooth-16857010 --profile junior-pessoal | Out-Null

2. Em um processo que obtenha a URL direta (sem pooler) com `neon connection-string ... --database-name polaris_pr47_gate --role-name neondb_owner --profile junior-pessoal`, exporte somente neste processo `DATABASE_URL`, `POLARIS_SALES_GATE_DATABASE_URL`, `POLARIS_SALES_GATE_BRANCH` (precisa casar `^pr\d+-[a-z0-9-]+-gate$`) e `POLARIS_SALES_GATE_DATABASE`. Confirme que o host tem o formato `ep-…c-2.sa-east-1.aws.neon.tech`, sem `pooler`.
3. Aplicar as migrations do zero: `bun run --filter @polaris/db db:migrate`.
4. Rodar, **em sequência**, no mesmo banco:

       bun run --filter @polaris/db poc:sales:verify
       bun run --filter @polaris/db poc:sales:transaction:verify
       bun run --filter @polaris/db poc:sales:customer-link:verify
       bun run --filter @polaris/db poc:sales:cancellation:verify
       bun run --filter @polaris/db poc:sales:return:verify
       bun run --filter @polaris/db poc:sales:dates:verify
       bun run --filter @polaris/db poc:gate4:verify

   Todos devem terminar com `"status": "passed"`.
5. Limpar o ambiente do processo (todas as variáveis acima) e, depois do gate, apagar a branch descartável própria: `neon branches delete <nome> --project-id green-tooth-16857010 --profile junior-pessoal`. A expiração de 24 h cobre o esquecimento, mas não libera o limite de branches raiz antes disso.

## O que prova cada propriedade

| Propriedade | Gate por etapa (profundidade) | Cenário ponta a ponta (`poc:gate4:verify`) |
| --- | --- | --- |
| Venda atômica | `poc:sales:transaction:verify`: falha injetada em cada ponto da transação com rollback conjunto, corridas do mesmo `commandId`, gatilhos deferidos que recusam venda parcial. `poc:sales:verify`: agregado sem venda parcial. | Venda com a segunda linha sem estoque não deixa cabeçalho, item, pagamento, movimento, saldo nem auditoria; repetir uma venda confirmada não muda nada. |
| Estoque correto | Ordem de locks sem deadlock, saldo nunca negativo, custo médio, movimento por item no custo do snapshot. | Um movimento `sale` por item ao custo do snapshot, saldos 47 e 18, média intocada, e o razão explica todos os saldos depois de cada etapa. |
| Dinheiro correto | Biblioteca de dinheiro (PR39), ajustes (PR40), pagamentos (PR41), perfis (PR42): decimal exato, meio-para-cima uma vez por valor. | Subtotal, desconto, frete e total devido coincidem com um oráculo independente em centavos inteiros e com as linhas persistidas; o pagamento único é igual ao total. |
| Cancelamento correto | `poc:sales:cancellation:verify`: reposição ao custo do item, regra da média, corridas cancelamento × cancelamento e × venda, gatilho de completude. | Quantidade inteira volta ao estoque ao custo original, a venda e os movimentos originais não são editados, repetir o comando é replay, a venda cancelada mantém os totais e não aceita devolução. |
| Devoluções corretas | `poc:sales:return:verify`: `returned ≤ disponível`, `restocked ≤ returned`, sequência aleatória contra um modelo, exclusão mútua com o cancelamento, guardas do banco. | Devolvido e reposto são separados, só o reposto movimenta estoque, devolução acima do disponível é recusada, venda com devoluções não cancela, a venda nunca é editada. |
| Reconciliação de cliente não altera a economia | `poc:sales:customer-link:verify`: histórico versionado, concorrência, cliente arquivado. | Atribuir, reatribuir, conflito de versão e remover (inclusive em venda cancelada) mantêm vendas, itens, ajustes, pagamentos, movimentos e saldos idênticos byte a byte. |
| Datas (PR47) | `poc:sales:dates:verify`: janela de 30 dias no calendário da organização, tolerância de 5 minutos, data do razão = data comercial, replay e conflito de `recorded_at`. | Venda de 10 dias atrás grava o movimento na sua data comercial. |

## Limites conhecidos

- Os gates não cobrem a interface no navegador: os modelos de visão têm testes unitários, mas não houve verificação ponta a ponta nem em 360 px nesta fase.
- Só existe o papel `owner`; a janela retroativa por papel e a capability de cada operação só foram exercidas para ele.
- O replay de uma venda **fora** da janela retroativa é garantido pela ordem do código (replay antes da checagem da janela) e documentado, mas o gate não consegue envelhecer uma venda sem editar linhas imutáveis.
- Não há reembolso nem valor monetário de devolução: a decisão do projeto é que o impacto em vendas líquidas pertence ao motor de métricas.

## Rollback ou forward-fix

O gate não altera recursos persistentes: ele roda só na branch descartável. Se um gate falhar, não prossiga para a próxima etapa; corrija na etapa dona do mecanismo, repita o gate falho e depois todos os anteriores. Escalonamento: responsável pelo projeto.
