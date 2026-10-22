# Verificações automáticas de tela

O que o revisor de UX acha medindo vira teste que falha no CI, sem IA. São sete verificações, mais um caso de controle para cada uma (um teste que injeta a falha e prova que a verificação a pega: verificação que nunca falha não prova nada). Este runbook diz o que cada uma mede, como rodar, como acrescentar uma tela e o que ela ainda não cobre.

## O que roda e onde

| # | Verificação | Onde | Como mede |
|---|---|---|---|
| 1 | Nada sai do contêiner | `apps/web/e2e-pwa/ui-guardrails.e2e.ts` | Sem rolagem lateral da página; nenhum elemento passa da tela nem da caixa do pai; nenhuma linha de texto passa da borda do bloco (palavra longa que não quebra). Contêiner que rola (`overflow-x: auto` ou `scroll`) ou corta com reticências é dono do que tem dentro; `overflow: hidden` não: ele só esconde a falha. |
| 2 | Alvo de toque | idem, só em contexto com toque | Todo controle (botão, link, campo, caixa, rádio, `role=button` etc.) tem área de toque de pelo menos 48 px nas telas migradas e 44 px nas antigas: a caixa mais os pseudo-elementos `::before` e `::after` de conteúdo vazio e posição absoluta (`touch-hit`), e o campo de texto vale pela área do seu `InputGroup` (só o campo: um botão dentro do grupo vale pela própria caixa ou pelo seu `touch-hit`, e um de 20 px sem `touch-hit` reprova). As áreas de dois controles vizinhos não podem se sobrepor (os botões de um mesmo `ButtonGroup` são uma peça só, e o campo e o botão dentro do mesmo `InputGroup`, como o "Mostrar" da senha, também). Link com texto do próprio pai ao lado, numa linha de texto (não numa linha de controles), fica isento do tamanho (WCAG 2.5.8), nunca da sobreposição. |
| 3 | Contraste e acessibilidade | idem | axe-core com as regras WCAG 2.2 A e AA, nos dois temas. |
| 4 | Só OKLCH e só tokens | `apps/web/scripts/ui-source-rules.test.ts` (Vitest) | Reprova `#hex`, `rgb(`, `hsl(`, cor por nome, classe da paleta do Tailwind (`bg-white`, `text-red-500`) e `oklch(…)` literal fora de `src/styles/theme.css`, em `src/ui`, `src/styles` e nas pastas das telas migradas. |
| 5 | Movimento | os dois | Fonte: reprova `zoom-*`, `slide-*`, `translate`, `scale` e `rotate` em estado de entrada ou saída (a exceção é o deslize do gesto de dispensar o aviso, `data-[swipe-direction=…]`) e qualquer `animate-*` que não seja desvanecer. Navegador: um gravador registra toda animação; nenhuma sobreposição (diálogo, popover, menu, seletor, tooltip, aviso) muda `transform`, `translate`, `scale` ou `rotate` ao abrir ou fechar, e com `prefers-reduced-motion: reduce` nada dura mais que um piscar (1 ms) nem se repete. |
| 6 | Foco | `ui-guardrails.e2e.ts` | Percorre a tela com Tab no teclado de verdade: cada parada mostra o contorno de 3 px (`focus-ring`) ou, em campo de texto, o halo do anel (sombra sem deslocamento nem desfoque e com 3 px de espalhamento; uma sombra suave de cartão não vale), no próprio controle ou no grupo que o contém; e todo controle que a página deixa na ordem de Tab é alcançado. A medida espera as transições de 140 ms terminarem. |
| 7 | A camada `legacy` não alcança a tela migrada | `apps/web/e2e-pwa/ui-shell-isolation.e2e.ts` | Monta "Trocar senha", a Venda e Produtos (lista, menu de ações aberto, sem produto, formulário novo e com erro, busca sem resultado e variantes) **dentro do shell real** (`.ui-root`, sessão e organização respondidas pelo teste) e as telas `/entrar`, `/criar-conta`, `/esqueci-a-senha` e `/redefinir-senha`, mais uma sonda sob o shell (campo com erro, campo com texto de apoio, `select` e `textarea` nativos), e lê o estilo computado (caixa, borda, preenchimento, tipo, cor, posição, foco com Tab) de todo elemento sob `[data-ui]`, com a camada `legacy` na página e depois com ela tirada do CSSOM, sem transições (a leitura no meio de uma transição devolve o começo dela). Qualquer diferença é vazamento de CSS antigo (`.ui-root input`, `button` sem escopo, `:focus-visible`) e reprova, com o elemento, a propriedade e os dois valores. O laboratório das telas não serve de referência: ele não tem `.ui-root`. |

