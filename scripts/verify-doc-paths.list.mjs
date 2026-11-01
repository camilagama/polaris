/**
 * The missing paths each document may still name (`verify-doc-paths.mjs`), keyed `document → path`. The
 * entries below were in the main branch when the check started; each keeps its exact count, so the list only
 * goes down. A new entry says why the document names a path that is not in the repository.
 */
const BEFORE_THE_RULE =
  "anterior à checagem; ao mexer neste documento, aponte para o caminho atual ou tire a referência";

export const DOC_PATHS_LIST = {
  ".claude/skills/verify-polaris/features/outros-enderecos.md → apps/web/e2e/help.e2e.ts":
    { count: 1, reason: BEFORE_THE_RULE },
  "doc/doc-inicial.md → apps/api": { count: 1, reason: BEFORE_THE_RULE },
  "doc/handoff-pr43.md → docs/agents/issue-tracker.md": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "doc/status-implementacao.md → apps/web/src/server/router.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "docs/adr/0040-service-worker-do-app-shell.md → apps/web/scripts/generate-pwa-icons.mjs":
    { count: 1, reason: BEFORE_THE_RULE },
  "docs/adr/0101-adaptador-asaas-porta-de-saida-e-releitura-do-recurso.md → 0087-referencia-do-provedor-em-todo-fato.md":
    { count: 1, reason: BEFORE_THE_RULE },
  "docs/adr/0103-base-de-componentes-shadcn-base-ui-e-tailwind-4.md → apps/web/src/styles/preflight.css":
    { count: 1, reason: BEFORE_THE_RULE },
  "docs/runbooks/rls-hyperdrive-gate.md → apps/web/wrangler.pr11.jsonc": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "docs/runbooks/testes-de-tela.md → apps/web/.lighthouseci/": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
};
