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
- **Questão em aberto: lease offline.** A janela mede `occurred_at` contra a confirmação. Uma venda offline legítima de um dispositivo que ficou desconectado por mais tempo que a janela seria rejeitada. A duração do lease de autorização offline (PR49) e a janela retroativa precisam ser alinhadas: o lease não pode permitir criar vendas que a janela depois recusa. A decisão fica para o PR49, e até lá nenhum comportamento muda.

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
