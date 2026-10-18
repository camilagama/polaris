---
status: accepted
---

# Headers de segurança e CSP centralizados num módulo único

> O número deste ADR (0090) é o próximo livre na `main` (a última é a 0089, do PR do evlog) e nos PRs abertos no momento da escrita; pode mudar se outro entrar antes.

## Contexto

O plano (Fase 12, PR120) pede CSP e headers centralizados, com testes automatizados. Antes deste PR cada superfície escrevia os seus:

- **apps/web**: `public/_headers` (shell estático: CSP, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`) e `middleware/security-policy.ts` com uma cópia da mesma política para o Worker, mais os padrões do `hono/secure-headers`. Um teste mantinha as duas cópias iguais. Rotas de arquivo (mídia, exportação) escrevem o próprio `Cache-Control` e `nosniff`.
- **apps/admin**: três headers à mão (`Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`); sem CSP, HSTS, `frame-ancestors` nem COOP/CORP.
- **apps/catalog** (HTML renderizado no servidor, TanStack Start): nenhum header de segurança nas páginas; a rota de imagem escrevia `nosniff` e `Cross-Origin-Resource-Policy: cross-origin`.
- **Service worker**: `public/_headers` só revalida `/sw.js` (`Cache-Control: no-cache`); o script segue a CSP do shell.

## Decisão

- **Um pacote, `@polaris/http-security`, monta os headers por tipo de resposta.** Nenhum app monta uma política de segurança à mão (as rotas de arquivo que já escreviam `nosniff` e o próprio `Cache-Control` seguem escrevendo; o valor é o mesmo e o middleware o reafirma). Perfis:

  | Perfil | Quem usa | O que o navegador pode carregar |
  | --- | --- | --- |
  | `app-shell` | SPA do apps/web (HTML, JS, CSS, `sw.js`), servido pelo Workers Static Assets | `'self'`; `'wasm-unsafe-eval'` e `connect-src data:` (ver exceções) |
  | `api` | respostas do Worker do apps/web (`/health`, `/ready`, `/rpc/*`, `/api/*`) e o que o catálogo serve que não é página | nada (`default-src 'none'`) |
  | `admin` | o Worker do Admin | nada; sem referrer |
  | `public-document` | HTML do catálogo público | `'self'` e os scripts inline que levam o nonce da resposta |
  | `public-media` | bytes de imagem do catálogo | nada, `sandbox`; embutível por qualquer origem |

- **Em todo perfil**: `Strict-Transport-Security: max-age=31536000; includeSubDomains` (sem `preload`, que é um compromisso do domínio e não do código da aplicação), `X-Content-Type-Options: nosniff`, `Permissions-Policy` que nega câmera, microfone, geolocalização, pagamento e USB, `Referrer-Policy` (`strict-origin-when-cross-origin`; `no-referrer` no Admin), `X-Permitted-Cross-Domain-Policies: none` e `frame-ancestors 'none'`. Fora `public-media`: `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Resource-Policy: same-origin`. A imagem pública é `cross-origin` de propósito (o link de uma loja compartilhado num chat mostra a foto) e inerte como documento (`sandbox`).
- **Nenhuma política tem `'unsafe-inline'`, `'unsafe-eval'`, curinga ou esquema solto** (`https:`) em script, estilo ou conexão. O teste do pacote varre todos os perfis.
- **Cache-Control das respostas autenticadas**: `api` recebe `no-store` quando o handler não escolheu outro (a mídia e a exportação seguem com `private, no-store`); `admin` recebe `no-store` sempre. As páginas HTML do catálogo nunca vão para cache compartilhado: o nonce vale para uma resposta, e uma cópia servida a outro visitante o tornaria público; a entrada do catálogo força `private, no-cache` quando a rota não pediu `private` ou `no-store`. Imagens e demais respostas do catálogo ficam com o `Cache-Control` da rota que conhece o conteúdo. Os assets do shell seguem o padrão do Workers Static Assets, exceto `/sw.js` (`no-cache`).
- **`public/_headers` é gerado.** O arquivo é o resultado de `renderStaticHeadersFile` e um teste (`security-headers.test.ts`) falha se o arquivo commitado diferir da renderização. O Worker não roda para o shell, então a cópia estática é inevitável; o que antes eram duas políticas escritas à mão que um teste comparava agora é uma só.
- **Nonce no catálogo.** O servidor do catálogo (`src/server.ts`, entrada própria do TanStack Start, que o `main` do `wrangler.jsonc` aponta: a entrada padrão do pacote a ignoraria, e um teste guarda essa ligação) gera 128 bits aleatórios por requisição, entrega ao roteador (`ssr.nonce`, lido pelo `getRouter` de um header interno que a entrada sempre sobrescreve; em produção, sem o header o roteador falha em vez de renderizar sem política) e aplica o perfil na resposta. Os scripts de hidratação inline levam o nonce; o navegador lê o mesmo nonce da meta `csp-nonce`. Sem `'unsafe-inline'`. O servidor de desenvolvimento (`vite dev`) injeta scripts inline próprios (HMR, React refresh), que nenhuma política de produção permite: nele a entrada não aplica o perfil; o build sempre aplica.
- **Origens externas: nenhuma hoje.** A mídia passa pelas rotas do próprio app (`'self'`), não há origem de Cloudflare Images/R2 aberta ao navegador, e não há código de provedor de pagamento no navegador (o checkout é redirecionamento, a cobrança é por webhook no Worker). Para o Sentry (ainda não ligado) e qualquer outra origem, o módulo aceita `connectSources` e `imgSources`, que só admitem origens `https://host[:porta]` exatas (sem curinga, caminho, esquema solto ou palavra-chave; o teste cobre as recusas) e que o perfil `api`/`admin`/`public-media` recusa. Quem ligar o Sentry adiciona o host de ingestão em `APP_SHELL_SECURITY_OPTIONS` (apps/web) no mesmo PR, e a CSP muda no `_headers` pela renderização.

## Exceções (o que não é o mais restritivo, e por quê)

- **`script-src 'wasm-unsafe-eval'` no shell**: o armazenamento offline é SQLite compilado para WebAssembly. A palavra-chave só permite compilar WebAssembly; `eval` de JavaScript segue bloqueado.
- **`connect-src data:` no shell**: a biblioteca embute o módulo WASM como URL `data:`, que só lê bytes já presentes na página e não alcança a rede. Provado em navegador por `e2e/offline-csp.e2e.ts` (a CSP do `_headers` aplicada ao laboratório offline).
- **`img-src blob: data:` no shell**: pré-visualização e recorte de imagem antes do envio.
- **Sem `style-src 'unsafe-inline'` em lugar nenhum**: o build emite CSS externo e o React aplica `style` pelo CSSOM, que a CSP não bloqueia. Se uma biblioteca futura precisar de `<style>` inline, a saída é um nonce ou hash, não `'unsafe-inline'`.

## Consequências

- Os padrões do `hono/secure-headers` deixam de ser usados: `X-XSS-Protection`, `X-DNS-Prefetch-Control`, `X-Download-Options` e `Origin-Agent-Cluster` não são mais enviados (os dois primeiros são obsoletos ou neutros, os outros não têm efeito nestas respostas).
- O shell passa a enviar `Cross-Origin-Opener-Policy` e `Cross-Origin-Resource-Policy: same-origin`, que não enviava. Um fluxo que dependa de `window.opener` ou de embutir um asset do shell em outra origem deixa de funcionar; nenhum existe hoje (login e pagamento são por redirecionamento). Ver o item de verificação abaixo.
- O Admin e o catálogo ganham CSP, HSTS e `frame-ancestors`. O Admin ainda não tem interface; quando tiver, ela entra como um perfil de documento próprio, sem afrouxar o `admin` das respostas de API.
- Um header de segurança novo ou alterado muda em um lugar e em um teste.

## Limites aceitos

- A CSP do catálogo com nonce foi provada por testes unitários, pela conferência de que o bundle do Worker (`dist/server/index.js`) contém a entrada própria e pela leitura do código do roteador, não por um navegador contra o Worker rodando: o `workerd` local não respondeu neste ambiente de execução. Falta abrir uma página renderizada do catálogo com um navegador e conferir que a hidratação roda sem violações (o CI não cobre isso).
- Os gates de navegador do web (`test:offline-poc`, `test:pwa`) precisam do navegador do Playwright; o resultado de cada um está na seção "Verificação" do PR.
- Sem `report-uri`/`report-to`: não há coletor. Ele entra com o Sentry.
- HSTS com `includeSubDomains` vale para o domínio inteiro em que o app for servido; conferir os subdomínios antes de ligar o domínio de produção.

## Alternativas rejeitadas

- **Deixar cada app com a sua política e um teste de igualdade**: foi o estado anterior e já tinha divergido (Admin e catálogo sem CSP).
- **`'unsafe-inline'` no catálogo por causa da hidratação**: desnecessário, o roteador aceita nonce.
- **Hash em vez de nonce**: os scripts inline de hidratação carregam dados da página e mudam a cada resposta.
- **Configurar os headers na zona da Cloudflare (Transform Rules)**: fora do repositório, sem revisão nem teste, e fora do escopo desta tarefa.
