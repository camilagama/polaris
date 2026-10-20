# Invariantes do domínio e testes de propriedade

Este documento diz **o que o domínio promete** em cinco áreas (privacy, admin, events, offline, entitlements) e **qual teste prova cada promessa**. Serve à revisão para medir valor, não cobertura: uma invariante sem teste aparece em "Lacunas conhecidas", e um teste sem invariante aqui não deveria existir.

Autoridade: as regras de negócio vivem em [docs/business-rules/](../business-rules/) e as decisões em [docs/adr/](../adr/). Aqui só se liga cada invariante ao teste. Se a regra mudar, mude a fonte canônica, o teste e esta lista no mesmo pull request.

## Como os testes de propriedade funcionam

- Biblioteca: `fast-check`, em `packages/domain`. Os testes novos ficam ao lado do módulo, em `*.property.test.ts`.
- **Padrão único de execução:** todo teste de propriedade chama `assertProperty` de [`packages/domain/src/testing/property.ts`](../../packages/domain/src/testing/property.ts). Ninguém passa `numRuns` nem `seed` por conta própria, e o Biome recusa, em `packages/domain` fora desse arquivo, a importação nomeada de `assert` do `fast-check` e as chamadas `fc.assert`/`fc.check` (regra `noRestrictedImports` e o plugin `scripts/biome-plugins/no-fast-check-direct-run.grit`). É guarda-corpo, não prova: dá para contornar com um alias do objeto (`const run = fc.assert`), e a revisão continua olhando.
  - `POLARIS_PROPERTY_RUNS`: quantos casos por propriedade. Padrão **300**. Uma propriedade que precisa de mais declara um piso (`assertProperty(p, { minRuns: 500 })`, como a do custo médio ponderado do estoque): a rodada nunca fica abaixo dele, mesmo se alguém baixar a variável.
  - `POLARIS_PROPERTY_SEED`: um inteiro, para repetir uma rodada; `random` sorteia uma semente nova. Sem a variável, a semente é a do **commit sob teste**: no CI vem de `GITHUB_SHA` (os 8 primeiros dígitos, abaixo de 2^31). Em `pull_request` esse SHA é o do commit de merge que o GitHub monta com a base, então cada push (e cada avanço da main) explora outros casos, e reexecutar a mesma execução repete os mesmos; fora do CI é uma semente fixa (`20261020`), então o teste local não falha por sorte.
  - Uma variável ilegível (`POLARIS_PROPERTY_RUNS=abc`, `GITHUB_SHA` que não é SHA) derruba o teste, em vez de voltar ao padrão sem aviso.
- **A semente é impressa sempre**, não só na falha: cada arquivo de teste imprime uma linha `Property tests: seed <n> (commit|fixed|environment), <n> runs per property (...). Replay: POLARIS_PROPERTY_SEED=<n> POLARIS_PROPERTY_RUNS=<n> bun run test <caminho do arquivo>`, e uma falha repete a linha de replay no fim da mensagem do fast-check (contraexemplo reduzido, `seed` e `path`). O caminho é o do arquivo que rodou, pronto para copiar.
- **Quanta exploração isto é, e quanta não é.** Cada execução do PR explora 300 casos por propriedade, com sementes diferentes entre commits: um defeito que só aparece em uma fração pequena dos casos pode passar num commit e cair em outro. **Não existe rodada agendada** com muitos casos e semente aleatória: quem quer profundidade roda à mão (`POLARIS_PROPERTY_RUNS=5000 POLARIS_PROPERTY_SEED=random bun run test packages/domain`). Por isso as bordas dos limites quase não dependem de sorteio: veja o próximo item.
- **Bordas explícitas.** Todo gerador de um limite (tamanho, contagem, janela de tempo, teto) mistura valores de borda escritos à mão (`constantFrom` com mínimo-1, mínimo, máximo e máximo+1) ao sorteio largo, e o oráculo usa o número literal da regra, não a constante do código. Onde o espaço de bordas é pequeno (até algumas centenas de combinações: `inventory-cost`, `sale-return`, tamanhos do outbox) o teste percorre **todas** as combinações, sem sorteio, e mudar o limite ou trocar `>` por `>=` derruba o teste em toda rodada. Nos geradores largos (privacy, admin, offline, entitlements) as bordas entram por `constantFrom` entre os casos sorteados: a chance de uma borda específica faltar em 300 casos é pequena, mas não é zero. Um sorteio largo (`integer({ min: -2, max: 1010 })`) cai numa borda específica com chance de ~0,02% por caso e deixava escapar `1000 → 1001`.
- **Oráculo independente.** Cada propriedade compara a função com um modelo escrito no próprio teste, nunca com ela mesma: um leitor de CSV conforme a RFC 4180, um leitor de ZIP com CRC-32 bit a bit, aritmética de calendário civil (algoritmo de Hinnant) para prazos em meses, laços de caracteres para as regras de identificador, uma tabela para o plano em vigor. Um oráculo que chama o código testado não prova nada.
- **Geradores que chegam ao fundo.** Quando a entrada válida é rara (envelope, evento, entrada do ledger), o gerador parte de uma entrada válida e estraga no máximo um campo, e o teste confere que viu casos aceitos (`minimumSeen()`: 5 no padrão, nunca menos de 1). Sem isso a propriedade passaria só rejeitando.
- **Valor que não é texto é recusado, não convertido.** Os campos de texto de `outboxEvent` e `deletionLedgerEntry` (organização, chave de idempotência, correlação, entidade, caso) só passam se forem `string`; EVT-2 e PRV-11 geram também número, booleano, `null`, objeto e `bigint` e exigem a recusa.
- Mudar o comportamento de uma regra sem mudar o teste deve derrubar o teste. A prova por quebra das invariantes novas e das bordas está na descrição do PR.

