/**
 * The Vitest configs whose random order `verify-vitest-shuffle.mjs` keeps on, and what each must set. `needs` is the
 * list of `shuffle` keys that have to be `true` (`["files", "tests"]`, or `["tests"]` for a project that only
 * orders its tests). A config that turns the shuffle on is added here in the same change; a config that is not
 * listed is not checked.
 */
const ROOT_ORDERS_FILES_AND_TESTS =
  "ordena arquivos e testes; o que a raiz liga não chega a um projeto carregado de arquivo, que liga o seu";

const PROJECT_ORDERS_TESTS =
  "projeto carregado de arquivo: não herda o sequence da raiz, então liga o seu; a ordem dos arquivos vem da raiz";

export const VITEST_SHUFFLE_LIST = {
  "apps/admin/vitest.workers-db.config.ts": {
    needs: ["tests"],
    reason: PROJECT_ORDERS_TESTS,
  },
  "apps/admin/vitest.workers.config.ts": {
    needs: ["tests"],
    reason: PROJECT_ORDERS_TESTS,
  },
  "apps/catalog/vitest.workers-db.config.ts": {
    needs: ["tests"],
    reason: PROJECT_ORDERS_TESTS,
  },
  "apps/web/vitest.workers-db.config.ts": {
    needs: ["files", "tests"],
    reason: ROOT_ORDERS_FILES_AND_TESTS,
  },
  "vitest.admin-worker.config.ts": {
    needs: ["files", "tests"],
    reason: ROOT_ORDERS_FILES_AND_TESTS,
  },
  "vitest.catalog-worker.config.ts": {
    needs: ["files", "tests"],
    reason: ROOT_ORDERS_FILES_AND_TESTS,
  },
  "vitest.config.ts": {
    needs: ["files", "tests"],
    reason: ROOT_ORDERS_FILES_AND_TESTS,
  },
  "vitest.datas.config.ts": {
    needs: ["files", "tests"],
    reason: ROOT_ORDERS_FILES_AND_TESTS,
  },
  "vitest.web-worker.config.ts": {
    needs: ["files", "tests"],
    reason: ROOT_ORDERS_FILES_AND_TESTS,
  },
};
