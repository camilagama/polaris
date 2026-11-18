import { readFileSync } from "node:fs";
import type { ProductReadModel } from "@polaris/contracts";
import { MAX_PRODUCT_VARIANTS } from "@polaris/domain/catalog/product";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

import { keepLocalRow } from "./product-commands";

const LIST_BALANCES_LIMIT =
  /inventory\.listBalances\(\{[^}]*?\blimit:\s*(\d+)/s;

const HOOK = new URL("./use-product-delete.ts", import.meta.url);

const IMPORT = /^import\s+([^;]*?)\s+from\s+"([^"]+)";/gm;
// Textual: a queue reached through a name outside these words and outside the static imports is not seen, nor is one named only inside a string (`stores["outbox"]`).
const OFFLINE_WORDS = /outbox|enqueue|createOffline|stores\b/gi;
const QUOTED_OR_COMMENT =
  /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[\s\S]/y;
const TEMPLATE_TEXT = /(?:\\[\s\S]|[^`\\$]|\$(?!\{))*/y;
const DYNAMIC_IMPORT = /(?<!\btypeof\s+)\bimport\s*\(/g;
const TYPE_KEYWORD = /\btype\s+/g;
const BRACES = /[{}]/g;

/** Source without comments; quoted strings and template text stay whole, so a `//`, `/*` or quote inside one does not cut or shift what follows. */
function withoutComments(source: string): string {
  return scan(source, "keep");
}

/** Each name the file imports, as `source: name` (a default or namespace import counts by its local name). */
function importedNames(source: string): string[] {
  return [...withoutComments(source).matchAll(IMPORT)].flatMap((match) =>
    (match[1] ?? "")
      .replace(TYPE_KEYWORD, "")
      .replace(BRACES, "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => `${match[2]}: ${name}`)
  );
}

/** Walks the source token by token, tracking template literals and the code inside `${}`. In "blank" mode comments, quoted strings and template text become spaces; in "keep" mode only comments are dropped. Regex literals are not understood. */
function scan(source: string, mode: "blank" | "keep"): string {
  const keep = mode === "keep";
  const stack: string[] = [];
  let out = "";
  let inTemplate = false;
  let at = 0;
  while (at < source.length) {
    if (inTemplate) {
      const start = at;
      TEMPLATE_TEXT.lastIndex = at;
      at += (TEMPLATE_TEXT.exec(source)?.[0] ?? "").length;
      inTemplate = false;
      if (source.startsWith("${", at)) {
        stack.push("template");
        at += 2;
      } else {
        at += 1;
      }
      out += keep ? source.slice(start, at) : " ";
      continue;
    }
    QUOTED_OR_COMMENT.lastIndex = at;
    const token = QUOTED_OR_COMMENT.exec(source)?.[0] ?? "";
    at += token.length;
    if (token === "`") {
      inTemplate = true;
    } else if (token === "{") {
      stack.push("brace");
    } else if (token === "}") {
      inTemplate = stack.pop() === "template";
    }
    if (token.length === 1) {
      out += token;
    } else if (keep) {
      out += token.startsWith("/") ? "" : token;
    } else {
      out += " ";
    }
  }
  return out;
}

/** Source with comments, quoted strings and template text blanked; the code inside `${}` stays. */
function liveCode(source: string): string {
  return scan(source, "blank");
}

/** `import()` calls: `typeof import("x")` is read as the type form (a runtime `typeof import(...)` would pass), and quoted or commented text does not count. */
function dynamicImports(source: string): string[] {
  return liveCode(source).match(DYNAMIC_IMPORT) ?? [];
}

function offlineWords(source: string): string[] {
  return liveCode(source).match(OFFLINE_WORDS) ?? [];
}

/** Everything the delete hook may import: the server's client, the one local write after the server answered, and the refusal texts. */
const ALLOWED_IMPORTS = [
  "../lib/orpc: orpcClient",
  "./product-commands: Workspace",
  "./product-commands: keepLocalRow",
  "./product-errors: ProductDeleteRefusal",
  "./product-errors: productDeleteRefusal",
  "@polaris/contracts: ProductReadModel",
  "react: useCallback",
  "react: useEffect",
  "react: useRef",
  "react: useState",
].sort();

describe("o detector de fila do hook de Excluir", () => {
  it("vê import e uso da fila, e não se engana com comentário", () => {
    const planted = `import { createOfflineProduct } from "../offline/product-create";
workspace.stores.outbox.enqueue(command);`;
    expect(importedNames(planted)).toEqual([
      "../offline/product-create: createOfflineProduct",
    ]);
    expect(offlineWords(planted).length).toBeGreaterThan(0);
    expect(offlineWords("workspace.runtime.syncNow()")).toEqual([]);
    expect(offlineWords("// the outbox never gets one\nconst a = 1;")).toEqual(
      []
    );
    expect(
      dynamicImports('const m = await import("../offline/outbox");').length
    ).toBe(1);
    expect(
      dynamicImports('const m = await import ( "../offline/outbox" );').length
    ).toBe(1);
    expect(dynamicImports('// import("x")\nconst a = 1;')).toEqual([]);
    expect(
      importedNames(
        'import type { A } from "x";\nimport { b, type c } from "y";'
      )
    ).toEqual(["x: A", "y: b", "y: c"]);
  });

  it("um // dentro de string não esconde o que vem depois na mesma linha", () => {
    const planted = 'const u = "https://x"; stores.outbox.enqueue(c)';
    expect(offlineWords(planted)).toEqual(["stores", "outbox", "enqueue"]);
    expect(
      offlineWords("const u = 'https://x'; stores.outbox.enqueue(c)")
    ).toEqual(["stores", "outbox", "enqueue"]);
    expect(
      offlineWords('const u = "a\\"//b"; stores.outbox.enqueue(c)')
    ).toEqual(["stores", "outbox", "enqueue"]);
  });

  it("crase com /* ou aspas antes do import não apaga nem desalinha o que vem depois", () => {
    const planted = [
      "const a = `a /* b`;",
      "const b = `it's`;",
      'import { createOfflineProduct } from "../offline/product-create";',
      "stores.outbox.enqueue(c); /* nota */",
    ].join("\n");
    expect(importedNames(planted)).toEqual([
      "../offline/product-create: createOfflineProduct",
    ]);
    expect(withoutComments(planted)).toContain("stores.outbox.enqueue(c);");
    expect(offlineWords(planted)).toEqual([
      "createOffline",
      "stores",
      "outbox",
      "enqueue",
    ]);
    const sameLine = 'const b = `it\'s // x`; import { d } from "z";';
    expect(withoutComments(sameLine)).toBe(sameLine);
    const importZ = 'import { d } from "z";';
    const escaped = "const e = `a\\`/*b`;\n";
    expect(withoutComments(escaped + importZ)).toBe(escaped + importZ);
    const inside = `const c = \`x \${/* y */ 1} it's\`;\n`;
    expect(withoutComments(inside + importZ)).toBe(
      `const c = \`x \${ 1} it's\`;\n${importZ}`
    );
  });

  it("import seguido de comentário continua lido, e comentário de linha e de bloco é ignorado", () => {
    expect(
      importedNames('import { a } from "x"; // comentário com "y"')
    ).toEqual(["x: a"]);
    expect(
      importedNames('import { a } from "x"; /* import { b } from "z"; */')
    ).toEqual(["x: a"]);
    expect(
      importedNames('// import { b } from "z";\nimport { a } from "x";')
    ).toEqual(["x: a"]);
    expect(importedNames('import { a } from "https://x/y"; // fim')).toEqual([
      "https://x/y: a",
    ]);
    expect(offlineWords("/* outbox */ const a = 1; // enqueue")).toEqual([]);
  });

  it("um nome novo de um módulo já permitido muda a lista", () => {
    const widened =
      'import { keepLocalRow, deleteProductOffline, type Workspace } from "./product-commands";';
    expect(importedNames(widened).sort()).not.toEqual(
      ALLOWED_IMPORTS.filter((name) => name.startsWith("./product-commands"))
    );
  });
});

describe("o detector de import dinâmico do hook de Excluir", () => {
  it("reprova import() e deixa passar o que não é chamada", () => {
    expect(dynamicImports('const m = await import("x");')).toHaveLength(1);
    expect(dynamicImports('type T = typeof import("x");')).toEqual([]);
    expect(dynamicImports('type T = typeof   import ("x");')).toEqual([]);
    expect(dynamicImports('const s = "import(";')).toEqual([]);
    expect(dynamicImports("const s = 'import(';")).toEqual([]);
    expect(dynamicImports('/* import("x") */ const a = 1;')).toEqual([]);
    expect(
      dynamicImports('const u = "https://x"; await import("y");')
    ).toHaveLength(1);
    const inTemplate = `const a = \`\${await import("y")}\`;`;
    expect(dynamicImports(inTemplate)).toHaveLength(1);
    const quotedInTemplate = `const a = \`say "\${await import("y")}"\`;`;
    expect(dynamicImports(quotedInTemplate)).toHaveLength(1);
    const slashesInTemplate = `const a = \`http://x\${await import("y")}\`;`;
    expect(dynamicImports(slashesInTemplate)).toHaveLength(1);
    const textInTemplate = 'const a = `import("y")`;';
    expect(dynamicImports(textInTemplate)).toEqual([]);
    const nestedBraces = `const a = \`\${{ k: 1 }.k}\`; await import("y");`;
    expect(dynamicImports(nestedBraces)).toHaveLength(1);
  });
});

describe("Excluir produto nunca vira comando guardado no aparelho (AC-2.7)", () => {
  const source = readFileSync(HOOK, "utf8");

  it("o hook importa só os nomes do cliente do servidor, da linha local e dos textos de recusa", () => {
    expect(importedNames(source).sort()).toEqual(ALLOWED_IMPORTS);
  });

  it("o hook não toca a fila nem a loja local", () => {
    expect(offlineWords(source)).toEqual([]);
  });

  it("o hook não carrega módulo nenhum com import() dinâmico", () => {
    expect(dynamicImports(source)).toEqual([]);
  });

  it("a linha local que o hook grava depois da resposta do servidor não passa pela fila", async () => {
    const queueCalls = vi.fn();
    const queue = new Proxy(
      {},
      {
        get: (_target, name) => {
          queueCalls(String(name));
          return () => Promise.resolve();
        },
      }
    );
    const upsert = vi.fn(() => Promise.resolve());
    const workspace = {
      stores: { outbox: queue, writer: { upsert } },
    } as unknown as Parameters<typeof keepLocalRow>[0];
    await keepLocalRow(workspace, {
      id: "p1",
      name: "Jaqueta",
      organizationId: "org",
      status: "deleted",
      version: 3,
    } as unknown as ProductReadModel);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(queueCalls).not.toHaveBeenCalled();
  });
});

describe("a leitura do saldo cabe nas variantes do produto", () => {
  it("a página única de listBalances é do tamanho do teto de variantes por produto ou maior", () => {
    const found = LIST_BALANCES_LIMIT.exec(
      withoutComments(readFileSync(HOOK, "utf8"))
    );
    expect(found, "listBalances sem limit numérico literal").not.toBeNull();
    expect(Number(found?.[1])).toBeGreaterThanOrEqual(MAX_PRODUCT_VARIANTS);
  });

  it("o leitor do limite enxerga o valor e some se a chamada mudar de forma", () => {
    expect(
      LIST_BALANCES_LIMIT.exec(
        "await orpcClient.inventory.listBalances({ limit: 7, organizationId })"
      )?.[1]
    ).toBe("7");
    expect(
      LIST_BALANCES_LIMIT.exec(
        "await orpcClient.inventory.listBalances({ organizationId })"
      )
    ).toBeNull();
  });
});
