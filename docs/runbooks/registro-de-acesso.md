# Registro de acesso de autenticação

**Gatilho:** (1) um pedido de fornecimento de registros de acesso chega ao Polaris (ordem judicial); (2) um pedido de guarda cautelar chega de autoridade policial, administrativa ou do Ministério Público; (3) um alerta de gravação do registro dispara (`auth_access_log_write_failed` ou `auth_access_log_skipped`).

**Por quê:** o [registro de acesso](../adr/0092-registro-de-acesso-a-aplicacao.md) (`public.auth_access_log`) guarda, por 6 meses, data, hora, evento, usuário, IP de origem e identificador da requisição de cada login, falha de login, saída e renovação de sessão, por força do Marco Civil da Internet (art. 15). Ele é sigiloso e só sai com ordem judicial. Quem lê é o operador da plataforma, pela rota do Admin, e cada leitura fica auditada.

> **Nada deste procedimento foi executado contra produção.** Não há script: a consulta é a rota do Admin, feita por uma pessoa com o acesso do Cloudflare Access e a capacidade `access_log:read`. Os exemplos abaixo usam valores fictícios. O número do processo, o usuário e o IP são dados sensíveis: não os cole em chat, ticket ou e-mail comum.

## Pré-requisitos de acesso

- Acesso ao Admin pelo Cloudflare Access, com um principal ativo, e a capacidade `access_log:read`, que só o `platform_owner` tem ([ADR 0070](../adr/0070-admin-acesso-identidade-e-capacidades.md)).
- A ordem judicial, ou o pedido da autoridade, em mãos, com o número do processo no formato CNJ.
- Nenhum acesso ao banco de produção é necessário para a leitura. Acesso ao banco e as credenciais de papel seguem a [política de perfis de CLI](./cli-profile-policy.md) e não fazem parte deste procedimento.

## 1. Fornecimento de registros (ordem judicial)

**Regra:** sem ordem judicial, nada sai. Isso vale também para a polícia e o Ministério Público, que podem pedir só a guarda cautelar (passo 2). O prazo para a autoridade pedir a autorização judicial segue o art. 13, §§3º e 4º, do Marco Civil: **a confirmar com o jurídico**.

Passos:

1. **Conferir a ordem.** Ela existe, está assinada, cita o número do processo e pede o registro de um usuário ou de um endereço IP num período. Se algo faltar, não consulte: devolva o pedido ao jurídico.
2. **Conferir o número do processo.** Ele deve estar no formato `NNNNNNN-DD.AAAA.J.TR.OOOO` (número único do CNJ), com os dígitos verificadores DD corretos: a rota recusa um número digitado errado ou inventado (`invalid_reference`). Isso confere a forma, não a existência do processo: a consulta não se liga a uma ordem registrada, e a conferência da ordem é feita por quem consulta, com o papel de cada passo. Só esse número entra na consulta: nada de texto livre, porque a referência vai para a auditoria imutável de 5 anos.
3. **Conferir o período e o alvo.** Um só filtro: um usuário (`user`) ou um endereço IP exato (`ip`), sem máscara. A janela `from` a `to` tem no máximo 31 dias, com `to` depois de `from`. Instantes em ISO 8601 com fuso (use `Z` para UTC). Para um período maior, faça várias consultas, uma por janela.
4. **Consultar pela rota do Admin.** `POST /api/access-log/read`, com o corpo abaixo (exemplo fictício). O `limit` é de 1 a 50 (padrão 25).

   ```json
   {
     "legalReference": "0001234-09.2026.8.26.0001",
     "ip": "192.0.2.10",
     "from": "2026-10-01T00:00:00Z",
     "to": "2026-10-02T00:00:00Z",
     "limit": 25
   }
   ```

   Para um usuário, troque `ip` por `user` com o identificador interno do usuário.

5. **Paginar.** A página vem do mais antigo para o mais recente. Para a seguinte, repita a consulta com `after` igual ao id da última linha recebida, até não haver mais linhas.
6. **Recusas.** A rota responde 400 com um código e não grava auditoria: `invalid_reference` (número do processo fora do formato), `invalid_filter` (nem um filtro, ou os dois, ou IP mal formado), `invalid_window` (janela maior que 31 dias ou `to` não depois de `from`), `invalid_page` (`limit` fora de 1 a 50) e `invalid_cursor` (`after` que não é um id). Corrija o pedido e repita.
7. **Entregar.** A saída segue o passo (e), abaixo.

**O que a auditoria grava.** Cada leitura bem-sucedida grava `access_log.read` em `platform_audit_events`, na mesma transação da leitura: `detail` com `filter=user|ip; reference=<número do processo>; rows=<número de linhas>`, e `entity_id` com o id do usuário quando o filtro é usuário. **O IP nunca vai para a auditoria.** Sem auditoria, não há leitura, e cada página é uma leitura auditada.

## 2. Pedido de guarda cautelar (art. 15, §2º)

A guarda cautelar pode ser pedida pela autoridade policial, administrativa ou pelo Ministério Público, e impede a exclusão dos registros pedidos por prazo maior que o de 6 meses. **Hoje o sistema não tem a guarda**: a classe `auth_access_log` tem `blockedUntil: access_log_hold`, e não há job de expurgo. Por isso, enquanto a guarda não existir no sistema:

