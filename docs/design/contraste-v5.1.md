# Contraste dos tokens da v5.1

Mapa de contraste do desenho v5.1 (Petković, 20/10/2026), trazido para o repositório pelo PR de base do [ADR 0103](../adr/0103-base-de-componentes-shadcn-base-ui-e-tailwind-4.md). Os valores dos tokens estão em `apps/web/src/styles/theme.css` (`:root` e `.dark`), e o [DESIGN.md](../../DESIGN.md) é a fonte das diretrizes.

**Como se mede.** WCAG 2.x: razão entre as luminâncias relativas, com cada token convertido de OKLCH para sRGB. Um par escrito `x/NN sobre y` é o token `x` com opacidade NN% (como a utilidade `bg-x/NN` do Tailwind) composto sobre `y`. Meta: 7:1 para texto e valores, 4,5:1 para texto menor em estado, 3:1 para borda de controle, foco e ícone; bordas decorativas ficam abaixo disso de propósito.

**O script de medição é um teste.** `apps/web/src/styles/contrast.test.ts` lê as duas tabelas abaixo, recalcula cada par a partir do `theme.css` e falha se a razão ficar abaixo da meta ou se afastar mais de 0,1 da razão escrita aqui (o script do desenho compunha as transparências de outro modo; a diferença chega a 0,08 nos pares com `x/NN`). Mudou um token: rode o teste, corrija a razão nesta tabela e, se a meta deixar de ser cumprida, troque o valor do token.

## Tema claro

