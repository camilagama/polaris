# Configurações

Configurações da loja (`/configuracoes`, `h1` "Configurações da loja"; o item do menu segue "Configurações") junta, em abas, o que muda quando se troca de loja (uma faixa só, sem rótulos de grupo; abaixo de 760 px, no celular, `/configuracoes` sem `aba` é uma lista de linhas, e cada tela aberta traz o link "Voltar para Configurações"): Formas de receber (`/configuracoes?aba=formas-de-receber`, a primeira; a partir de 760 px é o mesmo que `/configuracoes`), Catálogo público (`/configuracoes?aba=catalogo-publico`), Assinatura (`/configuracoes?aba=assinatura`) e Seus dados (`/configuracoes?aba=seus-dados`, a última). Senha e Aparelhos são de [Minha conta](conta.md) (`/conta`); `/configuracoes?aba=senha` e `?aba=aparelhos` abrem a tela nova na aba certa.

## Sub-features

- `formas-de-receber` perfis de pagamento: "Novo perfil", `region "Perfis cadastrados"`, "Incluir arquivados" (fora da moldura, acima dela); em cada perfil ativo o botão "Mais ações para <perfil>" abre o menu com "Editar perfil <perfil>" e "Arquivar perfil <perfil>"; o perfil arquivado tem o botão "Restaurar perfil <perfil>"; vazio: "Nenhum perfil cadastrado" (só o `EmptyState`, sem a região).
- `catalogo-publico` perfil público e produtos do catálogo (busca "Buscar produto" e 50 de cada vez com "Carregar mais"); no Free: "Seu plano não inclui o catálogo público…" e "Salvar perfil" desligado.
- `assinatura` o plano e o uso ("Plano Free", barras "Variantes: N de 50", "Imagens: N de 50", "Metas em andamento: N de 1").
- `seus-dados` a cópia dos dados da loja, só para o dono (`organization:export`): cartão "Pedir cópia" (caixas "Dados em JSON", "Dados em planilha (CSV)", "Imagens dos produtos" e o botão "Pedir cópia dos dados") e `region "Suas cópias"` com "Atualizar"; vazio: "Nenhuma cópia pedida ainda."; no fim, `region "Encerrar a loja"` (só `organization:close`) com o botão "Encerrar a loja", que abre o diálogo "Encerrar a loja {nome}" (avisos, fila deste aparelho, campo do nome, "Voltar" e "Encerrar a loja"); encerrar leva a `/loja-encerrada?loja=<id>` (ver `outros-enderecos.md`).

## How to get to it (user POV)

- Desktop: link `Configurações` do menu "Principal" (grupo "Configurações").
- Celular: "Mais", o link `Configurações` e, na lista, a linha da tela (`list "Configurações da loja"`); na tela aberta, o link `Voltar para Configurações` e o `page.goBack()` levam de volta à lista (a linha de origem ganha o foco), porque abrir uma linha acrescenta um passo ao histórico; uma aba aberta direto pelo endereço não tem lista antes, e o `goBack` sai de Configurações.
- Abas (a partir de 760 px): `tablist "Configurações da loja"`. Endereços antigos: `/payment-profiles`, `/public-catalog` e `/subscription` abrem a aba correspondente; `/devices`, `/conta/seguranca`, `/configuracoes?aba=senha` e `/configuracoes?aba=aparelhos` abrem Minha conta.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. A Assinatura precisa de `launch --assinatura`; o plano no limite, de `$V seed limite` e `VERIFY_LOJA=limite`.

- **Abrir.** `await page.goto("/configuracoes")`. `getByRole("heading", { level: 1, name: "Configurações da loja" })`; a partir de 760 px, aba "Formas de receber" selecionada; no celular, a lista (com `/configuracoes?aba=formas-de-receber` abre a primeira tela, com o "Voltar").
- **Assinatura no limite.** Com `--assinatura` e loja `limite`: `$V snap "/configuracoes?aba=assinatura"`. `tabpanel "Assinatura"` mostra `region "Plano Free"` com "Você usa 50 de 50 variantes." e `progressbar "Variantes: 50 de 50"`, e o `status` "A assinatura do Pro não está disponível agora. Nada muda no seu plano." Provado nesta skill (captura `snap-configuracoes-aba-assinatura`).
- **Catálogo público.** `$V snap "/configuracoes?aba=catalogo-publico"`: o aviso do plano, o formulário "Perfil público" e `region "Produtos"` com "Mostrar no catálogo" desligado.
- **Formas de receber.** "Novo perfil" abre o formulário (`apps/web/e2e/payment-profiles-screen.e2e.ts`).
- **Seus dados.** `$V snap "/configuracoes?aba=seus-dados"`: o cartão "Pedir cópia" e `region "Suas cópias"`. Pedir cria um pedido real, que fica preparando: o job horário não roda no launch, então "pronta", "expirada" e as recusas só se veem com a API simulada (`apps/web/e2e/data-export-screen.e2e.ts`). O diálogo de encerrar abre sem risco (o "Voltar" não chama nada); confirmar encerra a loja de teste de verdade, então só numa loja descartável. Os estados do diálogo estão em `apps/web/e2e/close-store.e2e.ts`.
- **Prova.** `snap` de cada aba pedida, na loja do estado.

## Gotchas

- Sem `--assinatura`, a aba Assinatura diz "A assinatura não está disponível agora." (o self-service de cobrança está desligado no `wrangler.jsonc`, como na produção). Contratar o Pro nunca funciona aqui: não há provedor de cobrança nem chave, e não deve haver.
- O `tablist` (a lista, no celular) mostra Assinatura só com o self-service de cobrança e Seus dados só com `organization:export`; a aba que o endereço pede aparece mesmo sem a condição, e a tela dela diz o que não dá para fazer (por isso Assinatura sem `--assinatura` abre com um aviso).
- Senha (de Minha conta) fica atrás da flag de senha, desligada: veja [Minha conta](conta.md).
