# Gate 5 — offline (Fase 5)

Gatilho: fechamento da Fase 5 (PR48 a PR59) e qualquer mudança posterior em dispositivos, lease, change log, bootstrap, outbox, `sync.push`, comandos offline, painel de atenção ou saída com pendências.

O plano define o Gate 5 assim: o offline só é considerado pronto quando (1) um iPhone real funciona, (2) um reinício preserva o outbox, (3) um envio duplicado é seguro, (4) um conflito de estoque não corrompe nada e (5) sair da conta não perde dados em silêncio. O que o software consegue provar sozinho está automatizado abaixo; o que exige o aparelho físico é o **checklist manual** no fim, e **bloqueia ligar a escrita offline em produção** (ADR 0032).

## Pré-requisitos de acesso

- Siga a [política de perfis de CLI](./cli-profile-policy.md): Neon CLI com o perfil `junior-pessoal`. Não use o plugin ou conector Neon.
- Nenhuma connection string, senha ou token é impressa, gravada ou colada em chat; a URL do gate vive só nas variáveis de ambiente do processo e é removida ao final.
- Alvo seguro: uma **branch Neon nova e descartável** (filha da `production` do projeto Neon descartável dos gates, sem `--schema-only`, expiração de 24 h) com um banco novo, as migrations reaplicadas do zero e apenas dados sintéticos. Nunca use um projeto com dados reais de clientes. O procedimento de criação da branch é o do [Gate 4](./gate-4-sales-core.md#prova-antes-de-liberação-em-neon).
- Não rode dois gates ao mesmo tempo no mesmo banco.

## Passos automáticos

    CI=true bun scripts/run-gates.ts gate5     # suíte offline (Fase 5), a partir de packages/db; também roda na suíte ci do CI
    bun run --filter @polaris/db gates:all     # tudo

A suíte `gate5` roda, em sequência: `offline-devices`, `offline-lease`, `sync-log`, `bootstrap`, `sync-push`, `offline-product`, `offline-customer`, `offline-stock`, `offline-sale` e `offline-e2e`. Cada um termina com `"status": "passed"`.

Localmente, `bun run test:offline-browser` (em `apps/web`) roda as duas configurações de navegador. Os cenários do PR62 (recarregar, matar e reabrir, reconectar, duas abas, conflito, atualização pendente) e sua cobertura estão no [ADR 0042](../adr/0042-suite-de-navegador-do-offline-e-versoes.md); a compatibilidade com versões antigas do app está no arquivo dourado de payloads.

No CI, o job **Offline persistence browser gate** roda os cenários de navegador (Chromium desktop e Pixel 5 emulado) da persistência (PR12), das coleções locais (PR50b), do outbox (PR52), do painel de atenção (PR58) e da saída com pendências (PR59); o job de gates PostgreSQL 18 roda a suíte `ci`, que inclui as provas de banco acima.

## O que prova cada critério

| Critério do plano | Prova automática | Onde |
| --- | --- | --- |
| Reinício preserva o outbox | Comandos enfileirados sobrevivem a recarregar e mantêm a ordem; um comando `sending` interrompido volta à fila na mesma posição; o mesmo comando repetido não entra duas vezes; a limpeza recusa apagar comandos sem descarte explícito. | `e2e/offline-outbox.e2e.ts`, `e2e/offline-logout.e2e.ts` (IndexedDB e OPFS reais, Chromium e Pixel 5 emulado) |
| Envio duplicado é seguro | O resultado de cada comando é gravado uma vez por `commandId` e repetido igual; o mesmo ID com conteúdo diferente é recusado sem gravar; oito envios simultâneos executam uma vez; uma resposta perdida é reenviada e repetida, para os sete tipos de comando. | `sync-push`, `offline-product`, `offline-stock`, `offline-sale`, `offline-e2e` |
| Conflito de estoque não corrompe | Uma baixa ou venda que não cabe é recusada inteira, sem rastro (sem venda, pagamento, movimento ou saldo alterado); contagem contra saldo que mudou é recusada; duas contagens e duas baixas concorrentes: uma vence e o saldo nunca fica negativo; o razão explica todos os saldos ao final; a versão que o aparelho prevê é a do servidor. | `offline-stock`, `offline-sale`, `offline-e2e` |
| Conflito se corrige sem "forçar" | Venda recusada é reenviada como comando novo depois de corrigir a causa; contagem obsoleta e SKU em uso são descartadas e refeitas; acesso revogado vira `needs_attention` sem reenvio; não existe botão que force a sincronização. | `offline-e2e`, `e2e/offline-attention.e2e.ts`, testes de marcação do painel |
| Sair não perde dados em silêncio | Com fila: envia primeiro; sem rede ou com recusa, a saída é bloqueada e nada é apagado; descartar exige confirmação em duas etapas e informa quantas operações se perdem; a limpeza do outbox se recusa a apagar comandos sem o flag. | `e2e/offline-logout.e2e.ts`, `logout-guard.test.ts` |
| Autorização e tenant | Lease assinado, épocas, grants e capacidades revalidados a cada comando; um aparelho revogado não confirma nada; outra organização não alcança dados nem IDs. | `offline-devices`, `offline-lease`, `sync-push`, `offline-e2e` |
| Telas leem do aparelho | Com o runtime pronto, clientes e produtos listam das coleções locais, cadastram sem rede com o selo "Aguardando envio", bloqueiam arquivar/restaurar/variantes/imagens sem rede e tudo sobre o que o servidor ainda não confirmou, avisam cliente repetido só com dados do aparelho e, numa segunda visita sem rede, mostram o que ficou; ao voltar a rede o servidor confirma e as ações voltam. | `e2e/offline-screens.e2e.ts` (telas reais sobre o runtime real, [ADR 0045](../adr/0045-telas-lendo-do-aparelho.md)), `customers/local-customers.test.ts`, `catalog/local-products.test.ts` |
| Venda e estoque sem conexão | Sem rede, a venda do formulário real é guardada no aparelho (um comando, ID e instante da tentativa), sem perfil e sem data digitada, o estoque do aparelho já desconta o que está na fila, aparece como não confirmada e o servidor a confirma ao voltar a rede; estoque insuficiente no aparelho avisa e guarda, e a recusa do servidor fica em Pendências; com rede o botão é o do servidor; receber/contar/baixar sem rede ficam na fila sem custo médio e baixa acima do saldo do aparelho é recusada pelo formulário; uma venda travada (sem resposta do servidor) nunca muda de conteúdo e, sem perfil nem data digitada, pode ser guardada no aparelho como a MESMA venda, que o servidor reconhece sem duplicar (gate `offline-sale`, passo 1b). | `e2e/offline-screens.e2e.ts` ([ADR 0046](../adr/0046-venda-e-estoque-sem-conexao.md)), `sales/queue-offline-sale.test.ts`, `sales/offline-sale-model.test.ts`, `offline/local-stock-entries.test.ts`, `inventory/offline-stock.test.ts` |
| Perfil de pagamento sem conexão | Sem rede a tela de venda oferece os perfis da última conexão, guarda a venda com o perfil (id e versão) e o servidor a confirma registrando o perfil e a versão; com o perfil mudado, arquivado ou inexistente a venda é recusada inteira, sem rastro, com código próprio, visível em Pendências com "Reenviar sem perfil de pagamento"; a venda enviada direto e depois pelo aparelho é a mesma venda. | `e2e/offline-screens.e2e.ts` (perfil), gates `offline-sale` (1c a 1e) e `offline-e2e`, `server/sync/handlers/sale-confirm.test.ts`, `offline/sale-confirm.test.ts`, `offline/attention.test.ts`, `lib/payment-profile-cache.test.ts` ([ADR 0049](../adr/0049-perfil-de-pagamento-na-venda-sem-conexao.md)) |
| Edição de cliente sem conexão | Sem rede o cliente é editado e a alteração aparece de imediato com o selo "Alteração aguardando envio" (sobreposta, a linha local não muda); o servidor a aplica só sobre a versão que o aparelho viu; se o cliente mudou em outro aparelho, a alteração é recusada inteira (`customer_version_conflict`), sem sobrescrever nada e sem auditoria, e fica em Pendências só com "Descartar"; repetir o envio devolve o mesmo resultado; cliente inexistente, de outra organização ou perfil inválido são recusados sem rastro. | `offline-customer`, `e2e/offline-screens.e2e.ts` (edição), `offline/customer-update.test.ts`, `server/sync/handlers/customer-update.test.ts` ([ADR 0050](../adr/0050-edicao-de-cliente-sem-conexao.md)) |
| Aparelhos | A tela lista os aparelhos ativos (este primeiro), revogar pede confirmação que diz o que se perde, cancelar não faz nada, revogar mostra quantas autorizações offline foram canceladas e tira o aparelho da lista, este aparelho só sai por "Sair", sem conexão não há como revogar. | `e2e/offline-devices.e2e.ts`, `offline/runtime/devices-model.test.ts` ([ADR 0048](../adr/0048-tela-de-aparelhos.md)) |
| Histórico sem conexão | Sem rede, o histórico lista as vendas recentes do aparelho (últimas 100), filtra por situação, data e cliente, não oferece detalhe nem busca por item; com rede volta a ser o do servidor. | `e2e/offline-screens.e2e.ts` (histórico), `sales/local-history.test.ts` ([ADR 0046](../adr/0046-venda-e-estoque-sem-conexao.md)) |
| Duas abas | O cadastro feito numa aba aparece na outra sem recarregar, com o selo de envio; o aviso é só a notícia (sem dados) e a aba que fechou os armazenamentos deixa de ouvir. | `e2e/offline-screens.e2e.ts` (duas abas), `offline/runtime/offline-runtime.test.ts` ([ADR 0045](../adr/0045-telas-lendo-do-aparelho.md)) |
| App abre sem rede | Depois de uma visita online, o app real abre sem rede com a organização lembrada; sem visita anterior diz que não foi possível carregar; sessão encerrada apaga a cópia e ela não é oferecida nem offline depois; aberto da cópia, a lista verdadeira entra quando a rede volta. | `e2e/offline-entry.e2e.ts`, `lib/organizations-cache.test.ts` ([ADR 0047](../adr/0047-abrir-o-app-sem-rede.md)) |
| API do runtime em navegador | O `createRpcRuntimeApi` real (get-session, `device.check`, `sync.push`) sob o app real, com o servidor interceptado: get-session 401 com fila não envia nada, esquece o usuário lembrado, deixa a fila intacta (mesmos IDs, reenviados na volta da sessão) e leva a tela à sessão encerrada; `push` 401 apaga lease e coleções e guarda a fila; get-session 429 e lento (mais de 4 s) seguem com o usuário lembrado e o lease próprio; `device.check` 404 troca o aparelho, 500 mantém o do próprio usuário e nunca empresta o de outro; `push` com `session_changed` deixa o comando na fila com o mesmo ID e a venda em "Precisa de atenção". As respostas do servidor (404, 500, 401, `session_changed`) são ditadas pelo teste: não prova o servidor real, só o que o runtime faz com cada uma; o 409 do `device.check` fica no teste unitário. | `e2e/offline-runtime-api.e2e.ts`, `offline/runtime/runtime-api.test.ts` |
| Números e invariantes | Totais da venda conferidos em centavos contra um oráculo independente; razão × saldo; saldos nunca negativos; uma saída gravada por comando. | `offline-e2e` |

## Suíte em aparelhos reais (BrowserStack)

Roda o roteiro do Gate 5 em um iPhone e um Android **físicos** do BrowserStack (Automate Mobile, 1 sessão paralela), um aparelho por vez. É manual e local: não faz parte do CI e não usa IA.

    scripts/gate5-real-devices.sh              # iPhone e Android, em sequência
    GATE5_PLATFORMS=android scripts/gate5-real-devices.sh   # só um aparelho (ios ou android)
    GATE5_FLOWS=2 scripts/gate5-real-devices.sh             # só um fluxo (1, 2 ou 3)

Pré-requisitos: `bun install --frozen-lockfile`, `openssl` no PATH e as credenciais `BROWSERSTACK_USERNAME` e `BROWSERSTACK_ACCESS_KEY` no ambiente ou em `~/.secrets/browserstack.env` (o script exige modo 600 ou 400 e lê só essas duas variáveis, sem executar o arquivo; outro caminho em `BROWSERSTACK_ENV_FILE`). As credenciais nunca vão para o repositório, o relatório ou o log. Aparelhos padrão: iPhone 18 Pro Max (iOS 27, Safari) e Google Pixel 11 Pro (Android 17, Chrome); troque com `GATE5_IOS_DEVICE`, `GATE5_IOS_VERSION`, `GATE5_ANDROID_DEVICE` e `GATE5_ANDROID_VERSION` (nomes como na lista da API do BrowserStack, `GET https://api.browserstack.com/automate/browsers.json`, filtrando `device` e navegador `iphone` ou `android`). Use só dados sintéticos: os laboratórios têm servidor simulado dentro da página e não alcançam API, Neon nem pagamentos.

### O que o script faz

1. Constrói o laboratório offline (`build:offline-poc`) e o shell com service worker (`vite.pwa.config.ts`, modo `pwa-e2e`).
2. Serve os dois em **HTTPS** com certificado autoassinado e descartável (diretório temporário, apagado ao final), em `https://bs-local.com:4443` (laboratório) e `:4444` (shell).
3. Abre o BrowserStack Local (identificador aleatório por execução, `onlyAutomate` e `only` restrito às duas portas da suíte, para o aparelho remoto não alcançar o resto do `localhost`; o binário exige a chave na linha de comando, então ela fica visível em `ps` enquanto o túnel está de pé: rode numa máquina sem outros usuários). O script só roda com o binário em `~/.browserstack/BrowserStackLocal` (ou `BROWSERSTACK_LOCAL_BINARY`) cujo sha256 bata com o fixado no próprio script (versão 8.9, linux-arm64) e o repassa à biblioteca (`binarypath`), que então não baixa outro. O hash fixado é o do binário que a biblioteca baixou na primeira vez; em outra plataforma ou versão, baixe do site oficial do BrowserStack e atualize o hash no mesmo commit.
4. Abre uma sessão WebDriver no aparelho (iPhone com Safari, Android com Chrome) e roda os três fluxos abaixo (o fluxo 1 apaga os dados do site no começo, como num aparelho recém-instalado, esperando o `deleteDatabase` terminar; o fluxo 2 não apaga) e um passo final que devolve a rede do aparelho ao normal.
5. Grava `apps/web/test-results/real-devices/<instante>/report.json` e `report.md`, marca a sessão no BrowserStack como passou ou falhou, encerra a sessão, o servidor e o túnel e sai com código diferente de zero se algum passo falhar. Em Ctrl+C ou SIGTERM a sessão do aparelho (com a rede religada), o servidor e o túnel também são encerrados, mas nenhum relatório é gravado. Valores inválidos em `GATE5_PLATFORMS` ou `GATE5_FLOWS` abortam antes de construir o app.

Fluxos (cada passo falho pula os seguintes do mesmo fluxo):

| Fluxo | Passos |
| --- | --- |
| 1. Clientes | abrir o app em contexto seguro com OPFS, IndexedDB e service worker e pedir `storage.persist()`; iniciar o runtime e carregar dados (cliente cadastrado com rede é confirmado); **derrubar a rede do aparelho** (perfil `no-network`) e conferir de dentro da página que ela caiu; registrar um cliente sem rede (fica "Aguardando envio"); religar a rede e recarregar a página (a fila sobrevive ao reinício); voltar online, sincronizar e conferir o selo e a edição liberada |
| 2. Venda | iniciar a tela de venda e esperar o carregamento; sem rede, guardar uma venda de 2 itens no aparelho; conferir que o estoque do aparelho desce de 5 para 3; religar a rede, sincronizar e ver o servidor simulado confirmar uma venda; conferir que o botão volta a ser "Confirmar venda" |
| 3. Shell | instalar o service worker e deixá-lo controlar a página; sem rede, recarregar e abrir uma rota interna a partir do shell em cache; religar a rede |

### Como ler o relatório

`report.md` traz, por aparelho, o link da sessão no BrowserStack (vídeo, logs e capturas, com a conta do projeto) e uma tabela com fluxo, passo, resultado (✅ passou, ❌ falhou, ⏭️ pulado), tempo e detalhe. No primeiro passo o detalhe registra o navegador do aparelho e o resultado de `storage.persist()`. `report.json` tem os mesmos dados (`status` geral, `devices[].steps[]`, `sessionUrl`). Uma execução restrita por `GATE5_PLATFORMS` ou `GATE5_FLOWS` sai com `partial: true` (e um aviso no `report.md`) e não prova o Gate inteiro. Um passo falho traz a mensagem; abra o vídeo da sessão para ver a tela. Guarde o relatório (sem segredos) junto do registro do Gate; não aponte `GATE5_REPORT_DIR` para dentro do repositório. O log do binário do Local fica num diretório temporário e é apagado ao final.

### Como a rede do aparelho é derrubada

A sessão WebDriver não passa pela rede do aparelho, então o perfil de rede pode ser trocado no meio do teste pela API REST do BrowserStack (`PUT /automate/sessions/<id>/update_network.json` com `{"networkProfile":"no-network"}`). Observado em 18/10/2026 (Pixel 11 Pro): o perfil `reset` responde 200 mas **não** religa a rede; a rede é restaurada com o perfil documentado `4g-lte-advanced-good`. Depois de cada troca o script confere de dentro da página (um `fetch` para `/rpc/probe`, que o service worker nunca guarda) que a rede de fato caiu ou voltou.

### Limites (o que a suíte não prova)

- O servidor dos laboratórios é simulado na própria página: a suíte prova o **aparelho** (OPFS, IndexedDB, outbox, service worker, comportamento sem rede), não a API real, o Neon nem o RLS. O ciclo com servidor real continua sendo o do checklist manual em staging, com a chave ligada.
- A flag de rede do laboratório ("Rede disponível") é o que o runtime usa para decidir que está offline; a rede do aparelho é derrubada de verdade ao mesmo tempo e conferida, mas o runtime não é forçado a ler `navigator.onLine`.
- O iPhone redireciona `localhost` para `http://bs-local.com`, que não é contexto seguro (sem OPFS e sem service worker); por isso o app é servido em HTTPS com certificado autoassinado e a capacidade `acceptInsecureCerts` dentro de `bstack:options`. Fora desse atalho o Safari mostra "Esta conexão não é particular".
- Não dá para automatizar: **instalar na tela inicial** (PWA instalado no iPhone), relógio do aparelho adiantado/atrasado, modo avião real, matar o app pelo seletor de apps e dias sem abrir (ITP). Continuam como itens do checklist manual abaixo.
- Os fluxos 1 e 2 usam a mesma origem e o mesmo aparelho, com usuários diferentes. Em 18/10/2026 a busca da venda não achava a variante sem apagar os dados do site entre eles. Causa (defeito do laboratório, não do app): o lease fica no `localStorage` só por organização, `leaseIsUsable` não confere o usuário, o namespace do OPFS sai do usuário de dentro do lease e o laboratório respondia `deviceIsMine` sempre verdadeiro; o fluxo 2 reaproveitava o aparelho e o lease do usuário do fluxo 1 e não fazia o bootstrap do servidor simulado da venda. Correção: o laboratório passou a guardar o dono do aparelho e a responder `deviceIsMine` conforme o usuário, como o servidor real; coberto por um teste Playwright que roda os dois fluxos na mesma aba sem limpar dados (`e2e/offline-screens.e2e.ts`). O fluxo 1 ainda apaga os dados do site no começo (aparelho recém-instalado) e o fluxo 2 não apaga mais. A troca de usuário **sem rede**, que ficou pendente de análise de segurança, foi corrigida no PR 149 (achado L6, emenda do [ADR 0044](../adr/0044-revisao-de-seguranca-adicional.md)): o lease passou a ser guardado por usuário e organização, a abertura exige `claims.sub` igual ao usuário da sessão, o namespace é montado com o usuário da sessão e `stillMine` não falha mais aberto. A reexecução de 19/10/2026 (`8a7bc54`) é anterior a essa correção; a prova final de 19/10/2026 (`29aec22`) já a inclui.
- Um aparelho por vez (o plano tem 1 sessão paralela); uma execução completa leva cerca de cinco minutos.

### Registro da execução de 18/10/2026

Execução completa (`partial: false`, de 22:01:06Z a 22:05:42Z nos dois aparelhos, 18 passos por aparelho, todos aprovados) com o código do PR #145 no head `d96af4f`. O `report.md` fica só na máquina de quem rodou (`test-results` está no `.gitignore`); este é o resumo, sem credenciais e sem links da conta do BrowserStack.

| Aparelho | Navegador | Resultado |
| --- | --- | --- |
| iPhone 18 Pro Max, iOS 27 | Safari | 18/18 |
| Google Pixel 11 Pro, Android 17 | Chrome 152 | 18/18 |

Fatos a levar para a decisão do Gate:

- `navigator.storage.persist()` respondeu **false** nos dois aparelhos: o armazenamento é "melhor esforço" e pode ser descartado pelo navegador; o item de dias sem abrir (ITP) segue no checklist manual.
- O runtime decide que está offline pela caixa **"Rede disponível"** do laboratório, não pela rede real do aparelho. A rede foi derrubada de verdade (`no-network`, conferida de dentro da página), mas a prova de que o app reage à queda real da rede (`navigator.onLine` e falha de `fetch`) não vem desta suíte.
- Essa execução ainda apagava os dados do site entre os fluxos 1 e 2 (ver Limites). Depois da correção do laboratório, o fluxo 2 não apaga mais; a reexecução em aparelho real está no registro de 19/10/2026, logo abaixo; nem ela nem este 18/18 são a prova final do Gate; a prova final é o registro de 19/10/2026 mais abaixo ("Registro da prova final").

### Registro da reexecução de 19/10/2026 (depois da correção do laboratório)

Uma única execução completa (`partial: false`, de 04:11:29Z a 04:16:20Z, cerca de 4 min 51 s ao todo, os dois aparelhos em sequência) na `main` no commit `8a7bc54`, que já inclui a correção do laboratório (dono do aparelho por usuário) e a recusa do `sync.push` com lease de outro usuário (#154). Os fluxos 1 e 2 rodaram seguidos, no mesmo aparelho e na mesma origem, **sem apagar os dados do site entre eles**: a suíte só apaga os dados no começo do fluxo 1 (aparelho recém-instalado), e o fluxo 2 entra com outro usuário e o laboratório responde `deviceIsMine` falso (o aparelho é do usuário do fluxo 1), como o servidor real: o runtime descarta o aparelho e o lease lembrados, registra um aparelho novo para o segundo usuário e faz o bootstrap do servidor simulado da venda. Sem segunda tentativa. O `report.md` fica só na máquina de quem rodou; este é o resumo, sem credenciais e sem links da conta do BrowserStack.

| Aparelho | Navegador | Passos aprovados | Passos reprovados | Tempo |
| --- | --- | --- | --- | --- |
| iPhone 18 Pro Max, iOS 27 | Safari (Version/27.0) | 18/18 | 0 | 2 min 24 s de passos |
| Google Pixel 11 Pro, Android 17 | Chrome 152 | 18/18 | 0 | 1 min 27 s de passos |

Por fluxo, nos dois aparelhos: fluxo 1 (clientes) 7/7, fluxo 2 (venda, sem limpar os dados) 6/6, fluxo 3 (shell) 4/4 e encerramento 1/1.

**O que esta execução vale (e o que não vale).** Ela rodou o `OfflineRuntime` real no commit `8a7bc54`, **antes** do PR 149 (`0f5ca67`), que mudou o runtime a fundo (lease e namespace por usuário, `stillMine` sem falha aberta, esquecer lease e apagar coleções na sessão recusada). Por isso ela prova o laboratório corrigido e o comportamento do aparelho (OPFS, IndexedDB, outbox, service worker, sem rede) **até `8a7bc54`**; não prova o runtime de hoje e **não vale como prova final do Gate 5** (a prova final é o registro seguinte).

**Pendência (cumprida em 19/10/2026, ver o registro da prova final abaixo):** a prova final era **uma nova execução da suíte no BrowserStack depois do merge da revogação de aparelho (t056)**, a última mudança do runtime antes de ligar o offline (decisão do Arrascaeta). Até ela passar nos dois aparelhos, o Gate 5 não fecha; se outra mudança tocar o runtime antes do merge da t056, a execução espera por ela também.

- `navigator.storage.persist()` respondeu **false** nos dois aparelhos, como em 18/10: o armazenamento segue "melhor esforço"; o item de dias sem abrir (ITP) continua no checklist manual.
- O relatório não informa os minutos de BrowserStack consumidos; o tempo de relógio da execução (cerca de 5 min, duas sessões) é o que se tem. O consumo exato está no painel da conta, que exige login.
- O `User-Agent` informado pelos navegadores é reduzido (o Safari diz "iPhone OS 18_7" com `Version/27.0`; o Chrome diz "Android 10"), então a versão do sistema vem do nome do aparelho no BrowserStack, não do `User-Agent`.
- Valem as mesmas limitações de 18/10: o runtime lê a caixa "Rede disponível" do laboratório, o servidor é simulado na página, e instalar na tela inicial, relógio, modo avião real e ITP seguem no checklist manual. A troca de usuário **sem rede** foi corrigida depois desta execução (PR 149, ver Limites), então esta prova não a cobre.

### Registro da prova final de 19/10/2026 (runtime atual)

Uma única execução completa (`partial: false`, de 07:45:19Z a 07:50:02Z, cerca de 4 min 43 s ao todo, os dois aparelhos em sequência, sem segunda tentativa) na `main` no commit `29aec22`, que já inclui o PR 149 (lease e namespace por usuário), o PR 154 (`session_changed`) e o PR 157 (revogar um aparelho encerra as sessões dele, `device.check` no runtime). É a prova final do Gate 5 decidida pelo Arrascaeta, sobre o runtime da `main` nesse commit. A suíte e o app rodaram sem nenhum ajuste, mas a suíte de aparelho real **não carrega** o `device.check` nem o `session_changed`: o laboratório entrega ao runtime uma API falsa (`deviceIsMine` decidido pela página, `sessionUserId` sem rede, `push` direto no servidor simulado), então o `createRpcRuntimeApi` (get-session, `device.check`, `sync.push`) não roda nela. Esses caminhos são cobertos pelo e2e `e2e/offline-runtime-api.e2e.ts` (app real, servidor interceptado), no job de navegador do CI. Os fluxos 1 e 2 rodaram seguidos, no mesmo aparelho e na mesma origem, **sem apagar os dados do site entre eles** (a suíte só apaga no começo do fluxo 1; o fluxo 2 entra com outro usuário). O `report.md` fica só na máquina de quem rodou; este é o resumo, sem credenciais e sem links da conta do BrowserStack.

| Aparelho | Navegador | Passos aprovados | Passos reprovados | Tempo |
| --- | --- | --- | --- | --- |
| iPhone 18 Pro Max, iOS 27 | Safari (Version/27.0) | 18/18 | 0 | 2 min 16 s de passos |
| Google Pixel 11 Pro, Android 17 | Chrome 152 | 18/18 | 0 | 1 min 27 s de passos |

Por fluxo, nos dois aparelhos: fluxo 1 (clientes) 7/7, fluxo 2 (venda, sem limpar os dados) 6/6, fluxo 3 (shell) 4/4 e encerramento 1/1.

- `navigator.storage.persist()` respondeu **false** nos dois aparelhos, como nas execuções anteriores: o armazenamento segue "melhor esforço"; o item de dias sem abrir (ITP) continua no checklist manual.
- O relatório não informa os minutos de BrowserStack consumidos; o tempo de relógio (cerca de 5 min, duas sessões) é o que se tem. O consumo exato está no painel da conta, que exige login.
- Valem as limitações de sempre: o runtime lê a caixa "Rede disponível" do laboratório, o servidor é simulado na página (não prova API, Neon nem RLS), e instalar na tela inicial, relógio, modo avião real e ITP seguem no checklist manual. A suíte não exercita a revogação nem o `device.check` contra servidor real: isso continua nos gates de banco e no item "Revogar um aparelho perdido" do checklist manual.
- Esta execução substitui a pendência do registro anterior: a prova do aparelho real sobre o runtime atual passou nos dois aparelhos. O Gate 5 só fecha com o checklist manual abaixo, que segue bloqueando ligar a escrita offline em produção. Além disso, ligar a escrita offline depende da tela de entrada (`/entrar`) e da tela de aparelhos com "encerrar as outras sessões", que ainda não estão montadas: vários itens do checklist (abrir o app sem rede, "Sair", revogar um aparelho perdido) só podem ser executados depois delas.

### Como o BrowserStack foi escolhido (fontes consultadas em 18/10/2026)

- [Playwright em iOS real](https://www.browserstack.com/docs/automate/playwright/playwright-ios/nodejs) existe (Safari, SDK Node.js, Playwright 1.50.1 ou mais novo), mas no Android real o Playwright só aparece até a versão 1.59 na [tabela de versões](https://www.browserstack.com/docs/automate/playwright/browsers-and-os) e o repositório usa 1.63. Por isso a suíte usa WebDriver (WebdriverIO), igual nas duas plataformas.
- [Rede simulada em Automate](https://www.browserstack.com/docs/automate/selenium/simulate-network-conditions): `networkProfile` com `no-network` em Android e iPhone (iOS 11 ou 13 em diante, a página diverge), troca durante a sessão por `update_network.json`.
- [BrowserStack Local com WebdriverIO](https://www.browserstack.com/docs/automate/selenium/getting-started/nodejs/webdriverio/local-testing): no Safari de aparelhos iOS reais as URLs com `localhost` são redirecionadas para `bs-local.com`. [Parâmetros do binário](https://www.browserstack.com/docs/local-testing/binary-params): `--key`, `--local-identifier`, `--only-automate`.

## Checklist manual em aparelho físico (adiado; bloqueia ligar a escrita offline)

> Pré-requisitos para executar este checklist: staging no ar, tela de entrada (`/entrar`) e tela de aparelhos montadas, e a chave `VITE_OFFLINE_RUNTIME_ENABLED=true` no build de staging.

A suíte acima já exercita, em iPhone e Android reais e sem dados reais, o armazenamento (OPFS e IndexedDB), o outbox, a venda e o cadastro sem rede, o reinício da página e o shell offline; o que ela não cobre (instalação na tela inicial, servidor real em staging, relógio, ITP) segue abaixo. Nada desta lista foi marcado como executado. Registre o resultado de cada item com a versão do navegador e do sistema, sem dados reais de clientes.

- [ ] **iPhone real (Safari, e instalado na tela inicial como PWA):** abrir o laboratório offline de persistência, o do outbox e o das coleções locais; confirmar que OPFS e IndexedDB funcionam, que `navigator.storage.persist()` responde e que o armazenamento não é descartado após dias sem uso (política do ITP do Safari para sites não instalados).
- [ ] **Android real (Chrome):** os mesmos laboratórios, e o ciclo completo: criar cliente, produto com estoque, entrada, venda e contagem sem rede; religar a rede; conferir o resultado no servidor.
- [ ] **Telas de clientes e produtos com a chave ligada (build de staging com `VITE_OFFLINE_RUNTIME_ENABLED=true`):** cadastrar um cliente e um produto em modo avião, ver o selo "Aguardando envio", fechar e reabrir o app ainda sem rede (os dois continuam na lista), religar a rede e conferir que o selo some e o servidor tem os dois; tentar arquivar um deles em modo avião (botão desabilitado, com a razão no cartão).
- [ ] **Edição de cliente sem conexão (staging, chave ligada):** em modo avião corrigir o telefone de um cliente já cadastrado e ver "Alteração aguardando envio"; religar a rede e conferir no servidor a versão nova e o selo sumindo; repetir editando o mesmo cliente por outro aparelho com este sem rede e ver, ao religar, "Alteração recusada pelo servidor" e, em Pendências, só "Descartar", com o cadastro do outro aparelho intacto.
- [ ] **Venda de cartão com perfil sem conexão (staging, chave ligada):** abrir a tela de venda com conexão (para guardar os perfis), em modo avião vender no cartão escolhendo o perfil, religar a rede e conferir no servidor que a venda registrou o perfil e a versão; repetir depois de alterar o perfil no servidor com o aparelho sem rede e ver a recusa em Pendências e o "Reenviar sem perfil de pagamento".
- [ ] **Revogar um aparelho perdido (staging, chave ligada):** com dois aparelhos registrados na mesma conta, revogar um pelo outro na tela Aparelhos; a sessão do revogado cai (401) desde o PR 157: ao reconectar ele vai para a tela de entrada, os comandos guardados ficam no aparelho e são recusados no envio; conferir que as autorizações offline foram canceladas, que a sessão dele foi encerrada e que a revogação aparece na auditoria (`device_revoked`).
- [ ] **Abrir o app sem rede (staging, chave ligada):** entrar e abrir o app com rede; fechar; em modo avião abrir de novo (também com o app instalado na tela inicial): a organização aparece e as telas de clientes, produtos, venda e estoque abrem do aparelho; "Sair" e abrir de novo sem rede mostra que não foi possível carregar (a cópia foi apagada).
- [ ] **Venda e estoque sem conexão com a chave ligada (staging):** em modo avião, vender dois itens (com um preço negociado) e ver "Venda guardada neste aparelho" e o saldo do aparelho descer; receber estoque de um item; religar a rede e conferir no servidor a venda confirmada, o movimento e o saldo final; repetir com um item cujo saldo no aparelho não cobre e ver a recusa em Pendências; conferir que, com rede, o botão da venda é "Confirmar venda".
- [ ] **Shell offline (PR60):** instalar o app, ativar o modo avião e abrir de novo: o shell abre, inclusive numa rota interna; no iPhone, repetir com o app instalado na tela inicial e depois de alguns dias sem abrir.
- [ ] **Atualização do app (PR61):** publicar uma build nova em staging com a anterior aberta num aparelho; o aviso aparece sem recarregar a página; com operações na fila, "Enviar e atualizar" envia antes e só recarrega com a fila vazia; sem rede, a atualização fica para depois e nada se perde.
- [ ] **Matar e reabrir o app** no meio de um envio (modo avião durante a sincronização): a fila volta inteira, o comando `sending` é reenviado e confirmado uma vez.
- [ ] **Duas abas** do mesmo usuário e organização: a fila e as coleções são as mesmas; um comando não é enviado duas vezes.
- [ ] **Sessão trocada:** a pessoa A deixa operações guardadas no aparelho e a sessão passa a ser de B (B entra no mesmo aparelho, sem A sair); B não vê nenhum dado de A (clientes, produtos, vendas, fila), nada de A é enviado como se fosse de B, e a fila de A fica guardada: quando A entra de novo, os comandos dela seguem com os mesmos IDs.
- [ ] **Sair com pendências** no aparelho: bloqueia, oferece tentar de novo e descartar em duas etapas; depois de sair, os dados locais da organização somem.
- [ ] **Relógio do aparelho** adiantado e atrasado em horas: comandos com instante de criação fora do lease são recusados com `invalid_creation_time` e a venda não é perdida.

## Ordem de publicação

O servidor vai ao ar antes do app que usa um campo novo de comando: o payload da venda é estrito e um app mais novo que o servidor tem a venda recusada (`invalid_payload`). Nunca remova nem reinterprete um campo de comando; o arquivo dourado de payloads falha quando um construtor muda.

O controle de aceite legal do servidor (`LEGAL_ACCEPTANCE_ENFORCED`, [ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md)) é o contrário: o **cliente** com o ramo que trata `data.reason` antes de `isSessionRefusal` vai antes, e a flag só liga depois do prazo de atualização do service worker; a flag offline segue desligada em produção até lá ([item 19 do checklist de release](./release-checklist.md#19-ordem-do-controle-de-aceite-legal-cliente-primeiro-flag-depois-block)).

## Rollback ou forward-fix

Os gates não alteram recursos persistentes: use apenas a branch descartável própria e apague-a ao final (`neon branches delete <nome> --project-id green-tooth-16857010 --profile junior-pessoal`). Uma falha de gate é corrigida com um commit novo; nunca com reset ou force-push.

## Escalonamento

Responsável pelo projeto. Uma falha em qualquer critério acima impede ligar a escrita offline; a leitura offline (coleções locais) pode seguir independentemente.