| Par (texto sobre fundo) | Onde é usado | Componente | Razão | Meta | |
|---|---|---|---|---|---|
| `foreground` / `background` | texto, preço, total | body | **17.34** | 7 | ✓ |
| `card-foreground` / `card` | texto em cartão, diálogo, tabela | Card | **18.09** | 7 | ✓ |
| `popover-foreground` / `popover` | texto em menu, select, tooltip invertido | Popover, Select | **18.09** | 7 | ✓ |
| `primary-foreground` / `primary` | rótulo do botão principal | Button default | **18.09** | 7 | ✓ |
| `secondary-foreground` / `secondary` | rótulo do botão secundário | Button secondary | **16.19** | 7 | ✓ |
| `muted-foreground` / `background` | texto de apoio sobre o fundo | descrições, placeholder | **7.72** | 7 | ✓ |
| `muted-foreground` / `card` | texto de apoio em cartão (CardDescription, FieldDescription) | Card, Field | **8.06** | 7 | ✓ |
| `muted-foreground` / `muted` | texto de apoio sobre faixa neutra (Kbd, Avatar, cabeçalho) | Kbd, Avatar | **7.22** | 4.5 | ✓ |
| `muted-foreground` / `accent` | texto de apoio sobre item em foco de menu | menu | **6.85** | 4.5 | ✓ |
| `accent-foreground` / `accent` | item em foco de menu e de select | DropdownMenu, Select | **15.37** | 7 | ✓ |
| `foreground` / `muted` | texto em linha com hover e em faixa neutra | Table, Button ghost | **16.19** | 7 | ✓ |
| `sidebar-foreground` / `sidebar` | item do menu lateral | Sidebar | **9.81** | 7 | ✓ |
| `sidebar-accent-foreground` / `sidebar-accent` | item atual e item em hover do menu lateral | SidebarMenuButton | **14.78** | 7 | ✓ |
| `destructive` / `card` | texto de erro (FieldError, Alert destructive) | Field, Alert | **7.46** | 7 | ✓ |
| `destructive` / `destructive/10 sobre card` | texto de erro em Badge e Button destructive (claro: /10) | Badge, Button destructive | **6.3** | 4.5 | ✓ |
| `primary-foreground` / `destructive` | texto sobre vermelho sólido (se usado) | extensão | **7.46** | 4.5 | ✓ |
| `warning` / `card` | texto e ícone de aviso, offline, valor desconhecido | extensão | **7.6** | 7 | ✓ |
| `warning` / `warning/10 sobre card` | aviso sobre fundo de aviso (bg-warning/10) | extensão | **6.51** | 4.5 | ✓ |
| `warning-foreground` / `warning` | texto sobre aviso sólido | extensão | **7.6** | 4.5 | ✓ |
| `mark` / `card` | marcador de menu, aba e barra em destaque, sobre cartão | composição | **3.71** | 3 | ✓ |
| `mark` / `background` | marcador sobre o fundo | composição | **3.56** | 3 | ✓ |
| `mark` / `accent` | marcador sobre item atual | composição | **3.15** | 3 | ✓ |
| `mark-foreground` / `card` | texto de destaque esmeralda | composição | **8.05** | 7 | ✓ |
| `mark-foreground` / `mark/10 sobre card` | texto esmeralda sobre bg-mark/10 | composição | **7.16** | 4.5 | ✓ |
| `input` / `card` | borda de Input, Select, Checkbox, Radio, Switch desligado (cartão) | border-input | **3.36** | 3 | ✓ |
| `input` / `background` | borda de campo sobre o fundo | border-input | **3.22** | 3 | ✓ |
| `input` / `muted` | borda de campo sobre faixa neutra | border-input | **3.01** | 3 | ✓ |
| `input` / `popover` | borda de campo em diálogo e menu | border-input | **3.36** | 3 | ✓ |
| `ring` / `card` | anel de foco (borda) sobre cartão | focus-visible:border-ring | **3.95** | 3 | ✓ |
| `ring` / `background` | anel de foco sobre o fundo | focus-visible:border-ring | **3.79** | 3 | ✓ |
| `ring` / `accent` | anel de foco sobre item em foco | focus-visible:border-ring | **3.36** | 3 | ✓ |
| `sidebar-ring` / `sidebar` | anel de foco do menu lateral | ring-sidebar-ring | **3.57** | 3 | ✓ |
| `border` / `card` | divisória e borda do botão outline (decorativa; o rótulo identifica o botão) | border-border | **1.28** | 1.0 | ✓ |
| `border` / `background` | divisória sobre o fundo | border-border | **1.23** | 1.0 | ✓ |
| `chart-1` / `card` | escala do gráfico (desde a v7 não marca mais o melhor dia) | Chart | **3.71** | 3 | ✓ |
| `chart-sales` / `card` | série de vendas, anel do dia (v7) | Chart | **3.70** | 3 | ✓ |
| `chart-result` / `card` | série do resultado (v7) | Chart | **5.87** | 3 | ✓ |
| `chart-ticket` / `card` | série do ticket (v7) | Chart | **4.37** | 3 | ✓ |
| `chart-context` / `card` | série de comparação, tracejada (v7) | Chart | **3.36** | 3 | ✓ |
| `mark-foreground` / `chart-sales/12 sobre card` | chip de variação que sobe (v7) | DeltaChip | **7.06** | 4.5 | ✓ |
| `muted-foreground` / `muted` | chip de variação que cai ou fica igual (v7) | DeltaChip | **7.26** | 4.5 | ✓ |
| `chart-2` / `card` | série 2 | Chart | **3.64** | 3 | ✓ |
| `chart-3` / `card` | série 3 | Chart | **6.79** | 3 | ✓ |
| `chart-4` / `card` | série 4 | Chart | **12.27** | 3 | ✓ |
| `chart-5` / `card` | série 5 | Chart | **18.09** | 3 | ✓ |
| `primary-foreground` / `primary/88 sobre background` | rótulo do botão principal em hover (hover:bg-primary/88) | Button default, Badge default | **13.01** | 7 | ✓ |
| `destructive` / `destructive/15 sobre card` | botão destrutivo em hover (hover:bg-destructive/15) | Button destructive | **5.74** | 4.5 | ✓ |
| `warning` / `warning/10 sobre card` | texto de aviso sobre o próprio tom (Alert/Badge warning) | Alert, Badge warning | **6.51** | 4.5 | ✓ |
| `foreground` / `muted/60 sobre card` | texto de linha de tabela em hover (hover:bg-muted/60) | TableRow | **16.9** | 7 | ✓ |
| `muted-foreground` / `muted/60 sobre card` | texto de apoio em linha de tabela em hover | TableRow | **7.53** | 4.5 | ✓ |
| `muted-foreground` / `accent` | texto de apoio em item de lista em hover/foco | Item, Select, menu | **6.85** | 4.5 | ✓ |
| `foreground/70 sobre card` / `card` | borda do cartão de escolha marcado (border-foreground/70) | FieldLabel + RadioGroup | **6.68** | 3 | ✓ |
| `foreground` / `card` | rótulo do cartão de escolha marcado | FieldLabel + RadioGroup | **18.09** | 7 | ✓ |
| `ring` / `muted/60 sobre card` | foco do teclado sobre linha de tabela em hover | focus-ring | **3.69** | 3 | ✓ |
| `foreground` / `muted/60 sobre card` | texto do aviso neutro "sem link" (EntryNotice, bg-muted/60) | EntryNotice | **16.9** | 7 | ✓ |
| `muted-foreground` / `muted/60 sobre card` | ícone i do aviso neutro | EntryNotice | **7.53** | 3 | ✓ |
| `ring` / `destructive/10 sobre card` | foco do teclado sobre o alerta de erro (claro, destructive/10) | EntryAlert focus-ring | **3.34** | 3 | ✓ |
| `foreground` / `card` | texto do aviso de sucesso (EntrySuccess, fundo card) | EntrySuccess | **18.09** | 7 | ✓ |
| `foreground/15 sobre card` / `card` | borda do aviso de sucesso (border-foreground/15, decorativa) | EntrySuccess | **1.37** | 1 | ✓ |
| `popover-foreground` / `popover` | título do toast | Toast | **18.09** | 7 | ✓ |
| `muted-foreground` / `popover` | descrição do toast e X de fechar | Toast | **8.06** | 4.5 | ✓ |
| `destructive` / `popover` | ícone de erro do toast | Toast | **7.46** | 3 | ✓ |
| `warning` / `popover` | ícone de aviso do toast | Toast | **7.6** | 3 | ✓ |
| `ring` / `popover` | foco do teclado no toast | Toast | **3.95** | 3 | ✓ |
| `input` / `card` | borda da representação do widget do desafio | ChallengeSlot | **3.36** | 3 | ✓ |

