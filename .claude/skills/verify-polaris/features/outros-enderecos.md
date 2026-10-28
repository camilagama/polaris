# Outros endereços

Os endereços que o app abre fora dos 8 destinos: Pendências (no shell, só quando há registro recusado), as páginas de entrada, as páginas legais e o aceite (fora do shell, sem menu), a página 404 e os endereços antigos que hoje abrem uma aba.

## Sub-features

- `pendencias` `/attention`: os registros deste aparelho que o servidor recusou; o item "Pendências" aparece no menu depois de "Histórico" só enquanto houver algum.
- `entrada` `/entrar`, `/criar-conta`, `/confirmar-email`, `/esqueci-a-senha`, `/redefinir-senha` e `/desbloquear`.
- `legais` `/termos` (Termos de Uso) e `/privacidade` (Política de Privacidade), públicas.
- `aceite` `/aceite`: "Termos de Uso e Política de Privacidade", caixa de aceite e "Continuar".
- `nao-encontrada` qualquer outro endereço do shell: "Erro 404", "Página não encontrada".
- `enderecos-antigos` `/categories`, `/expenses`, `/payment-profiles`, `/public-catalog`, `/devices`, `/subscription` e `/conta/seguranca` abrem a aba nova no lugar.

## How to get to it (user POV)

- Pendências: pelo menu, quando existe; ou `/attention`.
- Entrada: sem sessão, qualquer tela do shell manda para `/entrar?voltar=<endereço>` ("Entrar no Polaris"). Com a senha desligada (padrão), `/entrar` só tem "Continuar com o Google"; as outras páginas de entrada são da senha.
- Legais: os links "Termos de Uso" e "Política de Privacidade" do rodapé de toda tela.
- Aceite: depois de entrar, quando falta o aceite da versão vigente.
- 404 e endereços antigos: só digitando ou por link salvo.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. Entrada e páginas legais não precisam de loja; para ver a entrada sem sessão, limpe os cookies no drive (`await context.clearCookies()`).

- **Legais.** `$V snap /termos` e `$V snap /privacidade`: o `h1` é "Termos de Uso" e "Política de Privacidade" (provado; estados em `apps/web/e2e-pwa/legal-pages.e2e.ts`).
- **Entrada.** `await context.clearCookies(); await page.goto("/")` termina em `/entrar?voltar=/` com `getByRole("heading", { level: 1, name: "Entrar no Polaris" })` (provado nesta skill). Os estados da tela estão em `apps/web/e2e/sign-in.e2e.ts`.
- **Aceite.** `apps/web/e2e/legal-acceptance.e2e.ts` cobre a tela (`getByRole("checkbox")`, "Continuar", `alert`). As lojas desta skill abrem direto no shell, sem passar por `/aceite`.
- **404.** `$V snap /sales/customer`: `h1` "Página não encontrada", com "Erro 404" e links para Início e Histórico (provado; `apps/web/e2e/app-shell.e2e.ts`).
- **Endereço antigo.** `await page.goto("/categories")` termina em `/products?aba=categorias`; `/expenses` em `/dashboard?aba=despesas`; `/subscription` em `/configuracoes?aba=assinatura`; `/public-catalog` em `/configuracoes?aba=catalogo-publico`; `/devices` em `/configuracoes?aba=aparelhos`; `/payment-profiles` e `/conta/seguranca` em `/configuracoes` (Formas de receber é a primeira aba, e Senha está desligada). Provado nesta skill.
- **Pendências.** Precisa de um registro recusado no aparelho, o que a pilha real com loja Free não produz: os estados estão no laboratório (`apps/web/e2e-pwa/ui-device-states.ts`, `attentionStates`).

## Gotchas

- Aqui `/entrar` diz "A entrada com o Google não está disponível agora. Tente de novo em instantes." com "Tentar novamente": o Google não está configurado na pilha local, e não deve estar. Não prove a entrada de verdade aqui.
- A barra no fim (`/entrar/`) é redirecionada para o endereço sem barra.
- O snap espera um `h1`: a 404 tem o seu ("Página não encontrada"); se um endereço não tiver, escreva um drive em `drives/local/`.
