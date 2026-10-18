---
status: accepted
---

# Concessões temporárias de entitlement

## Contexto

O plano (PR85) pede grants internos de entitlement: compensação ou parceria que dá a uma organização mais do que o plano dela, **sempre** com motivo, autor, início e fim, e **nunca** como assinatura falsa. A regra de negócio já dizia que uma concessão só eleva, tem prazo e motivo, e que uma organização não concede acesso a si mesma; a tabela `entitlement_grants` e a leitura (ADR 0057) existiam, mas nada as escrevia, e o PR82 deixou uma lacuna: uma organização Free acima do limite por causa de uma concessão que expirou não entrava na janela de adequação ([ADR 0064](0064-free-acima-do-limite-variantes-operacionais.md)).

## Decisão

- **Quem escreve.** Só o papel de billing (o mesmo que escreve o registro de assinatura), por comandos nomeados em `billing-store`: `grantEntitlement` e `revokeEntitlementGrant`. O tenant só lê (uma organização não concede nada a si mesma). O papel de billing pode inserir uma concessão e **encurtar** a sua vigência (`expires_at`, `revoked_at`, `revoked_by`); não edita motivo, valor, autor nem início e não apaga nada. "Só encurta" vale no banco para qualquer papel, por gatilho: o fim nunca avança e uma concessão encerrada não volta (`23514`). A tela de Admin que chamará esses comandos é da Fase 9; até lá eles são a interface.
- **O que toda concessão diz.** Organização, o entitlement (uma chave do catálogo), o valor, o **autor** (um identificador estável, nunca texto livre: `admin:…`, `system:…`), o **motivo** (1 a 300 caracteres), o **início** (agora, se não informado) e o **fim**. Tudo isso é validado no domínio (`normalizeGrant`, puro): o fim é no futuro e depois do início, a duração fica entre um minuto e 366 dias (**sempre expira**: mudança permanente é mudança de plano), o início não passa de um ano à frente, um limite é um inteiro entre 1 e 100.000, uma capacidade só pode ser **ligada** (uma concessão nunca reduz nada), o motivo não tem caractere nulo e o autor é um identificador (letras, números, `:`, `_`, `.`, `-`; **nunca um e-mail**, porque vai para o razão). O banco confere de novo o que cabe a ele: autor não vazio, início antes do fim, duração máxima e coerência do encerramento.
- **Nunca assinatura.** Uma concessão não muda o estado de billing, não cria registro de provedor nem período pago: o plano segue Free (ou o que for) e `raisedByGrant` diz o que foi elevado. Vale entre o início e o fim: uma concessão que ainda não começou não muda nada (o início passou a ser lido na resolução dos entitlements).
- **Idempotente e auditável.** O chamador pode informar o ID (UUID): dar a mesma concessão duas vezes é uma só, e **o mesmo ID com qualquer diferença** (organização, chave, valor, fim, motivo, autor) é recusado em vez de descartado em silêncio. Cada concessão e cada encerramento antecipado entra no razão de billing (`billing_events`, tipo `command`) com o autor, a chave, o ID e o período, **sem o motivo** (que fica na concessão): o razão não guarda dado que não seja do ciclo de vida. Encerrar duas vezes é um encerramento. Uma concessão encerrada antes de começar nunca esteve em vigor (a leitura a ignora); seu fim é só o menor valor que a tabela aceita, e nunca depois do fim que já tinha.
- **O fim de uma concessão de limite tem efeito.** A varredura horária de billing (`sweepDue`) também olha as concessões de limite que terminaram nos últimos 90 dias, **limite por limite**: uma organização no Free (nunca no Pro nem num trial em preparação) que mantém mais do que o Free permite num limite cuja última concessão terminou (e não tem outra concessão em vigor *para esse limite*) entra em `free_over_limit` com o início da janela **no fim dessa concessão**; uma concessão de outro limite que segue valendo não esconde isso. Se já estava em `free_over_limit`, ganha janela nova quando a concessão terminou depois do início da anterior. Um registro `free_over_limit` sem início gravado também é candidato: o fim da concessão passa a datar a janela (a consulta de candidatos não o descarta por causa do valor nulo, e a regra do [ADR 0064](0064-free-acima-do-limite-variantes-operacionais.md) para o registro sem início, que a varredura data pelo fim da concessão, é exatamente esta; a datação é feita pelo papel de billing). Os candidatos vêm do mais recente para o mais antigo (uma execução que não alcança todos nunca deixa sem exame o fim mais novo atrás de outros que não precisavam de nada), já sem os que pagam, os que montam um trial e os que já passaram daquele fim. Uma vez só (o razão tem uma linha por fim de concessão). Isso fecha a lacuna do ADR 0064: o catálogo, as imagens e as metas excedentes seguem as regras já definidas (variantes operacionais escolhidas, metas pausadas, imagens preservadas). Concessões de capacidade (offline, catálogo público) não precisam de varredura: o entitlement é derivado a cada leitura.

## Consequências

- Uma parceria de 60 dias com mais variantes termina sem cortes bruscos: o lojista tem sete dias para escolher o que fica operacional, como quem saiu do Pro.
- O custo da varredura é uma consulta indexada por fim de concessão e uma verificação por organização candidata, só quando há concessões de limite recém-terminadas.

## Limites aceitos

- Enquanto a varredura horária não passa, um registro Free comum acima do limite (a concessão acabou há minutos) **não é restringido** (o registro não diz que saiu de nada): a janela é datada do fim da concessão e não se perde, e o estado só muda na varredura.
- Uma janela nova (o fim de uma concessão depois do início da janela anterior) começa uma escolha nova: as linhas da escolha do episódio anterior, inclusive a que o lojista fez, não são carregadas (o papel de billing não escreve a tabela da escolha). A tela de escolha (PR80) deve mostrar o que estava escolhido antes.
- Uma organização no **Pro** com uma concessão acima do limite do Pro não entra em janela alguma quando ela acaba (o plano decide).
- Uma concessão que não eleva nada (valor igual ou abaixo do plano) é aceita, sem efeito; o razão a registra.
- A migration 0057 supõe a tabela sem linhas (nada escrevia concessões antes); linhas que existissem ficariam com o autor `migration` e começariam quando foram criadas, mas a política de linha (força) impediria o dono de reescrevê-las.
- A checagem "acima do limite Free" ignora outras concessões ainda não iniciadas e conta contra o catálogo Free (já registrado no ADR 0062); a varredura só age quando nenhuma concessão de limite está em vigor.
- Concessões de organização que já foi apagada e a leitura por Admin ainda não existem (Fase 9).
- A varredura olha 90 dias para trás: se ela ficar parada mais do que isso, o fim de uma concessão antiga não abre janela.

## Alternativas rejeitadas

- **Conceder dando uma assinatura ao tenant:** é exatamente a falsificação que o plano proíbe e deixaria a cobrança e o provedor com um estado que não aconteceu.
- **Permitir que o Admin edite uma concessão:** o histórico do que foi dado e por quem deixaria de valer; encurtar é suficiente para corrigir, e dar outra é sempre possível.
- **Concessão sem fim para casos especiais:** é um plano; a regra de negócio é "sempre expira".
- **Cortar o excedente no instante em que a concessão acaba:** é a mesma rotação e o mesmo susto que a janela de adequação existe para evitar.
