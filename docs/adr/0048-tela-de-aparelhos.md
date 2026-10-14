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
