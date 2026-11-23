# Minha conta

Minha conta (`/conta`, `h1` "Minha conta") junta o que é da pessoa e vale em todas as lojas: Senha (`/conta`, a primeira) e Aparelhos (`/conta?aba=aparelhos`). Abre pelo item "Minha conta" do menu do círculo (no celular também). Cada aba aparece por condição: Senha com a senha ligada, Aparelhos com o runtime offline; com uma aba só a tela não desenha a faixa de abas, e sem nenhuma o endereço abre o Início.

## Sub-features

- `senha` troca de senha (atrás da flag de senha): senha atual, nova, "Trocar senha" e "Cancelar e voltar para Minha conta".
- `aparelhos` os aparelhos do modo offline e a revogação.

## How to get to it (user POV)

- Desktop e celular: botão `getByRole("button", { name: /^Loja, conta e ajuda: / })`, item `getByRole("menuitem", { name: "Minha conta" })` (só aparece se a pessoa tem ao menos uma das duas abas); a lateral e a folha "Mais" não a listam.
- Abas: `tablist "Minha conta"` (só com duas abas). Endereços antigos: `/devices`, `/conta/seguranca`, `/configuracoes?aba=senha` e `/configuracoes?aba=aparelhos` abrem a aba correspondente, com o resto da consulta.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. Aparelhos precisa de `launch --runtime`; Senha, da flag de senha ligada (desligada no launch).

- **Abrir.** `await page.goto("/conta?aba=aparelhos")` com `--runtime`; `getByRole("heading", { level: 1, name: "Minha conta" })`. Sem a flag de senha e com o runtime, a aba Aparelhos é a única: não há `tablist`.
- **Sem aba.** Sem `--runtime` e com a senha desligada, `/conta` volta ao Início (`/`).
- **Prova.** `snap "/conta?aba=aparelhos"` com a loja `pro` e `--runtime`.

## Gotchas

- Senha fica atrás da flag de senha, desligada: `/conta?aba=senha` abre a primeira aba que a pessoa tem. Os estados da tela estão em `apps/web/e2e/password-screens.e2e.ts`.
- Aparelhos sem `--runtime` não existe como aba: o item "Minha conta" some do menu se a senha também está desligada.
- Aparelhos sem registro mostra "Nenhum aparelho registrado nesta conta…" e o aviso de que o navegador não preparou o acesso offline.
