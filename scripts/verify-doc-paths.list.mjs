/**
 * The missing paths each document may still name (`verify-doc-paths.mjs`), keyed `document → path`.
 * The list is empty: every document points at a path that exists. A new entry keeps its exact count
 * and says why the document names a path that is not in the repository.
 */
export const DOC_PATHS_LIST = {};
