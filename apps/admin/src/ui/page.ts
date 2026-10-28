import { html } from "hono/html";

/**
 * The operator's page of the Admin (corte admin-tela-v1, D-2): the Worker answers it itself, behind the same Access
 * verification as the API, with one script and one sheet built from `apps/admin/ui` and embedded as Text modules.
 *
 * The HTML is a constant: no store name, e-mail or bootstrap JSON is ever written into it, only the two file names,
 * which carry a hash of their content so a page opened during a deploy never pairs a new HTML with an old script
 * (a stale name answers 404). Every datum reaches the page by `fetch` and is written as text.
 */

export interface AdminPageAssets {
  /** The sheet, `apps/admin/ui/admin.css`. */
  css: string;
  /** The bundled script of `apps/admin/ui/main.ts`. */
  js: string;
}

export interface AdminPage {
  /** The paths answered with the document profile: the page, the script and the sheet, nothing else. */
  documentPaths: ReadonlySet<string>;
  /** The body and type of a file path, or null when the path is not one of the two files. */
  file: (path: string) => { body: string; type: string } | null;
  html: string;
}

const HASH_BYTES = 8;

async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest).slice(0, HASH_BYTES)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function documentOf(scriptPath: string, stylePath: string): string {
  const rendered = html`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Polaris Admin</title>
    <link rel="stylesheet" href="${stylePath}" />
    <script type="module" src="${scriptPath}"></script>
  </head>
  <body>
    <div id="admin">
      <p>Carregando o Admin…</p>
      <noscript><p>O Admin precisa de JavaScript ligado.</p></noscript>
    </div>
  </body>
</html>
`;
  // nothing in it is asynchronous, so the render is ready; a promise here would be a mistake to stop on
  if (rendered instanceof Promise) {
    throw new Error("the Admin page must render synchronously");
  }
  return rendered.toString();
}

/** The page for these files; the hashes are taken once per isolate. */
export function createAdminPage(
  assets: AdminPageAssets
): () => Promise<AdminPage> {
  let page: Promise<AdminPage> | null = null;
  const build = async (): Promise<AdminPage> => {
    const [script, style] = await Promise.all([
      contentHash(assets.js),
      contentHash(assets.css),
    ]);
    const scriptPath = `/ui/admin-${script}.js`;
    const stylePath = `/ui/admin-${style}.css`;
    const files = new Map([
      [scriptPath, { body: assets.js, type: "text/javascript; charset=utf-8" }],
      [stylePath, { body: assets.css, type: "text/css; charset=utf-8" }],
    ]);
    return {
      documentPaths: new Set(["/", scriptPath, stylePath]),
      file: (path) => files.get(path) ?? null,
      html: documentOf(scriptPath, stylePath),
    };
  };
  return () => {
    page ??= build();
    return page;
  };
}