## Tema escuro

| Par (texto sobre fundo) | Onde é usado | Componente | Razão | Meta | |
|---|---|---|---|---|---|
| `foreground` / `background` | texto, preço, total | body | **15.44** | 7 | ✓ |
| `card-foreground` / `card` | texto em cartão, diálogo, tabela | Card | **14.22** | 7 | ✓ |
| `popover-foreground` / `popover` | texto em menu, select, tooltip invertido | Popover, Select | **13.24** | 7 | ✓ |
| `primary-foreground` / `primary` | rótulo do botão principal | Button default | **14.75** | 7 | ✓ |
| `secondary-foreground` / `secondary` | rótulo do botão secundário | Button secondary | **11.58** | 7 | ✓ |
| `muted-foreground` / `background` | texto de apoio sobre o fundo | descrições, placeholder | **9.35** | 7 | ✓ |
| `muted-foreground` / `card` | texto de apoio em cartão (CardDescription, FieldDescription) | Card, Field | **8.61** | 7 | ✓ |
| `muted-foreground` / `muted` | texto de apoio sobre faixa neutra (Kbd, Avatar, cabeçalho) | Kbd, Avatar | **7.01** | 4.5 | ✓ |
| `muted-foreground` / `accent` | texto de apoio sobre item em foco de menu | menu | **6.33** | 4.5 | ✓ |
| `accent-foreground` / `accent` | item em foco de menu e de select | DropdownMenu, Select | **10.46** | 7 | ✓ |
| `foreground` / `muted` | texto em linha com hover e em faixa neutra | Table, Button ghost | **11.58** | 7 | ✓ |
| `sidebar-foreground` / `sidebar` | item do menu lateral | Sidebar | **9.48** | 7 | ✓ |
| `sidebar-accent-foreground` / `sidebar-accent` | item atual e item em hover do menu lateral | SidebarMenuButton | **12.41** | 7 | ✓ |
| `destructive` / `card` | texto de erro (FieldError, Alert destructive) | Field, Alert | **7.63** | 7 | ✓ |
| `destructive` / `destructive/20 sobre card` | texto de erro em Badge e Button destructive (escuro: /20) | Badge, Button destructive | **5.19** | 4.5 | ✓ |
| `primary-foreground` / `destructive` | texto sobre vermelho sólido (se usado) | extensão | **8.28** | 4.5 | ✓ |
| `warning` / `card` | texto e ícone de aviso, offline, valor desconhecido | extensão | **9.13** | 7 | ✓ |
| `warning` / `warning/10 sobre card` | aviso sobre fundo de aviso (bg-warning/10) | extensão | **7.4** | 4.5 | ✓ |
| `warning-foreground` / `warning` | texto sobre aviso sólido | extensão | **9.92** | 4.5 | ✓ |
| `mark` / `card` | marcador de menu, aba e barra em destaque, sobre cartão | composição | **7.67** | 3 | ✓ |
| `mark` / `background` | marcador sobre o fundo | composição | **8.33** | 3 | ✓ |
| `mark` / `accent` | marcador sobre item atual | composição | **5.64** | 3 | ✓ |
| `mark-foreground` / `card` | texto de destaque esmeralda | composição | **10.07** | 7 | ✓ |
| `mark-foreground` / `mark/15 sobre card` | texto esmeralda sobre bg-mark/15 (escuro) | composição | **7.66** | 4.5 | ✓ |
| `input` / `card` | borda de Input, Select, Checkbox, Radio, Switch desligado (cartão) | border-input | **3.42** | 3 | ✓ |
| `input` / `background` | borda de campo sobre o fundo | border-input | **3.71** | 3 | ✓ |
| `input` / `popover` | borda de campo em diálogo e menu | border-input | **3.18** | 3 | ✓ |
| `ring` / `card` | anel de foco (borda) sobre cartão | focus-visible:border-ring | **5.28** | 3 | ✓ |
| `ring` / `background` | anel de foco sobre o fundo | focus-visible:border-ring | **5.73** | 3 | ✓ |
| `ring` / `accent` | anel de foco sobre item em foco | focus-visible:border-ring | **3.88** | 3 | ✓ |
| `sidebar-ring` / `sidebar` | anel de foco do menu lateral | ring-sidebar-ring | **6.03** | 3 | ✓ |
| `border` / `card` | divisória e borda do botão outline (decorativa; o rótulo identifica o botão) | border-border | **1.32** | 1.0 | ✓ |
| `border` / `background` | divisória sobre o fundo | border-border | **1.43** | 1.0 | ✓ |
| `chart-1` / `card` | escala do gráfico (desde a v7 não marca mais o melhor dia) | Chart | **7.67** | 3 | ✓ |
| `chart-sales` / `card` | série de vendas, anel do dia (v7) | Chart | **5.72** | 3 | ✓ |
| `chart-result` / `card` | série do resultado (v7) | Chart | **4.38** | 3 | ✓ |
| `chart-ticket` / `card` | série do ticket (v7) | Chart | **4.89** | 3 | ✓ |
| `chart-context` / `card` | série de comparação, tracejada (v7) | Chart | **3.44** | 3 | ✓ |
| `mark-foreground` / `chart-sales/12 sobre card` | chip de variação que sobe (v7) | DeltaChip | **8.62** | 4.5 | ✓ |
| `muted-foreground` / `muted` | chip de variação que cai ou fica igual (v7) | DeltaChip | **7.05** | 4.5 | ✓ |
| `chart-2` / `card` | série 2 | Chart | **4.22** | 3 | ✓ |
| `chart-3` / `card` | série 3 | Chart | **6.69** | 3 | ✓ |
| `chart-4` / `card` | série 4 | Chart | **9.85** | 3 | ✓ |
| `chart-5` / `card` | série 5 | Chart | **14.22** | 3 | ✓ |
| `primary-foreground` / `primary/88 sobre background` | rótulo do botão principal em hover (hover:bg-primary/88) | Button default, Badge default | **11.6** | 7 | ✓ |
| `destructive` / `destructive/20 sobre card` | botão destrutivo e selo de erro no escuro (dark:bg-destructive/15, hover /20) | Button destructive, Badge destructive | **5.19** | 4.5 | ✓ |
| `warning` / `warning/10 sobre card` | texto de aviso sobre o próprio tom (Alert/Badge warning) | Alert, Badge warning | **7.4** | 4.5 | ✓ |
| `foreground` / `muted/60 sobre card` | texto de linha de tabela em hover (hover:bg-muted/60) | TableRow | **12.57** | 7 | ✓ |
| `muted-foreground` / `muted/60 sobre card` | texto de apoio em linha de tabela em hover | TableRow | **7.61** | 4.5 | ✓ |
| `muted-foreground` / `accent` | texto de apoio em item de lista em hover/foco | Item, Select, menu | **6.33** | 4.5 | ✓ |
| `foreground` / `secondary/60 sobre card` | rótulo do botão de contorno no escuro (dark:bg-secondary/60) | Button outline | **12.57** | 7 | ✓ |
| `input` / `input/30 sobre card` | borda do campo contra o próprio fundo (dark:bg-input/30) | Input, Select | **2.44** | 1.5 | ✓ |
| `foreground` / `input/30 sobre card` | texto digitado no campo (dark:bg-input/30) | Input, Select | **10.15** | 7 | ✓ |
| `muted-foreground` / `input/30 sobre card` | texto de apoio (placeholder) no campo (dark:bg-input/30) | Input, Select | **6.15** | 4.5 | ✓ |
| `foreground/70 sobre card` / `card` | borda do cartão de escolha marcado (border-foreground/70) | FieldLabel + RadioGroup | **7.59** | 3 | ✓ |
| `foreground` / `card` | rótulo do cartão de escolha marcado | FieldLabel + RadioGroup | **14.22** | 7 | ✓ |
| `ring` / `muted/60 sobre card` | foco do teclado sobre linha de tabela em hover | focus-ring | **4.67** | 3 | ✓ |
| `foreground` / `muted/60 sobre card` | texto do aviso neutro "sem link" (EntryNotice, bg-muted/60) | EntryNotice | **12.57** | 7 | ✓ |
| `muted-foreground` / `muted/60 sobre card` | ícone i do aviso neutro | EntryNotice | **7.61** | 3 | ✓ |
| `ring` / `destructive/15 sobre card` | foco do teclado sobre o alerta de erro (escuro, destructive/15) | EntryAlert focus-ring | **4.01** | 3 | ✓ |
| `foreground` / `card` | texto do aviso de sucesso (EntrySuccess, fundo card) | EntrySuccess | **14.22** | 7 | ✓ |
| `foreground/15 sobre card` / `card` | borda do aviso de sucesso (border-foreground/15, decorativa) | EntrySuccess | **1.54** | 1 | ✓ |
| `popover-foreground` / `popover` | título do toast | Toast | **13.24** | 7 | ✓ |
| `muted-foreground` / `popover` | descrição do toast e X de fechar | Toast | **8.02** | 4.5 | ✓ |
| `destructive` / `popover` | ícone de erro do toast | Toast | **7.1** | 3 | ✓ |
| `warning` / `popover` | ícone de aviso do toast | Toast | **8.5** | 3 | ✓ |
| `ring` / `popover` | foco do teclado no toast | Toast | **4.92** | 3 | ✓ |
| `input` / `card` | borda da representação do widget do desafio | ChallengeSlot | **3.42** | 3 | ✓ |

Notas:

- `--border` (1,28:1 sobre o cartão e 1,23:1 sobre o fundo, no claro) é **decorativo**; nenhum controle depende dele. Campo, seletor e escolha usam `--input` (≥ 3:1) ou `--foreground`.
- O foco do teclado é `--ring` cheio (3,36 a 5,73:1 contra fundo, cartão, menu e hover): é o que conta, o halo dos campos é só reforço.
- Estados com transparência estão na lista; nenhum cai abaixo da meta.
- Rampa do mapa de calor (`--chart-heat-1` a `-4`, v7, ainda sem tela): monótona, um matiz, passos de 1,42 / 1,55 / 1,86 (claro) e 1,69 / 1,74 / 1,76 (escuro) entre níveis vizinhos. O nível 1 tem 1,39:1 sobre o cartão no claro: a escala é sequencial e o tom mais claro recua para o fundo de propósito; o dia sem venda não depende dele, porque é outra forma (quadrado vazio com contorno). Fica fora da tabela testada por isso.
