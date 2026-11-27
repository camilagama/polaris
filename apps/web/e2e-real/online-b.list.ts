/**
 * The journeys of the `online` project that run in the second `online` part of the CI job (project `online-b`):
 * the same preview and the same build as `online`, only a different set of files, so each part of the job finishes
 * in about the same time. The files that are not listed here stay in `online`, and so does any new journey: add it
 * to this list when the two parts drift apart (`online-b.list.test.ts` keeps the list true to the folder).
 */
export const ONLINE_B_JOURNEYS = [
  "jornadas/despesa-editar-anular.e2e.ts",
  "jornadas/despesa.e2e.ts",
  "jornadas/devolucao.e2e.ts",
  "jornadas/estoque-produto-ida-e-volta.e2e.ts",
  "jornadas/estoque.e2e.ts",
  "jornadas/forma-de-receber.e2e.ts",
  "jornadas/historico-total-liquido.e2e.ts",
  "jornadas/inicio-grade.e2e.ts",
  "jornadas/inicio.e2e.ts",
  "jornadas/meta.e2e.ts",
  "jornadas/resultado-historico.e2e.ts",
  "jornadas/resultado-periodo.e2e.ts",
  "jornadas/valor-kpi.e2e.ts",
] as const;
