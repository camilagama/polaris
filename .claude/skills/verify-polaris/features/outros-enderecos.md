# Outros endereços

Os endereços que o app abre fora dos 8 destinos: Pendências (no shell, só quando há registro recusado), Ajuda e contato (no shell, estática), as páginas de entrada, as páginas legais, o aceite e o painel da loja encerrada (fora do shell, sem menu), a página 404 e os endereços antigos que hoje abrem uma aba.

## Sub-features

- `pendencias` `/attention`: os registros deste aparelho que o servidor recusou; o item "Pendências" aparece no menu depois de "Histórico" só enquanto houver algum.
- `ajuda` `/ajuda`: "Ajuda e contato", dentro do shell: o e-mail do suporte e o do encarregado (DPO) como links `mailto:`, "Antes de escrever" e os links dos Termos e da Política. Estática: abre sem conexão. A linha "Precisa de ajuda? Escreva para {endereço}." também está em `/entrar` e em "Abra a sua loja".
- `entrada` `/entrar`, `/criar-conta`, `/confirmar-email`, `/esqueci-a-senha`, `/redefinir-senha` e `/desbloquear`.
- `legais` `/termos` (Termos de Uso) e `/privacidade` (Política de Privacidade), públicas.
- `aceite` `/aceite`: "Termos de Uso e Política de Privacidade", caixa de aceite e "Continuar".
- `loja-encerrada` `/loja-encerrada`: o painel da loja encerrada do dono ("{nome} está encerrada"), com a fase, as três datas, a renovação e a cópia dos dados. `?loja=<id>` abre uma loja (`organization.closedStatus`); sem ele, lista as encerradas do dono (`organization.listClosed`). O botão "Abrir o painel" dos e-mails do encerramento leva aqui. "Desfazer encerramento" abre o diálogo "Desfazer o encerramento?" ("Voltar" / "Sim, desfazer"); reaberta vai a `/?reaberta=1`. O pé tem "Abrir outra loja" (`/?nova-loja=1`).
- `nao-encontrada` qualquer outro endereço do shell: "Erro 404", "Página não encontrada".
- `enderecos-antigos` `/categories`, `/expenses`, `/payment-profiles`, `/public-catalog`, `/devices`, `/subscription` e `/conta/seguranca` abrem a aba nova no lugar.

## How to get to it (user POV)

- Pendências: pelo menu, quando existe; ou `/attention`.
- Ajuda: no celular, "Mais" → "Ajuda e contato" (2 toques, depois de Configurações); no desktop, o terceiro link "Ajuda e contato" ao lado de "Termos de Uso" e "Política de Privacidade" no pé da lateral e no rodapé; ou `/ajuda`.
- Entrada: sem sessão, qualquer tela do shell manda para `/entrar?voltar=<endereço>` ("Entrar no Polaris"). Com a senha desligada (padrão), `/entrar` só tem "Continuar com o Google"; as outras páginas de entrada são da senha.
- Legais: os links "Termos de Uso" e "Política de Privacidade" do rodapé de toda tela.
- Aceite: depois de entrar, quando falta o aceite da versão vigente.
- Loja encerrada: Configurações → Seus dados → "Encerrar a loja" (só o dono, com conexão e a fila do aparelho vazia); depois de encerrar, a tela vai sozinha para `/loja-encerrada?loja=<id>`. Também pelo botão "Abrir o painel" dos e-mails do encerramento.
- 404 e endereços antigos: só digitando ou por link salvo.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. Entrada e páginas legais não precisam de loja; para ver a entrada sem sessão, limpe os cookies no drive (`await context.clearCookies()`).

