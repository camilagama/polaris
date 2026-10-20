# Provas por remoção de V1 e V2 — 20/10/2026

Correções da revisão de QA do T-125a (V1: devolução e cancelamento com 2 itens; V2: o "hoje" da organização no
servidor). Cada quebra foi feita na cópia de trabalho, rodada com `E2E_RETRIES=0`, `CI=true`, Node 24.21.0 e
PostgreSQL 18 local, e desfeita com `git checkout` antes da seguinte. O preview reconstrói o bundle a cada execução,
então a quebra entra no Worker servido.

| Quebra | Comando | Resultado |
| --- | --- | --- |
| Cancelamento repõe só a 1ª linha (`lockOrder.filter((l) => l.position === 0)` em `sale-cancellation-repository.ts`) | `--project=online jornadas/devolucao` | **Vermelho:** cancelamento, saldos `bottle 7, mug 8` em vez de `10, 10`. A devolução fica verde (não passa por esse arquivo). |
| Devolução repõe só a 1ª linha (o mesmo filtro em `sale-return-repository.ts`) | `--project=online jornadas/devolucao` | **Vermelho:** devolução parcial da 2ª linha (a devolução não é registrada). O cancelamento fica verde. |
| `organizationToday` em UTC (`calendarDateInTimeZone(new Date(), "UTC")` em `expense-repository.ts`) | `--project=online jornadas/despesa` | **Vermelho:** despesa recorrente, nenhuma ocorrência gerada em vez de `25000` centavos em `2026-10-21` (fuso do run: `Pacific/Kiritimati`, T0 19:09 UTC). A despesa avulsa fica verde, como a revisão apontou. |

Com a venda de uma linha só, as duas primeiras quebras passavam (a 1ª linha era a venda inteira).

O ramo de `Pacific/Pago_Pago` (runs antes das 10:00 UTC) não rodou: nesse fuso, o "hoje" em UTC é o "amanhã" local, e
a regra que começa amanhã geraria uma ocorrência, o que o mesmo teste reprova. O Pago Pago só é escolhido entre 00:00
e 10:00 UTC, e a data local dele vira às 11:00 UTC: a folga é de pelo menos 1 h.

Cada falha imprimiu `E2E_SEED=<semente>` (M1). Depois das quebras: suíte inteira verde, 2 vezes, sem retry (23 testes
e o `relogio-retry` proposital), e `node scripts/e2e-flaky-report.mjs` sem flaky.
