---
status: accepted
---

# Avisos de ativação e medida de comportamento

> Número provisório até o merge (o 0105 é o último na `main` e nenhum PR aberto reserva o 0106; pode mudar se outro ADR entrar antes). As migrations citadas (0122 a 0126) e os nomes de papel, de função e de flag marcados "provisório" também podem mudar; a decisão não depende do número nem do nome. Emenda o [ADR 0071](0071-admin-diagnostico-sem-acesso-ao-tenant.md) (a faixa de 14 dias, o M3 e o M4 no funil) e anota o [ADR 0104](0104-autosservico-de-cobranca-do-dono.md) (o e-mail de boas-vindas, E1, é aposentado). Cita o [ADR 0079](0079-retencao-por-classe-de-dado.md) (retenção) e o [ADR 0096](0096-migrations-compativeis-com-a-versao-anterior-do-worker.md) (expand/contract).

## Contexto

Uma loja criada que não chega à primeira venda é um lojista que testou e sumiu. O app já guia dentro (Primeiros passos); fora do app ninguém o chama de volta. Hoje não há medida do que acontece com quem não chega: o funil do Admin (ADR 0071) diz quantas lojas chegam à primeira venda, não se vale mandar e-mail, mexer na tela ou não fazer nada. O usuário decidiu em 07/11/2026 estudar duas coisas, e o estudo (`estudo-ativacao-2026-11-07.md`, com as respostas R-1 do Rodrigo, R-2 do Filipe e R-3 do Petković) as fechou:

1. **Uma série curta de e-mails de ajuda** ("dicas para começar", A1 a A3) à dona da primeira loja, até 14 dias, que para sozinha.
2. **Medida de comportamento** para decidir se a série vale: funil (M2, ativação em até 14 dias; M4, primeira venda dentro do teste Pro), resultado dos envios (M1) e "voltou ao app" (M3).

Decisões do usuário que este ADR cumpre sem reabrir: **U1** legítimo interesse (o jurídico confirma perto do lançamento); **U5** a medida é funil, M1, M2, M3 e M4, sem contador de passo extra; **U6** a série **liga só depois de 4 a 6 coortes de lojas reais** e antes disso fica construída e desligada; **U8** a série não vai a loja com teste Pro ou Pro; **U9** o E1 é aposentado. Os rótulos U1 a U10 e Q-1 a Q-7 são os do corte e do estudo de ativação de 07/11/2026 (documentos de trabalho, fora do repositório); cada decisão e cada pergunta está escrita por extenso aqui. Ficam para perto do lançamento, fora deste ADR: subdomínio de envio e campos P48 (U2), revisão do jurídico (U3), plano e conta do Resend (U4), quem lê as respostas ao A3 (U7) e a meta de ativação (U10).

**O que não foi conferido na fonte:** os limites do Resend (100 e-mails por dia e 3 mil por mês no plano grátis; reclamação abaixo de 0,08 % e bounce abaixo de 4 %, política de uso de 13/10/2026), os artigos da LGPD (7º, V e IX; 18; 33), o RFC 8058 e a regra de cron do plano grátis da Cloudflare vêm do estudo, de memória dos autores; o jurídico confirma a lei antes de ligar em produção (U3) e quem pegar o PR do envio confere os limites do Resend.

O risco que manda no desenho é duplo. A conta do Resend é uma só para login, recuperação de senha, cobrança e a série: com o volume de hoje, uma única reclamação de spam passa de 0,08 % e pode suspender a conta inteira. E o banco é onde está o risco de privacidade: escolher quem recebe e-mail exige ler tabelas que nenhum papel de cobrança lê, e medir "voltou" exige ler a sessão.

## Decisão

### Escopo e o que fica de fora

Entregar em **fase 1**: a medida, este ADR, o texto da Política e a série A1 a A3 **construída e desligada**. **Nenhum e-mail da série sai a ninguém** em nenhum ambiente, nem no staging; o parecer com envio real é a fase 2. Cada um dos itens abaixo é **fora do escopo e exige corte novo e parecer novo do Rodrigo**: abertura ou clique medidos por pixel ou redirecionamento; mais de 3 e-mails; conteúdo de Pro, preço, plano ou urgência; destinatário que não seja o dono da primeira loja; trilha de tela, toque ou tempo por pessoa; medida por loja nomeada; teste A/B de e-mail.

### D1. Tabela própria `activation_notices`

