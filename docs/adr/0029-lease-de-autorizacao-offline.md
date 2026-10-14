---
status: accepted
---

# Lease de autorização offline assinado, época de autorização e invalidação por troca de senha

## Contexto

O [ADR 0028](0028-dispositivos-e-grants-offline.md) criou o registro de dispositivos e de grants. O PR49 (plano) pede um lease de 72 horas, assinado e validado de forma segura, com usuário, organização, dispositivo, época, expiração e snapshot de capabilities, sem que o servidor deixe de revalidar tudo no sync. O `doc-inicial` (§56) acrescenta: reset de senha e suspensão invalidam de imediato; downgrade normal não renova mas deixa o lease vigente terminar; no trial a expiração é `min(agora + 72 h, fim do trial)`.

## Decisão

- **Formato.** `v1.<keyId>.<payload>.<assinatura>`: payload é o JSON base64url das claims (`v`, `jti`, `sub`, `org`, `dev`, `epoch`, `iat`, `exp`, `caps`, em ordem fixa) e a assinatura é HMAC-SHA256 sobre tudo que precede o último ponto, via Web Crypto (comparação em tempo constante). Só o servidor tem o segredo, então só ele assina e verifica. O cliente pode **ler** as claims (mostrar quando o lease acaba e parar mutações offline) mas não forjar nem estender. HMAC basta porque o verificador é o mesmo que assina; uma assinatura assimétrica só traria valor se o cliente precisasse verificar, o que não precisa e não deve confiar.
- **Chaves e rotação.** O Worker lê `OFFLINE_LEASE_SECRET` (mínimo 32 bytes) e `OFFLINE_LEASE_KEY_ID` (padrão `k1`). Em rotação, `OFFLINE_LEASE_PREVIOUS_SECRET` com `OFFLINE_LEASE_PREVIOUS_KEY_ID` continua verificando leases vivos (no máximo 72 h). Sem segredo, o recurso **falha fechado** (`SERVICE_UNAVAILABLE`) antes de gravar qualquer coisa.
- **Janela.** `min(agora + 72 h, fim do direito)`, em segundos inteiros, nunca vazia. O fim do direito (trial) é um parâmetro; billing ainda não existe, então hoje nenhum chamador o informa.
- **Época de autorização por membership** (`memberships.authorization_epoch`, migration 0043). O lease carrega a época vigente; no sync, época diferente invalida. O runtime de tenant só lê; **quem escreve é a função `SECURITY DEFINER` `bump_user_authorization_epoch(user_id)`**, executável só pela role de autenticação (a que roda o Better Auth). Ela incrementa a época de todas as memberships do usuário e revoga todos os grants vivos com motivo `security_event`, com um evento de auditoria por grant na própria organização. O gancho `onPasswordReset` do Better Auth a chama, então **reset de senha invalida todos os leases na hora**. Se a função falhar, o erro propaga (a senha já mudou e as sessões foram revogadas; um novo reset repete a invalidação).
- **Sem corrida.** Emissão de lease e `bump` tomam o mesmo lock consultivo por usuário (`authorization-epoch:<usuário>`): ou o lease nasce antes e é revogado, ou nasce depois com a época nova. Provado por corrida no gate.
- **Suspensão** não usa época: o grant só é válido com organização ativa (políticas de RLS e transação tenant), então a suspensão invalida na hora sem escrita. Downgrade normal não renova o lease (a emissão consulta o direito) e não toca os vigentes.
- **Revalidação no servidor** (`validateOfflineLeaseClaims`, usada pelo `sync.push` a partir do PR53): mesmo principal da sessão (usuário e organização), grant existente, vivo e não expirado, dispositivo vivo, mesma época, e capabilities do snapshot contidas no que o papel ainda tem. Cada falha tem seu motivo, só para log; o cliente não recebe o motivo.
- **RPC.** `device.register|list|revoke` (só usuário, sem contexto tenant) e `offline.issueLease` (transação tenant com a capability `offline:manage`). O lease é assinado **dentro** da transação: falha de assinatura desfaz o grant.

## Consequências

- Um lease roubado só vale pelo restante das 72 h, no máximo, e só enquanto o dispositivo, o grant, a época e a organização continuarem válidos; o servidor não confia nas capabilities do token além do que o papel ainda concede.
- O relógio do dispositivo não é confiável para a emissão (o servidor usa o seu); o cliente usa o `exp` apenas para bloquear novas mutações offline.
- O segredo é novo na lista de go-live: criar `OFFLINE_LEASE_SECRET` (e um `KEY_ID`) em cada ambiente antes de ligar o offline.
- A invalidação por troca de senha depende da role de auth ter `EXECUTE` na função; a migration concede.

## Alternativas rejeitadas

- **JWT com biblioteca externa:** a superfície de algoritmos e o formato aberto não trazem nada aqui; o formato próprio é pequeno, fechado a `v1` e testado.
- **Época no `user`:** o runtime de tenant não lê a tabela `user` ([ADR 0027](0027-separacao-de-roles-auth-tenant-e-superficies-poc.md)); a época por membership fica onde o sync já lê.
- **Revogar só pela época, sem tocar os grants:** deixaria grants "vivos" no banco e na lista, e a auditoria por grant se perderia.
