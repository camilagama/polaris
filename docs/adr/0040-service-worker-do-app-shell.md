---
status: accepted
---

# Service worker do app shell: abrir offline sem guardar dados de tenant

## Contexto

O PR60 do plano pede o app shell, a navegação offline e o versionamento de assets, e proíbe armazenar a API de tenant genérica no Cache Storage. Os dados que um aparelho mantém offline já têm casa própria: o banco local e o outbox (ADR 0015). Falta apenas o que abre o app sem rede: o HTML, o JavaScript e o CSS. O app é servido por Workers Static Assets (fallback de página única) e as rotas do Worker (`/rpc/*`, `/api/*`, `/health`, `/ready`) rodam antes dos assets.

## Decisão

- **O worker faz três coisas e só elas** (`src/pwa/sw.ts`): pré-guarda o shell desta build, responde navegações com a rede quando ela responde e com o shell guardado quando não, e serve os arquivos pré-guardados primeiro do cache. Tudo o mais é ignorado: o worker nem chega a ver `/rpc/*`, `/api/*`, `/health` e `/ready`, nem como navegação (um retorno de OAuth é uma navegação para `/api/...` e precisa ir à rede), nem métodos que não sejam GET, nem outras origens. Assim nenhum dado de tenant ou de autenticação pode parar no Cache Storage. O teste do roteamento e a prova em navegador conferem isso.
- **Versionamento por build.** O plugin de build (`pwa/service-worker-plugin.ts`) emite `sw.js` depois do build do cliente, com o manifesto desta build: um id (hash dos nomes dos arquivos, que já carregam o hash do conteúdo, e do conteúdo de `index.html` e dos arquivos públicos), o instante e a lista de arquivos a pré-guardar. Qualquer mudança no que o usuário baixaria muda o `sw.js`, e é isso que faz o navegador instalar a atualização. O cache se chama `polaris-shell-<instante com zeros à esquerda>-<id>`; o preenchimento garante que ordenar os nomes como texto ordena as builds no tempo (um teste pegou o erro da primeira versão, sem preenchimento).
- **A instalação é tudo ou nada** (`cache.addAll` com `cache: "reload"`): um shell pela metade é pior que nenhum. A busca no cache ignora o cabeçalho `Vary` (`ignoreVary`): os arquivos estáticos são iguais para quem pede, e um `Vary` do servidor fazia o módulo principal não ser achado offline, o que só apareceu no teste em navegador.
- **A atualização não é automática.** O worker novo não chama `skipWaiting` nem `clients.claim()`: ele espera na fila e só assume quando uma página pede (`SKIP_WAITING`), e as páginas abertas continuam com os arquivos da build delas. Ao ativar, apaga os caches de shell antigos, mantendo o da build atual e o da anterior, porque uma página ainda aberta pode carregar mais um pedaço (chunk) preguiçoso dela. Trocar de build sem recarregar à força e sem perder trabalho na fila é o ciclo do PR61.
- **Registro** (`src/pwa/register.ts`): só em build de produção, com suporte e em contexto seguro, depois do `load`, com `updateViaCache: "none"`, e nunca nos laboratórios offline (rotas `/offline-*`), que não dependem de um worker. Uma falha de registro não afeta o app. O `public/_headers` manda revalidar `/sw.js` sempre.
- **Instalável.** `manifest.webmanifest` (nome, `standalone`, `pt-BR`, cores) e ícones PNG rasterizados dos SVG de `design/icone-app/` (o "i" da marca sobre a tinta; versões "any", "maskable" e `apple-touch-icon`), sem script de geração no repositório: os SVG são a fonte e os PNG de `apps/web/public/icons/` foram exportados deles fora do repositório (PR 280). O CSP já permitia `manifest-src 'self'`.
- **Provas.** Testes do roteamento, da limpeza de caches, da mensagem e do manifesto de build, e uma simulação do worker compilado (instala, abre offline, serve do cache, não toca na API, espera a página para assumir, limpa caches antigos). Em navegador real (Chromium desktop e Pixel 5 emulado, CI) sobre a build de produção servida sem o Worker: instalar e controlar a página, abrir offline inclusive em rota interna, a API não passar pelo cache, o manifesto e os ícones, e os laboratórios não registrarem o worker.

## Consequências

