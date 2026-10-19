---
status: accepted
---

# Tela de aparelhos: revogar um celular perdido

## Contexto

Um aparelho perdido ou roubado guarda um lease offline válido por até 72 horas e uma cópia local da organização. O servidor já sabia revogar um aparelho (`device.revoke`, que também cancela as autorizações offline dele, ADR 0033 e 0044), e já recusava tudo o que um aparelho revogado enviasse, mas a pessoa não tinha como pedir isso: o ADR 0044 registrou a falta da tela como risco aceito.

## Decisão

- **Uma tela "Aparelhos"** (`/devices`, no menu só quando o runtime offline está ligado, que é quando existe aparelho registrado) lista os aparelhos ativos da conta (nome, registro, visto por último), este primeiro e depois o mais recente. Aparelhos já revogados não aparecem.
- **Revogar exige confirmação que diz o que perde:** o aparelho deixa de enviar, o que estiver guardado nele (vendas, cadastros, movimentos) não será aceito e não dá para desfazer; para um aparelho perdido ou roubado. Cancelar não altera nada. A resposta diz quantas autorizações offline foram canceladas.
- **Este aparelho não se revoga por aqui:** a tela manda usar "Sair", que protege a fila e apaga os dados locais antes de encerrar a sessão (ADR 0039). Revogar o aparelho em uso deixaria trabalho guardado sem caminho de envio.
- **Só com conexão:** sem conexão a lista não carrega e o botão fica desabilitado. Uma falha sem resposta não afirma que a revogação aconteceu: pede para atualizar e tentar de novo, e revogar um aparelho já revogado é seguro (idempotente no servidor).
- **O servidor continua a autoridade:** a tela só chama `device.list` e `device.revoke`, que leem a sessão (a conta nunca vem do cliente).
- **Provas:** testes de unidade da ordem, dos nomes e das mensagens; cenários de navegador com o app real e o servidor por interceptação de rede: listar, confirmação clara antes de revogar, revogar e ver o aparelho sair da lista com a contagem de autorizações, cancelar sem efeito, sem conexão sem opção de revogar, e o item no menu.

## Consequências

- O risco "sem tela de revogação de aparelho" do ADR 0044 está resolvido para o caso de perda; o aparelho revogado que voltar a falar com o servidor é tratado como no ADR 0044 (esquece o aparelho e o lease e registra de novo, sem abrir o espaço de outro usuário).
- Quem revoga o aparelho errado precisa que ele se registre de novo (entrando e abrindo o app com conexão); o trabalho guardado nele que ainda não tinha sido enviado fica recusado no servidor.

## Alternativas rejeitadas

- **Permitir revogar o próprio aparelho:** deixaria a fila dele sem como ser enviada; "Sair" já faz o caminho seguro.
- **Revogar sem confirmação:** a ação é irreversível e pode descartar trabalho de outro aparelho.

## Emenda (19/10/2026): revogar encerra as sessões do aparelho

Revogar um aparelho passa a encerrar também as sessões que o usaram. Antes, a revogação só recusava o que o aparelho enviasse, e o cookie do navegador perdido continuava válido até a sessão expirar.

