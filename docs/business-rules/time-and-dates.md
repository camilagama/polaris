# Tempo e datas

Este arquivo é o **único lugar** onde vivem a janela retroativa, a tolerância de futuro e a definição das datas da venda. Outros documentos apenas linkam para cá. A razão das escolhas está no [ADR 0021](../adr/0021-datas-da-venda-e-janela-retroativa.md); o modelo de dados, em [sales-data-model.md](../architecture/sales-data-model.md).

## Fuso e instantes

- Cada organização tem um timezone IANA próprio, confirmado durante o onboarding e validado pelo servidor.
- Instantes técnicos usam UTC e são guardados em colunas com fuso (`timestamptz`) ([ADR 0024](../adr/0024-colunas-de-instante-timestamptz.md)). Datas de negócio são interpretadas no timezone da organização e guardadas como data de calendário.

## Datas da venda

- **Momento comercial (`occurred_at`):** o instante em que a venda aconteceu, informado pelo operador e editável.
- **Data comercial (`occurred_on`):** a data de `occurred_at` no calendário da organização, calculada pelo servidor. É a data dos movimentos de estoque da venda.
- **Evidência local (`recorded_at`):** o horário do dispositivo ao criar a venda. Opcional, é só evidência e não decide nenhuma regra.
- **Confirmação (`confirmed_at`):** o relógio do servidor no momento da confirmação, nunca informado pelo cliente. O relógio do servidor é a autoridade da confirmação.

## Janela retroativa e futuro

- **Retroativo:** o `owner`, único papel da V1, pode registrar venda de até **30 dias de calendário** atrás, contados no timezone da organização. A mesma data local de 30 dias atrás ainda vale; a data local anterior é recusada com o motivo `sale_occurred_too_old`. Papel desconhecido recebe 0 dias (falha fechada).
- **Futuro:** o servidor recusa `occurred_at` mais de **5 minutos** à frente do seu relógio (`sale_occurred_in_future`). A tolerância cobre a diferença de relógio do dispositivo.
- **Replay antes da janela:** repetir um comando já confirmado é respondido antes da checagem da janela; o replay nunca é recusado por a venda ter saído da janela.
- **Quem decide:** o limite retroativo é decidido só pelo servidor. O navegador pode validar o formato e o futuro com o relógio do dispositivo, mas não decide o retroativo.
- **Questão em aberto:** o plano prevê um lease de autorização offline de 72 horas, mas uma venda criada dentro do lease pode demorar mais que a janela para chegar ao servidor e seria recusada. O alinhamento entre lease, tempo máximo de espera de uma venda pendente e janela será decidido na etapa de autorização offline ([ADR 0021](../adr/0021-datas-da-venda-e-janela-retroativa.md)).

## Outras datas de negócio

- O recebimento, a baixa e a contagem de estoque informam uma data de ocorrência como data de calendário da organização. Ainda não há limite superior definido para essa data.
- A data do movimento de cancelamento é a data do momento do cancelamento no fuso da organização, e a da devolução segue a mesma regra.
- A venda retroativa é registrada na data comercial, mas usa o custo médio e o estoque vigentes na confirmação, não os da data comercial ([vendas](sales.md), [estoque](inventory.md)).
