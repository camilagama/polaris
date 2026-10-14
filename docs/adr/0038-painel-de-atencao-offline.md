---
status: accepted
---

# Painel de atenção: o que o servidor recusou, dito com clareza e sem "forçar"

## Contexto

Os PR54 a PR57 enfileiram cliente, produto, estoque e venda offline e deixam o servidor recusar o que não cabe. Uma recusa não é um erro técnico: é um fato sobre os dados do servidor (o estoque que o aparelho não conhecia, o SKU que outro aparelho cadastrou primeiro, um acesso que mudou). O PR58 do plano pede o painel das operações que precisam de atenção, para os casos de estoque insuficiente, conflito de versão, mudança de direito, acesso revogado e conflito de SKU, e proíbe o botão genérico de "forçar sincronização".

## Decisão

- **O modelo é puro e testável** (`offline/attention.ts`): `buildAttention` transforma o snapshot do outbox em itens, um por comando recusado, cada um com a causa (`insufficient_stock`, `version_conflict`, `sku_conflict`, `id_conflict`, `unavailable`, `sale_too_old`, `entitlement_changed`, `authorization_revoked`, `other`), o código do servidor, um título que identifica a operação (cliente, produto, venda de N itens, entrada/baixa/contagem), uma explicação em português do que aconteceu e do que fazer, se o item está parando a fila, e as ações permitidas. `waitingBehind` conta o que espera atrás de uma recusa (e é zero quando nada foi recusado).
- **Só as ações honestas para cada causa.** Nada aplica uma operação recusada, então não existe "forçar":
  - `resubmit` (reenviar como comando novo, ADR 0037) só para uma venda cuja causa pode ter sido corrigida (estoque insuficiente, produto indisponível);
  - `discard` para o que precisa ser refeito com dados atuais (baixa maior que o saldo, contagem obsoleta, SKU em uso, ID colidido, venda mais antiga que a janela);
  - `review_account` para mudança de direito, sem descartar: o que está na fila é enviado quando o plano for regularizado, nada se perde; e `review_account` mais `discard` para acesso revogado, porque se o acesso não voltar o registro nunca poderá ser enviado.
- **Descartar é uma ação de duas etapas** na interface: o primeiro clique mostra o que será perdido (a venda não será registrada, o produto e o estoque de abertura serão apagados, etc.) e o segundo confirma. A execução passa pelo módulo dono de cada comando, que remove o comando e as linhas locais e se recusa quando uma operação posterior depende dele ou quando o comando está em envio. Por isso `discardPendingCustomer` passou a existir (o PR54 não tinha o descarte do cliente).
- **O painel é só apresentação** (`attention-panel.tsx`): recebe o resumo e os tratadores, não guarda dados e desabilita os botões do item em resolução. Os testes renderizam o HTML (sem DOM) e verificam que cada item mostra só as suas ações, que não há nenhum controle que force a sincronização e que a ausência de recusas é dita com clareza.
- **Prova em navegador real.** O laboratório `/offline-attention-lab` (só no modo offline-poc) monta o painel sobre o outbox real em IndexedDB com comandos sintéticos recusados; o gate de navegador (Chromium desktop e Pixel 5 emulado) cobre: a venda recusada aparece, bloqueia a fila e sobrevive a recarregar; reenviar a troca por um comando novo; descartar pede confirmação, diz o que se perde e remove; uma mudança de direito leva à revisão da conta sem reenviar nem descartar.

## Consequências

- Quando a interface offline for montada no app, ela passa o `Outbox` e o `LocalWriter` ao painel e liga `review_account` à tela de conta; nada no modelo muda.
- Uma recusa sem código conhecido cai em `other` (descartar), nunca em uma ação que aplique algo.
- A resolução de um conflito de SKU é refazer o cadastro com outro SKU: o painel descreve, mas a edição guiada do SKU fica para quando houver tela de cadastro offline.

## Alternativas rejeitadas

- **Botão "Forçar sincronização":** proibido pelo plano; esconde a causa e não faria o servidor aceitar o que recusou.
- **Reenviar qualquer comando recusado:** o servidor repetiria a recusa gravada para o mesmo `commandId`; só a venda, que tem sentido de negócio em ser reenviada depois de corrigir a causa, é reenviada (como comando novo).
- **Descartar sem confirmação:** o descarte apaga trabalho que a pessoa já fez no balcão.
