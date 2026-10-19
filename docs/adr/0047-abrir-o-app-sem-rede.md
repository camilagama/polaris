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
- **Sessão recusada com o app aberto.** Se o servidor responder "não autenticado" ou "sem permissão" a uma sincronização (a sessão acabou ou o acesso foi retirado com o app aberto e online), o runtime marca `sessionRefused`: as telas deixam de ler da cópia local (voltam ao servidor, que dirá não) e as organizações são lidas de novo, o que apaga a cópia quando a sessão realmente acabou. Uma sincronização que dá certo limpa a marca. Desde a emenda do ADR 0044 (L6) o runtime também esquece o lease e apaga as coleções locais nesse caso (a fila fica), e só volta a abrir depois que o app reler as organizações e iniciar de novo.
- **Saída:** a cópia é apagada e uma resposta de organizações que ainda estava em voo não a reescreve (marca de saída em curso); sem o runtime pronto, "Sair" diz que não conseguiu verificar o trabalho guardado em vez de não fazer nada.
- **A chave de build é lida num só lugar** (`offline/runtime/enabled.ts`): com ela desligada nada é gravado nem lido.
- **Prova em navegador** (`e2e/offline-entry.e2e.ts`, o app real na build de laboratório com o runtime ligado, e o servidor representado por interceptação de rede): depois de uma visita online o app abre sem rede com a organização lembrada; sem visita anterior diz que não foi possível carregar; com a sessão encerrada a cópia é apagada e não é oferecida nem depois, offline; aberto da cópia, a lista verdadeira entra quando a rede volta. A build de laboratório (nunca publicada) passou a ligar a chave do runtime para isso.

## Consequências

- Um navegador compartilhado cujo dono saiu da conta sem usar "Sair" e sem sessão válida online guarda a cópia até a próxima resposta do servidor; ela traz só nome, papel e fuso de organizações, e o mesmo navegador já guarda, por usuário, o namespace local que o ADR 0044 isola do usuário seguinte.
- A cópia da lista de organizações não é ligada a um usuário, mas ela só desenha a tela. O espaço local do dono anterior deixou de ficar aberto por falha de servidor: o runtime exige que o usuário da sessão seja o dono do lease e do namespace (emenda do ADR 0044, L6), e só uma recusa explícita da sessão (401, 403 ou sem sessão) deixa o offline indisponível; 5xx, 429 e falha de rede contam como "sem resposta" e o início segue com o usuário lembrado e o lease próprio, como sem rede.
- O papel guardado pode ficar defasado offline (um papel rebaixado continua desenhando as telas do papel antigo); o servidor recusa o que o papel atual não permite quando o trabalho é enviado.

## Emenda (19/10/2026, [ADR 0100](0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md))

Com a tela de entrada, o app com usuário lembrado ganha dois estados que este ADR não cobria. As regras acima (cópia só em falha de conexão, 5xx ou 429; só 401, 403 e "sem sessão" levam à entrada) continuam valendo.

- **Acesso sem internet vencido.** Com usuário lembrado, lease do próprio usuário **vencido** (passou do `exp`, 72 horas) e sem conexão, o app não vai a `/entrar`: mostra "O acesso sem internet venceu", com o número de operações guardadas, **não lê a cópia local, não aceita venda nem estoque novos e deixa a fila intacta**. A regra de lease usável é uma função pura, e um temporizador no `exp` aplica o mesmo estado com o app aberto, sem recarregar; quando a rede volta, o acesso se renova sozinho e o aviso some. Sem rede, nada tenta renovar em laço. A cópia das organizações deste ADR segue só desenhando tela: o vencimento a esconde, não a apaga.
- **Aceite legal pendente não é sessão recusada.** O servidor responde `data.reason = 'legal_acceptance_required'` (padrão de `entitlement_denied`) e o runtime trata esse caso num ramo **antes de `isSessionRefusal`**, em `sync`, `issueLease` e `registerDevice`: só pausa a sync e mostra um aviso fixo, sem navegar, e **não** esquece o lease, o usuário lembrado nem as coleções. O `get-session` não passa pelo controle de aceite. Teste obrigatório: com coleções, lease e fila intactos, um e2e de venda com itens recebe o 403 de aceite e os itens não se perdem.

## Alternativas rejeitadas

- **Derivar a organização só do lease e do registro de namespaces:** o lease não traz nome nem fuso, que o cabeçalho e as datas da venda e do estoque usam.
- **Guardar a cópia sempre, também com o runtime desligado:** gravaria no disco de todos os usuários antes do checklist em aparelho físico.
