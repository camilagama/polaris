# Direção de design do Polaris

## Autoridade

Este documento é a fonte de verdade para a **direção visual, os tokens de interface, as telas e o comportamento de interação**. Termos estão em [CONTEXT.md](CONTEXT.md), invariantes de negócio em [docs/business-rules/](docs/business-rules/), estrutura do sistema em [docs/architecture/](docs/architecture/) e a sequência de implementação em [doc/plano-inicial.md](doc/plano-inicial.md). Regras de negócio não descrevem comportamento de interface; ele vive aqui.

Seções marcadas como "diretriz" descrevem o que foi decidido para telas e navegação que ainda não existem; elas não afirmam que o código já as implementa. O resto descreve o que existe em `apps/web/src`.

## Sensação do produto

A direção visual é **Minimalismo Essencial**: uma interface operacional, densa o suficiente para o trabalho diário sem parecer carregada.

- Priorizar hierarquia clara e organização orientada a dados.
- Usar superfícies simples e pouca decoração.
- Facilitar a leitura de rótulos, totais e estados.
- Oferecer interação acessível e temas claro e escuro.
- Tratar explicitamente estados vazios, carregamento, sucesso e erro.

Este arquivo define direção visual e de interação, não bibliotecas.

## Tokens

Os tokens vivem como variáveis CSS `--category-*` no contêiner `.categories-page` de `apps/web/src/catalog/categories-page.css` e são reutilizados por todas as telas, que importam esse arquivo e usam `categories-page` na raiz. A tela de perfis de pagamento redefine os mesmos valores com o prefixo `--payment-*`; a duplicação é dívida a eliminar, e os valores são idênticos.

| Token | Tema claro | Tema escuro | Uso |
| --- | --- | --- | --- |
| canvas | `#f4f2eb` | `#111915` | Fundo da página. |
| surface | `#fffefa` | `#1b2520` | Painéis, campos e cartões. |
| surface-muted | `#f7f6f0` | `#202d27` | Cabeçalhos de tabela, itens aninhados, estados neutros. |
| ink | `#18221d` | `#e8f0eb` | Texto principal. |
| muted | `#607067` | `#a0b0a6` | Texto de apoio, rótulos secundários. |
| line | `#d9dfd8` | `#35453c` | Bordas e divisores. |
| accent | `#17654d` | `#7fc7a5` | Ação, foco, estado ativo e confirmado. |
| accent-strong | `#104b39` | `#a3dfbf` | Texto sobre fundo `accent-soft`, hover. |
| accent-soft | `#e5f0e9` | `#243d31` | Fundos de estado ativo e sucesso. |
| warning / warning-soft | `#785c1d` / `#f5efd9` | `#dfc57d` / `#3d3623` | Estados arquivado, aviso, custo ou taxa desconhecidos. |
| danger / danger-strong / danger-soft | `#a84038` / `#842e29` / `#f7e9e6` | `#f09a8e` / `#ffb4a7` / `#452b2a` | Erro, cancelamento, ações destrutivas. |
| shadow | `0 18px 52px rgb(26 43 34 / 8%)` | `0 18px 52px rgb(0 0 0 / 22%)` | Painéis elevados. |

- **Tema:** segue `prefers-color-scheme`, declarado com `color-scheme` na raiz da tela. Não há alternância manual. No tema claro, o botão primário usa o verde escuro fixo (`#17654d`, hover `#104b39`) com texto branco. No tema escuro, esse verde mal se distingue do cartão (`#1b2520`, 2,26:1), então o primário usa `--ui-accent` (`#7fc7a5`, hover `--ui-accent-strong` `#a3dfbf`) com texto `--ui-canvas` (`#111915`): 7,97:1 contra o cartão e 9,04:1 do texto sobre o botão (11,81:1 no hover). A meta `theme-color` do documento é fixa em claro (`#ffffff`).
- **Tipografia:** corpo na pilha sans-serif do sistema (`system-ui`); títulos de página e de painel em Georgia, como acento editorial discreto. Título de página `clamp(2.25rem, 5vw, 3.6rem)` com peso 500; títulos de painel entre 1,15 rem e 1,55 rem; campos e texto de tabela entre 0,86 rem e 0,94 rem; rótulo de campo 0,83 rem com peso 700; sobretítulo (eyebrow) 0,74 rem em maiúsculas com espaçamento de 0,11 em; cabeçalho de tabela 0,7 rem em maiúsculas; identificadores em monoespaçada. Valores monetários e quantidades usam `font-variant-numeric: tabular-nums`.
- **Forma e espaço:** conteúdo em `min(100% - 2rem, 76rem)`, com margem de 1 rem em telas estreitas; raio de 0,55 rem em campos e botões, 0,65 rem em blocos internos, 0,85 a 0,9 rem em painéis e 999 px em selos de estado.
- **Movimento:** painéis entram com um desvanecer de 220 ms apenas sob `prefers-reduced-motion: no-preference`. Não há outras animações.