Cada verificação roda só nos eixos (largura, ponteiro, tema) que podem mudar o resultado dela. O mapa está em `CHECK_CONTEXTS`, em `apps/web/e2e-pwa/ui-screens.ts`, e `ui-guardrails.e2e.ts` gera os testes a partir dele:

| Verificação | Contextos | Por quê |
|---|---|---|
| 1. contêiner | 320, 360 (com toque) e 1280 (com mouse), tema claro | a largura decide o que cabe; tema e ponteiro não mexem em caixa |
| 2. toque | 320, 360 e 1280, todos com toque, tema claro | as áreas de 48 px só existem com `pointer: coarse` (celular e tablet) |
| 3. axe | 360 com toque, tema claro e escuro | o contraste é do tema; o celular é a largura mais apertada |
| 6. foco | 1280 com mouse, tema claro | o anel de foco aparece com o teclado, que é a tela larga |
| 5. movimento | uma vez por estado com `exercise` e uma vez com `reduce`, ambas em `MOTION_CONTEXT` (360, toque, claro) | a pose (`transform`) das sobreposições não deveria depender do contexto; o que protege contra `slide-*` e `zoom-*` em qualquer largura é o teste de fonte (verificação 5); o posicionamento do popover e do seletor (inversão por colisão) muda com a largura e não é medido aqui |
| 4. OKLCH e tokens | teste de código-fonte, sem contexto | lê o texto, não renderiza |

Um contexto que várias verificações usam é uma carga de página só: o teste dele roda todas e cada uma reporta a sua falha. Hoje são cinco contextos por estado, mais o teste de movimento e o de `reduce`, ou seja, 7 testes por estado com `exercise` e 6 sem (eram 24 e 16, da matriz inteira de 4 contextos por 2 temas). O custo do CI cresce com o número de contextos do mapa, não com o produto de larguras, temas e ponteiros. Os testes de navegador rodam só no projeto `chromium-desktop` (cada contexto fixa o próprio tamanho e o toque; o projeto Pixel 5 repetiria a conta) e entram no `bun run test:pwa`, que já é um passo do CI.

**Mudar um eixo.** Uma verificação nova, ou um eixo novo para uma que existe, é uma linha em `CHECK_CONTEXTS` (e a razão na tabela acima). Quem acrescenta um contexto paga em tempo de CI em todas as telas: diga o motivo no PR. A matriz cheia (todos os contextos em todas as verificações) não roda mais; se um defeito passar por um eixo que o mapa não cobre, o caminho é acrescentar o contexto à verificação que o acusaria, com um caso de controle, e não voltar à matriz inteira.

## Rodar

```bash
# fonte (rápido, sem navegador)
bunx vitest run --project node apps/web/scripts/ui-source-rules.test.ts

# navegador (builda o pwa-e2e e serve na porta de E2E_PWA_PORT, 4174 por padrão; precisa do Node: ver a nota de máquina sem node)
cd apps/web
bunx playwright test --config playwright.pwa.config.ts --project=chromium-desktop ui-guardrails
# uma tela, um tema: -g "galeria · 360 px · com toque · tema escuro"
# a camada legacy dentro do shell (verificação 7)
bunx playwright test --config playwright.pwa.config.ts --project=chromium-desktop ui-shell-isolation
```

Uma falha diz a verificação (`1. nada sai do contêiner`, `2. área de toque`, `3. axe`, `6. foco de 3 px`; a 7 diz o elemento, a propriedade e o valor com e sem a camada `legacy`), o elemento e a medida. A de movimento diz as poses (`transform`, `translate`, `scale`, `rotate`) por que a sobreposição passou.

## Duas sessões ao mesmo tempo

Os três configs de navegador de `apps/web` abrem o próprio servidor (build e serve). Duas sessões na mesma máquina, cada uma na sua árvore (`git worktree`), disputavam as portas fixas, e o servidor de uma era reaproveitado pela outra: o teste rodava contra o código errado e passava. Agora:

