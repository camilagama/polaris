/**
 * How the journeys of `jornadas/` are shared among the projects of the real stack, and so among the parts of the CI
 * job (`playwright.e2e-real.config.ts`):
 *
 * - `RUNTIME_ONLY_JOURNEYS` need the preview with the offline runtime on (the lease and sync keys): only the
 *   `runtime-ligado` project runs them.
 * - `ONLINE_B_JOURNEYS` run in the project `online-b`: the same preview and build as `online`, a different set of
 *   files, so the two `online` parts finish in about the same time.
 * - every other file of `jornadas/` stays in `online`, and so does any new journey: add it to `ONLINE_B_JOURNEYS`
 *   when the parts drift apart. `partitionProblems` keeps the three sets true to the folder.
 */
export const RUNTIME_ONLY_JOURNEYS = [
  "jornadas/encerramento.e2e.ts",
  "jornadas/encerramento-aparelho.e2e.ts",
  "jornadas/resultado-historico-offline.e2e.ts",
  "jornadas/venda-saldo-curto-sem-conexao.e2e.ts",
  "jornadas/venda-dividida-sem-conexao.e2e.ts",
  "jornadas/sair-e-recarregar.e2e.ts",
  "jornadas/estoque-produto-sem-conexao.e2e.ts",
] as const;

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

/** What is wrong with the lists, given the files of `jornadas/` (as `jornadas/<name>.e2e.ts`); empty when all is well. */
export function partitionProblems(
  files: readonly string[],
  runtimeOnly: readonly string[] = RUNTIME_ONLY_JOURNEYS,
  onlineB: readonly string[] = ONLINE_B_JOURNEYS
): string[] {
  const problems: string[] = [];
  for (const [name, list] of [
    ["RUNTIME_ONLY_JOURNEYS", runtimeOnly],
    ["ONLINE_B_JOURNEYS", onlineB],
  ] as const) {
    if (new Set(list).size !== list.length) {
      problems.push(`${name} names a file twice`);
    }
    for (const file of list) {
      if (!files.includes(file)) {
        problems.push(`${name} names ${file}, which is not in jornadas/`);
      }
    }
  }
  for (const file of onlineB) {
    if (runtimeOnly.includes(file)) {
      problems.push(
        `${file} is in both lists: it needs the runtime preview and runs in online-b, which has the other one`
      );
    }
  }
  if (onlineB.join("\n") !== [...onlineB].sort().join("\n")) {
    problems.push("ONLINE_B_JOURNEYS is not in alphabetical order");
  }
  return problems;
}
