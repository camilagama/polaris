---
status: proposto
---

# Retenção por classe de dado

## Contexto

O PR105 do plano pede políticas de retenção por classe, sem um prazo único ("não hardcode 5 anos em tudo"), e jobs de expurgo somente onde a política estiver aprovada. Até aqui os prazos estavam espalhados: 24 horas para o marker de envio de mídia (ADR 0014), uma hora para a imagem removida (ADR 0061), 24 horas para a exportação (ADR 0078), "sem expiração automática" para a auditoria tenant (ADR 0006), "nunca apagada" para o razão de billing (ADR 0062) e "retenção no backlog" para o log de comandos offline (ADR 0033 e 0044). As regras de privacidade já dizem que prazos legais de retenção e de incidentes exigem revisão jurídica e contábil antes do go-live.

O PR102 (ADR 0075) deixou duas pendências para cá: o `sync_commands.payload_hash` é um SHA-256 sem sal sobre o payload de `customer.create` e `customer.update` (nome, telefone, email e observações), o que permite confirmar por tentativa um valor suspeito; e um `customer.update` offline recusado com `customer_anonymized` deixava o texto digitado na fila do aparelho até o dono descartar.

## Decisão

- **Um registro só, tipado.** `@polaris/domain/privacy/retention` declara cada classe de dado com o que ela cobre, a origem (`lei`, `contrato` ou `decisao`), a regra, as fontes e o estado. Uma política `aprovada` tem um prazo (`duration` ou `calendar_months`, este para o mínimo legal contado em meses), é guardada até o purge da organização ou expira pela rotação do provedor (`provider_rotation`); uma `proposta` não tem prazo em vigor (`undecided`) e carrega o prazo proposto em texto. O tipo só permite ligar um job a uma política aprovada com prazo, e `approvedRetention(classe)` recusa (`retention_not_approved`) uma classe proposta ou cujo prazo não é uma duração em milissegundos (até o purge, meses corridos, rotação do provedor); `retentionExpiry(classe, desde)` dá a data de expurgo de uma duração ou de meses corridos. Um código que expira dado lê o prazo daí: as constantes do reconciliador de mídia passam a vir do registro.
- **Classe com base legal não é aprovada pelo código.** Enquanto o responsável não registrar o prazo legal (fiscal, contábil, LGPD, Marco Civil), a classe fica `proposta`. Uma classe legal aprovada carrega a data da decisão (`approvedOn`) e as normas em que se apoia (`legalSources`, pelo nome e artigo, sem copiar o texto); um teste confere os dois campos.
- **Nenhum job novo.** Dos prazos aprovados em 18/10/2026 (seção abaixo), nenhum ganha job neste ADR: as classes `sync_commands`, `auth_sessions`, `auth_verification` e `auth_security_audit` têm prazo no registro e ainda não têm expurgo (pendência no [status de implementação](../../doc/status-implementacao.md)). As três classes com prazo aprovado antes já têm job: o reconciliador horário de markers e a limpeza de imagens removidas (cron do minuto 17) e o job horário da exportação, que expira a exportação e apaga seus objetos (ADR 0078). As constantes desses jobs passam a vir do registro. Todas as outras classes ficam propostas, sem job.
- **HMAC no hash do comando offline.** O Worker passa a gravar em `payload_hash` um HMAC-SHA256 do payload canônico com o segredo `SYNC_PAYLOAD_HASH_SECRET` (no mínimo 32 bytes). Sem o segredo, ou com um curto, `sync.push` responde 503 antes de tocar no banco, como faz sem o segredo do lease. O HMAC tem o mesmo formato (64 caracteres hexadecimais), então não há migration. Para que um reenvio de comando gravado antes continue sendo o mesmo comando (e não `command_id_reused`), a comparação aceita também as formas antigas do mesmo conteúdo: o SHA-256 sem sal das linhas anteriores e o HMAC com `SYNC_PAYLOAD_HASH_PREVIOUS_SECRET`, durante uma rotação. Essas formas são só comparadas, nunca gravadas.
- **Edição de cliente anonimizado sai do aparelho.** Quando o servidor recusa um `customer.update` com `customer_anonymized`, o aparelho descarta o comando (com o nome, o telefone e o email digitados), conta o descarte no resumo da sincronização, segue com a fila e atualiza as coleções locais. Um comando recusado assim por uma versão anterior é descartado na sincronização seguinte.

### Classes e prazos