O aviso da série vive em `activation_notices` (provisório), com o **formato** de `billing_notices` (o molde técnico inteiro: aviso gravado com o evento do outbox na mesma transação, fila, consumidor que relê e reavalia, chave de idempotência), mas **sem misturar com cobrança**: chave de deduplicação por **pessoa e passo** (a 1ª loja da pessoa é a única que gera aviso), estado `pending`, `sent`, `skipped` ou `failed` **com motivo**, `recorded_at`, **sem endereço nem texto**, e o banco recusa `@` em qualquer coluna de texto. RLS forçada, política por papel, nenhum acesso do tenant. **Alternativa recusada: um `kind` novo em `billing_notices`.** O aviso de cobrança tem base legal (LGPD, art. 7º, V), retenção, exportação e grants de um papel que não lê `sales` nem `privacy_cases`; a série tem outra base (art. 7º, IX), descadastro e um papel de leitura largo. Misturar faria o CHECK de tipos, o índice único por pessoa do `welcome` e o papel de cobrança carregarem a regra da série, e um erro de uma passaria à outra.

### D2. Dois papéis de banco (Q-6, decidido pelo Arrascaeta em 07/11/2026; Rodrigo e Filipe confirmam na revisão deste ADR)

- **`polaris_activation_owner`** (`NOLOGIN NOINHERIT NOBYPASSRLS`) é dono **só das funções da medida** e lê `session` por coluna (D9). Para delimitar a população do M3 ele lê também, só nas colunas que o funil já usa, `organizations`, `memberships` e `platform_internal_organizations` (condição 2 do Rodrigo) e, para excluir lojas com relação de cobrança e o que já vendeu, `products`, `sales` e `organization_billing` por coluna. Esses três últimos não estavam na lista da condição 2: a lista exata fecha no PR do banco da medida e **o Rodrigo e o Filipe a confirmam ali**; qualquer SELECT além do necessário reprova o gate.
- **Um papel separado para a série** (proposta `polaris_activation_notice_owner`, provisório) é dono da função de candidatos, do destinatário e das tabelas da série. Ele lê, por coluna e no mínimo necessário: `organizations`, `memberships`, `products`, `sales`, `organization_billing`, `platform_internal_organizations`, `privacy_cases`, `"user".email_verified` e as tabelas novas, e **nada mais; em particular, não lê `session`**. As colunas exatas fecham no PR do banco da série e o gate as prova.

A razão da separação: **a função que escolhe quem recebe e-mail não pode ser a que lê a sessão.** Um defeito ou um `CREATE OR REPLACE` errado numa delas não pode dar à outra o que ela não tem. **Alternativas recusadas:** (a) **um papel só** para as duas coisas, mais simples, mas a função de candidatos passaria a poder ler a sessão de todo usuário; (b) **ampliar `polaris_admin_owner`**, que é o dono de todas as funções `admin_*`: cada uma passaria a poder ler a sessão (condição 1 do Rodrigo, R-1). Os dois papéis têm `REVOKE ALL … FROM PUBLIC` nas funções, `search_path = pg_catalog, public, pg_temp` fixo, sem SQL dinâmico, e `EXECUTE` a um runtime só; o gate prova `has_function_privilege` função a função e que o Admin não faz SELECT direto, nem do catálogo.

### D3. Quando a série para: as 9 regras e duas do Rodrigo

Cada regra é um `skipped` com motivo, não um erro. Elas são **condições do mesmo `SELECT` da varredura** e voltam a valer **no envio**, numa versão do `noticeStillTrue` própria da série (o consumidor relê o aviso e o estado, e o que deixou de valer vira `skipped` com o motivo; nada sai):

1. **ativou** (primeira venda confirmada, em qualquer momento antes do envio);
2. **descadastro** da pessoa (vale na hora, em todas as lojas dela);
3. **passou de 14 dias** da criação ou **os 3 e-mails já saíram**;
4. **a loja tem teste Pro ou Pro** (U8), em qualquer estado de cobrança;
5. **loja encerrada, suspensa ou com pedido de dados (LGPD) aberto**;
6. **loja interna** (`platform_internal_organizations`);
7. **e-mail da conta não verificado**, ou **endereço suprimido** por bounce ou reclamação;
8. **só a 1ª loja da pessoa** (a mais antiga como dona);
9. **flag desligada** ou **série em parada** (D6 e D7);

