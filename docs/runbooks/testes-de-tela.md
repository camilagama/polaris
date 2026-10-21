# Verificações automáticas de tela

O que o revisor de UX acha medindo vira teste que falha no CI, sem IA. São seis verificações, mais um caso de controle para cada uma (um teste que injeta a falha e prova que a verificação a pega: verificação que nunca falha não prova nada). Este runbook diz o que cada uma mede, como rodar, como acrescentar uma tela e o que ela ainda não cobre.

## O que roda e onde

| # | Verificação | Onde | Como mede |
|---|---|---|---|
| 1 | Nada sai do contêiner | `apps/web/e2e-pwa/ui-guardrails.e2e.ts` | Sem rolagem lateral da página; nenhum elemento passa da tela nem da caixa do pai; nenhuma linha de texto passa da borda do bloco (palavra longa que não quebra). Contêiner que rola (`overflow-x: auto` ou `scroll`) ou corta com reticências é dono do que tem dentro; `overflow: hidden` não: ele só esconde a falha. |
| 2 | Alvo de toque | idem, só em contexto com toque | Todo controle (botão, link, campo, caixa, rádio, `role=button` etc.) tem área de toque de pelo menos 48 px nas telas migradas e 44 px nas antigas: a caixa mais os pseudo-elementos `::before` e `::after` de conteúdo vazio e posição absoluta (`touch-hit`), e o campo de texto vale pela área do seu `InputGroup` (só o campo: um botão dentro do grupo vale pela própria caixa ou pelo seu `touch-hit`, e um de 20 px sem `touch-hit` reprova). As áreas de dois controles vizinhos não podem se sobrepor (os botões de um mesmo `ButtonGroup` são uma peça só, e o campo e o botão dentro do mesmo `InputGroup`, como o "Mostrar" da senha, também). Link com texto do próprio pai ao lado, numa linha de texto (não numa linha de controles), fica isento do tamanho (WCAG 2.5.8), nunca da sobreposição. |
| 3 | Contraste e acessibilidade | idem | axe-core com as regras WCAG 2.2 A e AA, nos dois temas. |
| 4 | Só OKLCH e só tokens | `apps/web/scripts/ui-source-rules.test.ts` (Vitest) | Reprova `#hex`, `rgb(`, `hsl(`, cor por nome, classe da paleta do Tailwind (`bg-white`, `text-red-500`) e `oklch(…)` literal fora de `src/styles/theme.css`, em `src/ui`, `src/styles` e nas pastas das telas migradas. |
| 5 | Movimento | os dois | Fonte: reprova `zoom-*`, `slide-*`, `translate`, `scale` e `rotate` em estado de entrada ou saída (a exceção é o deslize do gesto de dispensar o aviso, `data-[swipe-direction=…]`) e qualquer `animate-*` que não seja desvanecer. Navegador: um gravador registra toda animação; nenhuma sobreposição (diálogo, popover, menu, seletor, tooltip, aviso) muda `transform`, `translate`, `scale` ou `rotate` ao abrir ou fechar, e com `prefers-reduced-motion: reduce` nada dura mais que um piscar (1 ms) nem se repete. |
| 6 | Foco | `ui-guardrails.e2e.ts` | Percorre a tela com Tab no teclado de verdade: cada parada mostra o contorno de 3 px (`focus-ring`) ou, em campo de texto, o halo do anel (sombra sem deslocamento nem desfoque e com 3 px de espalhamento; uma sombra suave de cartão não vale), no próprio controle ou no grupo que o contém; e todo controle que a página deixa na ordem de Tab é alcançado. A medida espera as transições de 140 ms terminarem. |

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

# navegador (builda o pwa-e2e e serve em 4174; precisa do Node: ver a nota de máquina sem node)
cd apps/web
bunx playwright test --config playwright.pwa.config.ts --project=chromium-desktop ui-guardrails
# uma tela, um tema: -g "galeria · 360 px · com toque · tema escuro"
```

Uma falha diz a verificação (`1. nada sai do contêiner`, `2. área de toque`, `3. axe`, `6. foco de 3 px`), o elemento e a medida. A de movimento diz as poses (`transform`, `translate`, `scale`, `rotate`) por que a sobreposição passou.

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
7. Rode as duas suítes acima e inclua o resultado na seção Verificação do PR.

Se a tela tem um padrão que a medida lê como falha de forma legítima (por exemplo um contêiner que corta de propósito), a saída certa é o jeito de marcar a intenção em CSS (`overflow-x: auto`, reticências) e não relaxar a medida; se a medida mesmo está errada, corrija em `ui-guardrails.ts` e acrescente o caso de controle que prova a correção.

## Casos de controle

Ficam no fim de `ui-guardrails.e2e.ts` (`controle: cada verificação pega a falha`) e na segunda metade de `ui-source-rules.test.ts`. Cada um injeta a falha (elemento mais largo que o cartão, link de 100% com padding, palavra longa, botão de 20 px, dois botões com áreas que se encontram, texto sem contraste, botão com `outline: none`, sobreposição que cresce, animação que ignora `reduce`, `#fff`, `bg-white`, `zoom-in-95`) e exige que a verificação a acuse; e põe ao lado o que não é falha (o botão dentro de um campo, deslize do gesto, `oklch(0 0 0)` de máscara, `-translate-x-1/2` de centralização) e exige que passe.