1. **Anote o pedido** em registro privado do responsável, fora do repositório e do banco: quem pediu, quando, o alvo (usuário ou IP), o prazo pedido e o número do processo. Ele é dado sensível.
2. **Suspenda o futuro job de expurgo** (`auth.access_log_expiry`), se ele já tiver sido criado quando o pedido chegar: o job precisa respeitar a guarda antes de apagar qualquer linha do alvo.
3. **Não apague nada à mão.** A tabela não aceita `DELETE` nem `UPDATE` para ninguém, e o expurgo futuro exigirá uma migration revisada.
4. **Lembre que hoje não há expurgo.** Nenhuma linha vence antes de 6 meses do go-live. Os registros do pedido ficam, portanto, enquanto a guarda não estiver implementada.

## 3. Horário

- O `occurred_at` é gravado pelo relógio do banco, sempre em UTC.
- Brasília é UTC menos 3 horas. Converta o horário antes de comparar com a ordem judicial e diga na resposta em qual fuso o horário foi dado.
- O relógio do banco segue o NTP do provedor (Neon).

## 4. Sigilo da saída

- Entregue só pelo canal indicado pela ordem. Nunca copie para chat, e-mail comum ou ticket.
- Apague as cópias locais (arquivo, tela salva, área de transferência) depois de entregar, e registre no pedido a data da entrega.
- Não cole IP, usuário ou número do processo no ticket de atendimento. Use o número do pedido.
- O IP nunca entra na auditoria da plataforma, nem em logs; por isso o registro da leitura não permite reconstruir o que saiu, só que houve uma leitura, o filtro, o processo e o número de linhas.

## 5. Limite conhecido: sem porta de origem (R1)

O registro guarda o IP, mas **não a porta de origem**. Pesquisa de 18/10/2026: nem `request.cf` nem os cabeçalhos da Cloudflare entregam ao Worker uma porta de origem confiável do cliente. Com CGNAT, vários usuários podem dividir o mesmo IP ao mesmo tempo, e só o IP pode não identificar a pessoa. O STJ tem exigido a porta.

Na resposta à autoridade, diga o que o registro tem: o IP de origem, o horário em UTC e o identificador da requisição, e que a porta não é registrada. Não afirme que o IP identifica uma pessoa. A redação final é do jurídico (**a confirmar com o jurídico**).

## 6. Monitoramento

Dois eventos de log tratam da gravação. O alerta sobre eles é configurado no destino dos logs (Cloudflare Observability, [ADR 0089](../adr/0089-evlog-e-logger-tipado-no-backend.md)), e é item de go-live ([checklist de release](./release-checklist.md), item 11).

- **`auth_access_log_write_failed`**: a gravação falhou. O login seguiu, mas **a linha não foi gravada**, e isso é um buraco no registro. Campos: `requestId`, `accessEvent`, `reason`, `errorClass` e `sqlState`; nunca IP, usuário ou e-mail.
  - `reason = error`: falha do banco. Confira `sqlState`. **`42501`** (permissão negada) quer dizer que o `EXECUTE` de `record_auth_access` foi revogado de `polaris_auth_runtime`: é mudança de privilégio, trate como incidente e restaure o grant pela migration, não à mão.
  - `reason = timeout`: o banco não respondeu em cerca de 300 ms. Veja se há lentidão ou bloqueio no banco. Um timeout não garante que a linha não entrou: ela pode aparecer depois, uma vez.
  - `reason` com um código de recusa (`invalid_event`, `invalid_user`, `invalid_ip`, `invalid_request`): o servidor montou uma entrada inválida. É defeito de código; abra uma correção.
- **`auth_access_log_skipped`** com `reason: ip_missing`: a requisição chegou sem `cf-connecting-ip`, então o evento não foi gravado. Se isso aparece em produção de forma constante, a origem da requisição não passa pela borda da Cloudflare; investigue antes de qualquer outra coisa.

- **`auth_access_log_throttled`**: um `session_refreshed` foi descartado pelo teto (mesmo usuário e IP em 10 minutos, ou 12 por usuário por hora, o 13º). É esperado em cliente que alterna IPs; um volume alto deve ser investigado, e não é perda de login.

Uma falha de gravação não é reconstituída depois. Ela fica como lacuna, e deve ser lembrada na resposta à autoridade se o período afetado for pedido.

## Verificação

- A consulta voltou só as linhas da janela e do filtro, na ordem do mais antigo.
- O número de linhas que a leitura gravou na auditoria bate com o que foi entregue.
- Nenhum IP aparece na auditoria, no ticket ou em log.

## Rollback ou forward-fix

Este procedimento só lê. Se uma consulta saiu errada (filtro ou período), não há o que desfazer no banco: registre o erro no pedido, informe o jurídico e apague a cópia local. Se a gravação falha de forma contínua, a correção é um commit com o motivo do `reason` (passo 6), não uma alteração manual na tabela.

## Escalonamento

**Proposta, pendente de decisão:** o responsável pelo projeto, como nos demais runbooks, até o time nomear pessoa ou papel. Pedidos de ordem judicial e de guarda cautelar vão para o jurídico antes de qualquer consulta; alertas de `auth_access_log_write_failed` com `sqlState` `42501` vão para o responsável no mesmo dia.