e, acrescentadas pelo Rodrigo: **encerramento pelo dono** e **loja em purge agendado**. O destinatário é sempre o **dono ativo com e-mail verificado**, lido na hora do envio por função própria (nunca membro, convite, indicação ou e-mail digitado). **Os estados S0 (sem produto ativo), S1 (com produto, sem venda) e S2 (ativou) não são guardados**: saem de `products.created_at`/`deleted_at` e de `sales.confirmed_at` a cada varredura.

### D4. Os três e-mails e o horário

**A1** 24 h depois da criação da loja, ainda em S0. **A2** 3 dias depois do 1º produto sem venda (S1), ou a variante de S0 no 5º dia. **A3** 10 dias depois da criação, ainda sem ativar, **só se o A2 já saiu**; pede resposta, avisa que é o último, não tem botão. Envio só entre **08:00 e 12:00 de São Paulo** (filtro no `WHERE` da varredura de hora em hora, que já roda na faixa `"17 * * * *"`; **nenhum cron novo**). A fila leva **só o ID opaco do aviso**; o corpo leva só o nome da loja (escapado, até 24 caracteres); nenhum dado pessoal, valor, contagem, URL com ID, token ou imagem, em evento, e-mail, log ou fila. **Por fora a série se chama "dicas para começar"**; "série", "descadastro", "opt-out", "ativação" e "trial" não aparecem em e-mail nem na Política.

### D5. Teto diário e janela de validade (o teto de 60 é proposta do Filipe; os 3 dias de validade são suposição do produto, que o Filipe ajusta em Q-1)

**Teto de 60 por dia**, guardado no banco, para a série não gastar a cota do Resend (100 por dia no plano grátis, a mesma dos e-mails de conta): no teto a varredura **para no dia** e retoma no seguinte, na ordem. **Janela de validade:** um aviso que não saiu em 3 dias do gatilho vira `skipped: expired` (o A2 não sai no dia 9). Lote fixo de 50 por varredura, com `truncated`.

### D6. Flag própria, desligada em todos os ambientes

A série tem flag própria (proposta `ACTIVATION_EMAILS_ENABLED`, provisório), **desligada por padrão em todos os ambientes, inclusive o staging**. Com ela desligada, **a varredura nem grava a linha**. **Ligar depois não manda o acumulado**: só entra loja criada depois do instante da liga, que o banco guarda na primeira varredura com a flag ligada (o corte também admite gravar as linhas devidas como `skipped` ao ligar, como o ciclo de cobrança; o PR da varredura escolhe uma das duas, e a regra é a mesma: nada atrasado sai). O remetente é configurável à parte (`ACTIVATION_EMAIL_FROM`, não o `AUTH_EMAIL_FROM`), para o subdomínio de envio de U2 entrar sem código. **Ligar em produção** é decisão do usuário, depois de 4 a 6 coortes de lojas reais (U6) e com U2, U3, U4 e U7 resolvidos; nenhum item da fase 1 liga a flag.

### D7. 1 reclamação desliga a série; só o usuário religa (Q-2)

Um webhook do Resend, no padrão dos de cobrança (assinatura Svix conferida **antes** de qualquer gravação, com o corpo cru e a janela de tempo; caixa de entrada com chave de idempotência; 401 sem assinatura; segredo do webhook é segredo do Worker), grava **só o tipo do evento e o HMAC do endereço**, nunca o corpo nem o endereço. **Bounce** suprime o endereço; **uma reclamação** suprime o endereço **e coloca a série em "parada"** num estado no banco, que a varredura e o consumidor respeitam (`skipped: series_stopped`). A taxa não serve de limite: com poucas centenas de e-mails por mês, uma só reclamação já passa de 0,08 %, e o Resend suspende a conta sem aviso. **Q-2, decidido pelo Arrascaeta em 07/11/2026: religar nunca é automático.** Religar exige **decisão do usuário** e é feito pelo Arrascaeta, **ligando a flag por deploy, com registro no feed**: não há comando no Admin nem retomada sozinha. A decisão não cria comando no Admin e **a parada só sai por ação explícita do operador, nunca por código do Worker nem por tempo**. Como o estado de parada no banco é liberado junto com esse deploy fica em aberto para o PR do webhook (Filipe e Rodrigo): a proposta é o estado valer só para a liga em que nasceu (o instante da liga de D6), de modo que a nova liga a libera. Dois outros sinais pedem que o Arrascaeta **desligue a flag à mão** e olhe: descadastro acima de 5 % num e-mail com pelo menos 50 envios (limite do Rodrigo, a ajustar no 1º lote) e queixa de e-mail que chegou a quem não devia (a regra 5 ou a 8 falhou). **Nenhum item da fase 1 os automatiza.**

