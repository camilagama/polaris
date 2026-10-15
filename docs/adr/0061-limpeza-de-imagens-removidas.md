---
status: accepted
---

# Limpeza dos objetos de imagens removidas

## Contexto

Remover uma imagem de um produto (ADR 0059) apaga os vínculos e mantém o asset e o objeto no armazenamento, e o reconciliador de mídia (ADR 0014) não os alcançava: ele trabalha a partir dos markers de envio e só apaga o master de uma chave que nenhum asset referencia, e o asset da imagem removida continua existindo. O resultado era um arquivo que a pessoa vê como removido e que fica no bucket privado sem prazo (custo, e retenção de uma imagem que a pessoa quis apagar).

## Decisão

- **Uma imagem removida é um asset sem vínculo.** O asset nasce junto do seu vínculo, na mesma transação, e um vínculo nunca é acrescentado a um asset existente (um envio novo cria um asset novo), e **o banco impõe isso**: um gatilho recusa (`product_media_new_asset_only`) inserir um vínculo de produto que não seja na mesma transação que criou o asset. Assim uma futura troca ou restauração de imagem, ou um erro, não pode ligar um asset que a limpeza já listou. Então "nenhum vínculo aponta para o asset" significa, sem ambiguidade, "foi removida do produto". Um produto excluído (tombstone) mantém seus vínculos e, portanto, suas imagens.
- **Duas funções do banco, no mesmo desenho de privilégios do reconciliador de markers (migration 0026).** `list_unlinked_media_for_cleanup(limite, idade mínima, excluídos)` lista os assets sem vínculo (de 1 a 500 por chamada, mais antigos primeiro, deixando de fora os que já falharam na execução); `finalize_unlinked_media_cleanup(asset)` apaga a linha do asset, só se ainda não houver vínculo, e registra a chave no tombstone (`media_cleanup_claims`), de modo que a chave nunca mais possa ser usada por outro asset. Ambas são `SECURITY DEFINER` da role dona da limpeza, com `EXECUTE` só para o grupo de limpeza; a role tenant não as executa, e a role de login da limpeza não lê nenhuma tabela diretamente (ela só enxerga o que as funções devolvem).
- **A ordem é "objeto primeiro, banco depois".** O Worker apaga o master e os dois derivados (320 e 640) no R2 e só então chama a finalização. Se o R2 falhar, nada foi registrado e a próxima execução encontra o asset de novo; se o banco falhar depois de apagar os objetos, a próxima execução apaga de novo o que já não existe (inofensivo) e finaliza. Não existe estado em que um objeto fique sem dono: o asset só sai do banco depois de o arquivo ter saído do bucket.
- **Espera de uma hora, contada pela criação do asset (não pela remoção).** O asset precisa ter mais de uma hora de vida para entrar na lista. Não há desfazer de remoção, então a espera não guarda nada para a pessoa. Consequência direta: uma imagem enviada há dias e removida agora é limpa já na próxima execução horária, sem espera; só a que foi removida logo depois de enviada espera a primeira hora. Uma leitura de derivado em andamento no instante da remoção ainda pode gravar um derivado depois da limpeza, e esse arquivo ficaria órfão (nenhum processo varre `media/derivatives/v1/`); a janela é muito estreita e fica registrada como limite.
- **No cron já existente, de forma independente.** O cron horário (minuto 17) roda o reconciliador de markers e o de imagens removidas; a falha de um não esconde o outro (os dois rodam, e a primeira falha é relançada no fim). No máximo 150 imagens por execução (três lotes de cinquenta, três chamadas ao bucket por imagem, para ficar abaixo do teto de chamadas de uma invocação do Worker, que deve ser confirmado na implantação); a execução seguinte continua. Um ativo que falha entra na lista de excluídos do resto da execução, para que um item preso no começo da fila não esconda os outros; cada falha é registrada com o ID do asset, e a execução termina com erro.
- **Chaves que não parecem uma chave de mídia v2 não são tocadas** e contam como falha da execução (para investigação), como no reconciliador de markers.

## Consequências

- Uma imagem removida deixa de ocupar o bucket em até cerca de uma hora (limite da execução horária), e o ciclo "remover e enviar" do Free deixa de acumular objetos.
- A linha do asset removido também sai do banco; a chave fica registrada no tombstone sem o conteúdo.
- Se um asset ganhar vínculo depois de seus objetos serem apagados (o gatilho existe para que isso seja impossível), a finalização o recusa e a execução registra o erro com o ID do asset, em vez de seguir em silêncio.
- Um reenvio atrasado do mesmo comando de envio (mesmo ID e mesmos bytes) depois que a limpeza apagou o asset cria uma imagem nova, em vez de dar conflito: o conflito do [ADR 0059](0059-remover-e-reordenar-imagens-de-produto.md) vale enquanto o asset existe.
- O que continua em aberto: um limite de envios por organização (a limpeza apaga o que foi removido, não impede o envio em massa) e a prova no R2 real, que depende da implantação, adiada pelo responsável. Os testes usam um bucket falso; o banco foi provado em Neon descartável.

## Alternativas rejeitadas

- **Apagar o objeto na hora da remoção, dentro do comando:** o R2 não participa da transação; uma falha deixaria o vínculo apagado e o objeto sem dono, ou o contrário.
- **Marcar a remoção com um `removed_at` e deixar o reconciliador de markers cuidar:** o reconciliador parte de markers de envio, que já foram removidos; seria preciso um segundo mecanismo de qualquer forma.
- **Deixar o runtime tenant apagar o asset:** daria ao caminho de requisição a capacidade de apagar o registro do arquivo; a limpeza fica com a role que não tem outro uso.
- **Registrar o tombstone antes de apagar o objeto:** uma falha do R2 deixaria a chave reivindicada sem ninguém para apagar o objeto.