- **Vínculo sessão-aparelho:** a tabela `device_sessions` (migration 0078) guarda o id da sessão e o id do aparelho, nunca o token. O servidor cria o vínculo a partir da sessão verificada quando ela usa um aparelho vivo: registro (`device.register`), autorização offline (`offline.issueLease`), validação do lease no envio (`sync.push`) e a nova verificação `device.check`. O vínculo só é criado no mesmo comando que trava o aparelho com `FOR SHARE`. Assim, uma revogação concorrente ou espera e vê o vínculo, ou vence e o envio é recusado (`device_revoked`).
- **Verificação ao iniciar:** o runtime offline chama `device.check` a cada início com conexão. Um novo login no mesmo navegador, com lease em cache e sem envio, também fica ligado ao aparelho e cai na revogação.
- **Encerramento na mesma transação:** revogar marca o aparelho, revoga os leases dele e chama `end_device_sessions()`, função SECURITY DEFINER de um dono NOLOGIN próprio, executável só pelo runtime tenant. Ela apaga as sessões ligadas ao aparelho. O cookie daquele navegador deixa de valer na próxima requisição, porque o cache de sessão em cookie está desligado. As sessões dos outros aparelhos continuam, sem troca de época de autorização.
- **Encerrar as outras sessões:** `device.revoke` aceita a opção "encerrar também todas as outras sessões deste usuário", desmarcada por padrão. Quando marcada, encerra todas as sessões do usuário, menos a atual, inclusive a que nunca usou aparelho (por exemplo, um login novo feito por quem roubou o celular).
- **Sessão recente:** revogar outro aparelho, ou usar a opção acima, exige login há menos de 15 minutos. Fora disso, o servidor responde FORBIDDEN com motivo `fresh_session_required`, e é preciso entrar de novo. Revogar o próprio aparelho não exige. Próprio é o aparelho que esta sessão registrou: usar um aparelho (verificação, lease ou envio) liga a sessão a ele, mas não o torna próprio, senão bastaria verificar outro aparelho antes de revogá-lo. Nesse caso a resposta traz `endedCurrentSession: true` e o navegador também sai. A própria função também exige login recente para a opção de encerrar as outras sessões, para que quem consiga executar SQL como o runtime tenant não tenha por ela um jeito de derrubar todas as sessões de um usuário. A resposta de `device.revoke` traz `endedSessionCount` e `endedCurrentSession`.
- **Auditoria:** sempre que um aparelho passa de vivo a revogado, mesmo sem nenhuma sessão ligada a ele, e sempre que uma repetição da revogação encerra ao menos uma sessão, grava `device_revoked` em `auth_security_audit_event`, com ator, aparelho revogado (`subject_id`), quantidade de sessões encerradas, sessão e aparelho de quem revogou (`acting_session_id` e `acting_device_id`, nunca o token) e o id da requisição. Sem id de requisição válido, a função gera um, e a falta dele não derruba a revogação; a auditoria grava na mesma transação da revogação. Retenção de 6 meses. `device_sessions` segue a classe `auth_sessions` e sai em cascata com a sessão. A repetição que não encerra nada (aparelho já revogado e nenhuma sessão ligada) não é auditada. A função recebe `p_newly_revoked` do `revokeDevice`, que sabe se o `UPDATE` mudou a linha. O banco confia nesse valor, mas não amplia o que o chamador alcança: as recusas da função valem também com ele forçado (aparelho vivo, de outro usuário, sem usuário, sessão alheia). Quem executa SQL como o runtime tenant pode, no pior caso, gravar linhas `device_revoked` ilimitadas sobre aparelhos já revogados do próprio usuário, ou deixar de auditar uma revogação com valor falso. Aceitamos esse limite, igual ao do restante da trilha, porque exigiria já ter SQL arbitrário no runtime tenant.
- **Limite offline:** um navegador que nunca volta a ficar online continua com o lease local até vencer, no máximo 72 horas. Esse limite já foi aceito no ADR 0047. Quando o navegador volta a falar com o servidor, a revogação recusa a sessão, e o cliente que trata o 401 apaga a cópia local.
- **Limite conhecido, sessões anteriores ao deploy:** não há backfill do vínculo, que só nasce quando a sessão usa o aparelho depois do deploy. Uma sessão criada antes e que não usou o aparelho (um celular perdido e parado) não é encerrada pela revogação. A saída é a opção "encerrar as outras sessões" da API, ou encerrar as sessões no deploy; no go-live não há sessões antigas, e o [checklist de release](../runbooks/release-checklist.md) (item 17) cobre o caso de o PR entrar depois de haver usuários. Não anunciar que "revogar encerra a sessão do aparelho perdido" antes de a tela oferecer a opção.
- **Escopo desta emenda:** a tela ainda não oferece a opção de encerrar as outras sessões nem mostra o aviso de `endedCurrentSession`. Por enquanto existe só o contrato da API. A classe de retenção de `devices` foi decidida em 19/10/2026 (90 dias depois da revogação; ver o [ADR 0079](0079-retencao-por-classe-de-dado.md)).