### D8. Preferência e supressão

- **Preferência de descadastro por pessoa** (a pessoa e a data): vale em **todas as lojas dela** e para qualquer e-mail não transacional futuro baseado em legítimo interesse. Os avisos de conta e cobrança **não têm descadastro** (fazem parte do serviço) e a tela diz isso. O descadastro é de um clique, sem login: o GET só mostra a página, **quem grava é o POST**; o token é HMAC sobre o ID interno do usuário e a finalidade, sem e-mail, com segredo próprio (diferente do `BETTER_AUTH_SECRET`, com `PREVIOUS` para rotação), mesma resposta exista ou não a pessoa, idempotente; os e-mails levam `List-Unsubscribe` e `List-Unsubscribe-Post` (RFC 8058, citado de memória, o PR confirma).
- **Supressão por bounce ou reclamação** guarda o **HMAC-SHA256 do endereço em minúsculas, com segredo próprio, nunca o endereço em claro**, sem relação com a conta: vale mesmo que a conta seja apagada e para outra conta com o mesmo e-mail. **Alternativa recusada: guardar o endereço** para comparar. Seria dado pessoal sem relação com nenhuma conta para apagar, e o banco recusa `@`.

### D9. A medida: funil, M1 e M3 derivado da sessão

- **M2 e M4 saem do funil** (emenda ao ADR 0071, abaixo): `activatedWithin14Days` e as células do teste, sem evento novo.
- **M1** é o aviso: enviado, pulado com motivo, falhou, bounce, reclamação; o Admin lê só agregados com k = 5 (a série sem endereço nem loja).
- **M3, "voltou ao app", entre as lojas que não ativaram, é derivado da sessão, não de um marcador novo.** "Voltou" = existe sessão da dona da 1ª loja com `updated_at` (dia de Brasília) **depois do dia de criação da loja e até 14 dias depois**, na mesma população da série (S0/S1, sem loja interna, **sem relação de cobrança**). Um voltar no mesmo dia da criação não conta. A sessão é da pessoa: "voltou ao app", não "abriu esta loja". Decide **qual conserto**: "nunca voltou" aponta o e-mail; "voltou e não cadastrou" aponta a tela de produto (corte de interface, não e-mail).
- **Colunas lidas de `session`: `user_id`, `created_at`, `updated_at`. Proibidas: `id`, `token`, `ip_address`, `user_agent`, `expires_at`.** `auth_access_log` (registro do Marco Civil, sigiloso, só sai por ordem judicial) e `devices` ficam **fora**. O gate prova `has_column_privilege` falso para cada coluna proibida, `has_table_privilege` falso para a tabela inteira, nenhum INSERT, UPDATE ou DELETE.
- **RLS:** a `session` tem `FORCE ROW LEVEL SECURITY`; o papel da medida precisa de **uma política própria** `FOR SELECT TO polaris_activation_owner USING (true)` (o filtro é da função), e o gate prova que é a única política dele em `session` e que tenant, cobrança, catálogo e Admin continuam sem política. A migration traz `SET LOCAL lock_timeout = '10s'` antes do `CREATE POLICY` (como a da RLS da `session`): `CREATE POLICY` pede lock exclusivo na tabela que todo `/get-session` lê, e é melhor falhar e reimplantar do que enfileirar login.
- **A função** (`SECURITY DEFINER` do `polaris_activation_owner`) devolve **só contagens por semana de coorte**, sem ID de loja ou de pessoa, com `EXECUTE` a um runtime (o da congelagem). **O Admin lê só a tabela congelada**, pelo wrapper auditado do funil.
- **Contador semanal congelado.** Quando a coorte está fechada, ou seja, **na mesma janela do M2: o início da semana mais 21 dias**, de modo que toda loja dela teve os 14 dias (congelar antes subconta o "voltou"), e antes de as sessões saírem da retenção (30 dias depois do fim, ADR 0079), a varredura grava **só valores já suprimidos** (k = 5 por célula, com a complementar, como o funil; célula abaixo do k **não é gravada**) numa tabela **append-only** (gatilho como o de `platform_audit_events`), sem loja, pessoa nem ID, **13 meses**. Congelamento que falha deixa a coorte **"indisponível", nunca zero**. A tabela `activation_returns` (um marcador por loja, gravado pelo tenant) **fica descartada**; volta só com parecer novo do Rodrigo e do Filipe. Nenhuma escrita é acrescentada a rota do lojista; o custo é **uma leitura agregada** a mais na varredura que já roda de hora em hora.
- **O M3 é um piso de "voltou" e isso é decisão, não detalhe.** Sessão apagada no logout ou na revogação de aparelho e `updated_at` que se renova uma vez por dia (o código lê 24 h de renovação e 7 dias de ociosidade) **subcontam o "voltou"**; quem abre o app offline não toca a sessão. Isso **infla o "nunca voltou"**, o lado que favorece a conclusão "o e-mail é a alavanca". Por isso **a série não liga só porque "nunca voltou" está alto: exige também o M2 baixo.** O texto está na tela do funil e aqui. Não conferido: se a linha de sessão vencida ainda existe quando a coorte fecha os 14 dias (o teste do PR do banco da medida semeia "sessão expirada que já foi apagada"); se não existir, o viés é maior que o dito, no mesmo sentido.
- **Antes de ligar, a linha de base** das últimas coortes que passam do k é lida e gravada; a meta sai dela, com o usuário (U10). A leitura é direcional: coorte menor que o k é "inconclusiva" e não decide nada, e o e-mail não se prova causa da ativação.

