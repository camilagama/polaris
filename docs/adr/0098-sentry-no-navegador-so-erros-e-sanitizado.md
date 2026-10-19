---
status: accepted
---

# Sentry no navegador: só erros, sanitizado, com source maps escondidos

> O número deste ADR (0098) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0097 é o do staging, já na `main`); pode mudar se outro entrar antes.

## Contexto

O plano da Fase 12 (PR 118) pede o Sentry só no frontend, com source maps, `environment`, release pelo SHA e sanitização, sem Session Replay. O servidor ainda **não** usa o SDK do Sentry: os erros dele vão para o Workers Logs ([ADR 0089](0089-evlog-e-logger-tipado-no-backend.md), [ADR 0094](0094-tracing-e-amostragem-do-workers-observability.md)) e o [ADR 0095](0095-onde-os-alertas-operacionais-vao-rodar.md) deixa o Sentry fora dos alertas por enquanto. O que o servidor já tem, e este ADR reaproveita, é a **política de redação** (`packages/observability/src/redaction.ts`): chaves que dizem o que guardam perdem o valor, e textos que parecem e-mail, telefone, CPF/CNPJ, cartão, IP, cookie ou token perdem essa parte. O [ADR 0090](0090-headers-de-seguranca-centralizados.md) manteve o `connect-src` do shell só em `'self'` e pediu que quem ligasse o Sentry abrisse o host de ingestão no mesmo PR. O SDK roda no aparelho do usuário, onde há CPF, telefone e e-mail de clientes em telas e formulários: o que sai dali é dado pessoal em potencial ([ADR 0076](0076-teto-de-custo-e-free-tier-primeiro.md) fixa o teto de custo; o Sentry Developer é gratuito).

## Decisão

- **Desligado por padrão.** O SDK (`@sentry/react`) só inicia se o build tiver `VITE_SENTRY_DSN` com um DSN válido (`https`, chave pública, projeto numérico, host `o<id>.ingest[.<região>].sentry.io`, sem senha, porta ou query) **e** `VITE_SENTRY_ENVIRONMENT` em `local`, `staging` ou `production`. Faltando um dos dois, ou inválido, nada é carregado nem enviado. Nenhum DSN fica no código, nos testes ou nos docs: os testes usam uma chave inventada.
- **O SDK é um chunk à parte** (`sentry-sdk.ts`, com o SDK importado por nome, o que deixa de fora Replay, feedback e tracing, e com a sanitização dentro), carregado por `import()` só quando há DSN válido e ambiente válido. A guarda de `main.tsx` usa a constante do build (`import.meta.env.VITE_SENTRY_DSN`), então um build sem DSN nem contém o SDK nem a sanitização: o chunk (cerca de 35 kB gzip, medido) não existe, não entra no precache do Service Worker e o bundle principal fica como antes. Com DSN, o chunk entra no precache como qualquer asset. Um erro anterior à chegada do chunk não é reportado.
- **Release = SHA do commit.** `VITE_SENTRY_RELEASE` vale se vier; senão, com DSN, a configuração do Vite grava `GITHUB_SHA` ou `git rev-parse HEAD`. Sem DSN o build não muda por commit (o conteúdo do bundle fica idêntico). O servidor ainda não declara release; quando o declarar, usará o mesmo SHA.
- **Só erros.** Sem Session Replay, sem profiling, sem tracing (nenhuma taxa de amostragem nem integração de tracing, e `tracePropagationTargets: []`, para o SDK não pôr `sentry-trace`/`baggage` nas requisições do app), sem sessões de release health, sem captura do console nem da localidade. Coleta automática de dados pessoais desligada: o SDK 11 trocou o `sendDefaultPii` por `dataCollection`, e o app o configura com `userInfo`, `cookies`, `httpHeaders` e `urlQueryParams` em `false`, `httpBodies: []` e `stackFrameVariables: false` (o equivalente de `sendDefaultPii: false`, que não existe mais nessa versão).
- **Sanitização única** (`apps/web/src/observability/sentry-sanitize.ts`), em `beforeSend` e `beforeBreadcrumb`, sobre a política de redação do servidor, agora exportada como `@polaris/observability/redaction` (a regra de importação do navegador abre só essa exceção; o logger e o evlog continuam proibidos):
  - URL: mantém o caminho; **todo valor de query** vira `[REDACTED]` (cobre `token`, `code`, `state` e termos de busca) e o fragmento sai;
  - requisição: ficam URL, método e os headers `User-Agent` e `Referer` (este sanitizado); saem cookies, corpo, `query_string` e os demais headers (`Authorization` incluso);
  - o usuário sai; mensagem, exceção, `extra`, `contexts` e `tags` passam pela redação por chave e por padrão de valor; a rejeição com valor que não é `Error` perde o `extra.__serialized__`, o `mechanism.data` guarda só os nomes do handler e do alvo e o `fingerprint` passa pela redação; subárvores sob chaves de formulário (`form`, `body`, `payload`, `input`, `fields`…) são substituídas, porque texto livre digitado não tem padrão para pegar;
  - breadcrumbs: lista branca de categorias (`fetch`, `xhr`, `navigation`), com URL sanitizada; qualquer outra (`console`, `ui.*`, as customizadas) é descartada, o breadcrumb de DOM fica desligado (o seletor de um clique pode trazer `aria-label` com nome de cliente) e `body`, `input` e `value` saem do `data`.