Os prazos das classes propostas são propostas deste ADR; os legais estão marcados "a confirmar pelo responsável".

| Classe | Dados | Estado | Prazo | Justificativa |
| --- | --- | --- | --- | --- |
| `media_staging_marker` | markers de envio e masters órfãos no R2 | aprovada (job existente) | 24 horas pelo timestamp do R2 | ADR 0014: tempo para um envio em andamento terminar. |
| `media_removed_image` | asset sem vínculo, master e derivados | aprovada (job existente) | 1 hora desde a criação do asset | ADR 0061: a pessoa quis apagar; não há desfazer. |
| `tenant_audit_events` | `tenant_audit_event` | proposta | até o purge da organização, sem expiração automática; prazo legal e legal hold a confirmar pelo responsável | ADR 0006 já impede expiração automática; o prazo legal não foi decidido. |
| `product_media` | imagens de produtos | proposta | enquanto o produto existir; depois, com o produto ou o purge | Produto com tombstone mantém as imagens. |
| `customers` | cadastro de clientes | proposta | até a anonimização ou o purge; sem expiração por inatividade | O revendedor é o controlador. |
| `sales_records` | vendas, itens, ajustes, pagamentos, cancelamentos, devoluções | proposta | enquanto a organização existir; depois, prazo fiscal e contábil a confirmar pelo responsável | Venda é snapshot econômico. |
| `inventory_ledger` | movimentos e saldos de estoque | proposta | como as vendas, a confirmar pelo responsável | Ledger append-only. |
| `expenses_and_goals` | despesas e metas | proposta | despesas como as vendas (a confirmar pelo responsável); metas até o purge | Dado de gestão. |
| `billing_events` | razão e estado de billing, concessões | proposta | prazo fiscal e contábil depois do fim da relação, a confirmar pelo responsável | "Nunca apagada pelo runtime" é uma restrição de quem apaga, não um prazo. |
| `sync_commands` | log de comandos offline | aprovada (sem job) | 90 dias depois de `received_at`; o servidor recusa comando novo criado há mais de 90 dias | Decisão de 18/10/2026. O registro é a idempotência do `sync.push`; o comando só precisa ter sido criado dentro do lease e o intervalo entre criar e enviar não tem limite, então o prazo é uma escolha operacional. A recusa (`command_too_old`, não gravada) vale desde já; o reenvio de um comando que ainda tem registro continua devolvendo o resultado gravado. O job de expurgo ainda não existe e só pode apagar depois de `received_at` + 90 dias + a margem de relógio do lease (5 minutos), porque o `createdAt` do aparelho pode estar à frente do recebimento. |
| `sync_change_log` | `sync_changes`, `sync_cursors` | proposta | podar com piso de cursor, junto com `sync_commands` | ADR 0030: cursor antigo demais refaz o bootstrap. |
| `data_exports` | exportação, registros de arquivo e objetos no R2 | aprovada (job existente) | 24 horas depois de pronta; a que falhou, 24 horas | ADR 0078: artefato privado e temporário. Decisão de 18/10/2026: o prazo deixa de ser provisório. |
| `closed_organization` | dados de uma organização `closed` | proposta | purge depois da janela de 30 dias, respeitando as classes com prazo legal (a confirmar pelo responsável) | ADR 0074: a janela de recuperação é aprovada; o atraso até o purge não. |
| `auth_sessions` | sessões (IP e user-agent) | aprovada (sem job) | 30 dias depois do fim da sessão (`expires_at`) | Decisão de 18/10/2026. A linha é hoje o único lugar do banco com o IP, e o registro de acesso mínimo de 6 meses ainda não o guarda: o job de expurgo de sessões não deve existir antes de essa lacuna fechar (pendência). |
| `auth_verification` | tokens de verificação e recuperação | aprovada (sem job) | 1 dia depois de expirar | Decisão de 18/10/2026. Sem uso depois da expiração. |
| `auth_security_audit` | `auth_security_audit_event` | aprovada (sem job) | 6 meses, contados de `created_at` | Decisão de 18/10/2026, delegada ao orquestrador com base em pesquisa: Marco Civil da Internet (Lei 12.965/2014), art. 15, para o registro de acesso a aplicação (a norma pede também sigilo e ambiente controlado e seguro). A tabela guarda data, hora, ator e identificador da requisição, não o IP (pendência); validar com contador ou jurídico antes do go-live. |
| `platform_audit_and_support` | auditoria do Admin, casos e acessos de suporte | proposta | sobrevive à organização, sem dado pessoal; prazo a confirmar pelo responsável | Registro de acesso privilegiado. |
| `privacy_cases` | casos de privacidade e ações | proposta | sobrevive à organização como evidência; prazo a confirmar pelo responsável | ADR 0077. |
| `deletion_ledger` | tombstones de anonimização e de purge | proposta | sobrevive à organização, sem expiração automática e sem job; não expira antes da janela de restauração mais longa do provedor; prazo a confirmar pelo responsável | ADR 0080: enquanto um backup anterior ao tombstone puder ser restaurado, o tombstone precisa existir; nenhum papel o apaga hoje. |
| `event_outbox` | eventos a despachar (só IDs opacos) | proposta | despachados apagados depois de um prazo curto; pendentes saem com o purge; prazo a confirmar pelo responsável | ADR 0082 e ADR 0084: nenhum papel apaga hoje; o expurgo dos despachados espera o prazo aprovado pelo responsável (o [ADR 0086](0086-framework-de-jobs-agendados.md) não cria esse job). |
| `queue_processing` | registro do consumidor de filas (só IDs opacos) | aprovada | uma semana depois de concluído (ou do fim do prazo de uma tomada abandonada); job `outbox.processing_expiry`, na execução do despachante | ADR 0084: mais que as 24 horas de retenção da fila e as novas tentativas. |
| `operational_incident` | incidentes operacionais e eventos mortos do outbox (só IDs opacos, contagens e datas) | proposta | apagar o incidente e os itens já reenviados depois de um prazo de operação; os itens saem no purge da organização, que os apaga explicitamente (a linha da organização fica, então a cascata não age); prazo a confirmar pelo responsável | ADR 0085: nenhum papel apaga hoje; o expurgo é do job agendado (PR112). |
| `provider_backups` | backups e branches do provedor | aprovada | expiram pela rotação do provedor; o dado apagado some deles ao fim dela; restore reaplica o deletion ledger | Decisão de 18/10/2026. Neon Free ([ADR 0076](0076-teto-de-custo-e-free-tier-primeiro.md)): 6 horas de histórico de restauração, até 1 GB de mudanças, pela documentação do Neon consultada em 18/10/2026 (Launch e Scale: 7 e 30 dias, não contratados). R2: a documentação consultada não descreve versões ou cópias de objetos apagados, e o Polaris não configura backup de bucket. O prazo configurado na conta ainda precisa ser conferido antes do go-live. |

