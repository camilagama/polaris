# t1077 · capturas (PR 874)

Pilha real do e2e-real (runtime-ligado/online, PG descartável), fullPage, Chromium, 360x740 e 1280x800, claro e escuro.

- `cartao-com-chip-e-link-*` e `cartao-sem-chip-com-link-*` (t1094, rodada 1): código do commit 4bd6d5a (o chip e o link sob ele; sem chip o link na linha de apoio). Lê-se um dia no minigráfico: sem captura, medido no e2e (a altura do cartão não muda).
- Os demais (`cartao-com-link`, `cartao-uma-venda`, `cartao-sem-vendas`, `cartao-sem-conexao`, `historico-*`, `medidas.json`): código do commit 9089794 da t1077; nada que eles mostram mudou na rodada 1 (a loja de teste deles não tem período anterior, então sem chip).
- Não há captura de "carregando" nem "erro": o PR não muda esses estados.