- **Fora do CI, servidor que já escuta não é reaproveitado.** O Playwright recusa a porta ocupada (`... is already used`) em vez de testar contra ele. `E2E_REUSE_SERVER=1` (configs `offline-poc` e `pwa`; o `e2e-real` nunca reaproveita) liga o reaproveitamento de propósito (iterar na mesma árvore, sem rebuild); nunca use com duas árvores. No CI nunca se reaproveita.
- **As portas vêm do ambiente, com o padrão de sempre** (o CI não muda):

  | Variável | Config | Padrão |
  |---|---|---|
  | `E2E_OFFLINE_POC_PORT` | `playwright.offline-poc.config.ts` (`vite preview`) | 4173 |
  | `E2E_PWA_PORT` | `playwright.pwa.config.ts` (`scripts/serve-static.mjs`) | 4174 |
  | `E2E_REAL_PORT_ONLINE`, `E2E_REAL_PORT_RUNTIME` | `playwright.e2e-real.config.ts` | 4321, 4322 |

  A segunda sessão escolhe portas livres, por exemplo `E2E_OFFLINE_POC_PORT=4273 E2E_PWA_PORT=4274 bun run test:offline-browser`. Os testes leem a mesma variável (`apps/web/e2e/run-settings.ts`), então a origem que eles conferem acompanha a porta. Os testes de atualização (`update*.e2e.ts`) não usam porta fixa: cada worker builda em `dist/pwa-e2e-update-<n>` e serve de um servidor em porta livre (`e2e-pwa/support.ts`).
- Cada árvore tem o próprio `dist` e o próprio `node_modules`; o que as sessões ainda dividem é a CPU. Servidor que sobrou de uma execução interrompida (um `timeout` que matou o Playwright e deixou o `vite preview`) continua escutando e faz a próxima falhar com a mensagem acima: ache o PID com `ss -ltnp | grep :<porta>` e encerre só o seu.

**Workers.** `E2E_WORKERS` define o número de workers dos configs `offline-poc` e `pwa` (no CI: 2 e 3; fora dele: 1 e 2). As verificações de tela só leem o build `pwa-e2e` e os testes do `offline-poc` usam um contexto de navegador por teste (OPFS e armazenamento próprios), então não dividem estado. Só os testes de atualização escrevem num build, e escrevem no próprio. Num teste novo que mude arquivo, porta ou estado do servidor compartilhado, dê a ele diretório e servidor próprios, como o `support.ts`, em vez de voltar a `workers: 1`.

## Acrescentar uma tela

1. **A tela precisa abrir no build `pwa-e2e` sem servidor** (servido por `scripts/serve-static.mjs`, sob o CSP do `_headers`): uma rota que não chame `/rpc` nem `/api`, ou um estado que o teste consiga montar. Tela que depende de sessão entra pelo laboratório das telas (`/offline-screens-lab?screen=…`, que o build `pwa-e2e` também traz, com o runtime offline ligado), com o servidor respondido por `page.route` e dados sintéticos; os controles do próprio laboratório ficam em `[data-lab-chrome]` e o estado os esconde no fim, para medir só a tela (a Venda: `e2e-pwa/ui-sale-states.ts`). A galeria (`/ui-galeria`) é onde o componente novo aparece primeiro. A galeria e o laboratório das telas são só do build de navegador: o `precacheBudgetPlugin` reprova o build de produção se o chunk de um deles (`ui-gallery-*.js`, `screens-lab-*.js`) entrar nele (`pwa/precache-budget.test.ts` tem o caso de controle).
2. **Registrar em `apps/web/e2e-pwa/ui-screens.ts`**, um item de `SCREENS`:
   - `name`: o nome que aparece no teste;
   - `open(page, context)`: navega e espera a tela desenhada (título, texto principal, `document.fonts.ready`). Um estado diferente (vazio, erro, sem conexão) é outro item da lista, que abre a mesma rota no seu `open`; sem conexão, abra a tela e chame `context.setOffline(true)` depois;
   - `exercise(page)`, se a tela tem sobreposição: abre e fecha cada uma pela interface (veja `exerciseGallery` em `ui-screens.ts`), para o gravador de movimento enxergá-las;
   - `status`: `"migrated"` (tela da interface nova, área de 48 px) ou `"legacy"` (CSS antigo, 44 px);
   - `sourceDirs`: pastas ou arquivos de `src/` da tela migrada (as regras de fonte leem estes caminhos; um arquivo serve quando a pasta mistura telas novas e antigas, como `src/sales`); `[]` na antiga.
