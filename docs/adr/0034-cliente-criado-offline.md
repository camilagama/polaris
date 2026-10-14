---
status: accepted
---

# Cliente criado offline: ID do dispositivo, comando idempotente e rodada de sincronização

## Contexto

O PR54 do plano é a primeira escrita offline real: criar um cliente sem rede, vê-lo como pendente, sincronizar e vê-lo confirmado, e provar que enviar duas vezes não duplica. Ele liga as peças dos PR50b (coleções locais), PR52 (outbox) e PR53 (`sync.push`) em um fluxo de ponta a ponta. Nada disso é montado na interface ainda: a prova em Android físico (ADR 0032) continua a condição para **ligar** a escrita offline em produção.

## Decisão

- **O dispositivo nomeia o cliente.** O ID é um UUIDv7 gerado no navegador (`lib/uuidv7.ts`, RFC 9562, `crypto.getRandomValues`): a linha otimista local e a do servidor são a mesma entidade, e as referências feitas offline (venda a cliente, nos PR seguintes) já apontam para o ID definitivo. O banco aceita o ID (`createCustomer` com `id`), valida o formato UUID e o grava; sem ID ele continua gerando um UUIDv7.
- **Dois níveis de idempotência.** O `commandId` torna o reenvio do mesmo comando um replay (ADR 0033). O `customerId` protege contra outro comando diferente tentando criar o mesmo cliente: a chave primária recusa e o manipulador responde `customer_id_conflict`. A inserção roda em um savepoint, de modo que o conflito não aborta a transação do chamador. A chave é global: outra organização que usasse o mesmo UUID também recebe o conflito; com UUIDv7 aleatório isso só ocorre por erro ou ataque, e a resposta não revela dados do outro tenant.
- **O servidor revalida tudo.** O manipulador `customer.create` (capability `customer:update`, a mesma da edição online) normaliza o perfil com as regras do domínio (nome obrigatório, telefone ou e-mail, limites). Um perfil que o dispositivo não deveria ter enviado vira `invalid_payload`. A normalização roda também no cliente antes de enfileirar: o que o servidor recusaria nem entra na fila.
- **Fluxo no cliente.** `createOfflineCustomer` enfileira o comando e só então grava a linha otimista; se o app cair entre os dois, `restorePendingCustomers` recria as linhas dos comandos ainda na fila. `pendingCustomers` expõe o estado de cada cliente (`pending`, `rejected` com o código) para a interface. `syncOutbox` envia em lotes na ordem, marca `sending` antes da requisição, aplica o resultado de cada comando (aceito sai da fila; rejeitado fica e bloqueia o que vem atrás; `not_processed` volta a esperar) e, se algo foi aceito, atualiza as coleções locais pelo change log, que troca a linha otimista pela do servidor. Falha de rede devolve o lote a `pending` e propaga o erro; o reenvio usa os mesmos IDs.
- **Resposta que não chega.** Se o servidor executou mas a resposta se perdeu, o próximo envio recebe `replayed: true` com o resultado gravado: o cliente é criado uma vez só (testado com um servidor sintético e provado no banco pelo gate de `sync-push`).

## Consequências

- Os PR55 a PR57 repetem o molde: ID gerado no dispositivo, comando com payload completo, manipulador no registro, classificação de recusas.
- Um cliente rejeitado continua visível e marcado, e bloqueia a fila até o descarte explícito (PR58 define a interface de conflito).
- Em caso de colisão de ID a única saída é descartar o comando; não há reescrita automática de ID, que quebraria referências já feitas offline.

## Alternativas rejeitadas

- **ID gerado pelo servidor:** impede referenciar o cliente em comandos enfileirados antes da sincronização.
- **Reescrever o ID em conflito:** esconderia um erro real e invalidaria referências locais.
- **Capability própria `customer:create`:** mais um item no lease sem ganho; quem edita clientes pode criá-los, como no fluxo online.