## Invariantes por área

Legenda: **P** = teste de propriedade com oráculo; **E** = teste por exemplos já existente.

### Privacy

| ID | Invariante | Teste |
| --- | --- | --- |
| PRV-1 | O CSV lido de volta por um leitor RFC 4180 traz cada célula como escrita (com BOM, CRLF e aspas dobradas), uma linha por registro. | P `privacy/privacy.property.test.ts` |
| PRV-2 | Nenhuma célula de texto volta como fórmula de planilha (`=`, `+`, `-`, `@`, tab, CR), exceto número simples; o texto original nunca se perde, ganha no máximo um apóstrofo. | P idem |
| PRV-3 | Número, booleano, data e valor ausente saem como são, sem guarda. | P idem |
| PRV-4 | Um leitor de ZIP encontra todas as entradas, na ordem, com os bytes e o CRC-32 certos. | P idem |
| PRV-5 | `size` é o tamanho exato do arquivo depois de cada `add`; a mesma entrada dá os mesmos bytes. | P idem |
| PRV-6 | Nome que sai da pasta (`..`, `/`, `\`, segmento vazio) ou repetido é recusado e não muda o construtor. | P idem |
| PRV-7 | Cada classe de retenção aprovada vence exatamente quando o calendário diz (duração em ms; meses corridos com o dia inexistente passando ao mês seguinte, mais a folga); classe sem prazo aprovado recusa. A tabela de prazos é lida do próprio código, então mudar um prazo (folga de 30 para 0 dias, 6 para 5 meses) é pego pelos exemplos de `retention.test.ts` (PRV-13), não por esta propriedade. | P idem |
| PRV-8 | Um prazo em meses nunca é menor que 28 dias por mês nem maior que 31 dias por mês, mais a folga (também lida da tabela do código: ver a nota do PRV-7). | P idem |
| PRV-9 | Começar mais tarde adia o vencimento pelo mesmo intervalo (duração) ou por esse intervalo menos até 3 dias (meses corridos, por causa do mês curto; ver "Achados"). | P idem |
| PRV-10 | `blockedPurgeJobs` aponta exatamente as classes com bloqueio ativo e job; resolver mais bloqueios nunca aumenta a lista. | P idem |
| PRV-11 | Uma entrada do ledger de exclusão é aceita exatamente quando o modelo diz (par conhecido, IDs opacos em texto, UUID minúsculo do cliente, organização com `entityId = organizationId`); valor que não é texto é sempre recusado. | P idem |
| PRV-12 | Uma entrada válida com qualquer campo a mais (nome, e-mail, valor) é recusada. | P idem |
| PRV-13 | O registro de retenção declara cada classe uma vez, com fonte e base; nenhum job existe para classe só proposta ou com bloqueio ativo. | E `privacy/retention.test.ts` |
| PRV-14 | O pacote de exportação, o expurgo da organização e a auditoria do tenant seguem as listas e prazos das regras. | E `privacy/data-export.test.ts`, `privacy/organization-purge.test.ts`, `privacy/tenant-audit-events.test.ts` |

### Admin

| ID | Invariante | Teste |
| --- | --- | --- |
| ADM-1 | Só o papel que existe tem capacidades; qualquer outra string (inclusive `__proto__`, `constructor`) não tem nenhuma e é recusada (falha fechada). | P `admin/admin.property.test.ts` |
| ADM-2 | O dono da plataforma tem exatamente as capacidades listadas; um quase-acerto (`PLATFORM:READ`, espaço no fim) é recusado. | P idem |
| ADM-3 | A duração do acesso de suporte é aceita só se inteira, de 5 a 240 minutos; sem valor vale 60. | P idem |
| ADM-4 | Um caso abre exatamente quando o tipo é conhecido e motivo e contexto, aparados, respeitam o tamanho em pontos de código e a regra de caracteres de controle. | P idem |
| ADM-5 | A data de revisão da retenção legal é aceita só se futura e a no máximo 366 dias, em qualquer deslocamento, e volta em UTC. | P idem |
| ADM-6 | Data que não existe (30 de fevereiro, hora 24, minuto 60, mês 13) é recusada, nunca "rolada" para uma real. | P idem |
| ADM-7 | O acesso de suporte, o caso de privacidade, o registro de acesso e o incidente operacional seguem os estados e limites das regras. | E `admin/support-access.test.ts`, `admin/privacy-case.test.ts`, `admin/access-log.test.ts`, `admin/operational-incident.test.ts` |

### Events

| ID | Invariante | Teste |
| --- | --- | --- |
| EVT-1 | O atraso de reenvio segue o modelo (30 s dobrando a cada tentativa), nunca cai com mais tentativas e fica entre 30 s e 1 h. | P `events/events.property.test.ts` |
| EVT-0 | Todo tipo declarado em `OUTBOX_EVENT_TYPES` tem entrada na tabela do teste (chaves do corpo e fila), e toda entrada é um tipo declarado; a falha diz qual tipo falta. Um tipo novo derruba só este teste, com a mensagem, até ganhar entrada. | P idem |
| EVT-2 | Um evento do outbox é aceito exatamente quando o modelo diz (tipo da tabela, só as chaves do tipo, só ID opaco, inteiro ou booleano) e volta inteiro; organização, chave e correlação que não são texto são recusadas, e os tamanhos (organização até 64, chave e correlação até 128) valem em cada borda. | P idem |
| EVT-3 | A chave de idempotência de um tipo e um ID opaco é ela mesma uma chave válida, igual para a mesma coisa e diferente para outra. | P idem |
| EVT-4 | Um envelope atravessa a fila (JSON de ida e volta) sem mudar, reler não muda nada, e a fila do tipo é a da tabela do teste. | P idem |
| EVT-5 | Uma mensagem é aceita exatamente quando versão, tentativa (1 a 1000, testada em 0, 1, 999, 1000 e 1001), IDs e campos são os do modelo; campo a mais é recusado. | P idem |
| EVT-6 | Qualquer corpo que chegue à fila de mensagens mortas é classificado sem lançar erro, com referência que é token simples ou nada, e o evento é nomeado inteiro ou não é. | P idem |
| EVT-7 | O aviso guarda a causa e nomeia o evento só inteiro (ID, organização e tipo juntos, ou nenhum); um envelope válido na fila morta significa sempre "tentativas esgotadas". | P idem |
| EVT-8 | Formato e limites do outbox, do envelope e da fila morta por exemplos (campos, tamanhos, causas). | E `events/outbox.test.ts`, `events/queue-envelope.test.ts`, `events/dead-letter.test.ts`, `events/outbox-dispatch.test.ts` |

### Offline

| ID | Invariante | Teste |
| --- | --- | --- |
| OFF-1 | Um lease montado sobre a janela planejada é sempre válido, em segundos inteiros, e dura no máximo 72 horas. | P `offline/offline.property.test.ts` |
| OFF-2 | Os bytes assinados não dependem da ordem nem das repetições das capacidades, e lê-los devolve as mesmas claims. | P idem |
| OFF-3 | As claims valem exatamente enquanto agora é anterior ao segundo de expiração e a emissão está a no máximo 5 minutos à frente do relógio (as bordas, de 1 ms para cada lado, e o limite de 5 minutos como número literal); uma claim vencida e adiantada ao mesmo tempo é informada como vencida. | P idem |
| OFF-4 | Revogação vale mais que o tempo; sem revogação, o aparelho está ativo exatamente até o instante de expiração. | P idem |
| OFF-5 | O rótulo do aparelho é guardado aparado se for uma linha limpa de até 80 caracteres; vazio vale nenhum; o resto é recusado. | P idem |
| OFF-6 | A janela do grant é aceita só se `0 < duração <= 72 h`. | P `offline/offline-grant.test.ts` |
| OFF-7 | O lease vence em `min(agora + 72 h, fim do direito)`. | P `offline/offline-lease.test.ts` |

### Entitlements (planos e cobrança)

| ID | Invariante | Teste |
| --- | --- | --- |
| ENT-1 | Pro só enquanto um estado Pro tem data de fim à frente; qualquer outro estado e prazo vencido valem Free. | P `billing/entitlements.property.test.ts` |
| ENT-2 | Cada chave é o maior entre o valor do plano e o dos grants ativos (flag: ligada se um dos dois liga); um grant nunca baixa nada. | P idem |
| ENT-3 | A ordem dos grants não muda o resultado. | P idem |
| ENT-4 | Resolver não altera o catálogo nem os grants, entrega cópia da data de fim e, sem grants, dá exatamente o plano. | P idem |
| ENT-5 | Uma adição é recusada exatamente quando passaria do limite (flag: quando não está ligada); tirar ou adicionar nada nunca é recusado, mesmo acima do limite. | P idem |
| ENT-6 | Qualquer catálogo sobrevive a ser guardado em linhas, em qualquer ordem; faltar um valor é recusado, nunca lido como "sem limite". | P idem |
| ENT-7 | O registro de cobrança fica coerente, o acesso nunca termina antes do devido, um pagamento nunca o encurta, e o mesmo fato aplicado duas vezes vale uma. | P `billing/subscription-state.test.ts`, `billing/facts.test.ts` |
| ENT-8 | O catálogo inicial tem as hipóteses do PRODUCT.md, e o Pro nunca fica abaixo do Free. | E `billing/entitlements.test.ts` |

## Lacunas conhecidas

- `canonical-json` do app web (hash estável), a ordem e a idempotência do outbox do navegador e a idempotência do `sync.push` (reenviar qualquer prefixo da fila não muda o resultado) ficam em `apps/web`, fora do pacote `domain`. Entram quando o helper for compartilhado com o app (hoje ele mora em `packages/domain/src/testing/`).
- Propriedade modelo × banco do ledger de estoque e devolução (T-124b): precisa do PostgreSQL e de gerar comandos válidos sem inflar o gate.
- **Não há rodada agendada** com `POLARIS_PROPERTY_RUNS` alto e `POLARIS_PROPERTY_SEED=random`: seria um workflow, decisão do responsável. Até lá a exploração em profundidade é manual e o PR explora 300 casos por propriedade com semente por commit (ver "Quanta exploração isto é").
- `catalog/` não tem teste de propriedade. Os módulos money, sales, inventory, economics, expenses, goals, billing (estado e fatos) já tinham propriedades e agora usam o helper, mas não foram reauditados contra esta lista. Duas bordas deles foram fechadas na revisão do PR: o teto de quantidade de `inventory-cost` e de `sale-return`, e o teto de parcelas e de valor de `sale-payment`.

## Achados

Coisas que as propriedades mostraram e que **não foram corrigidas** (esta tarefa só testa):

1. **`retentionExpiry` em meses corridos não é monotônico.** Quem começa a contar em 31 de janeiro vence em 3 de março; quem começa em 1º de fevereiro vence em 1º de março. É a regra documentada ("o dia que não existe no mês de destino passa ao mês seguinte, nunca encurta o prazo"), então PRV-9 declara a tolerância de 3 dias em vez de exigir monotonia. Fica o registro para o jurídico: dois registros vizinhos podem vencer fora de ordem. O prazo legal (6 meses mais 30 dias) não encurta em nenhuma data testada; o que muda é a ordem entre registros vizinhos.

Achados **corrigidos** na revisão do PR: `outboxEvent` e `deletionLedgerEntry` convertiam com `String()` antes de testar o padrão, então `organizationId: 123` ou `idempotencyKey: 12345` passavam e voltavam como número (o consumidor, `parseQueueEnvelope`, recusava depois, com a linha já no outbox). Agora a regra é recusar o que não é texto, e EVT-2 e PRV-11 exigem a recusa.
