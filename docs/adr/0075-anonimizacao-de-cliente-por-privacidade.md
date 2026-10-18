---
status: accepted
---

# Anonimização de cliente por privacidade

## Contexto

Nome, telefone, email e observações de um cliente são dado pessoal fornecido pelo revendedor (ver [privacidade](../business-rules/privacy.md)). O PR102 do plano pede o comando `customer.anonymizeForPrivacy`, que remove a pessoa e **preserva os fatos econômicos**. O cliente é referenciado por vendas (a atribuição de cliente é uma linha separada, em [vendas](../business-rules/sales.md#atribuição-de-cliente-pr44), e a venda não guarda dado pessoal), pelo log de mudanças que os aparelhos puxam e pela auditoria, e hoje não existe exclusão física de cliente.

## Decisão

- **O registro fica e a pessoa sai.** Anonimizar mantém o `id` (as vendas continuam apontando para o mesmo cliente) e troca, na mesma linha, o nome por um texto fixo (`Cliente anonimizado`) e apaga telefone, email e observações. O cliente é arquivado se ainda não estava, a versão avança e `anonymized_at` marca o momento. Não se apaga nem se cria linha.
- **O banco exige isso, e não deixa desfazer.** A coluna `anonymized_at` entra com um CHECK: uma linha anonimizada tem exatamente o nome fixo, nenhum contato, nenhuma observação e está arquivada; o CHECK de "nome e ao menos um contato" passa a valer só para quem não foi anonimizado. Um gatilho `BEFORE UPDATE` recusa **qualquer** alteração de uma linha já anonimizada (inclusive limpar a marca, recolocar os dados ou mudar a versão). O papel de runtime ganha `UPDATE` só na coluna nova, e o dono do cliente continua sem `DELETE`.
- **Comando próprio e capacidade própria.** `customer.anonymizeForPrivacy` exige a capacidade nova `customer:anonymize` (separada de `customer:update`, porque é irreversível), a versão atual (`expectedVersion`) e o `organizationId` de uma transação tenant autorizada. Repetir sobre um cliente já anonimizado não muda nada (devolve `changed: false`, qualquer que seja a versão informada). Um evento de auditoria `customer.anonymized` guarda só o ID do cliente e o ID da requisição, como os outros.
- **O que deixa de ser possível.** Editar ou restaurar um cliente anonimizado é recusado (`customer_anonymized`, 409 online; offline, o comando `customer.update` é rejeitado com esse código e a pendência aparece como indisponível); arquivar de novo é um no-op. Como está arquivado, uma venda não pode ser ligada a ele de novo (a regra de vínculo só aceita cliente ativo), e as vendas já ligadas continuam apontando para ele, com a mesma economia: itens, ajustes, pagamento, vínculo, movimentos de estoque e saldos ficam idênticos. A busca de possíveis duplicados não o encontra (não tem mais email nem telefone).
- **Nada da pessoa sobra nos outros lugares do servidor.** A auditoria e o log de mudanças guardam só IDs; o log de comandos offline guarda um hash do payload e um resultado com IDs e versão; as tabelas de venda não guardam dado pessoal (a lista de vendas mostra o nome do cliente lendo a linha viva, que agora tem o nome fixo). O gate procura os dados antigos em texto claro no cadastro, na auditoria, no log de mudanças, no log de comandos e nas vendas, e não acha.
- **Aparelhos.** A anonimização chega aos aparelhos pelo log de mudanças como qualquer alteração do cliente (a linha local passa a ter o nome fixo, sem contatos, arquivada). A mudança de um cliente também atualiza as vendas recentes guardadas no aparelho, porque elas carregam o nome do cliente. O modelo local não guarda `anonymized_at`: a tela reconhece um cliente anonimizado pelo formato que só ele pode ter (sem telefone e sem email, porque o banco exige um contato de todo cliente comum), e o servidor é quem recusa editar ou restaurar. Um aparelho que ficou offline sem sincronizar mantém a cópia antiga até puxar a mudança.
- **Quem decide.** O pedido de privacidade de um cliente do revendedor é, em geral, do revendedor (controlador); o Polaris não anonimiza por e-mail de terceiro. Os casos de privacidade (PR103) são o fluxo que registra o pedido e a decisão; este PR entrega o comando que o executa, usado pelo dono na própria organização.

## Consequências

- Atende um pedido de apagamento sem perder o histórico financeiro: o relatório de vendas, margens e estoque não muda.
- Uma anonimização não tem volta, nem pelo suporte: não há como recolocar o dado, porque o sistema não o guarda.

## Limites aceitos

- O log de comandos offline guarda um hash SHA-256 (sem sal) do payload dos comandos `customer.create` e `customer.update`, que cobre nome, telefone, email e observações. Não é dado em texto claro, mas é pseudonimização: quem lê o banco ou um backup pode confirmar, por tentativa, um valor suspeito. Trocar por um HMAC com segredo fica para a retenção do log (PR105).
- Uma edição de cliente feita offline e ainda não enviada (ou rejeitada) permanece na fila do aparelho, com o que foi digitado, até ser enviada ou descartada; o servidor a recusa depois da anonimização (`customer_anonymized`), e o dono descarta em Pendências.
- Cópias antigas fora do banco ativo (backups do provedor, branches do banco, exportações já entregues, caches no navegador do dono, aparelhos que não sincronizaram) não são alcançadas por este comando; o ciclo de retenção desses backups e a limpeza local do aparelho pertencem à retenção (PR105) e ao purge (PR107).
- O texto das observações de outros registros (por exemplo, nome do cliente digitado dentro de um motivo de cancelamento ou de uma descrição de despesa) é texto livre do revendedor e não é varrido.
- Anonimizar é por cliente. Anonimizar em lote, por pedido de uma pessoa que aparece em vários cadastros, é decisão do dono, cadastro a cadastro.
- Sem tela de confirmação além da de dois passos na lista de clientes; sem aviso à pessoa.
- Não há ainda registro do motivo (o caso de privacidade, PR103).

## Alternativas rejeitadas

- **Apagar a linha do cliente:** as vendas e os vínculos apontam para ela, e apagar quebraria o histórico ou exigiria soltar os vínculos, mudando fatos que devem ficar.
- **Substituir os campos por valores aleatórios:** deixa de ser reconhecível como anonimizado e permite confundir com um cadastro real; o texto fixo é verificável pelo banco.
- **Só convenção do código (sem CHECK e sem gatilho):** um erro ou um acesso direto poderia recolocar o dado ou deixar a anonimização pela metade.

## Atualização

O [ADR 0079](0079-retencao-por-classe-de-dado.md) tratou as duas pendências deste ADR: o `payload_hash` passou a ser um HMAC com segredo do Worker (as linhas gravadas antes mantêm o SHA-256 até existir a retenção do log), e o aparelho descarta a edição recusada com `customer_anonymized` em vez de guardá-la como indisponível.
