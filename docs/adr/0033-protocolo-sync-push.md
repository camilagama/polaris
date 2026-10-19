---
status: accepted
---

# Protocolo do `sync.push`: idempotência por ID, revalidação por comando e fila em ordem

## Contexto

O PR53 do plano pede o protocolo de servidor para os comandos que o outbox ([ADR 0032](0032-outbox-duravel-de-comandos.md)) envia: idempotência, mesmo comando com o mesmo resultado, revalidação de capability, de direito (entitlement), de lease e de organização. Os comandos de domínio (clientes, produtos, estoque, vendas) chegam nos PR54 a PR57; este PR entrega o quadro em torno deles.

## Decisão

- **Uma transação de tenant por comando, em ordem.** `sync.push` recebe até 50 comandos e trata cada um em sua própria transação autorizada (`sync:push`: sessão, membership e organização ativos). Depois de uma rejeição, os seguintes voltam `not_processed`: um comando nunca ultrapassa outro de que pode depender. Um erro inesperado (banco fora) derruba a requisição inteira e o dispositivo reenvia; o que já tem resultado gravado é repetido.
- **Idempotência por `command_id` e organização** (`sync_commands`, migration 0046): cada comando tem **um** resultado gravado, `accepted` com o resultado do domínio ou `rejected` com um código estável. O mesmo comando de novo devolve o resultado gravado (`replayed: true`) sem executar de novo; o mesmo ID com outro tipo ou conteúdo (hash SHA-256 do JSON canônico de tipo, versão-base e payload) responde `command_id_reused` e **não grava nada**, de modo que o primeiro resultado prevalece. Um lock consultivo por (organização, comando) faz oito envios simultâneos executarem uma vez só. A tabela é append-only para o runtime (só `SELECT` e `INSERT`) e imutável até para o dono (gatilho).
- **Revalidação por comando**, nesta ordem: assinatura do lease (o servidor é o único que assina), manipulador e capability do tipo presentes no lease, payload válido, depois, no banco, o mesmo principal da sessão, grant existente e não revogado, dispositivo vivo e igual ao do comando, mesma época e capabilities do snapshot ainda concedidas ao papel, e o direito da organização (ponto de extensão `isEntitled`, sem efeito até existir billing). Antes de qualquer leitura, um lease cujo `sub` difere do usuário da sessão responde `session_changed` sem gravar nada: a chave de idempotência é (organização, `command_id`) sem o usuário e uma recusa gravada ficaria colada ao comando, chegando ao dono quando ele voltasse. Pelo mesmo motivo, um `command_id` cujo registro pertence a outro usuário responde `command_id_reused` sem gravar e sem devolver o resultado alheio. Qualquer outra falha de autorização vira o código `authorization_revoked` gravado; assinatura ruim vira `lease_invalid` sem gravar (sem claims verificadas não há como saber de quem é o comando, e o registro tomaria o `command_id` do dono); tipo desconhecido, `unsupported_command_type`; payload ruim, `invalid_payload`.
- **O lease vencido ainda cobre o que foi criado enquanto valia.** A janela do lease não é verificada na assinatura nem no grant; no lugar dela, o instante de criação do comando (relógio do dispositivo) precisa estar dentro de `[iat, exp]` do lease, com tolerância de 5 minutos, e não pode estar no futuro do relógio do servidor (`invalid_creation_time`). O relógio do dispositivo não é confiável: o risco aceito é um dispositivo adiantar ou atrasar um comando dentro de um lease que ainda não foi revogado, mitigado porque revogação, época e capabilities valem sempre e o domínio revalida as regras de negócio (estoque, versões) no servidor.
- **O trabalho de domínio roda em um savepoint.** Uma recusa esperada (classificada pelo manipulador) desfaz as escritas do comando e grava a rejeição; um erro inesperado desfaz tudo, não grava nada e permite o reenvio.
- **Registro de manipuladores.** Cada comando offline se registra em `server/sync/registry.ts` com tipo, capability, validação de payload, execução e classificador de erros; o registro está vazio até o PR54.
- **Códigos estáveis para a interface** (PR58): `authorization_revoked`, `lease_invalid`, `entitlement_changed`, `invalid_creation_time`, `wrong_device`, `command_id_reused`, `session_changed` (o lease foi emitido para outro usuário que não o da sessão que envia, por exemplo troca de conta no mesmo navegador; não gravado, o comando segue na fila e o dono o envia depois), `command_too_old` (comando novo criado há mais de 90 dias, não gravado; [ADR 0079](0079-retencao-por-classe-de-dado.md)), `capability_not_in_lease`, `invalid_payload`, `unsupported_command_type`, mais os códigos de cada manipulador (estoque insuficiente, conflito de versão, conflito de SKU).

## Consequências

- Reenviar é sempre seguro: a repetição devolve o mesmo resultado, e o outbox pode reenviar um comando `sending` depois de um reinício.
- Os comandos de domínio dos próximos PRs só precisam de manipulador, validação e classificação; idempotência, autorização e ordem já estão provadas por gate.
- A tabela `sync_commands` cresce com o uso; retenção e limpeza ficam no backlog (a idempotência exige guardar o resultado por um prazo maior que o maior lease mais a espera de sincronização).
- Sem o segredo do lease o endpoint falha fechado (503) antes de tocar no banco.

## Alternativas rejeitadas

- **Um lote atômico para todos os comandos:** uma recusa descartaria trabalho válido e quebraria a idempotência por comando.
- **Pular o comando rejeitado e continuar o lote:** reordenaria comandos dependentes.
- **Rejeitar todo comando depois do vencimento do lease:** perderia vendas feitas dentro da janela por causa de uma sincronização tardia, contra o §56 do documento inicial.
- **Incluir o usuário na chave de idempotência** (índice único `(organization_id, command_id)` passaria a `(organization_id, user_id, command_id)`): exigiria migration e deixaria o mesmo `command_id`, UUID gerado no aparelho, valer duas vezes para usuários diferentes da mesma organização. Recusar antes de ler ou gravar (`session_changed`, `command_id_reused`) resolve o problema sem migration e mantém um resultado por comando.
