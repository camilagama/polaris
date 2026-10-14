# Direção de design do Polaris

## Sensação do produto

A direção visual é **Minimalismo Essencial**: uma interface operacional, densa o suficiente para o trabalho diário sem parecer carregada.

- Priorizar hierarquia clara e organização orientada a dados.
- Usar superfícies simples e pouca decoração.
- Facilitar a leitura de rótulos, totais e estados.
- Oferecer interação acessível e temas claro e escuro.
- Tratar explicitamente estados vazios, carregamento, sucesso e erro.

## Limite deste documento

Este arquivo define direção visual e de interação, não bibliotecas. Os primeiros tokens de interface foram definidos abaixo para o módulo Categories e podem ser estendidos por telas futuras.

## Tokens iniciais — Categories

O PR24 aplica a direção Minimalismo Essencial à primeira interface de catálogo:

- Corpo usa a pilha sans-serif do sistema para leitura densa; títulos usam Georgia como acento editorial discreto.
- Tema claro: canvas `#f4f2eb`, superfície `#fffefa`, texto `#18221d`, linha `#d9dfd8` e acento verde `#17654d`.
- Tema escuro: canvas `#111915`, superfície `#1b2520`, texto `#e8f0eb`, linha `#35453c` e acento verde `#7fc7a5`.
- Erros usam vermelho terroso; estados ativos, arquivados e removidos têm rótulos e cores distintas, sempre com texto além da cor.
- Tabelas viram cartões em telas estreitas. Controles mantêm foco visível, rótulos explícitos e estados de carregamento, vazio, sucesso e erro.

## Catálogo — Variantes

- O formulário permite selecionar Modelo, Cor e Tamanho, informar valores legíveis e adicionar combinações manualmente.
- Combinações nunca são geradas automaticamente. Cada linha mostra uma escolha por opção selecionada e o total visível respeita o limite de 50.
- A lista de variantes mantém a ordem de cadastro, com a variante padrão oculta enquanto o produto não foi configurado.
- Depois da configuração inicial, a interface apresenta as combinações em leitura; edição ou remoção aguarda regras para preservar referências futuras de SKU e estoque.
- A configuração deve manter rótulos explícitos, validação junto aos campos e navegação por teclado nos temas claro e escuro.