3. **Tela migrada passa limpa.** Se a verificação acha uma falha de verdade, corrija a tela; não há `known` para tela migrada (o teste de fonte reprova).
4. **Tela antiga que ainda falha** lista a falha em `known`, por verificação, com o texto exato que o teste imprime e um comentário com o motivo e quando sai (a migração da tela). O teste exige que o que o navegador acha seja exatamente a lista: falha nova reprova, falha corrigida e ainda listada também. Não use `known` para esconder falha de tela nova.
5. **Os contextos já valem para a tela nova.** Ela entra no mapa sem declarar largura nem tema: cada item de `SCREENS` roda nos contextos de `CHECK_CONTEXTS`, e cada estado é um item (custa 6 ou 7 testes, ver acima). Não crie estado só para trocar de tema ou de largura: o mapa já faz isso.
6. **CSS novo de tela migrada**: a pasta entra em `@source` de `src/styles/index.css` e em `sourceDirs`; cor só por token; tela antiga não muda (capturas antes e depois no PR).
7. **Tela migrada que vive no shell antigo** (qualquer uma que abra dentro de `.ui-root`): acrescente-a a `SCREENS` de `e2e-pwa/ui-shell-isolation.e2e.ts`, aberta pela rota do app com a sessão respondida pelo teste (a verificação 7). Regra nova numa folha antiga que nomeie elemento ou `:focus-visible` sob `.ui-root` leva `:not(:where([data-ui] *))`.
8. Rode as suítes acima (fonte, navegador e a verificação 7) e inclua o resultado na seção Verificação do PR.

Se a tela tem um padrão que a medida lê como falha de forma legítima (por exemplo um contêiner que corta de propósito), a saída certa é o jeito de marcar a intenção em CSS (`overflow-x: auto`, reticências) e não relaxar a medida; se a medida mesmo está errada, corrija em `ui-guardrails.ts` e acrescente o caso de controle que prova a correção.

## Casos de controle

Ficam no fim de `ui-guardrails.e2e.ts` (`controle: cada verificação pega a falha`), na segunda metade de `ui-source-rules.test.ts` e, para a 7, em `ui-shell-isolation.e2e.ts` (injeta na camada `legacy` cada regra do `ui.css` que vazou, um `button` sem escopo e uma propriedade que transiciona, e exige a linha exata da diferença; uma regra antiga só para o cabeçalho e o rodapé do shell não reprova). Cada um injeta a falha (elemento mais largo que o cartão, link de 100% com padding, palavra longa, botão de 20 px, dois botões com áreas que se encontram, texto sem contraste, botão com `outline: none`, sobreposição que cresce, animação que ignora `reduce`, `#fff`, `bg-white`, `zoom-in-95`) e exige que a verificação a acuse; e põe ao lado o que não é falha (o botão dentro de um campo, deslize do gesto, `oklch(0 0 0)` de máscara, `-translate-x-1/2` de centralização) e exige que passe.

## O que não cobre

