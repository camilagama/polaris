---
status: accepted
---

# Runtime offline no app: aparelho, lease, armazenamento e sincronização num só lugar

## Contexto

Os PR48 a PR62 entregaram as peças do offline (aparelho e lease, outbox, coleções locais, comandos, painel de atenção, saída segura, shell offline e ciclo de atualização), cada uma provada em separado e nos laboratórios. Faltava o que as une dentro do app: alguém que registre o aparelho, mantenha o lease, abra os armazenamentos do usuário certo, restaure o que uma queda deixou, sincronize na hora certa e mostre à pessoa o estado disso. Sem isso as telas não têm onde se apoiar e o aviso de atualização e a saída segura ficam sem fila para ler.

## Decisão

- **Um `OfflineRuntime` por organização aberta** (`offline/runtime/offline-runtime.ts`), sem dependência de React e com tudo o que é externo injetado (servidor, armazenamento chave-valor, abertura dos armazenamentos, relógio, rede), então é testado sem navegador. Ele faz, em ordem: o aparelho (registrado uma vez e lembrado), o lease (guardado e renovado enquanto há rede, quando restam menos de 12 horas), a abertura do outbox e das coleções do namespace, a restauração do que está na fila (clientes e produtos pendentes) e o bootstrap quando as coleções ainda estão vazias.
- **O usuário vem das claims do lease**, não de uma consulta: a identidade do namespace (usuário e organização) sai de `sub` e `org` do lease guardado. Por isso uma segunda visita **sem rede** abre direto do aparelho lembrado e do lease guardado, sem nenhuma chamada. Sem aparelho ou sem lease e sem rede, o runtime fica `unavailable` com a razão (`no_device_offline`, `no_lease_offline`), nunca em um estado a meio caminho.
- **Aparelho de outro usuário no mesmo navegador.** Se o servidor recusar o lease do aparelho lembrado (ele pertence a outra conta), o runtime o esquece e registra de novo, uma única vez. A saída (ADR 0039) apaga o aparelho e o lease lembrados junto com o namespace.
- **Sincronização de uma execução por vez** (`syncNow`, single-flight: chamadas simultâneas compartilham a mesma): renova o lease se for hora, envia a fila em ordem (ADR 0033), atualiza as coleções pelo change log e atualiza os números. Falha do servidor deixa a fila intacta e marca `sync_failed`; a próxima execução continua de onde parou. Quem chama decide quando: ao iniciar, quando a rede volta, quando a pessoa volta ao app e a cada minuto com o app na frente.
- **Pontos de ligação:** `workSource()` entrega a fila ao ciclo de atualização (ADR 0041), que passa a refletir o trabalho real; `logoutWorkspace()` entrega a organização ao fluxo de saída (ADR 0039); `context()` entrega às telas o que elas precisam para enfileirar um comando (aparelho, lease, outbox e leitores locais).
- **No app:** um provedor inicia o runtime para a organização atual; um chip no cabeçalho diz "Tudo sincronizado", "Enviando N operações…", "Sem conexão · N operações guardadas", "Não foi possível enviar" ou, quando há recusa, "N operações precisam de atenção" como link. O chip cabe numa linha a 360 px: o texto visível é curto ("Em dia", "Enviando N", "Offline · N", "Envio falhou", "Atenção: N", "Preparando", "Só online", "Atualizando") e a frase inteira fica no `title` e num texto só para leitor de tela; a página `/attention` mostra o painel de atenção (ADR 0038) sobre o outbox real; "Sair" executa o fluxo completo (proteger a fila, apagar os dados, encerrar a sessão no servidor, voltar ao início) e nunca encerra a sessão antes de o guarda liberar. Se o encerramento da sessão falhar depois de os dados terem sido apagados, a pessoa continua conectada e é avisada; o próximo carregamento reconstrói o que foi apagado.
- **Atrás de uma chave de build** (`VITE_OFFLINE_RUNTIME_ENABLED`), desligada por padrão: sem ela nada disto roda, registra aparelho ou toca o disco, e o app se comporta exatamente como antes. Ela só deve ser ligada em produção depois do checklist em aparelho físico do Gate 5.
- **Provas.** Testes do runtime com servidor, relógio e rede simulados (início, segunda visita offline, indisponibilidade, renovação do lease com e sem falha, aparelho de outro usuário, troca de organização, sincronização, execução única, falha e recuperação, fonte de trabalho, saída com e sem fila); testes do chip, da rota e do fluxo de saída; e um laboratório de navegador (`/offline-runtime-lab`) com o runtime real sobre IndexedDB e OPFS reais e um servidor simulado: iniciar online, trabalhar sem rede, **recarregar e abrir offline do que ficou no aparelho**, e enviar quando a rede volta.

## Consequências

- Nenhuma tela ainda lê as coleções locais nem enfileira comandos: o runtime está montado e sincroniza, mas as telas existentes continuam online. Converter as telas (vender, estoque, produtos, clientes) para ler do aparelho e enfileirar é o trabalho seguinte, e cada uma encontra pronto o `context()` e o chip.
- Com a chave ligada, cada usuário passa a ter um aparelho registrado, um lease de até 72 horas e uma cópia local da organização; o custo de armazenamento e o limite de aparelhos por usuário valem desde então.
- Dois separadores abertos compartilham o outbox e as coleções (já provado); ambos sincronizam, e a ordem e a unicidade do envio vêm do outbox, não do runtime.

## Alternativas rejeitadas

- **Iniciar o runtime sempre, sem chave:** registraria aparelhos e gravaria no disco de todos os usuários antes da prova em aparelho físico, que é a condição para ligar o offline em produção.
- **Descobrir o usuário por uma consulta de sessão:** exigiria rede na abertura; as claims do lease já dizem de quem é o namespace e o servidor revalida tudo a cada comando.
- **Sincronizar a cada mudança de estado da rede dentro do runtime:** misturaria política com mecanismo; o runtime só sabe sincronizar, e o provedor decide quando.