## Estados e feedback

- Toda tela trata carregamento (`aria-busy` na lista ou texto de status), vazio (texto explicativo, sem ilustração), erro e sucesso.
- Mensagens de erro usam `role="alert"`; avisos de estado, confirmações e carregamento usam `role="status"`; resultados que mudam sem foco (totais, resumo) usam `aria-live="polite"`.
- Estados de ciclo de vida (ativo, arquivado, removido, confirmada, cancelada, com devoluções) aparecem como selo com texto e cor; **nunca só cor**.
- Validação fica junto do campo (`aria-invalid` e texto de erro associado por `aria-describedby`); campos desabilitados mostram opacidade reduzida e cursor de bloqueio.
- Ações que alteram dados mostram o estado pendente no próprio botão e impedem reenvio.
- **Ação irreversível em duas etapas:** cancelamento e devolução pedem os campos, depois um resumo do efeito ("isso não poderá ser desfeito") e só então a confirmação, com opção de voltar.
- **Resultado desconhecido** (falha de rede, 5xx) trava a tentativa: o formulário não é editável, só a repetição exata da mesma tentativa é oferecida, e descartar exige uma segunda confirmação que avisa que a operação pode já ter sido registrada. Falhas definitivas com motivo explicam a causa e liberam a edição, que gera uma nova tentativa. O contrato de repetição está em [vendas](docs/business-rules/sales.md).
- **Custo ou taxa desconhecidos** nunca aparecem como zero: usam texto explícito, estilo itálico com borda tracejada e a cor de aviso.

## Responsividade e toque

- Largura mínima suportada: 360 px (o `body` tem `min-width: 320px`). Nenhuma tela foi verificada em navegador a 360 px; a verificação é pendência antes da Fase 5.
- Pontos de quebra: 560 px (topo e grades da venda em coluna), 600 px (mídia), 640 px (tabela de devolução), 760 px (catálogo, produtos, clientes e categorias: tabelas viram cartões), 900 px (venda e perfis de pagamento em uma coluna; o resumo da venda deixa de ser fixo).
- Tabelas viram cartões em telas estreitas, com o rótulo de cada coluna repetido por `data-label`; o cabeçalho continua disponível a leitores de tela.
- **Alvo de toque:** controles interativos devem ter pelo menos 44 px (2,75 rem) de altura. Campos de texto e seletores de formulário (2,8 rem) e abas (2,75 rem) cumprem. Ficam abaixo e devem ser corrigidos: botões primário, silencioso e de perigo (2,7 rem, 43 px), navegação superior (2,15 rem), botão de texto de perigo (2,3 rem), campo de renomear categoria (2,45 rem), campo de quantidade da devolução (2,4 rem), seletor de regra de pagamento (2,65 rem), opção de variante da mídia (2,5 rem) e as caixas de seleção e links de texto da venda.

## Acessibilidade

- Foco visível em todos os controles: contorno de 3 px na cor `accent`, com deslocamento de 2 a 3 px.
- Todo campo tem rótulo explícito (`label` associado ou `legend` de grupo); grupos de campos usam `fieldset`.
- Navegação por teclado em todo o fluxo. O recorte da mídia tem um rótulo ("Área de recorte. Arraste ou use as setas para ajustar.") e responde às setas, mas não expõe `aria-valuetext` e usa `touch-action: none` no arraste.
- Contraste: tokens definidos para os dois temas; não foi feita medição formal de contraste.
- Texto de interface em português do Brasil (`lang="pt-BR"`); valores em BRL.
- Não há `ErrorBoundary`, carregamento por rota nem página 404; erros de renderização derrubam a tela.

