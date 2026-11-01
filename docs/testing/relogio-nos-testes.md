# Relógio nos testes

Um teste que lê o relógio real passa hoje e quebra no dia 1 do mês, depois da meia-noite de São Paulo ou na virada do ano. A regra é o teste fixar o próprio relógio (`vi.useFakeTimers({ now, toFake: ["Date"] })`) e derivar as datas do mesmo `now`.

## Varredura local, fora do CI

`bun run test:datas` roda os testes de nó de `apps/web`, `apps/admin`, `apps/catalog` e `packages/*` (menos `packages/db`) em 5 instantes, cada um com `TZ=America/Sao_Paulo` e com `TZ=UTC`: 10 rodadas completas das suítes, e só a do `apps/web` passa de 7 min. O CI não a roda.

| Chave | Valor (UTC) | Em São Paulo |
| --- | --- | --- |
| `dia-1-0030` | `2026-11-01T03:30:00Z` | 01/11, 00:30 |
| `ultimo-dia-2350` | `2026-12-01T02:50:00Z` | 30/11, 23:50 |
| `virada-do-ano` | `2027-01-01T02:50:00Z` | 31/12, 23:50 |
| `bissexto-1200` | `2028-02-29T15:00:00Z` | 29/02, 12:00 |
| `fim-fev-2350` | `2027-03-01T02:50:00Z` | 28/02, 23:50 (fevereiro não bissexto) |

- `--instante <chave>` e `--tz <fuso>` rodam uma só combinação. O primeiro argumento que não é flag, ou tudo depois de `--`, é filtro de arquivo do Vitest: `bun run test:datas -- apps/web` roda só o `apps/web` nas 10 combinações (o `bun run` já descarta um `--` inicial, e o script aceita as duas formas), e `bun run test:datas --instante virada-do-ano --tz UTC -- packages/billing` roda uma.
- Flag, instante ou fuso desconhecido encerra com erro (código 2) antes de rodar qualquer coisa.
- O Vitest roda pelo `process.execPath` e pelo `node_modules/vitest`, sem `bunx`.

## Como o relógio é fixado

Tudo vive na raiz, num helper só:

- `scripts/test-datas.mjs`: o comando, que roda `vitest.datas.config.ts` uma vez por instante e fuso e imprime o resumo.
- `scripts/test-clock/instants.mjs`: os instantes, os fusos e `parseNow`.
- `scripts/test-clock/setup.mjs`: o `setupFile` que lê `POLARIS_TEST_NOW`.
- `vitest.datas.config.ts`: uma config só, com o `include` do projeto `node` da raiz (`apps/**` e `packages/**`) e `packages/db/**` no `exclude`; app novo entra sozinho, e o teste reprova se o `include` se afastar do da raiz.

Regras do setup:

- O relógio congela: só o `Date` é falseado, sem `shouldAdvanceTime`. Timers, `performance.now` e `process.hrtime` seguem reais, então o teste mede duração com `performance.now()`, nunca com `Date.now()`.
- `POLARIS_TEST_NOW` é ISO 8601 e exige `Z` ou `±hh:mm`; sem o fuso a data seria lida no fuso do processo. Valor sem fuso ou inválido derruba o carregamento do setup com erro, inclusive dia que não existe (`2026-02-30`) e `24:00`, que o `Date` empurraria para outro instante sem avisar.
- Com `POLARIS_TEST_NOW` definido, o setup também exige `TZ` definido e válido, conferido por `Intl.DateTimeFormat`: sem o fuso do processo, a data seria lida no fuso da máquina e a rodada não seria a pedida. `TZ` ausente, vazio ou inválido derruba o carregamento do setup com erro que cita `bun run test:datas`. O setup não restringe `TZ` a `FUSOS` (`TZ=America/Manaus` passa); quem escolhe os fusos da varredura é o executor. A conferência prova que o nome existe para o `Intl`, não que o processo rodou nele: o `Intl` aceita maiúsculas trocadas (`america/sao_paulo`) e `+03:00`, que o processo não usa. Por isso o valor de `TZ` vem do `test:datas`, ou é escrito igual ao nome IANA.
- O relógio é instalado ao carregar o arquivo (um `new Date()` no topo do teste já o vê) e de novo antes de cada teste, porque um teste que chama `vi.useRealTimers()` deixaria o resto do arquivo no relógio real.
- O teste que fixa o próprio relógio manda no dele. Sem a variável, o setup não faz nada.

`vitest.config.ts` da raiz (e o CI) não carrega o setup. `scripts/test-clock/setup.test.mjs` roda nos dois lugares: no CI confere que o `exclude` (mais `packages/db/**`) e o alias da config da varredura são os do projeto `node` da raiz, que os instantes caem na hora de São Paulo declarada, que `freezeClock` congela só o `Date` e que o setup recusa valor sem fuso e `TZ` ausente, vazio ou inválido ao carregar, e aceita `TZ=America/Manaus`; só na varredura, com a variável, prova que o relógio de cada teste é o pedido (5 testes pulados de propósito no CI). `scripts/test-datas.test.mjs` confere a leitura dos argumentos.

Com a CPU carregada, teste que estoura os 5 s do Vitest pode falhar sem relação com a data: rode o arquivo sozinho no mesmo instante antes de culpar o relógio.
