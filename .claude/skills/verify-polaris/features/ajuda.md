# Ajuda e contato

Ajuda e contato (`/ajuda`) é a página estática de suporte, dentro do shell: o e-mail do suporte e o do encarregado (DPO), o que anotar antes de escrever e os links dos Termos e da Política. Abre sem conexão.

## Sub-features

- `ajuda` `/ajuda`: o e-mail do suporte e o do encarregado (DPO) como links `mailto:`, "Antes de escrever" e os links dos Termos e da Política. Estática: abre sem conexão. A linha "Precisa de ajuda? Escreva para {endereço}." também está em `/entrar` e em "Abra a sua loja".

## How to get to it (user POV)

- Ajuda: no desktop, o item "Ajuda e contato" da lateral, depois de Configurações (1 toque, também recolhida); nas duas larguras, o menu "Loja, conta e ajuda" → "Ajuda e contato"; no celular também "Mais" → "Ajuda e contato" (2 toques, depois de Configurações); ou `/ajuda`.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK, qualquer loja (a página não lê nada da loja; uma conta sem loja também a abre).

- **Ajuda.** `$V snap /ajuda`: o `h1` é "Ajuda e contato"; `getByRole("link", { name: /^Escrever para o suporte: / })` e `getByRole("link", { name: /^Escrever ao encarregado de dados: / })` têm `href` `mailto:` com o texto do próprio endereço. No celular (360 px), `getByRole("button", { exact: true, name: "Mais" })` abre `getByRole("dialog", { name: "Mais" })` e o link "Ajuda e contato" leva a `/ajuda` (provado no `describe("Ajuda e contato")` de `apps/web/e2e/app-shell.e2e.ts`). O endereço é o de `VITE_LEGAL_CONTATO_EMAIL` do build; sem ela a pilha local mostra o exemplo dos Termos.
- **Desktop.** A 1280 px, `getByRole("navigation", { exact: true, name: "Principal" }).getByRole("link", { exact: true, name: "Ajuda e contato" })` é o último link, logo depois de "Configurações", e leva a `/ajuda` com `aria-current="page"`; recolhida a lateral, o link continua, só com o ícone. O cabeçalho não tem mais o "?".

## Gotchas

- O item é `NAV_ITEMS` com o grupo de Configurações; a página não marca outro item da lateral.
- Sem `VITE_LEGAL_CONTATO_EMAIL` no build, os endereços mostram o exemplo dos Termos.