## Navegação

**Hoje**, cada página monta o próprio topo (marca "Polaris" e navegação em barra de links). Há duas variações da mesma barra: Categorias, Produtos, Clientes e Perfis de pagamento nas telas de catálogo; essas e mais "Nova venda", "Histórico" e "Cliente da venda" nas telas de venda. A rota `/` abre Categorias. O item atual usa `aria-current="page"`. A organização usada pelas telas vem de `localStorage` e é gravada pelo onboarding; sem ela, cada tela mostra um cartão "Abra uma organização". A tela "Cliente da venda" pede o identificador da venda digitado.

**Diretriz (decidida na revisão do checkpoint Gate 4, 13/10/2026, ainda não implementada):** um único shell de aplicação compartilhado por todas as telas, com a mesma navegação e o item atual marcado; a organização resolvida a partir da sessão (RPC `organization.listMine`), sem valor digitado; a entrada de uma venda a partir do histórico, sem pedir identificador; e uma página inicial operacional em vez de Categorias. A tela de entrada (`/entrar`) existe fora desse shell (ver "Tela de entrada").

## Tela de entrada

`/entrar` fica fora do shell: sem menu, sem organização e sem o runtime offline (ninguém entrou ainda). É um cartão central com a marca, o título "Entrar no Polaris", a frase de apoio e o botão "Continuar com o Google" (G nas cores originais, embutido no código, sem imagem externa). Fonte: ADR 0100 e o corte da tela de entrada.

- **Parâmetros do endereço:** só `voltar` (destino validado, nunca `/entrar` nem um caminho do Worker como `/api` e `/rpc`), `motivo` (`sessao` ou `recente`) e `erro` (`google`, `limite` ou `indisponivel`). Valor desconhecido mostra a tela padrão e nunca é refletido. A tela não guarda nada no navegador.
- **Estados:** pronta; abrindo o Google (botão pendente, `aria-busy`, um clique só); entrando (volta do Google ou quem já está dentro, `role="status"`); erro do Google, limite e indisponível (`role="alert"`, o foco vai ao aviso, mesmo texto para qualquer causa); sem conexão (aviso, botão desabilitado, volta sozinho com o evento `online`); sessão acabou e "por segurança, entre de novo" (frase acima do botão); Google desligado no servidor (botão desabilitado e aviso).
- **Alvos e cores:** botão de 48 px, links de 44 px, foco de 3 px, erro com texto e ícone (nunca só cor), tokens claro e escuro. Os links da política de privacidade e dos termos ficam atrás de uma constante até as páginas legais existirem (`LEGAL_PAGES_PUBLISHED`).
- **Dentro do app:** quando o servidor responde que a sessão acabou, o shell mostra o aviso "Sua sessão acabou. Entre de novo para continuar." com o botão "Entrar de novo" (e, se há texto digitado, o aviso de que ele pode se perder). Na abertura do app, o 401 de `organization.listMine` leva sozinho a `/entrar?motivo=sessao&voltar=<tela>`.

## Telas existentes

### Categorias (`/`)
Lista com abas Ativas, Arquivadas e Removidas; formulário de criação; renomear em linha, arquivar, restaurar e remover. Remover pede confirmação em linha e explica que o registro permanece como tombstone, sem restauração. Estados ativo, arquivado e removido têm selo com texto e cor.

### Produtos (`/products`)
Formulário de cadastro e edição (nome, descrição, categoria) e lista ativa ou arquivada com selo de estado. O formulário de variantes permite escolher Modelo, Cor e Tamanho, informar valores legíveis e adicionar combinações manualmente. Combinações nunca são geradas automaticamente; cada linha mostra uma escolha por opção selecionada e o total visível respeita o limite de 50. A ordem de cadastro é preservada e a variante padrão fica oculta enquanto o produto não foi configurado. Depois da configuração inicial, as combinações aparecem em leitura. A tela não tem estoque: a interface avisa que o estoque será definido em uma etapa própria.