- **Error Boundary** (`apps/web/src/app-shell/error-boundary.tsx`): `componentDidCatch` chama `captureReactException` com a pilha de componentes. O que a pessoa vê não muda.
- **CSP.** O host de ingestão sai do próprio DSN, no build: com DSN e ambiente válidos (a mesma condição que liga o SDK), um plugin do Vite regrava o `_headers` da saída com `connect-src 'self' data: https://<host de ingestão>` e nada mais muda. O `public/_headers` commitado continua sem origem nenhuma (o teste do ADR 0090 segue valendo), porque o host é parte do DSN (identifica a organização) e o DSN não entra no repositório. Isto **substitui** a instrução do ADR 0090 de pôr o host em `APP_SHELL_SECURITY_OPTIONS`. O módulo `@polaris/http-security` continua recusando curinga e origem fora de `https://host[:porta]`, e o DSN só vale com host de ingestão do Sentry (`o<id>.ingest[.<região>].sentry.io`): um DSN estranho não abre origem.
- **Source maps escondidos.** O build do navegador gera `.map` (`sourcemap: "hidden"`: o bundle não os referencia) e o `public/.assetsignore` (`*.map`) os mantém fora dos Static Assets no deploy. O worker não gera mapa. O **upload** ao Sentry (`sentry-cli sourcemaps inject` e `upload`, por release) precisa de um token de CI que não existe aqui: é o item 21 do [checklist de release](../runbooks/release-checklist.md), a cargo do responsável. Antes do upload, as pilhas chegam minificadas.
- **Fora do escopo:** criar projeto, DSN ou token no Sentry; mexer no projeto `dgimports` (nunca); ligar o SDK no servidor ou nos Workers; alerta do Sentry (ADR 0095); `.github/workflows` (o workflow de staging não define `VITE_SENTRY_*`, então o staging só reporta depois que o responsável o ajustar).

## Consequências

- Sem DSN, o app se comporta como antes e o build é o mesmo de antes (conferido: nenhum chunk novo, bundle principal do mesmo tamanho).
- Com DSN, a pessoa que usa o app envia erros a um terceiro (Sentry). A sanitização reduz o risco, mas texto livre fora das chaves de formulário (uma mensagem de erro com nome de cliente, por exemplo) só é pego pelos padrões da redação: nome próprio e endereço soltos em texto passam. Isso é um limite conhecido, a rever com a revisão de dados pessoais antes de ligar em produção, junto com a política de privacidade (o Sentry é um operador a listar).
- O Service Worker não muda: `.map` já não entra no precache (`service-worker-plugin.ts`) e o `_headers` regravado entra no id do build como antes.

## Alternativas descartadas

- **DSN no código ou em `APP_SHELL_SECURITY_OPTIONS`:** o host identifica a organização e o DSN não vai para o repositório.
- **`@sentry/vite-plugin` no build:** enviaria os mapas durante o build, exigindo um token de CI no build, que roda código do repositório (ver o cuidado do workflow de staging).
- **Curinga `https://*.sentry.io` na CSP:** o módulo o recusa de propósito; abriria todo o domínio.
- **Servir os `.map` e confiar na obscuridade:** o código-fonte ficaria público.
- **Replay, profiling e tracing do navegador:** gravam telas e requisições com dado de cliente e gastam a franquia; ficam para uma decisão própria.
- **SDK no bundle principal:** custaria cerca de 35 kB gzip a todo aparelho, com ou sem DSN, e arrastaria as regex da redação (com `lookbehind`, que o Safari anterior ao 16.4 não aceita) para o bundle que carrega o app inteiro: no chunk à parte, um navegador assim só deixa de reportar.