### D10. Aposentadoria do E1 (boas-vindas)

O A1 assume o papel do E1. **Ele não herda a base do E1** (art. 7º, V): é legítimo interesse (art. 7º, IX), com descadastro. **Herda os pré-requisitos para ligar em produção**: campos P48 (razão social, caixa de suporte, e-mail do encarregado), subdomínio de envio, região e DPA do Resend (art. 33), rastreio de abertura e de clique desligado no domínio de envio (conferido no painel), a seção da Política publicada, o jurídico confirmando o legítimo interesse. A pendência do E1 (base legal) **fecha por aposentadoria**. A saída tem caminho seguro, em fases (ADR 0096):

- **Fase 1, só código:** tirar a chamada de `runWelcomeNoticeSweep` da manutenção, o ramo `welcome` do consumidor, o modelo `emails/welcome.ts`, a leitura de `WELCOME_EMAIL_ENABLED` e a variável em `wrangler.jsonc` e no runbook. Com a chave desligada em todos os ambientes, tirar não muda comportamento.
- **Banco intacto:** a função `welcome_notice_candidates`, o CHECK de tipos, o índice único por pessoa e as linhas `kind = 'welcome'` já gravadas ficam. Uma função que o Worker anterior ainda pode chamar não se apaga no expand, e um CHECK mais estreito recusaria as linhas.
- **Contração depois:** `DROP FUNCTION welcome_notice_candidates` num PR à parte, com o marcador `-- expand-contract`, depois de um deploy sem o código; o tipo `welcome` só sai do CHECK quando não houver linha (Q-4, a data desse PR, é do Filipe). `create_initial_organization` não muda.
- **O A1 não herda a tabela:** a série usa `activation_notices` e a sua regra de uma por pessoa; quem recebeu o E1 no staging não conta.

### D11. Retenção (classe nova, nasce `proposta`)

| Dado | Prazo | Observação |
| --- | --- | --- |
| Linha de aviso da série (`activation_notices`) | **12 meses** de `recorded_at`, só aviso encerrado; sai com a loja no purge e com a conta | Classe operacional do ADR 0079; nasce **`proposta`, sem job**, até haver aprovação e um job que pule loja sob trava legal |
| Preferência de descadastro | enquanto a conta existe; sai com ela | Prova de que a preferência foi respeitada. Efeito aceito, dito na Política: quem apaga a conta e volta recebe a série de novo |
| Estados S0, S1 e S2 | **não são guardados** | Calculados no envio; nenhuma coleta nova |
| Supressão por bounce ou reclamação | enquanto a série existir | **HMAC-SHA256** do endereço em minúsculas, segredo próprio, nunca o endereço; vale mesmo se a conta for apagada |
| Contadores agregados (M1 a M4, inclusive o M3 congelado) | **13 meses**, k ≥ 5, só células já suprimidas | Sem ID de pessoa nem de loja; não é dado pessoal se a supressão valer |
| Sessão lida para o M3 | o que o ADR 0079 já fixa (`auth_sessions`, 30 dias depois do fim) | Não é copiada: só se lê, e só a contagem sai |
| Evento bruto por loja | **não existe**; teto de 90 dias e depois só agregado, se algum dia houver | Seria dado pseudônimo de lojista |