### Prazos aprovados em 18/10/2026

O responsável aprovou os prazos operacionais e delegou ao orquestrador, com base em pesquisa, os legais; **os legais precisam ser validados com contador ou jurídico antes do go-live**. As normas são citadas pelo nome e artigo.

| Classe | Prazo aprovado | Fonte da regra |
| --- | --- | --- |
| `sync_commands` | 90 dias; o servidor recusa comando mais antigo (`command_too_old`) | Decisão operacional. |
| `auth_verification` | 1 dia depois de expirar | Decisão operacional. |
| `auth_sessions` | 30 dias depois do fim (job só depois de o registro de acesso com IP ter lugar próprio) | Decisão operacional. |
| `data_exports` | link de 24 horas (deixa de ser provisório) | Decisão operacional; ADR 0078. |
| `closed_organization` | purge 30 dias depois do encerramento (janela para exportar ou desistir) | Decisão do responsável; ADR 0074. |
| Dados operacionais do tenant: `sales_records`, `inventory_ledger`, `expenses_and_goals`, `tenant_audit_events`, `product_media` | enquanto a organização existir e 30 dias depois do encerramento; depois, purge | O Polaris é operador (LGPD, art. 39); a guarda fiscal é obrigação do cliente, que tem a exportação. |
| `billing_events` (registros fiscais do próprio Polaris: valores, datas, tipos e referências do provedor) | 5 anos contados de 1º de janeiro do ano seguinte ao fato; contato do pagador anonimizado no purge | Código Tributário Nacional, arts. 173 e 195; Código Civil, art. 1.194; anonimização por decisão do POL-81. |
| `auth_security_audit` (registro de acesso a aplicação: data, hora e IP da sessão ou do login; auditoria de segurança) | 6 meses, sob sigilo, em ambiente controlado e seguro | Marco Civil da Internet (Lei 12.965/2014), art. 15. |
| `platform_audit_and_support` | 5 anos | Código de Defesa do Consumidor, art. 27 (prazo prescricional, para defesa); a aplicação do CDC a lojistas é uma hipótese a validar com o jurídico. |
| `privacy_cases` | 5 anos, só o registro mínimo (tipo, datas, decisão, IDs opacos), sem texto livre | Decisão do responsável; prazo prescricional do CDC, art. 27. |
| `provider_backups` | expiram pela rotação do provedor; o dado apagado some ao fim dela | Decisão do responsável; prazos reais na linha da tabela acima. |
| Legal hold | suspende qualquer expurgo da organização enquanto vigente | Decisão do responsável. |

