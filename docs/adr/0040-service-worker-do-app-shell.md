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
