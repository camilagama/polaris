# Relógio nos testes do `apps/web`

Um teste que lê o relógio real passa hoje e quebra no dia 1 do mês, depois da meia-noite de São Paulo ou na virada do ano. A regra é o teste fixar o próprio relógio (`vi.useFakeTimers({ now, toFake: ["Date"] })`) e derivar as datas do mesmo `now`.

## Varredura local, fora do CI

`bun run --cwd apps/web test:web:datas` roda a suíte vitest do `apps/web` em 4 instantes, cada um com `TZ=America/Sao_Paulo` e com `TZ=UTC` (8 rodadas de mais de 7 min cada; o script inteiro passa de 1 h, então rode uma combinação por vez com `--instante` e `--tz` se o seu terminal limita o tempo do comando):

| Instante | Valor (UTC) | Em São Paulo |
| --- | --- | --- |
| `inicio-do-mes` | `2026-11-01T03:30:00Z` | dia 1, 00:30 |
| `fim-do-mes` | `2026-12-01T02:50:00Z` | último dia do mês, 23:50 |
| `virada-do-ano` | `2027-01-01T02:50:00Z` | 31/12, 23:50 |
| `bissexto` | `2028-02-29T15:00:00Z` | 29/02, 12:00 |

- `--instante <nome>` e `--tz <fuso>` rodam uma só combinação; o que vem depois de `--` vai ao vitest (`-- apps/web/src/server/auth.test.ts`).
- Por baixo, `apps/web/vitest.clock.config.ts` carrega `apps/web/vitest.clock.setup.ts`, que lê `POLARIS_TEST_NOW` (ISO 8601 com fuso) e congela só o `Date`. O relógio fica parado: para medir duração, o teste usa `performance.now()`, nunca `Date.now()`.
- O teste que fixa o próprio relógio manda no dele, e o do setup volta antes do teste seguinte. Sem a variável, nada muda, e o `vitest.config.ts` da raiz (e o CI) não carrega o setup: no CI só roda 1 dos 5 testes de `vitest.clock.setup.test.ts` (o resto é pulado de propósito, e prova o setup só na varredura local). O mesmo arquivo confere que o `exclude` e o alias da config da varredura são os do projeto `node` da raiz.
- Com a CPU carregada, teste que estoura os 5 s do vitest pode falhar sem relação com a data: rode o arquivo sozinho no mesmo instante antes de culpar o relógio.
