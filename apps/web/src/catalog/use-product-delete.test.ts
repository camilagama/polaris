import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProductReadModel } from "@polaris/contracts";
import { MAX_PRODUCT_VARIANTS } from "@polaris/domain/catalog/product";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

import { keepLocalRow } from "./product-commands";

const LIST_BALANCES_LIMIT =
  /inventory\.listBalances\(\{[^}]*?\blimit:\s*(\d+)/s;

const HOOK = new URL("./use-product-delete.ts", import.meta.url);

const IMPORT = /^import\s+([^;]*?)\s+from\s+"([^"]+)";/gm;
// Textual and complementary to the import graph: a queue named only inside a string (`stores["outbox"]`) or reached without any of these words is not seen here.
const OFFLINE_WORDS = /outbox|enqueue|createOffline|stores\b/gi;
const QUOTED_OR_COMMENT =
  /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[\s\S]/y;
const TEMPLATE_TEXT = /(?:\\[\s\S]|[^`\\$]|\$(?!\{))*/y;
const DYNAMIC_IMPORT = /(?<!\btypeof\s+)\bimport\s*\(/g;
const TYPE_KEYWORD = /\btype\s+/g;
const BRACES = /[{}]/g;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_PATH = join(SRC, "catalog/use-product-delete.ts");
const GRAPH_IMPORT =
  /(?:^|[\s;}])(import|export)\s+(type\s+)?(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*(?:["']([^"']+)["']|([^)]*))\)/g;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const SRC_ALIAS = /^@\/(lib|ui)\//;
const BUNDLER_LOADERS =
  /\bimport\.meta\.glob(?:Eager)?\s*\(|new\s+URL\s*\([^)]*import\.meta\.url/g;

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

/** What the hook may reach under `offline/`: the session-ended signal the server client raises and the cache cleanup it triggers. Any other module there (a command builder, the outbox, the sync runner, the stores) is a way into the queue. */
const REACHABLE_OFFLINE_FILES = [
  "offline/runtime/leave-browser.ts",
  "offline/runtime/session-ended.ts",
];
/** The graph stops here: it is the module of `keepLocalRow` (the single local write after the server answered, proven by behavior below) and of the create path, which does use the queue. The hook's names from it are pinned by `ALLOWED_IMPORTS`. */
const GRAPH_BOUNDARY = "catalog/product-commands.ts";
const QUEUE_PATH = /outbox|sync-runner/;

type SourceReader = (absolutePath: string) => string | undefined;

function readFromDisk(path: string): string | undefined {
  return existsSync(path) && statSync(path).isFile()
    ? readFileSync(path, "utf8")
    : undefined;
}

function resolveSource(
  from: string,
  specifier: string,
  read: SourceReader
): string | undefined {
  const aliased = SRC_ALIAS.test(specifier)
    ? join(SRC, specifier.slice(2))
    : undefined;
  if (!(aliased || specifier.startsWith("."))) {
    return;
  }
  const base = aliased ?? resolve(dirname(from), specifier);
  return SOURCE_EXTENSIONS.map((extension) => base + extension).find(
    (candidate) => read(candidate) !== undefined
  );
}

/** Runtime import graph of `entry` inside `src`: static imports, `export ... from`, side-effect imports and `import("x")`; `import type` is erased at build time and does not load anything. What cannot be followed is reported as `unresolved`: a dynamic import whose argument is not a string literal, a relative or `@/` specifier that resolves to no file, `import.meta.glob` and `new URL(..., import.meta.url)`. */
function runtimeGraph(
  entry: string,
  read: SourceReader,
  boundary?: string
): { files: string[]; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) {
      return;
    }
    files.add(file);
    if (file === boundary) {
      return;
    }
    const source = withoutComments(read(file) ?? "");
    for (const match of source.matchAll(GRAPH_IMPORT)) {
      if (match[2]) {
        continue;
      }
      const specifier = match[3] ?? match[4];
      if (specifier === undefined) {
        unresolved.push(`${relative(SRC, file)}: import(${match[5]?.trim()})`);
        continue;
      }
      const target = resolveSource(file, specifier, read);
      if (target) {
        visit(target);
      } else if (specifier.startsWith(".") || SRC_ALIAS.test(specifier)) {
        unresolved.push(`${relative(SRC, file)}: ${specifier}`);
      }
    }
    for (const loader of source.match(BUNDLER_LOADERS) ?? []) {
      unresolved.push(`${relative(SRC, file)}: ${loader}`);
    }
  };
  visit(entry);
  return { files: [...files], unresolved };
}

/** The modules a graph reaches that lead to the offline queue, plus every dynamic import it could not follow. */
function queueReach(
  entry: string,
  read: SourceReader,
  boundary?: string
): string[] {
  const { files, unresolved } = runtimeGraph(entry, read, boundary);
  const reached = files
    .map((file) => relative(SRC, file))
    .filter(
      (file) =>
        QUEUE_PATH.test(file) ||
        (file.startsWith("offline/") && !REACHABLE_OFFLINE_FILES.includes(file))
    );
  return [...reached, ...unresolved].sort();
}

function virtualSources(sources: Record<string, string>): SourceReader {
  return (path) => sources[relative(SRC, path)] ?? readFromDisk(path);
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

describe("o grafo de imports do hook de Excluir não chega à fila guardada no aparelho", () => {
  const hookSource = readFileSync(HOOK_PATH, "utf8");
  const withHook = (extra: string, more: Record<string, string> = {}) =>
    virtualSources({
      "catalog/use-product-delete.ts": `${hookSource}\n${extra}`,
      ...more,
    });

  it("o hook de hoje, seguido até a fronteira, só alcança o que a lista permite", () => {
    const { files, unresolved } = runtimeGraph(
      HOOK_PATH,
      readFromDisk,
      join(SRC, GRAPH_BOUNDARY)
    );
    expect(unresolved).toEqual([]);
    expect(files.map((file) => relative(SRC, file))).toContain(GRAPH_BOUNDARY);
    expect(
      queueReach(HOOK_PATH, readFromDisk, join(SRC, GRAPH_BOUNDARY))
    ).toEqual([]);
    const offlineReached = files
      .map((file) => relative(SRC, file))
      .filter((file) => file.startsWith("offline/"))
      .sort();
    expect(offlineReached).toEqual(REACHABLE_OFFLINE_FILES);
  });

  it("import() dinâmico que leva à fila reprova", () => {
    const reached = queueReach(
      HOOK_PATH,
      withHook('const m = await import("../offline/outbox/outbox");'),
      join(SRC, GRAPH_BOUNDARY)
    );
    expect(reached).toContain("offline/outbox/outbox.ts");
  });

  it("módulo intermediário com outro nome que importa a fila reprova", () => {
    const reached = queueReach(
      HOOK_PATH,
      withHook('import { relay } from "./product-relay";', {
        "catalog/product-relay.ts":
          'import { Outbox } from "../offline/outbox/outbox";\nexport const relay = Outbox;',
      }),
      join(SRC, GRAPH_BOUNDARY)
    );
    expect(reached).toContain("offline/outbox/outbox.ts");
  });

  it("a fila alcançada de mais longe, fora da pasta offline, também reprova", () => {
    const reached = queueReach(
      HOOK_PATH,
      withHook('import { a } from "./step-a";', {
        "catalog/step-a.ts": 'export { b } from "../lib/step-b";',
        "lib/step-b.ts":
          'import "../offline/sync-runner";\nexport const b = 1;',
      }),
      join(SRC, GRAPH_BOUNDARY)
    );
    expect(reached).toContain("offline/sync-runner.ts");
  });

  it("módulo de comando guardado do aparelho reprova mesmo sem a palavra outbox", () => {
    const reached = queueReach(
      HOOK_PATH,
      withHook(
        'import { createOfflineProduct } from "../offline/product-create";'
      ),
      join(SRC, GRAPH_BOUNDARY)
    );
    expect(reached).toContain("offline/product-create.ts");
  });

  it("import() com argumento que não é texto literal reprova por não poder ser seguido", () => {
    const reached = queueReach(
      HOOK_PATH,
      withHook("const m = await import(modulePath);"),
      join(SRC, GRAPH_BOUNDARY)
    );
    expect(reached.some((entry) => entry.includes("import("))).toBe(true);
  });

  it("import type e comentário não contam, e o alias @/lib é seguido", () => {
    expect(
      queueReach(
        HOOK_PATH,
        withHook(
          'import type { Outbox } from "../offline/outbox/outbox";\n// import("../offline/outbox/outbox")'
        ),
        join(SRC, GRAPH_BOUNDARY)
      )
    ).toEqual([]);
    expect(
      queueReach(
        HOOK_PATH,
        withHook('import { x } from "@/lib/aliased";', {
          "lib/aliased.ts": 'import "../offline/outbox/outbox";',
        }),
        join(SRC, GRAPH_BOUNDARY)
      )
    ).toContain("offline/outbox/outbox.ts");
  });

  it("export *, pasta com index.ts, import em várias linhas, alias @/ui são seguidos, e import() com crase reprova", () => {
    const boundary = join(SRC, GRAPH_BOUNDARY);
    const outbox = "offline/outbox/outbox.ts";
    const via = (extra: string, more: Record<string, string>) =>
      queueReach(HOOK_PATH, withHook(extra, more), boundary);
    expect(
      via('export * from "./star";', {
        "catalog/star.ts": 'export * from "../offline/outbox/outbox";',
      })
    ).toContain(outbox);
    expect(
      via('import { r } from "./pasta";', {
        "catalog/pasta/index.ts":
          'import { Outbox } from "../../offline/outbox/outbox";\nexport const r = Outbox;',
      })
    ).toContain(outbox);
    expect(
      via('import {\n  a,\n  b,\n} from "./multi";', {
        "catalog/multi.ts":
          'export { Outbox as a, Outbox as b } from "../offline/outbox/outbox";',
      })
    ).toContain(outbox);
    expect(
      via('import { u } from "@/ui/viaui";', {
        "ui/viaui.ts":
          'import "../offline/outbox/outbox";\nexport const u = 1;',
      })
    ).toContain(outbox);
    expect(
      via("const m = await import(`../offline/outbox/outbox`);", {})
    ).toHaveLength(1);
  });

  it("especificador relativo que não resolve, import.meta.glob e new URL com import.meta.url reprovam por não poderem ser seguidos", () => {
    const boundary = join(SRC, GRAPH_BOUNDARY);
    const reach = (extra: string) =>
      queueReach(HOOK_PATH, withHook(extra), boundary);
    expect(reach('import "../offline/outbox/outbox?worker";')).toEqual([
      "catalog/use-product-delete.ts: ../offline/outbox/outbox?worker",
    ]);
    expect(reach('import "../offline/outbox/outbox.js";')).toHaveLength(1);
    expect(
      reach('const all = import.meta.glob("../offline/*.ts", { eager: true });')
    ).toHaveLength(1);
    expect(
      reach(
        'const w = new Worker(new URL("../offline/w.ts", import.meta.url));'
      )
    ).toHaveLength(1);
  });

  it("sem a fronteira o grafo chega ao construtor de comandos pelo módulo de criar", () => {
    expect(queueReach(HOOK_PATH, readFromDisk)).toContain(
      "offline/product-create.ts"
    );
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

  it("nenhum módulo que o hook alcança é da fila guardada no aparelho", () => {
    expect(
      queueReach(HOOK_PATH, readFromDisk, join(SRC, GRAPH_BOUNDARY))
    ).toEqual([]);
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