- A verificação 7 mede o estado em que a tela abre no shell (a Venda sem servidor, com o erro de variantes e a linha de item; "Trocar senha" pronta; Produtos com a API respondida pelo teste, sem o estado de carregando, só coberto por teste de componente, nem o de leitura que falhou, que fica em `e2e/products-screen.e2e.ts`). Estados que só existem com dado real (Venda confirmada, pagamento a crédito) não passam por ela: uma regra antiga que só os atinja (um seletor de classe, por exemplo) não é vista. As medidas de tamanho usado (`width`, `height`, `margin`) ficam de fora, porque seguem o contêiner, que o CSS antigo muda; `max-width`, `min-height`, `padding`, `gap`, `position` e `overflow` entram. As páginas "Confirme seu e-mail", `/confirmar-email` e `/desbloquear` não estão na lista (precisam de resposta do servidor); a entrada de uma delas é acrescentar o estado em `ENTRY_PAGES`. Tela migrada nova entra em `SCREENS` do arquivo, sem `known`.
- Os eixos que o mapa não combina: o tema escuro só passa pelo axe (e o movimento não o vê); o axe só roda a 360 px, não a 320 nem a 1280; o contêiner não é medido no escuro nem a 1280 com toque; o foco só roda a 1280 com mouse, não a 320 nem a 360; o movimento só roda a 360. Um defeito que só aparece nesses cruzamentos (por exemplo um estouro de largura que depende do tema) não é visto: acrescente o contexto à verificação, com caso de controle. Uma matriz cheia numa rotina à parte (noturna) não existe; se for preciso, é decisão do Arrascaeta e mexe nos workflows do CI.
- Só as telas que abrem sem servidor ou no laboratório das telas (Produtos no shell, com a API respondida pelo teste, é da verificação 7). A Venda entra em seis estados (vazia, com itens, pagamento a crédito, erro nos campos, confirmada, sem conexão); as telas de senha (`/entrar`, `/criar-conta`, "Confirme seu e-mail", `/confirmar-email`, `/esqueci-a-senha`, `/redefinir-senha`, `/desbloquear` e "Trocar senha") em 54 estados, com o servidor de auth e o script do Turnstile respondidos pelo teste (`e2e-pwa/ui-entry-states.ts` e `ui-password-states.ts`; "Trocar senha" abre no laboratório das telas, `?screen=change-password`; ficam de fora os estados de passagem, como "Tentando…"); Produtos em três estados no laboratório das telas com o catálogo de exemplo (`&catalog=seeded`: a lista, com o menu de uma linha aberto e fechado para o movimento; a edição com o erro no nome; as variantes com as opções e uma combinação; `e2e-pwa/ui-product-states.ts`): cada estado do laboratório liga o runtime offline em todos os contextos do mapa, e o job do CI tem 30 minutos, então os demais (vazia, arquivados, busca sem resultado, variantes configuradas, sem conexão) ficam no e2e da tela; as outras telas do app com sessão (Estoque, Clientes…) entram quando migrarem e tiverem um estado montável. Os estados de erro de servidor e de carregamento da Venda e de Produtos não estão na lista (o laboratório sempre tem as coleções do aparelho); os de Produtos são provados em `e2e/products-screen.e2e.ts`, com a API respondida pelo teste.
- A barra com o total da Venda é presa ao fim da tela (`sticky`) e flutua sobre os controles de baixo: o estado termina com a página rolada até o fim, onde a barra descansa no fim do formulário; em outra posição a área de toque dos controles sob a barra encontra a do botão, por desenho.
- A volta de Tab parte do alto da página (um elemento focado ali e removido), mesmo depois de cliques no meio dela, e um campo de várias partes (`datetime-local`, que tem sete paradas no mesmo elemento) não encerra a volta.
- Sobreposição aberta não passa pelas verificações 1, 2 e 3 (só pela 5): o diálogo aberto, por exemplo, não é medido em toque nem no axe. Para medir, `exercise` pode deixar a sobreposição aberta; hoje ela fecha antes.
- Contêiner de rolagem vertical: o navegador calcula `overflow-x: auto` quando só `overflow-y: auto` foi escrito, e a medida trata esse contêiner como dono do que tem dentro. Um filho largo demais dentro de uma lista rolável só na vertical não é visto pela verificação 1. Quem escreve esse contêiner deve declarar `overflow-x: hidden` se não quer rolagem lateral, e a verificação passa a olhar o filho.
- Contraste de texto sobre imagem e estados que só aparecem com dado real. O mapa de contraste dos tokens está em [docs/design/contraste-v5.1.md](../design/contraste-v5.1.md), conferido por `src/styles/contrast.test.ts`.
- Aparelho real: os testes emulam toque no Chromium. O teste em aparelho é só pelo BrowserStack, no passo próprio.
- O movimento mede a pose (transformações) das sobreposições, não a de todo elemento da tela: um `hover` que desloca um botão não é visto. A regra de fonte lê só variantes de entrada e saída (`data-open`, `data-closed`, `data-starting-style`, `data-ending-style`, `in`, `out`, `starting`) e `animate-*`; um `rotate` de estado (seta que gira com `aria-expanded`) não é lido, e `@keyframes` só é lido em CSS novo (as folhas do tokens e a do shadcn podem defini-los).
- A regra de cor lê o texto: `style={{ color: someVar }}` com valor calculado e cor montada em tempo de execução não passam por ela. Ela pega o hex, `rgb(`, `hsl(`, `color(`, cor por nome (as 148 do CSS), classe da paleta do Tailwind (com `!` e com `/[…]`) e `oklch(…)` literal fora de `theme.css`.
