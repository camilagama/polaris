---
status: accepted
---

# Datas da venda, janela retroativa e venda retroativa com custo vigente

## Contexto

Uma venda precisa de mais de uma data: quando ela aconteceu para o negócio, em que dia do calendário da organização ela pertence, o que o dispositivo registrou e quando o servidor a confirmou. O plano pedia momento comercial, evidência local e confirmação do servidor, um fuso por organização e um limite retroativo, sem definir nomes, o cálculo da data comercial nem a ordem entre replay e janela. O offline torna isso mais sensível: uma venda feita sem rede chega horas ou dias depois. A regra vigente (valores, borda, papel e futuro) vive somente em [time-and-dates.md](../business-rules/time-and-dates.md); este ADR guarda o motivo e as consequências.

## Decisão

Registro das decisões do PR47, mais as decisões tomadas na revisão do checkpoint Gate 4 (13/10/2026):

- **Quatro datas com papéis distintos.**
  - `occurred_at`: o momento comercial, informado pelo operador;
  - `occurred_on`: a data comercial no calendário do fuso da organização, calculada no servidor a partir do fuso lido dentro da transação tenant, e **a data dos movimentos de estoque da venda** (o banco recusa movimento `sale` com outra data);
  - `recorded_at`: evidência do dispositivo na criação (substitui o nome `client_created_at` do plano), que **não decide nenhuma regra**;
  - `confirmed_at`: o relógio do servidor (`clock_timestamp()`), nunca informado pelo cliente.
- **Janela retroativa por papel, contada em dias de calendário** no fuso da organização, com papel desconhecido recebendo zero dias (falha fechada). Os valores estão em [time-and-dates.md](../business-rules/time-and-dates.md).
- **Tolerância de futuro curta** para diferença de relógio do dispositivo; além dela o servidor recusa. O navegador valida formato e futuro com o relógio do dispositivo, mas o limite retroativo é decidido só pelo servidor.
- **Replay antes da janela.** Repetir um command já confirmado é respondido antes da checagem da janela, para que um retry legítimo de uma venda antiga nunca vire recusa.
- **Venda retroativa usa o custo vigente na confirmação (D-4).** A venda retroativa captura o custo médio de quando é **confirmada**, e não o da data comercial, e consome o estoque **atual**. Isso é uma **limitação aceita**: o CMV de uma venda retroativa usa o custo de hoje, e o saldo "na data D" reconstruído a partir de `occurred_on` pode ficar negativo ou diferente do físico daquela data. A alternativa (custo e saldo por data) exigiria um razão por data e fica fora da V1. O limite está documentado em [sales.md](../business-rules/sales.md) e [inventory.md](../business-rules/inventory.md).
- **Questão em aberto: lease offline.** A janela mede `occurred_at` contra a confirmação. O plano prevê um lease de autorização offline de 72 horas (etapa de autorização offline): o dispositivo pode criar vendas durante o lease, mas pode demorar muito mais que isso para sincronizá-las. Uma venda offline legítima que chegue ao servidor depois de a janela vencer seria rejeitada, e o operador perderia trabalho já feito. O lease e a janela precisam ser alinhados (por exemplo, limitando por quanto tempo uma venda pendente pode esperar, ou definindo o que acontece com a venda fora da janela), e a decisão fica para a etapa de autorização offline; até lá nenhum comportamento muda.

## Consequências

- O ledger é explicável por data de negócio, e o dia contábil não muda com o fuso do dispositivo.
- O CMV de vendas retroativas e a reconstrução de saldo histórico são aproximações; relatórios devem sinalizar que a venda é retroativa quando o custo importar.
- Renomear o campo de evidência quebra clientes antigos em cache (o campo é descartado e um retry de venda com evidência vira conflito); é aceitável antes do lançamento, e depois exige nota de release.
- A interface rotula a venda retroativa comparando com o dia local do dispositivo, que não conhece o fuso da organização; perto da meia-noite o rótulo pode errar, e a decisão do servidor prevalece.
- O formato de armazenamento dos instantes (UTC) é tema do [ADR 0024](0024-colunas-de-instante-timestamptz.md).

## Alternativas consideradas

- **Janela medida pelo relógio do dispositivo.** Burlável e dependente de fuso do aparelho.
- **Custo e saldo por data comercial.** Exato, mas exige um razão por data, recálculo de médias e correção em cascata; custo desproporcional para a V1.
- **Checar a janela antes do replay.** Mais simples, porém transforma um retry legítimo em erro.
- **Usar `recorded_at` como regra.** Dá autoridade a um relógio que o usuário controla.

## Emenda (25/10/2026): o backfill da `occurred_on` na migration 0038 converteu o fuso duas vezes

- **O erro.** O `UPDATE` de `drizzle/0038_sale_dates.sql` calculou `occurred_on` com `((sale.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE organization.timezone)::date`. A primeira conversão já devolve o horário de parede em UTC; a segunda o trata como horário local da loja e o desloca de novo. O resultado é um instante deslocado pelo desvio do fuso da loja, e o `::date` o corta pelo `TimeZone` da sessão da migration, que o repositório não fixa. Para uma loja em São Paulo, as vendas do fim do dia ficaram com o dia seguinte: de 21:00 a 23:59 no horário da loja quando a sessão está em America/Sao_Paulo (o achado da revisão de arquitetura) e de 18:00 a 23:59 quando está em UTC (o padrão do Neon). Em fusos a leste de UTC o erro vai para o dia anterior. Nas vendas afetadas, `sales.occurred_on` ficou diferente de `stock_movements.occurred_on`, que está certo; relatórios por `sales.occurred_on` mostram essas vendas no dia errado.
- **A expressão certa.** `(sale.occurred_at AT TIME ZONE organization.timezone)::date`, a mesma que a aplicação usa nas vendas novas (`calendarDateInTimeZone`). As vendas confirmadas depois da 0038 estão certas.
- **O que foi afetado.** Só as vendas anteriores à 0038 que existiam no staging, todas sintéticas ou de teste. Não há banco de produção: a produção nasce depois da 0038 e não passa pelo backfill, então não é afetada.
- **Decisão (Arrascaeta, 25/10/2026): não haverá migration de correção.** Uma migration para corrigir dados de teste não se justifica, e a `0038_sale_dates.sql`, já aplicada, não é editada. Os dados do staging com a data errada podem ser descartados ou recriados quando convier.
- **Por que o gate não pegou.** A verificação 6c de `poc:sales:dates:verify` compara a data gravada com `(occurred_at AT TIME ZONE timezone)::date`, que é a expressão certa, e não executa o `UPDATE` da migration; ela prova a regra da aplicação e a leitura de `organizations` pela role da migration, não o SQL do backfill. Um backfill futuro de data deve ser provado executando o próprio SQL da migration sobre linhas de teste.

