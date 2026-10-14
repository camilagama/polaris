---
status: accepted
---

# Venda atômica por constraint triggers deferidos e idempotência por commandId

## Contexto

Confirmar uma venda grava várias tabelas ao mesmo tempo (cabeçalho, itens, ajustes, pagamento, movimentos de estoque, saldos e auditoria). A V1 não tem rascunho persistido de venda, e o runtime precisa de `INSERT` nas tabelas de venda. Um `GRANT INSERT` genérico permitiria, por bug ou por SQL arbitrário na role de tenant, gravar uma venda incompleta (sem itens, sem pagamento ou sem o movimento de estoque correspondente) ou acrescentar itens depois. A lógica de domínio e o repositório garantem a atomicidade, mas o plano pede que o banco também recuse a venda parcial. O modelo de dados está em [sales-data-model.md](../architecture/sales-data-model.md) e as invariantes em [sales.md](../business-rules/sales.md).

## Decisão

Registro retroativo das decisões do PR38 e do PR43, confirmadas na revisão do checkpoint Gate 4 (13/10/2026):

- **Um comando, uma transação.** `sale.confirm` confirma a venda inteira em uma única transação tenant: ou todas as escritas acontecem ou nenhuma. Não há mutations independentes para partes da venda e não há rascunho persistido; estados como `pending` e `rejected` pertencem ao outbox local do offline.
- **Triggers de restrição deferidos como cinto de segurança.** Funções como `check_sale_confirmation_complete` rodam em `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` e recusam no commit qualquer venda sem os itens e ajustes declarados no cabeçalho, sem exatamente um pagamento igual ao total devido, sem o movimento `sale` correspondente a cada item, com movimento em data diferente da data comercial, ou movimento `sale` sem venda. O runtime não tem `UPDATE`, `DELETE` nem `TRUNCATE` nas tabelas de venda; itens, ajustes e pagamentos não podem ser acrescentados depois.
- **Idempotência por `commandId`.** O `commandId` é único por organização. O mesmo `commandId` com o mesmo conteúdo devolve a venda já confirmada (`replayed: true`), mesmo que o perfil de pagamento tenha mudado depois; com conteúdo diferente é conflito; entregas simultâneas criam uma única venda. O replay é respondido antes de qualquer checagem dependente do tempo (ver [ADR 0021](0021-datas-da-venda-e-janela-retroativa.md)).
- **Fatos do servidor.** Produto, rótulo do produto e custo unitário do item vêm do servidor, sob lock do saldo; o cliente informa só variante, quantidade, preço de tabela e preço cobrado. O saldo nunca fica negativo, e os locks seguem uma ordem estável (produto, depois saldo) para que vendas concorrentes não gerem deadlock.
- **Erros estáveis.** Erros 400, 404 e 409 carregam o código de domínio em `data.reason`; erros de autorização e inesperados não expõem motivo.
- **Sem outbox no servidor nesta etapa.** A confirmação não cria intents de outbox; o outbox transacional pertence à Fase 11.

## Consequências

- A venda parcial é impossível mesmo com permissão de `INSERT`, e a prova está nos gates PostgreSQL (falha injetada em cada ponto, corridas do mesmo `commandId`).
- A confirmação faz várias leituras e escritas por item dentro da transação; não há teste de desempenho para vendas grandes, e o limite de itens por venda funciona como teto de custo.
- Reproduzir a prova em CI depende da decisão do [ADR 0025](0025-estrategia-de-testes-de-banco.md).
- Os triggers deferidos precisam se comportar da mesma forma através do pooler do Hyperdrive; essa prova com código tenant real em staging é item do checklist de go-live.
- A ordem dos movimentos de uma variante passa a ser dada por uma sequência por variante gravada sob o lock do saldo (decidido na revisão do checkpoint), e não pelo horário de início da transação, que pode preceder um movimento confirmado antes.

## Alternativas consideradas

- **Rascunho de venda persistido e confirmação em etapas.** Facilita editar no servidor, mas cria estados intermediários e permite venda parcial entre as etapas.
- **Atomicidade só na aplicação.** Menos SQL, mas um bug ou um acesso direto à role de tenant grava venda incompleta sem que nada reaja.
- **Uma `SECURITY DEFINER` única que escreve tudo e nenhum `INSERT` direto.** Fecha a superfície, mas esconde a lógica em SQL e dificulta o teste e a evolução; os triggers deferidos validam sem concentrar a escrita.
- **Triggers imediatos por linha.** Rejeitariam a venda enquanto ela ainda está sendo montada dentro da própria transação.