- **Ajuda.** `$V snap /ajuda`: o `h1` é "Ajuda e contato"; `getByRole("link", { name: /^Escrever para o suporte: / })` e `getByRole("link", { name: /^Escrever ao encarregado de dados: / })` têm `href` `mailto:` com o texto do próprio endereço. No celular (360 px), `getByRole("button", { exact: true, name: "Mais" })` abre `getByRole("dialog", { name: "Mais" })` e o link "Ajuda e contato" leva a `/ajuda` (provado em `apps/web/e2e/help.e2e.ts`). O endereço é o de `VITE_LEGAL_CONTATO_EMAIL` do build; sem ela a pilha local mostra o exemplo dos Termos.
- **Legais.** `$V snap /termos` e `$V snap /privacidade`: o `h1` é "Termos de Uso" e "Política de Privacidade" (provado; estados em `apps/web/e2e-pwa/legal-pages.e2e.ts`).
- **Entrada.** `await context.clearCookies(); await page.goto("/")` termina em `/entrar?voltar=/` com `getByRole("heading", { level: 1, name: "Entrar no Polaris" })` (provado nesta skill). Os estados da tela estão em `apps/web/e2e/sign-in.e2e.ts`.
- **Aceite.** `apps/web/e2e/legal-acceptance.e2e.ts` cobre a tela (`getByRole("checkbox")`, "Continuar", `alert`). As lojas desta skill abrem direto no shell, sem passar por `/aceite`.
- **404.** `$V snap /sales/customer`: `h1` "Página não encontrada", com "Erro 404" e links para Início e Histórico (provado; `apps/web/e2e/app-shell.e2e.ts`).
- **Endereço antigo.** `await page.goto("/categories")` termina em `/products?aba=categorias`; `/expenses` em `/dashboard?aba=despesas`; `/subscription` em `/configuracoes?aba=assinatura`; `/public-catalog` em `/configuracoes?aba=catalogo-publico`; `/devices` em `/configuracoes?aba=aparelhos`; `/payment-profiles` e `/conta/seguranca` em `/configuracoes` (Formas de receber é a primeira aba, e Senha está desligada). Provado nesta skill.
- **Loja encerrada.** Encerrar apaga o acesso à loja de teste: use uma loja que não vai mais servir (`seed vazia` numa loja própria) e confirme pelo nome no diálogo. Depois, `$V snap /loja-encerrada`: o `h1` é "{nome} está encerrada". Sem loja encerrada, o `h1` é "Loja encerrada" com "Não encontramos uma loja encerrada nesta conta.". Os estados de cada fase, com a API simulada, estão em `apps/web/e2e/closed-store.e2e.ts`; o diálogo de encerrar em `apps/web/e2e/close-store.e2e.ts`.
- **Pendências.** Precisa de um registro recusado no aparelho, o que a pilha real com loja Free não produz: os estados estão no laboratório (`apps/web/e2e-pwa/ui-device-states.ts`, `attentionStates`).

## Gotchas

- Aqui `/entrar` diz "A entrada com o Google não está disponível agora. Tente de novo em instantes." com "Tentar novamente": o Google não está configurado na pilha local, e não deve estar. Não prove a entrada de verdade aqui.
- O painel da loja encerrada só fica no ar com a sessão: sem ela, vai a `/entrar?motivo=sessao&voltar=/loja-encerrada…`. O pedido de cópia da encerrada exige entrada de até 15 minutos; numa sessão mais velha, a recusa diz para sair e entrar de novo.
- Conta sem loja ativa: `/` lê `organization.listClosed` e, com loja encerrada do dono, vai sozinha para `/loja-encerrada?loja=<id>`; para ver "Abra a sua loja" de uma conta assim, abra `/?nova-loja=1`. A linha "Você também tem uma loja encerrada" do Início só aparece num navegador que já abriu o painel daquela loja (fica em `localStorage`, `polaris.closedStores`). Os estados do aparelho com a loja encerrada, com a API simulada, estão em `apps/web/e2e/closed-store-device.e2e.ts`; o roteamento em `apps/web/e2e/closed-store-routing.e2e.ts`.
- A barra no fim (`/entrar/`) é redirecionada para o endereço sem barra.
- O snap espera um `h1`: a 404 tem o seu ("Página não encontrada"); se um endereço não tiver, escreva um drive em `drives/local/`.
