---
status: accepted
---

# Remover e reordenar imagens de produto

## Contexto

A mídia de produto só aceitava adição (ADR 0018). Com as cotas por plano (ADR 0058), o Free tem uma imagem por produto: sem remover não há como trocar a foto errada, e sem reordenar o Pro não escolhe a imagem que aparece primeiro. O ADR 0018 registrou que esses comandos eram necessários antes da Fase 7. O modelo já os previa: o trigger de tombstone cobre `DELETE` e `UPDATE` das associações e mantém a identidade delas imutável.

## Decisão

- **Remover tira as associações, não o asset.** `removeProductMedia` apaga os vínculos do asset com as variantes e com o produto, na transação do pedido, sob o lock da linha do produto. A linha de `media_assets` e o objeto no armazenamento ficam: o runtime continua sem `DELETE` em `media_assets`. A imagem deixa de ser servida e de aparecer em qualquer tela. O objeto no R2 privado é apagado pela limpeza de imagens removidas ([ADR 0061](0061-limpeza-de-imagens-removidas.md)), que trata como removida toda imagem cujo asset não tem mais vínculo; até lá (cerca de uma hora), o arquivo permanece no bucket. Uma imagem removida deixa de ser servida (a entrega exige o vínculo) e a vaga volta para o plano na hora, porque as cotas contam vínculos.
- **Remover é idempotente.** Remover uma imagem que já não está no produto responde `removed: false`, para um reenvio depois de uma resposta perdida ser seguro. Produto de outra organização ou inexistente é "não encontrado"; produto excluído (tombstone) é recusado e o banco recusa também pelo SQL direto (a política só enxerga produto vivo).
- **Reordenar recebe a lista inteira.** `reorderProductMedia` exige exatamente as imagens atuais do produto, em qualquer ordem (sem repetição, sem faltar nem sobrar). Uma tela que não viu uma mudança feita em outro lugar recebe `invalid_media_order` (409) e recarrega, em vez de aplicar a ordem por cima. As posições são únicas por produto, então os vínculos saem do caminho (posição + 1.000.000) e assumem as posições finais 0, 1, 2... em um único `UPDATE`, na mesma transação. A mesma ordem de novo, com as posições já arrumadas, não é mudança (sem escrita e sem evento de auditoria); com buracos nas posições (remover os deixa) ela os arruma. Uma imagem nova vai sempre por último.
- **Substituir é remover e depois enviar.** O servidor não tem um comando de troca atômica: o Free não comportaria enviar antes de remover. A interface remove e abre o envio; se o envio falhar ou for cancelado, o produto fica com uma imagem a menos e a tela diz isso.
- **Permissões do banco, mínimas.** `DELETE` em `product_media` e `variant_media`, e `UPDATE (position)` em `product_media`, com políticas de linha que exigem a organização ativa e o produto não excluído. Nada mais mudou: o asset continua imutável e sem `DELETE`, e o vínculo não muda de asset, de produto nem de data.
- **Rotas HTTP, como o resto da mídia.** `DELETE /api/products/:productId/media/:assetId` e `PUT /api/products/:productId/media/order`, com a organização no cabeçalho `X-Organization-Id` e a capacidade `product:update`; ids malformados respondem 404 e o corpo da ordem é pequeno e validado antes de abrir transação. Cada comando deixa um evento de auditoria (`product.media_removed` e `product.media_reordered`).

## Consequências

- Um Free troca a foto de um produto (remover e enviar) e um Pro escolhe a ordem das imagens.
- Os objetos de imagens removidas saem do bucket em até cerca de uma hora, pela limpeza do ADR 0061; o limite de envio por organização (a limpeza não impede o envio em massa) continua sendo um item à parte, no checklist de go-live.
- Um reenvio do mesmo `uploadCommandId` de uma imagem já removida recebe `media_upload_command_conflict` enquanto o asset da imagem removida ainda existe; depois que a limpeza ([ADR 0061](0061-limpeza-de-imagens-removidas.md)) apaga o asset, um reenvio atrasado do mesmo comando com os mesmos bytes cria uma imagem nova. Um envio novo tem um ID novo.

## Alternativas rejeitadas

- **Remoção lógica (`removed_at`).** Manteria o vínculo, mas todas as consultas e as cotas precisariam filtrá-lo, e o índice de posição única teria de virar parcial; apagar o vínculo mantém o modelo simples e o asset preserva o histórico do arquivo.
- **Apagar também o asset e o objeto.** Contraria o reconciliador e a corrida entre a checagem de referência e a exclusão que o ADR 0014 resolve com o claim.
- **Mover uma imagem por posição (`moveTo(index)`).** Dois aparelhos moveriam sobre listas diferentes; a lista inteira com checagem detecta o conflito.
- **Troca atômica no servidor.** Exigiria carregar o ID da imagem trocada pelo envio e pela pré-verificação da cota; fica para quando houver necessidade.