As tabelas novas **não entram na exportação do tenant** (como `billing_notices`) e **entram na do titular** (estado da série e preferência) quando a Política disser. O purge da loja e a exclusão da conta apagam a linha de aviso; **a supressão por HMAC não é apagada com a conta**.

### D12. Migrations e ordem

Tudo é **expand**: só `CREATE` e `GRANT`; nada apaga dado nem função existente neste corte (ADR 0096). Números provisórios: 0122 (funil até 14 dias e M4), 0123 (M3 da sessão), 0124 (tabelas e papel da série), 0125 (candidatos), 0126 (supressão e parada, se não couber na 0124). O contrato do funil é **estrito**, e a migration roda antes do Worker: o Admin que aceita as células novas como opcionais **entra e é implantado antes** da migration que as devolve.

## Consequências

- A medida (funil e M3) vale mesmo que a série nunca ligue, e precisa estar no ar **desde o 1º dia da produção**: a linha de base é o que a série vai comparar.
- Dois papéis e várias tabelas lidas por colunas são mais superfície de banco; o preço é que nenhum papel junta sessão com a decisão de quem recebe e-mail.
- Sem flag ligada, sem coorte real e sem Resend de produção, a série não envia nada; o que o lojista vê é só o cartão "E-mails que você recebe" em Seus dados.
- O número exato do teto, da janela e dos nomes de papel e de flag é ajustável sem novo ADR; mudar uma regra de D3, o destinatário, o número de e-mails, o tipo de dado medido ou a base legal **pede ADR novo, corte novo e parecer do Rodrigo**.
- Perguntas ainda abertas, sem trava para este ADR: **Q-1** (teto de 60 e validade de 3 dias; Filipe), **Q-3** (congelamento e leitura do M3 em um PR ou dois; Léo), **Q-4** (quando sai a contração do E1; Filipe), **Q-5** (loja de teste não interna e caixa de e-mail para o parecer em staging; Arrascaeta e Diego, fase 2) e **Q-7** (se `trial_started_at` continua preenchido depois do teste; muda o M4, conferido na leitura do esquema do PR do funil no banco).

## Alternativas consideradas

- **Consentimento no cadastro em vez de legítimo interesse:** derrubaria o alcance e poria atrito onde o DESIGN.md pede o mínimo. O usuário decidiu o legítimo interesse (U1); consentimento fica só para o que vende (Pro, preço, plano anual, newsletter, pesquisa), e cada um deles é corte novo.
- **Fundir o E1 na série sem descadastro, ou manter o E1 separado:** o Rodrigo não aceita a fusão sem descadastro; manter dois e-mails de boas-vindas e dicas pesa mais que um. A aposentadoria (U9) tira uma base e um e-mail.
- **Marcador `activation_returns` para o M3** (uma linha por loja, gravada na leitura do tenant): grava dado novo por loja em caminho do lojista e exige uma função que o tenant chama. A leitura da sessão por coluna, sem gravar nada por loja, é mais restrita (R-1).
- **Rota de eventos do navegador, Workers Analytics Engine ou `auth_access_log` para o M3:** a rota mantém o banco acordado o dia inteiro; o Analytics Engine é outro lugar com dado por loja; o `auth_access_log` é registro do Marco Civil e estatística mudaria a finalidade.
- **Contador de passo extra, eventos por tela e abertura ou clique por pixel:** sem decisão que dependa deles (U5); a abertura é inflada pelo Apple Mail e o rastreio é a parte invasiva. Decide-se pela ativação (M2), não pela abertura.
- **Dividir a faixa "depois de 7 dias" do funil:** mudaria o significado de uma faixa que já se lê; a célula nova é própria.
- **Guardar S0/S1/S2 numa coluna:** é estado que fica velho e precisa de um segundo caminho de escrita; calculado a cada varredura não coleta nada e não envelhece.
- **Parar a série por taxa de reclamação, e retomar sozinha depois de um tempo:** com o volume de hoje, a taxa não lê (uma reclamação já passa do limite do Resend) e a conta suspensa derruba login e cobrança; religar sem decisão repetiria o dano.
- **Outra conta do Resend e subdomínio:** o subdomínio separa a reputação nos provedores de caixa de entrada (U2), mas só outra conta protege da suspensão da conta; é decisão do usuário (U4), para perto do lançamento.
- **Cron novo para a série:** a faixa de manutenção que já roda de hora em hora basta (o Free permite 5 e usamos 2).