### Catálogo público (`/public-catalog`)
Item do menu "Catálogo público". Três cartões: **Perfil público** (nome público, endereço, descrição com contador de 280 caracteres, WhatsApp e Instagram; o endereço acompanha o nome, sem acentos e com hífens, até a pessoa digitar o seu; o texto de ajuda mostra o endereço completo; "Salvar perfil" só habilita quando algo mudou), **Catálogo** (o estado em uma frase: "No ar", "Fora do ar" ou "Ligado, mas fora do ar" quando o plano não inclui o catálogo; botão "Ligar catálogo" ou "Desligar catálogo", desabilitado enquanto o perfil tem mudanças não salvas; o link para abrir o catálogo só aparece no ar) e **Produtos** (lista dos produtos ativos, cada um com "Mostrar no catálogo" ou "Tirar do catálogo", e "Mostrar todos" e "Tirar todos"). Fora do plano, a tela mostra um aviso, mostra o que está guardado e só deixa desligar e tirar. Erros e recusas em português (endereço em uso, reservado ou inválido, versão antiga, plano). Ver [public-catalog.md](docs/business-rules/public-catalog.md).

### Mídia do produto
Painel dentro do produto: envio de imagem (JPEG, PNG, WebP e HEIC/HEIF), área de recorte com arraste ou setas, escolha das variantes que usam a imagem e lista das imagens com miniatura de 4,5 rem. A imagem é servida por rota autorizada, nunca por URL pública. Mensagens de erro e de sucesso seguem os papéis `alert` e `status`. Cada imagem da lista tem "Para antes" e "Para depois" (nomes acessíveis "Mover imagem N para antes" e "Mover imagem N para depois", desabilitados nas pontas; cada movimento envia a ordem inteira e a lista volta do servidor), "Remover" e "Substituir". Remover e substituir pedem confirmação na própria linha (`alertdialog`): remover diz que a imagem sai do produto e libera um lugar no plano; substituir remove a imagem agora e leva ao campo de arquivo, e uma caixa de estado permanente diz que o produto tem uma imagem a menos até o envio, com "Desistir da substituição" (se o envio falha, o aviso fica). Enquanto um comando ou envio roda, todas as ações de imagem ficam desabilitadas; depois de mover, o foco volta ao botão da mesma imagem, depois de remover vai ao título da lista e depois de substituir vai ao campo de arquivo. O aviso de que o produto ficou com uma imagem a menos vale enquanto a tela está aberta. Uma lista desatualizada (`invalid_media_order`) recarrega sozinha com a mensagem "A lista de imagens mudou em outro lugar"; o limite do plano pede para remover uma imagem, sem preços. Nenhum código aparece na tela.

### Clientes (`/customers`)
Formulário (nome e pelo menos um contato: telefone ou e-mail; observações), lista ativa ou arquivada, arquivar e restaurar. Ao criar, a tela consulta possíveis duplicados e mostra "Encontramos possíveis clientes existentes", com as opções de usar o existente (abre para revisão, sem mesclar) ou criar mesmo assim. Dados do cliente nunca vão para a URL.

### Perfis de pagamento (`/payment-profiles`)
Formulário de perfil com regras por método, parcelamento, prazo esperado e taxas (processamento e antecipação: desconhecida, zero, fixa, percentual ou fixa mais percentual), lista de perfis em cartões com opção de mostrar arquivados, e estado vazio "Nenhum perfil cadastrado". Editar usa a versão vista (conflito de versão é reportado).

### Despesas (`/expenses`)
Só com conexão. Texto de abertura que diz que a despesa pertence ao mês de competência (não à data do pagamento), que comprar estoque não é despesa e que taxas de cartão e antecipação já registradas na venda não são lançadas de novo. Formulário de lançamento (valor em reais, que aceita "1.500,50" e recusa mais de duas casas, categoria agrupada por grupo, data de competência, favorecido opcional e descrição); erros aparecem junto do campo e o foco vai ao primeiro campo inválido. A lista é por mês de competência (anterior, próximo e seletor de mês), com filtro de categoria e abas Ativas e Anuladas, o "Total do período" que vem do servidor e cobre todas as páginas, e "Carregar mais". Cada despesa tem Editar e Anular; a anulada é somente leitura e tem Reativar. Uma edição sobre versão antiga mostra o conflito, recarrega e fecha o formulário. O painel recolhível "Despesas recorrentes" lista as regras (frequência, valor, categoria, início, fim, "Próxima: …" ou "Série encerrada", e "Pausada" com "Geração suspensa até retomar"), com Editar (frequência e início só de leitura, com a explicação de que mudar o calendário é criar outra regra) e Pausar ou Retomar, e um formulário para criar regra; as despesas geradas mostram o selo "Recorrente". O painel recolhível "Categorias de despesa" lista por grupo, com Renomear, Arquivar e Restaurar, e um formulário para criar categoria num grupo.

