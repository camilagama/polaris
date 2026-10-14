---
status: accepted
---

# Edição de cliente sem conexão

## Contexto

O ADR 0045 deixou a edição offline de fora de propósito: não havia comando de edição e inventar um exigiria decidir antes como resolver conflitos. Cadastrar sem rede já funciona (`customer.create`), mas corrigir o telefone de um cliente já cadastrado exigia conexão, e o telefone é justamente o dado que se corrige no balcão. Edição é também o caso em que dois aparelhos podem discordar: outro aparelho pode ter alterado o mesmo cliente enquanto este estava sem rede.

## Decisão

- **Um comando, `customer.update`, que carrega a versão que a pessoa editou.** O payload é o do cadastro (`customerId`, `name`, `phone`, `email`, `notes`, normalizado pelas mesmas regras do servidor) e o `baseVersion` do comando é a versão do cliente quando a edição começou. O contrato só cresce (ADR 0042): o servidor sobe antes do app e o arquivo dourado de payloads ganhou um caso.
- **O servidor aplica a edição só sobre a versão que o aparelho viu.** O manipulador chama a mesma `updateCustomer` da tela online com `expectedVersion = baseVersion`. Se o cliente já passou dessa versão, a edição é recusada inteira (`customer_version_conflict`), sem sobrescrever nada e sem evento de auditoria; cliente inexistente ou de outra organização é `customer_not_found`; perfil inválido é `invalid_payload`. Um `baseVersion` ausente ou inválido é payload inválido (nunca se aplica "sobre qualquer versão"). Reenviar o mesmo `commandId` devolve o resultado guardado, sem aplicar duas vezes.
- **A recusa não tem "reenviar"; a saída é descartar e refazer.** Reenviar a mesma alteração sobre uma versão nova sobrescreveria, sem a pessoa ver, o que o outro aparelho gravou. Pendências mostra o que aconteceu ("este cliente foi alterado em outro lugar…, nada foi sobrescrito"), oferece só **Descartar** (com confirmação) e a pessoa edita de novo a partir do cadastro atual. Cliente que sumiu tem o mesmo caminho.
- **A edição não é gravada na linha local.** A linha do cliente continua sendo a que o servidor mandou; a edição que espera é sobreposta na exibição (`overlayPendingCustomerEdits`) a partir do outbox. Assim o outbox é a única fonte do que está pendente: um descarte, uma recusa ou um travamento no meio do caminho nunca deixam uma linha meio aplicada, não há o que restaurar depois de uma queda, e a edição aceita é substituída pela linha do servidor no próximo pull, como qualquer outra mudança. Uma edição recusada deixa de ser sobreposta (o cartão mostra o cadastro do servidor, com "Alteração recusada pelo servidor" e o caminho para Pendências).
- **Uma edição pendente por cliente.** Uma segunda edição seria feita sobre uma versão que o servidor ainda não produziu e seria recusada por construção; por isso editar, arquivar e restaurar ficam desabilitados, com a razão escrita no cartão, enquanto o cliente tem uma edição esperando (ou recusada e não resolvida) ou um cadastro que o servidor ainda não confirmou.
- **Só com o runtime pronto e sem conexão.** Com conexão a edição segue direto ao servidor, como antes (a resposta já diz se houve conflito), e a linha devolvida entra na coleção local. Sem conexão a edição é guardada. **Arquivar e restaurar continuam exigindo conexão** (sem comando; o cartão diz isso).
- **Provas.** Testes de unidade do manipulador (tipo, capacidade, payload igual ao do cadastro, base inválida sem tocar o cliente, classificação das recusas), do módulo do aparelho (comando com a versão editada, nada gravado na linha local, uma pendente por cliente, aplicado e substituído pela linha do servidor, recusado sem sobrescrever, descarte, sobreposição) e do painel de atenção; o arquivo dourado; 3 cenários de navegador (6 execuções: editar sem rede e o servidor aplicar ao voltar; arquivar bloqueado e editar não; cliente alterado em outro aparelho, recusa à vista); e no banco real (gate `offline-customer`, em PostgreSQL 18): edição sobre a versão atual aplicada (versão +1, um evento de auditoria) e repetida sem aplicar duas vezes; edição sobre versão antiga recusada com código próprio, sem alteração nem auditoria, e a recusa guardada e repetida; a mesma edição refeita como comando novo aceita; edição sem mudança aceita sem mexer na versão; cliente inexistente ou de outra organização, lease emprestado de outra organização e perfil inválido recusados sem rastro.

## Consequências

- Corrigir o telefone de um cliente sem rede passa a funcionar, e o único custo de duas pessoas editarem o mesmo cliente sem rede é uma alteração recusada à vista, nunca um dado sobrescrito em silêncio.
- Uma edição recusada bloqueia a fila, que é ordenada: o que vem depois espera até a pessoa descartá-la em Pendências.
- A linha local pode mostrar, de uma edição recusada, o cadastro de antes da edição até o próximo pull que traga a versão nova; a tela diz que a alteração foi recusada e a causa está em Pendências.
- Quem edita sem rede um cliente que o outro aparelho também editou perde a digitação ao descartar; o painel mostra o nome digitado no título para a pessoa refazer.

## Alternativas rejeitadas

- **Gravar a edição na linha local e restaurar a partir do outbox:** é o que o cadastro faz, mas ali a linha não existia; aqui haveria uma linha alterada que o servidor ainda não aceitou, a restaurar e a desfazer em cada descarte e recusa. Sobrepor na exibição elimina a classe inteira de inconsistências.
- **Reenviar a edição recusada sobre a versão nova (último a gravar vence):** perde, sem ninguém ver, o que o outro aparelho gravou.
- **Mesclar campo a campo:** exige decidir, por campo, quem vence; o volume de edições concorrentes de cliente não justifica a regra nova.
- **Fila de várias edições por cliente:** cada uma dependeria da versão produzida pela anterior, que o aparelho só conhece depois de o servidor responder.