## O que não cobre

- Os eixos que o mapa não combina: o tema escuro só passa pelo axe (e o movimento não o vê); o axe só roda a 360 px, não a 320 nem a 1280; o contêiner não é medido no escuro nem a 1280 com toque; o foco só roda a 1280 com mouse, não a 320 nem a 360; o movimento só roda a 360. Um defeito que só aparece nesses cruzamentos (por exemplo um estouro de largura que depende do tema) não é visto: acrescente o contexto à verificação, com caso de controle. Uma matriz cheia numa rotina à parte (noturna) não existe; se for preciso, é decisão do Arrascaeta e mexe nos workflows do CI.
- Só as telas que abrem sem servidor ou no laboratório das telas. A Venda entra em seis estados (vazia, com itens, pagamento a crédito, erro nos campos, confirmada, sem conexão); as telas de senha (`/entrar`, `/criar-conta`, "Confirme seu e-mail", `/confirmar-email`, `/esqueci-a-senha`, `/redefinir-senha`, `/desbloquear` e "Trocar senha") em 54 estados, com o servidor de auth e o script do Turnstile respondidos pelo teste (`e2e-pwa/ui-entry-states.ts` e `ui-password-states.ts`; "Trocar senha" abre no laboratório das telas, `?screen=change-password`; ficam de fora os estados de passagem, como "Tentando…"); Produtos em três estados no laboratório das telas com o catálogo de exemplo (`&catalog=seeded`: a lista, com o menu de uma linha aberto e fechado para o movimento; a edição com o erro no nome; as variantes com as opções e uma combinação; `e2e-pwa/ui-product-states.ts`): cada estado do laboratório liga o runtime offline em todos os contextos do mapa, e o job do CI tem 30 minutos, então os demais (vazia, arquivados, busca sem resultado, variantes configuradas, sem conexão) ficam no e2e da tela; as outras telas do app com sessão (Estoque, Clientes…) entram quando migrarem e tiverem um estado montável. Os estados de erro de servidor e de carregamento da Venda e de Produtos não estão na lista (o laboratório sempre tem as coleções do aparelho); os de Produtos são provados em `e2e/products-screen.e2e.ts`, com a API respondida pelo teste.
- A barra com o total da Venda é presa ao fim da tela (`sticky`) e flutua sobre os controles de baixo: o estado termina com a página rolada até o fim, onde a barra descansa no fim do formulário; em outra posição a área de toque dos controles sob a barra encontra a do botão, por desenho.
- A volta de Tab parte do alto da página (um elemento focado ali e removido), mesmo depois de cliques no meio dela, e um campo de várias partes (`datetime-local`, que tem sete paradas no mesmo elemento) não encerra a volta.
- Sobreposição aberta não passa pelas verificações 1, 2 e 3 (só pela 5): o diálogo aberto, por exemplo, não é medido em toque nem no axe. Para medir, `exercise` pode deixar a sobreposição aberta; hoje ela fecha antes.
- Contêiner de rolagem vertical: o navegador calcula `overflow-x: auto` quando só `overflow-y: auto` foi escrito, e a medida trata esse contêiner como dono do que tem dentro. Um filho largo demais dentro de uma lista rolável só na vertical não é visto pela verificação 1. Quem escreve esse contêiner deve declarar `overflow-x: hidden` se não quer rolagem lateral, e a verificação passa a olhar o filho.
- Contraste de texto sobre imagem e estados que só aparecem com dado real. O mapa de contraste dos tokens está em [docs/design/contraste-v5.1.md](../design/contraste-v5.1.md), conferido por `src/styles/contrast.test.ts`.
- Aparelho real: os testes emulam toque no Chromium. O teste em aparelho é só pelo BrowserStack, no passo próprio.
- O movimento mede a pose (transformações) das sobreposições, não a de todo elemento da tela: um `hover` que desloca um botão não é visto. A regra de fonte lê só variantes de entrada e saída (`data-open`, `data-closed`, `data-starting-style`, `data-ending-style`, `in`, `out`, `starting`) e `animate-*`; um `rotate` de estado (seta que gira com `aria-expanded`) não é lido, e `@keyframes` só é lido em CSS novo (as folhas do tokens e a do shadcn podem defini-los).
- A regra de cor lê o texto: `style={{ color: someVar }}` com valor calculado e cor montada em tempo de execução não passam por ela. Ela pega o hex, `rgb(`, `hsl(`, `color(`, cor por nome (as 148 do CSS), classe da paleta do Tailwind (com `!` e com `/[…]`) e `oklch(…)` literal fora de `theme.css`.
