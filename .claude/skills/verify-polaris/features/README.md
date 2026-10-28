# Mapa de telas do Polaris

Esta pasta é a fonte mantida para verificar o que a pessoa vê e faz no app web. Leia este índice antes de dirigir o app e use o arquivo do destino como receita. O teste `apps/web/scripts/verify-feature-map.test.ts` (no `bun run check`) reprova quando uma rota, uma aba (`?aba=`), uma página fora do shell ou um endereço antigo do roteador não aparece em nenhum arquivo daqui.

## Condições de partida

- Instância de pé e saudável: `verify.sh launch` terminou com `DOCTOR OK` e `verify.sh doctor` continua OK (`V=.claude/skills/verify-polaris/scripts/verify.sh`).
- A loja da receita está semeada: `vazia` vem do launch; `vendas`, `limite` e `pro` com `$V seed <loja>`. O drive usa a loja de `VERIFY_LOJA` (padrão `vazia`). `pro` é a loja do plano Pro (a única que escreve offline) e só mostra o offline numa instância `launch --runtime`.
- Nunca dirija uma instância que este run não subiu nem uma que o doctor reprovou.

## Convenções

- Toda receita parte da loja semeada, sem o que outras receitas deixaram, salvo quando diz o contrário. Quem precisa de estado limpo semeia de novo (`cleanup` + `launch`) ou usa nomes únicos.
- Papel e nome acessível antes de tudo (`getByRole("button", { name: "Novo produto" })`, `getByLabel("Nome do produto")`). `data-*` só onde o arquivo do destino o cita.
- Os nomes entre aspas são literais: copie-os sem mudar acento, aspas curvas nem maiúsculas.
- O menu no desktop é `getByRole("navigation", { exact: true, name: "Principal" })`, com os links `Início`, `Vender`, `Histórico`, `Estoque`, `Produtos`, `Clientes`, `Resultado` e `Configurações`, agrupados em "Catálogo", "Resultado" e "Configurações".
- No celular (menos de 760 px), a barra de baixo é `getByRole("navigation", { exact: true, name: "Destinos" })`, com os links `Início`, `Histórico`, `Vender` (no meio), `Estoque` e o botão `getByRole("button", { exact: true, name: "Mais" })`, que abre `getByRole("dialog", { name: "Mais" })` com o mesmo menu e o "Sair".
- O título de cada tela é o `h1` (`getByRole("heading", { level: 1, name })`); as abas ficam num `tablist` e o endereço guarda a aba em `?aba=`.
- Toda mutação se prova duas vezes: na tela e de um segundo jeito (recarregar, outra tela, `$V sql`).

## Prova e o que não foi verificado

- Capture a ação e o estado que ela produz, não só a tela final (`evidence.shot` antes e depois).
- Cada captura leva a loja, o projeto (largura e tema) e o commit no `LEIAME.md` da evidência; o traço do drive vai junto.
- Caminho que não se alcança: diga a receita tentada, o endereço e a condição que faltou (ex.: "Assinatura sem `--assinatura`"). Não declare verificado por outro caminho.
- Um destino com várias entradas (menu, atalho do Início, botão vazio) só está provado nas entradas que o drive percorreu.

## Contrato de cada arquivo

Um H1 com o nome do destino e um parágrafo do que a pessoa vê. Depois, exatamente quatro H2, nesta ordem:

1. `Sub-features`: IDs curtos, uma linha cada.
2. `How to get to it (user POV)`: toda entrada que a pessoa usa, com o endereço.
3. `Driving it with verify.sh (Playwright)`: começa com `Preconditions:` e pareia cada ação com o seletor exato e o que se vê depois.
4. `Gotchas`: armadilhas que fazem perder tempo ou invalidam a prova.

Fica fora do mapa o que é implementação: só caminho da pessoa, seletores estáveis, estado necessário, comandos e prova observável. A fonte de cada seletor é o spec citado no arquivo; os marcados "provado" rodam em `drives/`.

## Destinos

Os 8 do menu, na ordem do menu (os cinco primeiros com receitas mais fundas):

- [Início](inicio.md) `/`: números do dia e do mês, atalho para a Nova venda.
- [Vender](vender.md) `/sales`: a tela "Nova venda", um formulário só, do item à confirmação.
- [Histórico](historico.md) `/sales/history` e o detalhe `/sales/detail`: lista, filtros, devolução e cancelamento.
- [Estoque](estoque.md) `/inventory`: receber, contar, baixar.
- [Produtos](produtos.md) `/products`: Dialogs "Novo produto" e "Importar planilha", aba Categorias.
- [Clientes](clientes.md) `/customers`: Dialog "Novo cliente".
- [Resultado](resultado.md) `/dashboard`: abas Resultado, Metas e Despesas.
- [Configurações](configuracoes.md) `/configuracoes`: Formas de receber, Catálogo público, Aparelhos, Assinatura, Senha.

Fora do menu: [outros endereços](outros-enderecos.md) (Pendências, entrada, páginas legais, aceite, 404 e endereços antigos).

## Gotchas de toda a pilha

- **Build velha.** O preview serve o build do momento do launch. Mudou código em `apps/` ou `packages/`? O doctor reprova a linha "the build is the worktree's": `cleanup` e `launch`.
- **Sem conexão na pilha real.** As lojas `vazia`, `vendas` e `limite` são Free, e o Free não escreve offline (a `pro` escreve, com `launch --runtime`: ver [Vender](vender.md)): com `context.setOffline(true)` a barra mostra "Offline indisponível neste aparelho" e as telas que leem do servidor dizem "Não foi possível carregar …: a conexão falhou. Tente novamente." com o botão "Tentar novamente". `page.goto`/`page.reload` sem rede dá página em branco se o service worker ainda não controla a aba: só existe worker com `launch --runtime`, e a aba passa a ser controlada depois de `navigator.serviceWorker.ready` e uma recarga com rede. Fluxos offline de verdade: a loja `pro` e o modo offline do `SKILL.md`.
- **Serviços externos.** Entrar com o Google, e-mail, cobrança (Asaas, Woovi), mídia (R2), cron e fila não rodam aqui. A sessão das lojas vem do `testUtils` do Better Auth, no Node, com o segredo do run.
- **Limite de taxa.** 120 escritas por minuto por sessão e endereço. Cada loja tem o seu `cf-connecting-ip`; um drive que cria dezenas de itens em sequência pode receber 429.
- **Data.** As vendas semeadas em dias anteriores aparecem como "Retroativa" no Histórico, e o primeiro item da lista da loja `vendas` recém-semeada é a de 6 dias atrás (a última registrada pela semeadura), não a de hoje.