Onde cada classe está hoje:

- **No registro, aprovadas por este ADR:** `sync_commands`, `auth_sessions`, `auth_verification`, `auth_security_audit` e `provider_backups` (além de `data_exports`, que só perdeu o "provisório").
- **No PR do purge completo (ADR 0081, PR 126):** o 30 dias do encerramento, o legal hold, os dados operacionais do tenant e a anonimização do pagador de `billing_events`. Este ADR não altera esses trechos para não duplicar nem conflitar com ele.
- **Ainda propostas no registro, com o prazo já decidido acima:** `billing_events` (5 anos), `platform_audit_and_support` (5 anos) e `privacy_cases` (5 anos). O registro só aceita hoje prazo em duração ou em meses corridos, e as linhas dessas classes são as mesmas que o PR do purge muda; passam a `aprovada` depois do merge dele, com um prazo "ano seguinte mais 5 anos" que o registro ainda não sabe expressar.
- **Lacuna do registro de acesso:** `auth_security_audit_event` guarda data, hora, ator e identificador da requisição, mas não o IP, e a linha da sessão (com o IP) sai 30 dias depois do fim. O registro de acesso mínimo de 6 meses com IP precisa de um lugar próprio, e o job de sessões não deve existir antes disso; é uma decisão de modelo de dados que fica fora deste ADR.

## Consequências

- Um prazo novo ou um job novo começa por mudar a política no registro (de `proposta` para `aprovada`, com a fonte) e por um ADR ou regra que a aprove. É uma convenção: o job deve ler o prazo por `approvedRetention` (ou `retentionExpiry`, para meses corridos), que recusa classe não aprovada, e se declarar em `RETENTION_PURGE_JOBS`, cuja coerência com o registro um teste confere; o teste não enxerga um job que ignore o registro.
- O segredo `SYNC_PAYLOAD_HASH_SECRET` precisa existir em cada ambiente **antes** do deploy desta versão: sem ele a sincronização offline responde 503 (o trabalho fica na fila do aparelho, nada se perde). Este PR não o cria em nenhum ambiente.
- As linhas gravadas antes do HMAC continuam com o SHA-256 sem sal: a tabela é imutável e o payload não é guardado, então não há como recalcular. A retenção de `sync_commands` está aprovada (90 dias), mas a exposição dessas linhas só acaba quando o job de expurgo existir.
- Durante uma rotação, o segredo anterior fica em `SYNC_PAYLOAD_HASH_PREVIOUS_SECRET` enquanto um comando antigo puder ser reenviado. Um rollback para uma versão sem o HMAC faz um reenvio de comando gravado com HMAC ser recusado como `command_id_reused` (o aparelho mostra a recusa e o dono descarta); evitar rollback com comandos em voo. Há um só segredo anterior: uma segunda rotação antes de os comandos antigos serem reenviados faz esses reenvios virarem `command_id_reused`.
- Descartar a edição de um cliente anonimizado é o único descarte que a sincronização faz sozinha. O resumo da sincronização conta o descarte, mas a interface ainda não o mostra: a pessoa vê o cliente como o servidor o deixou, sem aviso de que a edição foi descartada (limite aceito).

## Alternativas consideradas

- **Prazo único para tudo:** o plano o proíbe, e cada classe tem base diferente (lei, contrato, operação).
- **Coluna com o esquema do hash (migration aditiva):** exigiria um deploy ordenado (o Worker antigo não preencheria a coluna) e não corrige as linhas antigas; comparar com as formas antigas resolve o reenvio sem mudar o banco.
- **Apagar o log de comandos junto com a aprovação do prazo:** o prazo está aprovado e a recusa de comando com mais de 90 dias já existe, mas o expurgo é outro trabalho (um job novo), registrado como pendência.
- **Marcar a edição recusada como indisponível (como antes):** deixava o dado pessoal no aparelho sem que houvesse algo a fazer com ele.
