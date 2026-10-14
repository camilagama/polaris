---
status: accepted
---

# Abrir o app sem rede: a cópia das organizações

## Contexto

Com as telas lendo do aparelho (ADR 0045 e 0046), faltava o primeiro passo de toda visita: o app só desenha qualquer tela depois de saber em qual organização está, e isso vinha de uma única leitura ao servidor (`organization.listMine`). Sem rede essa leitura falhava e o app mostrava um erro, então a segunda visita offline, que o runtime e o service worker já suportam, morria na porta.

## Decisão

- **Guardar a última lista que o servidor devolveu** (id, nome, papel e fuso de cada organização), só com o runtime offline ligado, e usá-la **somente** quando a leitura falha por conexão ou por servidor fora do ar (sem código de resposta, `SERVICE_UNAVAILABLE` ou erro interno). Nunca para "sessão encerrada" (`UNAUTHORIZED`), "sem permissão" ou erro de pedido: esses mostram o erro de sempre.
- **É conforto de tela, não prova de acesso.** O servidor continua autorizando cada pedido; o papel guardado só desenha a tela. A organização escolhida segue sendo a preferida validada contra a lista (a guardada, quando offline).
- **A cópia some quando a sessão termina:** ao sair (depois de o fluxo seguro de saída apagar os dados do aparelho) e quando o servidor responde `UNAUTHORIZED`. Quem abrir o navegador depois não recebe as organizações de outra pessoa; sem rede e sem cópia o app diz que não foi possível carregar, como antes.
- **Aberto da cópia, lê a lista de verdade assim que a rede volta** (evento `online`), então uma organização renomeada ou um acesso retirado aparecem sem recarregar.
- **Sessão recusada com o app aberto.** Se o servidor responder "não autenticado" ou "sem permissão" a uma sincronização (a sessão acabou ou o acesso foi retirado com o app aberto e online), o runtime marca `sessionRefused`: as telas deixam de ler da cópia local (voltam ao servidor, que dirá não) e as organizações são lidas de novo, o que apaga a cópia quando a sessão realmente acabou. Uma sincronização que dá certo limpa a marca.
- **Saída:** a cópia é apagada e uma resposta de organizações que ainda estava em voo não a reescreve (marca de saída em curso); sem o runtime pronto, "Sair" diz que não conseguiu verificar o trabalho guardado em vez de não fazer nada.
- **A chave de build é lida num só lugar** (`offline/runtime/enabled.ts`): com ela desligada nada é gravado nem lido.
- **Prova em navegador** (`e2e/offline-entry.e2e.ts`, o app real na build de laboratório com o runtime ligado, e o servidor representado por interceptação de rede): depois de uma visita online o app abre sem rede com a organização lembrada; sem visita anterior diz que não foi possível carregar; com a sessão encerrada a cópia é apagada e não é oferecida nem depois, offline; aberto da cópia, a lista verdadeira entra quando a rede volta. A build de laboratório (nunca publicada) passou a ligar a chave do runtime para isso.

## Consequências

- Um navegador compartilhado cujo dono saiu da conta sem usar "Sair" e sem sessão válida online guarda a cópia até a próxima resposta do servidor; ela traz só nome, papel e fuso de organizações, e o mesmo navegador já guarda, por usuário, o namespace local que o ADR 0044 isola do usuário seguinte.
- A cópia não é ligada a um usuário: num navegador compartilhado cujo dono saiu sem "Sair" e sem sessão, uma falha de servidor (5xx) simultânea na leitura das organizações e na checagem do aparelho abre o espaço do dono anterior até a próxima resposta do servidor. Aceito, na mesma linha do ADR 0044 (a janela exige as duas falhas ao mesmo tempo; o servidor continua recusando tudo o que o aparelho enviar sem sessão).
- O papel guardado pode ficar defasado offline (um papel rebaixado continua desenhando as telas do papel antigo); o servidor recusa o que o papel atual não permite quando o trabalho é enviado.

## Alternativas rejeitadas

- **Derivar a organização só do lease e do registro de namespaces:** o lease não traz nome nem fuso, que o cabeçalho e as datas da venda e do estoque usam.
- **Guardar a cópia sempre, também com o runtime desligado:** gravaria no disco de todos os usuários antes do checklist em aparelho físico.
