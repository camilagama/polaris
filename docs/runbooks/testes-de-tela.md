# Verificações automáticas de tela

O que o revisor de UX acha medindo vira teste que falha no CI, sem IA. São seis verificações, mais um caso de controle para cada uma (um teste que injeta a falha e prova que a verificação a pega: verificação que nunca falha não prova nada). Este runbook diz o que cada uma mede, como rodar, como acrescentar uma tela e o que ela ainda não cobre.

## O que roda e onde

| # | Verificação | Onde | Como mede |
|---|---|---|---|
| 1 | Nada sai do contêiner | `apps/web/e2e-pwa/ui-guardrails.e2e.ts` | Sem rolagem lateral da página; nenhum elemento passa da tela nem da caixa do pai; nenhuma linha de texto passa da borda do bloco (palavra longa que não quebra). Contêiner que rola (`overflow-x: auto` ou `scroll`) ou corta com reticências é dono do que tem dentro; `overflow: hidden` não: ele só esconde a falha. |
| 2 | Alvo de toque | idem, só em contexto com toque | Todo controle (botão, link, campo, caixa, rádio, `role=button` etc.) tem área de toque de pelo menos 48 px nas telas migradas e 44 px nas antigas: a caixa mais o maior entre `::before` e `::after` (`touch-hit`), e o campo de texto vale pela área do seu `InputGroup`. As áreas de dois controles vizinhos não podem se sobrepor (os botões de um mesmo `ButtonGroup` são uma peça só). Link no meio de uma linha de texto fica isento do tamanho (WCAG 2.5.8), nunca da sobreposição. |
| 3 | Contraste e acessibilidade | idem | axe-core com as regras WCAG 2.2 A e AA, nos dois temas. |
| 4 | Só OKLCH e só tokens | `apps/web/scripts/ui-source-rules.test.ts` (Vitest) | Reprova `#hex`, `rgb(`, `hsl(`, cor por nome, classe da paleta do Tailwind (`bg-white`, `text-red-500`) e `oklch(…)` literal fora de `src/styles/theme.css`, em `src/ui`, `src/styles` e nas pastas das telas migradas. |
| 5 | Movimento | os dois | Fonte: reprova `zoom-*`, `slide-*`, `translate`, `scale` e `rotate` em estado de entrada ou saída (a exceção é o deslize do gesto de dispensar o aviso, `data-[swipe-direction=…]`) e qualquer `animate-*` que não seja desvanecer. Navegador: um gravador registra toda animação; nenhuma sobreposição (diálogo, popover, menu, seletor, tooltip, aviso) muda `transform`, `translate`, `scale` ou `rotate` ao abrir ou fechar, e com `prefers-reduced-motion: reduce` nada dura mais que um piscar (1 ms) nem se repete. |
| 6 | Foco | `ui-guardrails.e2e.ts` | Percorre a tela com Tab no teclado de verdade: cada parada mostra o contorno de 3 px (`focus-ring`) ou, em campo de texto, o halo de 3 px do anel, no próprio controle ou no grupo que o contém; e todo controle que a página deixa na ordem de Tab é alcançado. A medida espera as transições de 140 ms terminarem. |

As telas são medidas a **320, 360 e 1280 px**, nos temas **claro e escuro**; a 1280 px roda uma vez com mouse e outra com toque (tablet), que é quando as áreas de 48 px existem (`pointer: coarse`). Os testes de navegador rodam só no projeto `chromium-desktop` (cada contexto fixa o próprio tamanho e o toque; o projeto Pixel 5 repetiria a conta) e entram no `bun run test:pwa`, que já é um passo do CI.

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

1. **A tela precisa abrir no build `pwa-e2e` sem servidor** (servido por `scripts/serve-static.mjs`, sob o CSP do `_headers`): uma rota que não chame `/rpc` nem `/api`, ou um estado que o teste consiga montar. Tela que depende de sessão entra pelo e2e real, e a galeria (`/ui-galeria`) é onde o componente novo aparece primeiro.
2. **Registrar em `apps/web/e2e-pwa/ui-screens.ts`**, um item de `SCREENS`:
   - `name`: o nome que aparece no teste;
   - `open(page, context)`: navega e espera a tela desenhada (título, texto principal, `document.fonts.ready`). Um estado diferente (vazio, erro, sem conexão) é outro item com o mesmo `path` e o seu `open`; sem conexão, abra a tela e chame `context.setOffline(true)` depois;
   - `exercise(page)`, se a tela tem sobreposição: abre e fecha cada uma pela interface (veja `exerciseGallery` em `ui-screens.ts`), para o gravador de movimento enxergá-las;
   - `status`: `"migrated"` (tela da interface nova, área de 48 px) ou `"legacy"` (CSS antigo, 44 px);
   - `sourceDirs`: pastas de `src/` da tela migrada (as regras de fonte leem estas pastas); `[]` na antiga.
3. **Tela migrada passa limpa.** Se a verificação acha uma falha de verdade, corrija a tela; não há `known` para tela migrada (o teste de fonte reprova).
4. **Tela antiga que ainda falha** lista a falha em `known`, por verificação, com o texto exato que o teste imprime e um comentário com o motivo e quando sai (a migração da tela). O teste exige que o que o navegador acha seja exatamente a lista: falha nova reprova, falha corrigida e ainda listada também. Não use `known` para esconder falha de tela nova.
5. **CSS novo de tela migrada**: a pasta entra em `@source` de `src/styles/index.css` e em `sourceDirs`; cor só por token; tela antiga não muda (capturas antes e depois no PR).
6. Rode as duas suítes acima e inclua o resultado na seção Verificação do PR.

Se a tela tem um padrão que a medida lê como falha de forma legítima (por exemplo um contêiner que corta de propósito), a saída certa é o jeito de marcar a intenção em CSS (`overflow-x: auto`, reticências) e não relaxar a medida; se a medida mesmo está errada, corrija em `ui-guardrails.ts` e acrescente o caso de controle que prova a correção.

## Casos de controle

Ficam no fim de `ui-guardrails.e2e.ts` (`controle: cada verificação pega a falha`) e na segunda metade de `ui-source-rules.test.ts`. Cada um injeta a falha (elemento mais largo que o cartão, link de 100% com padding, palavra longa, botão de 20 px, dois botões com áreas que se encontram, texto sem contraste, botão com `outline: none`, sobreposição que cresce, animação que ignora `reduce`, `#fff`, `bg-white`, `zoom-in-95`) e exige que a verificação a acuse; e põe ao lado o que não é falha (deslize do gesto, `oklch(0 0 0)` de máscara, `-translate-x-1/2` de centralização) e exige que passe.

## O que não cobre

- Só as telas que abrem sem servidor. As telas do app com sessão (Vender, Estoque, Clientes…) entram aqui quando migrarem e tiverem um estado montável; até lá, a medida vale para a galeria e para as telas de entrada e legais.
- Sobreposição aberta não passa pelas verificações 1, 2 e 3 (só pela 5): o diálogo aberto, por exemplo, não é medido em toque nem no axe. Para medir, `exercise` pode deixar a sobreposição aberta; hoje ela fecha antes.
- Contraste de texto sobre imagem e estados que só aparecem com dado real. O mapa de contraste dos tokens está em [docs/design/contraste-v5.1.md](../design/contraste-v5.1.md), conferido por `src/styles/contrast.test.ts`.
- Aparelho real: os testes emulam toque no Chromium. O teste em aparelho é só pelo BrowserStack, no passo próprio.
- O movimento mede a pose (transformações) das sobreposições, não a de todo elemento da tela: um `hover` que desloca um botão não é visto.
