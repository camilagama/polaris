# Configurações

Configurações (`/configuracoes`) junta, em abas, o que se ajusta uma vez: Formas de receber (`/configuracoes?aba=formas-de-receber`, a primeira, o mesmo que `/configuracoes`), Catálogo público (`/configuracoes?aba=catalogo-publico`), Aparelhos (`/configuracoes?aba=aparelhos`), Assinatura (`/configuracoes?aba=assinatura`), Senha (`/configuracoes?aba=senha`) e Seus dados (`/configuracoes?aba=seus-dados`, a última).

## Sub-features

- `formas-de-receber` perfis de pagamento: "Novo perfil", `region "Perfis cadastrados"`, "Incluir arquivados"; vazio: "Nenhum perfil cadastrado".
- `catalogo-publico` perfil público e produtos do catálogo; no Free: "Seu plano não inclui o catálogo público…" e "Salvar perfil" desligado.
- `aparelhos` os aparelhos do modo offline e a revogação.
- `assinatura` o plano e o uso ("Plano Free", barras "Variantes: N de 50", "Imagens: N de 50", "Metas em andamento: N de 1").
- `senha` troca de senha (atrás da flag de senha).
- `seus-dados` a cópia dos dados da loja, só para o dono (`organization:export`): cartão "Pedir cópia" (caixas "Dados em JSON", "Dados em planilha (CSV)", "Imagens dos produtos" e o botão "Pedir cópia dos dados") e `region "Suas cópias"` com "Atualizar"; vazio: "Nenhuma cópia pedida ainda."

## How to get to it (user POV)

- Desktop: link `Configurações` do menu "Principal" (grupo "Configurações").
- Celular: "Mais" e o link `Configurações`.
- Abas: `tablist "Configurações"`. Endereços antigos: `/payment-profiles`, `/public-catalog`, `/devices`, `/subscription` e `/conta/seguranca` abrem a aba correspondente.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. A Assinatura precisa de `launch --assinatura`; o plano no limite, de `$V seed limite` e `VERIFY_LOJA=limite`.

- **Abrir.** `await page.goto("/configuracoes")`. `getByRole("heading", { level: 1, name: "Configurações" })`, aba "Formas de receber" selecionada.
- **Assinatura no limite.** Com `--assinatura` e loja `limite`: `$V snap "/configuracoes?aba=assinatura"`. `tabpanel "Assinatura"` mostra `region "Plano Free"` com "Você usa 50 de 50 variantes." e `progressbar "Variantes: 50 de 50"`, e o `status` "A assinatura do Pro não está disponível agora. Nada muda no seu plano." Provado nesta skill (captura `snap-configuracoes-aba-assinatura`).
- **Catálogo público.** `$V snap "/configuracoes?aba=catalogo-publico"`: o aviso do plano, o formulário "Perfil público" e `region "Produtos"` com "Mostrar no catálogo" desligado.
- **Formas de receber.** "Novo perfil" abre o formulário (`apps/web/e2e/payment-profiles-screen.e2e.ts`).
- **Seus dados.** `$V snap "/configuracoes?aba=seus-dados"`: o cartão "Pedir cópia" e `region "Suas cópias"`. Pedir cria um pedido real, que fica preparando: o job horário não roda no launch, então "pronta", "expirada" e as recusas só se veem com a API simulada (`apps/web/e2e/data-export-screen.e2e.ts`).
- **Prova.** `snap` de cada aba pedida, na loja do estado.

## Gotchas

- Sem `--assinatura`, a aba Assinatura diz "A assinatura não está disponível agora." (o self-service de cobrança está desligado no `wrangler.jsonc`, como na produção). Contratar o Pro nunca funciona aqui: não há provedor de cobrança nem chave, e não deve haver.
- O `tablist` mostra Aparelhos só com o runtime offline e Assinatura só com o self-service de cobrança; a aba que o endereço pede aparece mesmo sem a condição, e a tela dela diz o que não dá para fazer (por isso Aparelhos sem `--runtime` e Assinatura sem `--assinatura` abrem com um aviso). A exceção é Senha.
- Senha fica atrás da flag de senha, desligada: `/configuracoes?aba=senha` abre Formas de receber. Os estados da tela estão em `apps/web/e2e/password-screens.e2e.ts`.
- Aparelhos sem `--runtime` mostra "Nenhum aparelho registrado nesta conta…" e o aviso de que o navegador não preparou o acesso offline.