### Resultado (`/dashboard`)
Só com conexão e só o confirmado. Seletor de mês (anterior, próximo e `type=month`, com o mês corrente no fuso da organização), seis cartões (Vendas líquidas, Resultado estimado, Margem, Vendas, Ticket médio e Itens vendidos; valor ausente aparece como "—") e a tabela "Como chegamos a este resultado", que segue a cadeia de vendas brutas a resultado estimado e marca, na própria linha, o que ficou de fora por custo ou taxa desconhecidos. O resultado é sempre "estimado", nunca lucro líquido nem caixa liquidado. O aviso de qualidade diz em frases, com os números, o que não entrou na conta (itens sem custo, vendas sem taxa de processamento ou de antecipação, nenhuma despesa no período com vendas); quando a qualidade é parcial o resultado leva a etiqueta "estimativa incompleta", e quando está completa aparece um aviso discreto. Estados de carregamento, erro com nova tentativa e período vazio; uma resposta atrasada nunca sobrescreve a mais nova. Com o resultado lido do servidor aparece a linha discreta "Atualizado até dd/mm/aaaa HH:mm" (horário do servidor, no fuso da organização). Quando o servidor não responde (sem conexão ou fora do ar), com a chave offline ligada e uma cópia do mês pedido, aparece o aviso "Não foi possível falar com o servidor. Mostrando o último resultado confirmado, de dd/mm/aaaa às HH:mm" dizendo que vendas e despesas posteriores, ou ainda não enviadas deste aparelho, não estão nestes números (e quantas operações guardadas ainda não entram); o painel de metas continua só com conexão. Uma recusa do servidor (sessão, permissão) nunca cai na cópia.

### Metas (painel dentro de Resultado)
Painel recolhível sob a tabela do resultado. Metas ativas em cartões (nome ou indicador, período, alvo, progresso com valor e percentual e uma barra acessível limitada a 100%; resultado negativo mostra 0%), com Editar meta (nome e alvo), Histórico do alvo ("de X para Y em dd/mm/aaaa") e Cancelar meta com confirmação em duas etapas. Abaixo, as metas finais (Concluída, Não atingida, Cancelada), somente leitura, com o valor atingido e a data em que foram liquidadas; uma dica diz que uma meta concluída continua concluída mesmo que devoluções posteriores baixem os números. Uma meta que ainda não começou mostra "Começa em dd/mm/aaaa". Formulário de criação com indicador, nome opcional, período (padrão o mês exibido) e alvo.

### Nova venda (`/sales`)
Formulário único em duas colunas (principal e resumo fixo; uma coluna até 900 px). Seções: itens (produto, variante, quantidade, preço de tabela e preço cobrado, com aviso de estoque nos tons ok, aviso ou neutro), ajustes (desconto, acréscimo, frete e sobretaxa de pagamento, fixos ou percentuais), data e hora opcional da venda (`datetime-local`, com dica e "Usar agora"; a interface rotula "Venda retroativa" comparando com o dia local do dispositivo, que pode errar perto da meia-noite, e o servidor decide) e pagamento (método, perfil, parcelas e modalidade, intenção de antecipar). A prévia de taxas e prazo é informativa; mudar o perfil exibe um aviso e exige "Revisei a prévia atualizada". O resumo mostra linhas, subtotal, ajustes e total devido com totais em `aria-live`. O botão "Atualizar produtos, estoque e perfis" recarrega os dados. Nada é salvo como rascunho. A confirmação mostra um painel de venda confirmada com as três datas; o estado de resultado desconhecido segue a regra acima. O catálogo ainda não tem preço, então o operador digita os dois preços em cada item; a lembrança local do último preço por variante é diretriz decidida ([ADR 0026](docs/adr/0026-ui-de-estoque-organizacao-pela-sessao-e-preco-de-tabela.md)).

