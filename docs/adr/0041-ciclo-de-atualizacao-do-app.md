---
status: accepted
---

# Ciclo de atualização do app: avisar, enviar a fila primeiro e nunca recarregar à força

## Contexto

O service worker (ADR 0040) instala uma build nova ao lado da que está em uso e a deixa esperando. O PR61 do plano define os dois casos, atualização disponível com o outbox vazio e com comandos pendentes, e proíbe o recarregamento automático destrutivo. Atualizar troca os arquivos sob o app, e os comandos da fila foram feitos pela versão que está rodando; uma versão nova pode lê-los de outro jeito.

## Decisão

- **Quatro ofertas, decididas por uma função pura** (`offerFor`, `pwa/update-model.ts`): sem build esperando, nada; esperando e fila vazia, "pronta" (a pessoa atualiza quando quiser); esperando e fila com trabalho sem recusa, "enviar primeiro e depois atualizar"; esperando e com algo recusado, "adiada" até a pessoa resolver as recusas no painel de atenção (ADR 0038), porque a recusa trava a fila e ela não pode esvaziar.
- **Nunca se atualiza por cima de trabalho na fila.** `applyWhenSafe` lê a fila; com trabalho, envia (`sync`), lê de novo e só aplica se a fila ficou vazia; sem rede, ou com uma recusa, a atualização fica para depois com uma mensagem clara e nada se perde. Não há botão que atualize apesar da fila: a atualização sempre pode esperar mais um dia, e a fila durável sobreviveria a um recarregamento, mas não há garantia de que uma versão nova a entenda.
- **Nunca automático.** O app só avisa (`UpdateBanner`, com `role="status"`); o worker novo assume por `SKIP_WAITING` pedido pela página ao clicar, e a página recarrega uma única vez no `controllerchange`, mesmo que o evento chegue várias vezes. Enquanto isso o app em uso continua exatamente como está, com os arquivos da build dele (as páginas abertas mantêm o cache que combina com elas). A primeira instalação não é anunciada como atualização (só conta quando a página já é controlada por um worker).
- **Procura de builds novas** ao voltar para o app (`visibilitychange`) e a cada hora, com `registration.update()`, além da verificação que o navegador já faz a cada navegação.
- **A fila entra por uma interface** (`PendingWorkSource`: ler contagens e enviar). Hoje o padrão é ocioso (o app ainda não monta o outbox); quando a interface offline for montada, ela chama `getUpdateStore()?.setWorkSource(...)` com o outbox e o `syncOutbox`, e o aviso passa a refletir a fila sem mudar mais nada. O aviso reconsulta a fila a cada 15 segundos enquanto há uma build esperando.
- **Provas.** Testes da decisão, do envio seguro (vazia, envia e aplica, não limpou, sem rede, recusa), do controlador (build já esperando, instalação durante o uso, primeira instalação, recarga única), da store e do aviso renderizado. Em navegador real (Chromium desktop e Pixel 5 emulado, CI), com duas builds de verdade do mesmo app (a segunda com um marcador no `index.html`) servidas pelo mesmo servidor: a build nova vira um aviso sem recarregar a página; só troca quando se clica; ficam os caches das duas builds; e a primeira instalação não aparece como atualização.

## Consequências

- O app em uso nunca muda de arquivos sem pedido; o custo é que quem nunca clica continua na versão antiga até fechar todas as abas (quando o worker novo assume sozinho). A versão antiga continua funcionando contra o servidor porque o contrato é aditivo; uma mudança que quebre a compatibilidade precisa de um aviso próprio.
- Uma recusa pendente adia a atualização indefinidamente; o aviso diz por quê e aponta o painel de atenção.
- O worker de desfazer (se um dia for preciso reverter o PWA) precisa publicar um `sw.js` que se desregistre; não está incluído.

## Alternativas rejeitadas

- **Recarregar sozinho quando a fila está vazia:** perderia formulários em edição e surpreenderia a pessoa no meio de uma venda.
- **Atualizar com a fila cheia depois de um "tem certeza":** troca a versão sob comandos que ela não leu; o adiamento é barato e o erro, não.
- **Atualização silenciosa na próxima abertura:** é o comportamento natural do navegador quando todas as abas fecham, e já acontece sem código nosso.

## Emenda (25/10/2026): várias abas e "Tentar novamente" de um chunk que não baixou

Achados do staging em 24/10/2026 (t344):

- **"Atualizar agora" com várias abas.** O worker novo podia ficar em `waiting` sem `controllerchange`, e o botão ficava cinza para sempre. Agora a aba que pediu manda `SKIP_WAITING` ao `registration.waiting`; se em 5 s nada acontecer, ela mesma recarrega (a navegação busca a build nova na rede) e o botão volta a ficar habilitado; se o worker em espera já foi ativado por outra aba (não há mais `waiting` no clique), recarrega na hora. As outras abas, que já tinham um controlador, seguem a troca: no `controllerchange` que elas não pediram, recarregam, **desde que a fila delas esteja vazia**. Com operação na fila (ou fila ilegível) a aba mantém a página que tem (os chunks dela continuam no cache da build anterior), pela regra de nunca trocar com trabalho na fila.
- **"Tentar novamente" da tela de erro.** O `React.lazy` guarda a promessa do `import()` que falhou, e o navegador guarda o módulo que falhou: pedir `import()` de novo não recupera. Quando o erro vem de baixar um pedaço da tela (`Failed to fetch dynamically imported module`, `error loading dynamically imported module`, `Importing a module script failed`, `ChunkLoadError`), o botão recarrega a página, uma vez por janela de 10 s (marca em `sessionStorage`; sem armazenamento disponível, não recarrega). Nos outros erros o botão recria o componente lazy (`lazyScreen`, nova chamada de `import()`) e renderiza de novo.
