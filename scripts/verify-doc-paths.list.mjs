/**
 * The missing paths each document may still name (`verify-doc-paths.mjs`), keyed `document → path`. The
 * entries below were in the tree before the rule; each keeps its exact count, so the list only
 * goes down. A new entry says why the document names a path that is not in the repository.
 */
const BEFORE_THE_RULE =
  "anterior à checagem; ao mexer neste documento, aponte para o caminho atual ou tire a referência";

export const DOC_PATHS_LIST = {
  "docs/adr/0101-adaptador-asaas-porta-de-saida-e-releitura-do-recurso.md → 0087-referencia-do-provedor-em-todo-fato.md":
    { count: 1, reason: BEFORE_THE_RULE },
  "docs/runbooks/rls-hyperdrive-gate.md → apps/web/wrangler.pr11.jsonc": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
};
