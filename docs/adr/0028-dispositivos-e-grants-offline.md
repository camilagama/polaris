---
status: accepted
---

# Dispositivos e grants de autorização offline

## Contexto

A Fase 5 leva commands do domínio para o navegador. Antes de qualquer outbox ou lease assinado (PR49 a PR53), o servidor precisa saber **qual instalação** emitiu cada command e **até quando** ela pode operar sem consultar o servidor. O plano (PR48) pede as tabelas `devices` e `offline_grants`, sem fingerprint, com revogação. O `doc-inicial` (§56 e §57) define o lease de no máximo 72 horas e o dispositivo como instalação com id aleatório, usuário, `created_at`, `last_seen`, `revoked_at` e metadados mínimos; o dispositivo **não é fator de autenticação**.

## Decisão

- **`devices` pertence ao usuário, não à organização.** Uma instalação é de uma pessoa e pode atender mais de uma organização. As políticas de RLS olham apenas `app.user_id`. Colunas: `id` (UUIDv7 gerado pelo banco), `user_id`, `label` opcional (nome curto que o usuário digita; 1 a 80 pontos de código, sem caracteres de controle), `created_at`, `last_seen_at`, `revoked_at`. **Nenhum fingerprint, user agent ou descrição de hardware.**
- **`offline_grants` pertence a uma organização e a um dispositivo.** Registro no servidor de um lease emitido: `organization_id`, `user_id`, `device_id`, `authorization_epoch` (a época vigente na emissão; quem a incrementa e valida chega com o PR49), `issued_at`, `expires_at`, `revoked_at`, `revoked_reason`. Chaves estrangeiras compostas garantem que o dispositivo é do mesmo usuário e que o usuário é membro da organização. O lease assinado que o cliente guarda é o PR49.
- **No máximo 72 horas.** `expires_at > issued_at` e `expires_at <= issued_at + 72 h` valem no domínio e em um CHECK. Reduções (trial: `min(agora + 72 h, fim do trial)`) pertencem ao PR49.
- **Revogação é terminal e idempotente.** Um dispositivo ou grant revogado nunca volta; gatilhos no banco impedem reviver, alterar o motivo ou tocar `last_seen_at` de um dispositivo revogado, mesmo com SQL cru. A primeira revogação vence. Motivos fechados: `device_revoked`, `user_revoked`, `security_event`, `organization_suspended`.
- **Revogar um dispositivo revoga seus grants em todas as organizações do usuário**, na mesma transação, com um evento de auditoria `offline_grant.revoked` por grant, na auditoria da própria organização. Grants só são visíveis sob o escopo de sua organização, então a revogação percorre as organizações do usuário uma a uma na mesma conexão. Grants de organizações suspensas não são atualizáveis pela política (a organização deixa de ser ativa) e expiram em até 72 horas; a sincronização recusa de qualquer forma.
- **Um grant só nasce em dispositivo vivo do próprio usuário**, verificado no repositório e por um gatilho que trava a linha do dispositivo com `FOR SHARE`: uma revogação concorrente roda antes (o grant é recusado) ou espera o grant e o revoga. Provado por corrida no gate.
- **Limite de 20 dispositivos vivos por usuário**, serializado por lock consultivo. Revogar um libera uma vaga.
- **Privilégios mínimos para o runtime de tenant**: `SELECT` e `INSERT` nas duas tabelas; `UPDATE` só em `label`, `last_seen_at`, `revoked_at` (dispositivos) e `revoked_at`, `revoked_reason` (grants); nenhum `DELETE` ou `TRUNCATE`; RLS forçada.
- **Capability `offline:manage`** (owner) para operar grants dentro de uma organização. Operações de dispositivo usam uma transação só de usuário (`withUserTransaction`), sem organização.
- **Sem RPC neste PR.** O registro do dispositivo e a emissão do lease serão expostos junto com o lease assinado (PR49), onde há um cliente para chamá-los.

## Consequências

- O servidor passa a ter, por dispositivo e organização, o instante até o qual um lease é válido e a época de autorização que o originou, o que permite que o PR49 e o `sync.push` (PR53) revalidem tudo.
- Um registro duplicado de dispositivo (retry do cliente) cria uma segunda linha; o limite de 20 e a revogação contêm isso. O PR49 pode tornar o registro idempotente pelo id guardado no cliente.
- A revogação de organização suspensa não alcança o grant; é aceitável porque o lease dura no máximo 72 horas e o servidor revalida a suspensão no sync.
- O uso de `last_seen_at` é só diagnóstico; sua frequência de escrita será limitada pelo cliente.

## Alternativas rejeitadas

- **`devices` por organização:** duplicaria o mesmo navegador em cada organização e impediria revogar a instalação inteira de uma vez.
- **Fingerprint do navegador:** invasivo e sem valor de autenticação; o plano o proíbe.
- **`DELETE` de dispositivos:** perderia o histórico de que um grant existiu; a revogação terminal basta.