### Histórico (`/sales/history`) e detalhe (`/sales/detail?saleId=…`)
O histórico lista as vendas confirmadas e canceladas, com selos de estado ("Confirmada", "Cancelada", "Com devoluções"), total, método, cliente e data da venda, e abre o detalhe. Não há filtro nem busca; a paginação usa "Carregar mais". O detalhe mostra o snapshot completo, as três datas, o cancelamento (quando houver, com nota de que o registro original foi preservado) e a lista de devoluções com linhas. O identificador da venda fica na URL por não ser dado pessoal.

### Cancelamento
Painel do detalhe: explica o efeito, pede motivo opcional (nota obrigatória para "outro"), mostra um resumo com a frase de irreversibilidade e só então confirma, com "Voltar".

### Devolução
Painel do detalhe: tabela com uma linha por item, mostrando vendido, já devolvido e disponível, e dois campos numéricos (devolvido e reposto). Em telas estreitas a tabela vira cartões. Motivo estruturado opcional, resumo de confirmação e confirmação em duas etapas.

### Cliente da venda (`/sales/customer`)
Associar, trocar ou remover o cliente de uma venda confirmada, com a versão vista e a lista de clientes ativos. Hoje a tela pede o identificador da venda digitado.

### Laboratório offline (`/offline-poc`)
Rota de desenvolvimento e de build de prova, com CSS próprio; não faz parte do produto e sai do bundle de produção ([ADR 0027](docs/adr/0027-separacao-de-roles-auth-tenant-e-superficies-poc.md)).

## Catálogo público (`apps/catalog`)

Aplicação separada do ERP, sem login, com as mesmas cores e tipografia (tokens repetidos no próprio app, claro por padrão e escuro pelo sistema). Três páginas: `/<endereço>` (nome, descrição e contatos da loja, e a grade de produtos com o menor preço de tabela como "a partir de R$ …"; "Ver mais produtos" avança por cursor), `/<endereço>/p/<produto>` (nome, descrição e cada variante com rótulo e preço) e `/` (aviso para abrir o endereço de uma loja, fora dos resultados de busca). Uma loja que não está sendo exibida, por qualquer motivo, mostra a mesma página "não encontrada" (404) de uma que nunca existiu. Cada página tem título, descrição, endereço canônico e pré-visualização social (Open Graph e Twitter); cada produto mostra a primeira imagem como capa (quadrada, carregada sob demanda) e a página do produto mostra todas as imagens em ordem, com largura e altura declaradas para não deslocar o texto; a imagem de pré-visualização social é a primeira do produto (ou a capa do primeiro produto com imagem, na loja). Contatos viram links (WhatsApp, Instagram).

## Estoque (diretriz)

Decidido na revisão do checkpoint Gate 4 (13/10/2026) e ainda não implementado ([ADR 0026](docs/adr/0026-ui-de-estoque-organizacao-pela-sessao-e-preco-de-tabela.md)). As telas consomem os commands existentes, sem alterar o domínio, e seguem os tokens e os estados deste documento:

- **Saldo por variante:** quantidade, custo médio e versão do saldo; custo desconhecido aparece como texto explícito, nunca como zero.
- **Receber:** custo unitário em BRL, data de ocorrência, identificador de comando gerado pela tela.
- **Baixar:** quantidade, motivo da lista fixa e nota (obrigatória para "outro"), sem permitir saldo negativo.
- **Contar:** quantidade física; conflito de versão reapresenta o saldo atualizado, e o valor de valoração só é oferecido quando o custo é desconhecido e a quantidade é positiva.
- **Histórico por variante:** movimentos do ledger em ordem de confirmação, somente leitura.
- Mensagens de erro de domínio traduzem o código estável (`data.reason`) em texto compreensível, como na venda.
- A navegação de estoque entra no shell único descrito acima.

## Lacunas conhecidas

- Nenhuma tela foi verificada em navegador a 360 px nem no iPhone nesta fase; as telas de cancelamento, devolução e datas da venda só têm testes dos modelos de visão.
- Alvos de toque abaixo de 44 px listados acima; CSS compartilhado vive em `categories-page.css` e há uma cópia de tokens em perfis de pagamento.
- Sem `ErrorBoundary`, carregamento por rota ou 404; `theme-color` fixo em claro; recorte de mídia sem `aria-valuetext`.
- Histórico de vendas sem filtro nem busca (a paginação usa "Carregar mais"); a lista mostra o momento comercial e só o detalhe mostra as três datas.