- Sem rede o app abre e mostra o shell; o que a pessoa vê dali em diante depende dos dados locais (que as telas ainda precisam ler, trabalho de montagem do app) e não de cache de API.
- O primeiro acesso depois de um deploy usa a rede para o HTML (rede primeiro), então o usuário online sempre recebe o `index.html` novo; os arquivos novos vêm da rede até que o worker novo termine de instalar.
- O shell guardado não tem dados de usuário, então a saída da conta não precisa limpá-lo; a limpeza do PR59 cobre o outbox e as coleções.
- O comportamento em Safari de iPhone (limites de armazenamento, instalação na tela inicial) continua dependendo do checklist físico do Gate 5.

## Alternativas rejeitadas

- **Biblioteca de PWA (Workbox e plugins):** muito mais código e política embutida do que as três coisas de que o app precisa, e uma dependência a mais para auditar; o worker próprio tem poucas linhas e testes.
- **Cache de respostas da API para "funcionar offline":** é exatamente o que o plano proíbe; o offline dos dados é o banco local e o outbox, com revalidação de autorização.
- **`skipWaiting` e `clients.claim()` na instalação:** trocariam os arquivos sob um app em uso e quebrariam os pedaços preguiçosos de páginas abertas.

## Emenda (24/10/2026): origem dos ícones do manifesto

O PR 280 trocou os ícones do app pela variante tinta (o "i" da marca sobre `#171614`), e o PR 287 apagou `apps/web/scripts/generate-pwa-icons.mjs`, o gerador da estrela de quatro pontas sobre o verde da marca. A linha "Instalável" da Decisão foi reescrita no PR 287 sem nota datada; esta emenda a registra. A origem dos ícones passou a ser `design/icone-app/` (SVG "any", maskable e `apple-touch-icon`). Os PNG de `apps/web/public/icons/` não têm script nem receita de geração no repositório (a ferramenta usada não foi registrada). O desenho do service worker, o precache e as provas deste ADR não mudam.

## Emenda (25/10/2026): identidade só pelo conteúdo, arquivo conferido e chunk ausente

Três pontos mudam, todos achados no staging em 24/10/2026 (t344):

- **O `sw.js` não carrega mais o instante da build.** O manifesto traz só o id (hash do conteúdo) e a lista de arquivos. Antes, um deploy sem mudança de arquivo gerava um `sw.js` com bytes diferentes (o `builtAt`), o navegador instalava um worker novo e o aviso "Há uma nova versão do Polaris" aparecia sem nada de novo. O cache passa a se chamar `polaris-shell-<id>`. A ordem das builds, que o nome com o instante dava, vem da ordem de criação dos caches (`caches.keys()` devolve nessa ordem): ao ativar, guarda o cache da build atual e o criado por último entre os outros. Os caches de nome antigo (com o instante) saem do mesmo jeito.
- **Só entra no cache, e só é servido dele, o arquivo que se pediu.** A instalação busca cada arquivo e confere: resposta 200 e `content-type` do tipo da extensão (script para `.js`, folha de estilo para `.css`, página para `/` e para as páginas de entrada; qualquer outro arquivo, tudo menos página). Um HTML no lugar de um chunk faz a instalação falhar (tudo ou nada, como antes) e nada é guardado. O cache-first confere a cópia antes de servir: uma página guardada no lugar de um chunk por um worker antigo é ignorada e o pedido vai à rede. A cópia servida é um `clone()`: a `Response` direto de `cache.match` fazia o Chrome recusar o `modulepreload` da página ("a preload ... is not used because it is a cross-world service worker resource mismatch") e buscar o chunk de novo (medido: 8 de 10 cargas com o aviso antes, 0 a 1 de 10 depois).
- **`/assets/*` que não existe responde 404, nunca o HTML do SPA.** O fallback `single-page-application` da plataforma devolvia `200 text/html` para um chunk ausente (ainda não publicado, ou já apagado), e o `import()` e o worker o tomavam pelo chunk. O Worker passa a rodar primeiro para `/assets/*` (`run_worker_first` e o binding `ASSETS` do `wrangler.jsonc`), entrega o pedido aos arquivos estáticos e troca o fallback (e qualquer 404) por um 404 `text/plain` com `Cache-Control: no-store`: o arquivo pode aparecer um minuto depois, com o deploy. Custo: cada pedido de chunk que chega à rede passa a ser uma invocação do Worker (o worker de serviço e o cache do navegador seguram a maior parte); para o plano Free, ver o limite de pedidos por dia.
